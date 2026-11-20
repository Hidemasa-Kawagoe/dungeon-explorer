import { ID_PATTERN, type DungeonIndexEntry, type DungeonManifest } from "@dungeon/shared";
import { error, json } from "../http";

const IMMUTABLE = "public, max-age=31536000, immutable";

/** GET /api/dungeons: published list. */
export async function listDungeons(env: Env): Promise<Response> {
	const list = (await env.DUNGEON_META.get<DungeonIndexEntry[]>("dungeon:index", "json")) ?? [];
	return json(list, { headers: { "cache-control": "public, max-age=30" } });
}

/** GET /api/dungeons/:id: published manifest. */
export async function getManifest(env: Env, id: string): Promise<Response> {
	if (!ID_PATTERN.test(id)) return error(400, "invalid dungeon id");
	const obj = await env.PUBLISHED.get(`dungeons/${id}/manifest.json`);
	if (!obj) return error(404, "dungeon not found");
	return new Response(obj.body, {
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=30" },
	});
}

/** GET /api/dungeons/:id/floors/:n?rev=R: published floor (immutable per revision). */
export async function getFloor(env: Env, id: string, n: string, rev: string | null): Promise<Response> {
	if (!ID_PATTERN.test(id)) return error(400, "invalid dungeon id");
	if (!/^\d{1,2}$/.test(n)) return error(400, "invalid floor");
	if (!rev || !/^\d{1,9}$/.test(rev)) return error(400, "rev query parameter required");
	const obj = await env.PUBLISHED.get(`dungeons/${id}/r${rev}/floor-${n}.json`);
	if (!obj) return error(404, "floor not found");
	return new Response(obj.body, {
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": IMMUTABLE },
	});
}

export type { DungeonManifest };
