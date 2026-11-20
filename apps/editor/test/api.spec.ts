import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CellType, EdgeType, getEdge, type Dungeon, type DraftIndexEntry, type DungeonIndexEntry } from "@dungeon/shared";

// DEV_BYPASS_EMAIL only applies to localhost hosts.
const BASE = "http://localhost:8788";
const JSON_H = { "content-type": "application/json" };

const api = (path: string, init: RequestInit = {}) => SELF.fetch(`${BASE}${path}`, init);
const post = (path: string, body?: unknown) =>
	api(path, { method: "POST", headers: JSON_H, body: body === undefined ? undefined : JSON.stringify(body) });

async function create(extra: Record<string, unknown> = {}) {
	const res = await post("/api/dungeons", { name: "Test", width: 8, height: 8, floors: 2, ...extra });
	expect(res.status).toBe(200);
	return (await res.json()) as { id: string; revision: number };
}
async function load(id: string) {
	return (await (await api(`/api/dungeons/${id}`)).json()) as { dungeon: Dungeon; publishedRevision: number | null };
}
const put = (id: string, d: unknown, rev: number | string, headers: Record<string, string> = {}) =>
	api(`/api/dungeons/${id}`, { method: "PUT", headers: { ...JSON_H, "if-match": String(rev), ...headers }, body: JSON.stringify(d) });

describe("auth", () => {
	it("rejects requests without Access identity on a non-local host", async () => {
		const res = await SELF.fetch("https://editor.example.com/api/dungeons");
		expect(res.status).toBe(403);
		expect((await SELF.fetch("https://editor.example.com/")).status).toBe(403); // assets too
	});
	it("serves the app shell and /api/me for an authenticated (dev) caller", async () => {
		const page = await api("/");
		expect(page.status).toBe(200);
		expect(page.headers.get("cache-control")).toContain("private");
		expect(await (await api("/api/me")).json()).toEqual({ email: "dev@example.com" });
	});
});

describe("draft lifecycle", () => {
	it("creates, lists, loads and records the author", async () => {
		const { id, revision } = await create();
		expect(revision).toBe(1);
		const list = (await (await api("/api/dungeons")).json()) as DraftIndexEntry[];
		const e = list.find((x) => x.id === id)!;
		expect(e).toMatchObject({ name: "Test", floors: 2, revision: 1, publishedRevision: null, updatedBy: "dev@example.com" });
		const { dungeon } = await load(id);
		expect(dungeon.floors).toHaveLength(2);
		const m = (await (await api(`/api/dungeons/${id}/manifest`)).json()) as any;
		expect(m.updatedBy).toBe("dev@example.com");
		expect((await api(`/api/dungeons/${id}/floors/1`)).status).toBe(200);
	});
	it("validates creation input", async () => {
		expect((await post("/api/dungeons", { name: "" })).status).toBe(400);
		expect((await post("/api/dungeons", { name: "x", width: 3 })).status).toBe(400);
		expect((await post("/api/dungeons", { name: "x", floors: 99 })).status).toBe(400);
		expect((await api("/api/dungeons", { method: "POST", body: "{}" })).status).toBe(415);
	});
	it("saves with optimistic locking", async () => {
		const { id } = await create();
		const { dungeon } = await load(id);
		dungeon.name = "Renamed";
		const ok = await put(id, dungeon, 1);
		expect(ok.status).toBe(200);
		expect(((await ok.json()) as any).revision).toBe(2);
		const stale = await put(id, dungeon, 1);
		expect(stale.status).toBe(409);
		expect(((await stale.json()) as any).revision).toBe(2);
		expect((await put(id, dungeon, "abc")).status).toBe(428);
		expect((await load(id)).dungeon.name).toBe("Renamed");
	});
	it("serialises concurrent saves: exactly one wins per revision", async () => {
		const { id } = await create();
		const { dungeon } = await load(id);
		const results = await Promise.all(Array.from({ length: 6 }, () => put(id, dungeon, 1)));
		const codes = results.map((r) => r.status).sort();
		expect(codes.filter((c) => c === 200)).toHaveLength(1);
		expect(codes.filter((c) => c === 409)).toHaveLength(5);
		expect((await load(id)).dungeon.revision).toBe(2);
	});
	it("rejects invalid maps server-side (client checks are not trusted)", async () => {
		const { id } = await create();
		const { dungeon } = await load(id);
		const bad = structuredClone(dungeon);
		bad.floors[0]!.hEdges[0] = EdgeType.OPEN; // open perimeter
		const r = await put(id, bad, 1);
		expect(r.status).toBe(422);
		expect(JSON.stringify(await r.json())).toContain("perimeter");
		const mismatch = await put(id, { ...dungeon, id: "other" }, 1);
		expect(mismatch.status).toBe(400);
		expect((await put(id, { junk: true }, 1)).status).toBe(400);
		const typed = structuredClone(dungeon) as any;
		typed.floors[0].cells = "nope";
		expect((await put(id, typed, 1)).status).toBe(400);
		expect((await load(id)).dungeon.revision).toBe(1); // nothing was written
	});
	it("blocks cross-origin writes and oversize bodies", async () => {
		const { id } = await create();
		const { dungeon } = await load(id);
		expect((await put(id, dungeon, 1, { origin: "https://evil.example" })).status).toBe(403);
		expect((await post("/api/dungeons", { name: "x" }).then((r) => r.status))).toBe(200);
		const big = await put(id, { ...dungeon, name: "x".repeat(2_000_000) }, 1);
		expect(big.status).toBe(413);
	});
	it("prunes old draft revisions", async () => {
		const { id } = await create();
		let { dungeon } = await load(id);
		for (let rev = 1; rev <= 5; rev++) {
			const res = await put(id, dungeon, rev);
			expect(res.status).toBe(200);
		}
		const keys = (await env.DRAFT.list({ prefix: `dungeons/${id}/` })).objects.map((o) => o.key);
		const revs = new Set(keys.map((k) => /\/r(\d+)\//.exec(k)?.[1]).filter(Boolean));
		expect([...revs].sort()).toEqual(["4", "5", "6"]);
	});
});

describe("publish flow", () => {
	it("publishes to the public bucket and KV list, then unpublishes", async () => {
		const { id } = await create({ generate: true });
		const res = await post(`/api/dungeons/${id}/publish`);
		expect(res.status).toBe(200);
		expect(((await res.json()) as any).publishedRevision).toBe(1);

		const pub = (await env.DUNGEON_META.get<DungeonIndexEntry[]>("dungeon:index", "json"))!;
		expect(pub.find((e) => e.id === id)).toMatchObject({ name: "Test", revision: 1, floors: 2 });
		const m = (await (await env.PUBLISHED.get(`dungeons/${id}/manifest.json`))!.json()) as any;
		expect(m.publishedBy).toBe("dev@example.com");
		expect(await env.PUBLISHED.head(`dungeons/${id}/r1/floor-1.json`)).not.toBeNull();
		expect((await load(id)).publishedRevision).toBe(1);

		// draft changes don't leak until republished
		const { dungeon } = await load(id);
		dungeon.name = "Changed";
		await put(id, dungeon, 1);
		expect((await env.DUNGEON_META.get<DungeonIndexEntry[]>("dungeon:index", "json"))!.find((e) => e.id === id)!.name).toBe("Test");
		await post(`/api/dungeons/${id}/publish`);
		expect((await env.DUNGEON_META.get<DungeonIndexEntry[]>("dungeon:index", "json"))!.find((e) => e.id === id)).toMatchObject({ name: "Changed", revision: 2 });
		expect(await env.PUBLISHED.head(`dungeons/${id}/r1/floor-0.json`)).toBeNull(); // old public revision removed

		expect((await post(`/api/dungeons/${id}/unpublish`)).status).toBe(200);
		expect((await env.DUNGEON_META.get<DungeonIndexEntry[]>("dungeon:index", "json"))!.some((e) => e.id === id)).toBe(false);
		expect(await env.PUBLISHED.head(`dungeons/${id}/manifest.json`)).toBeNull();
		expect((await load(id)).publishedRevision).toBeNull();
	});
	it("refuses to publish a map with unreachable content", async () => {
		const { id } = await create({ floors: 1 });
		const { dungeon } = await load(id);
		const f = dungeon.floors[0]!;
		// chest in a cell sealed off by walls
		f.cells[5 * 8 + 5] = CellType.CHEST;
		f.chests["5,5"] = { id: "c" };
		for (const [kind, i] of [["h", 5 * 8 + 5], ["h", 6 * 8 + 5], ["v", 5 * 9 + 5], ["v", 5 * 9 + 6]] as const) {
			(kind === "h" ? f.hEdges : f.vEdges)[i] = EdgeType.WALL;
		}
		expect(getEdge(f, 5, 5, 0)).toBe(EdgeType.WALL);
		expect((await put(id, dungeon, 1)).status).toBe(200); // drafts may be incomplete...
		const res = await post(`/api/dungeons/${id}/publish`);
		expect(res.status).toBe(422); // ...but cannot be published
		expect(JSON.stringify(await res.json())).toContain("unreachable");
		expect(await env.PUBLISHED.head(`dungeons/${id}/manifest.json`)).toBeNull();
	});
	it("keeps the public list intact across concurrent publishes of different dungeons", async () => {
		const ids = await Promise.all([create(), create(), create()]);
		const rs = await Promise.all(ids.map(({ id }) => post(`/api/dungeons/${id}/publish`)));
		expect(rs.every((r) => r.status === 200)).toBe(true);
		const pub = (await env.DUNGEON_META.get<DungeonIndexEntry[]>("dungeon:index", "json"))!;
		for (const { id } of ids) expect(pub.some((e) => e.id === id)).toBe(true);
	});
	it("deletes everything for a dungeon", async () => {
		const { id } = await create();
		await post(`/api/dungeons/${id}/publish`);
		expect((await api(`/api/dungeons/${id}`, { method: "DELETE" })).status).toBe(200);
		expect((await api(`/api/dungeons/${id}`)).status).toBe(404);
		expect((await env.DRAFT.list({ prefix: `dungeons/${id}/` })).objects).toHaveLength(0);
		expect((await env.PUBLISHED.list({ prefix: `dungeons/${id}/` })).objects).toHaveLength(0);
		expect(((await (await api("/api/dungeons")).json()) as DraftIndexEntry[]).some((e) => e.id === id)).toBe(false);
		expect((await post(`/api/dungeons/${id}/publish`)).status).toBe(404);
	});
	it("rejects malformed ids", async () => {
		expect((await api("/api/dungeons/..%2Fx")).status).toBe(400);
	});
});
