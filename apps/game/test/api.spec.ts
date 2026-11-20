import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { generateFloor, linkStairs, type DungeonManifest } from "@dungeon/shared";

const ORIGIN = "https://example.com";

async function publishSample() {
	const g0 = generateFloor({ index: 0, seed: 1, downStairs: true });
	const g1 = generateFloor({ index: 1, seed: 2, upStairs: true });
	linkStairs([g0.floor, g1.floor]);
	const manifest: DungeonManifest = {
		id: "demo", name: "Demo", revision: 3, updatedAt: "2026-01-01T00:00:00Z",
		startPoint: { floor: 0, x: g0.start.x, y: g0.start.y, dir: 0 },
		floors: [g0.floor, g1.floor].map((f) => ({ index: f.index, width: f.width, height: f.height })),
	};
	await env.PUBLISHED.put("dungeons/demo/manifest.json", JSON.stringify(manifest));
	await env.PUBLISHED.put("dungeons/demo/r3/floor-0.json", JSON.stringify(g0.floor));
	await env.PUBLISHED.put("dungeons/demo/r3/floor-1.json", JSON.stringify(g1.floor));
	await env.DUNGEON_META.put("dungeon:index", JSON.stringify([{ id: "demo", name: "Demo", revision: 3, floors: 2, publishedAt: "x" }]));
	return { manifest, g0 };
}

const goodSave = {
	dungeonRevision: 3,
	position: { floor: 0, x: 1, y: 2, dir: 1 },
	visited: { 0: "10x10:AQID" },
	openedChests: ["0:1,1"],
	inventory: [],
};
const put = (body: unknown, headers: Record<string, string> = {}) =>
	SELF.fetch(`${ORIGIN}/api/save/demo`, {
		method: "PUT",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

describe("public map API", () => {
	beforeEach(publishSample);

	it("lists published dungeons (empty when none)", async () => {
		const res = await SELF.fetch(`${ORIGIN}/api/dungeons`);
		expect(await res.json()).toHaveLength(1);
		await env.DUNGEON_META.delete("dungeon:index");
		expect(await (await SELF.fetch(`${ORIGIN}/api/dungeons`)).json()).toEqual([]);
	});
	it("serves manifest and immutable floors", async () => {
		const m = await SELF.fetch(`${ORIGIN}/api/dungeons/demo`);
		expect(((await m.json()) as DungeonManifest).revision).toBe(3);
		const f = await SELF.fetch(`${ORIGIN}/api/dungeons/demo/floors/1?rev=3`);
		expect(f.status).toBe(200);
		expect(f.headers.get("cache-control")).toContain("immutable");
	});
	it("rejects bad input and unknown resources", async () => {
		expect((await SELF.fetch(`${ORIGIN}/api/dungeons/demo/floors/0`)).status).toBe(400); // no rev
		expect((await SELF.fetch(`${ORIGIN}/api/dungeons/demo/floors/x?rev=3`)).status).toBe(400);
		expect((await SELF.fetch(`${ORIGIN}/api/dungeons/..%2Fsecret`)).status).toBe(400);
		expect((await SELF.fetch(`${ORIGIN}/api/dungeons/nope`)).status).toBe(404);
		expect((await SELF.fetch(`${ORIGIN}/api/dungeons/demo/floors/9?rev=3`)).status).toBe(404);
		expect((await SELF.fetch(`${ORIGIN}/api/unknown`)).status).toBe(404);
	});
	it("has no write route for maps", async () => {
		for (const method of ["PUT", "POST", "DELETE"]) {
			const res = await SELF.fetch(`${ORIGIN}/api/dungeons/demo`, { method, body: "{}", headers: { "content-type": "application/json" } });
			expect(res.status).toBe(405);
		}
	});
	it("serves static assets for non-API paths", async () => {
		const res = await SELF.fetch(`${ORIGIN}/`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("<title>test</title>");
	});
});

describe("save API", () => {
	it("issues a pid cookie, round-trips a save, isolates players", async () => {
		const first = await SELF.fetch(`${ORIGIN}/api/save/demo`);
		expect(await first.json()).toBeNull();
		const cookie = first.headers.get("set-cookie")!;
		expect(cookie).toMatch(/pid=[0-9a-f-]{36}.*HttpOnly.*Secure.*SameSite=Lax/);
		const pid = cookie.split(";")[0]!;

		const saved = await put(goodSave, { cookie: pid });
		expect(saved.status).toBe(200);
		expect(saved.headers.get("set-cookie")).toBeNull(); // identity already known
		const got = (await (await SELF.fetch(`${ORIGIN}/api/save/demo`, { headers: { cookie: pid } })).json()) as any;
		expect(got.position).toEqual(goodSave.position);
		expect(got.dungeonId).toBe("demo");

		const other = await SELF.fetch(`${ORIGIN}/api/save/demo`, { headers: { cookie: `pid=${crypto.randomUUID()}` } });
		expect(await other.json()).toBeNull();
	});
	it("ignores client-supplied identity fields", async () => {
		const pid = `pid=${crypto.randomUUID()}`;
		await put({ ...goodSave, playerId: "evil", dungeonId: "other" }, { cookie: pid });
		const got = (await (await SELF.fetch(`${ORIGIN}/api/save/demo`, { headers: { cookie: pid } })).json()) as any;
		expect(got.playerId).toBe(pid.slice(4));
		expect(got.dungeonId).toBe("demo");
	});
	it.each([
		["bad position", { ...goodSave, position: { floor: 0, x: -1, y: 0, dir: 0 } }],
		["bad dir", { ...goodSave, position: { floor: 0, x: 0, y: 0, dir: 4 } }],
		["bad bitmap", { ...goodSave, visited: { 0: "!!!" } }],
		["bitmap without size", { ...goodSave, visited: { 0: "AQID" } }],
		["bad floor key", { ...goodSave, visited: { 99: "10x10:AQ==" } }],
		["chests not array", { ...goodSave, openedChests: "x" }],
		["array body", [1, 2]],
	])("rejects %s", async (_n, body) => {
		expect((await put(body)).status).toBe(400);
	});
	it("rejects wrong content-type, oversize, and cross-origin writes", async () => {
		const wrongType = await SELF.fetch(`${ORIGIN}/api/save/demo`, { method: "PUT", body: JSON.stringify(goodSave) });
		expect(wrongType.status).toBe(415);
		const big = await put({ ...goodSave, openedChests: ["x".repeat(30)].concat(new Array(2500).fill("y")) });
		expect(big.status).toBe(400);
		const huge = await put({ ...goodSave, inventory: new Array(20000).fill("itemitemitem") });
		expect(huge.status).toBe(413);
		expect((await put(goodSave, { origin: "https://evil.example" })).status).toBe(403);
	});
});
