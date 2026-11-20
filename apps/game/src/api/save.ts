import { ID_PATTERN, type PlayerSave } from "@dungeon/shared";
import { error, json, readJson, sameOrigin } from "../http";
import type { PlayerIdentity } from "../player";

const MAX_SAVE_BYTES = 64 * 1024;
const MAX_FLOORS = 20;
const MAX_CHESTS = 2000;
const MAX_ITEMS = 500;

const isInt = (v: unknown, lo: number, hi: number): v is number =>
	typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const isStrArray = (v: unknown, max: number, maxLen: number): v is string[] =>
	Array.isArray(v) && v.length <= max && v.every((s) => typeof s === "string" && s.length <= maxLen);

const key = (playerId: string, dungeonId: string) => `save:${playerId}:${dungeonId}`;

/** Validate untrusted client data; identity fields are always set server-side. */
export function parseSave(body: unknown, who: PlayerIdentity, dungeonId: string): PlayerSave | string {
	if (typeof body !== "object" || body === null) return "body must be an object";
	const b = body as Record<string, unknown>;
	if (!isInt(b.dungeonRevision, 0, 1_000_000_000)) return "dungeonRevision invalid";
	const p = b.position as Record<string, unknown> | undefined;
	if (!p || !isInt(p.floor, 0, MAX_FLOORS - 1) || !isInt(p.x, 0, 63) || !isInt(p.y, 0, 63) || !isInt(p.dir, 0, 3)) {
		return "position invalid";
	}
	const visited: Record<number, string> = {};
	if (typeof b.visited !== "object" || b.visited === null || Array.isArray(b.visited)) return "visited invalid";
	for (const [k, v] of Object.entries(b.visited)) {
		if (!/^\d{1,2}$/.test(k) || Number(k) >= MAX_FLOORS) return "visited floor key invalid";
		// "WxH:base64"; 64x64 cells = 512 bytes -> 684 base64 chars
		if (typeof v !== "string" || v.length > 720 || !/^\d{1,2}x\d{1,2}:[A-Za-z0-9+/]*={0,2}$/.test(v)) return "visited bitmap invalid";
		visited[Number(k)] = v;
	}
	if (!isStrArray(b.openedChests, MAX_CHESTS, 32)) return "openedChests invalid";
	if (!isStrArray(b.inventory ?? [], MAX_ITEMS, 64)) return "inventory invalid";
	return {
		playerId: who.playerId,
		dungeonId,
		dungeonRevision: b.dungeonRevision,
		position: { floor: p.floor, x: p.x, y: p.y, dir: p.dir as 0 | 1 | 2 | 3 },
		visited,
		openedChests: b.openedChests,
		inventory: (b.inventory ?? []) as string[],
		updatedAt: new Date().toISOString(),
	};
}

export async function getSave(env: Env, who: PlayerIdentity, dungeonId: string): Promise<Response> {
	if (!ID_PATTERN.test(dungeonId)) return error(400, "invalid dungeon id");
	const save = await env.PLAYER_SAVE.get<PlayerSave>(key(who.playerId, dungeonId), "json");
	return json(save, { headers: { "cache-control": "no-store" } }); // null when none yet
}

export async function putSave(env: Env, request: Request, who: PlayerIdentity, dungeonId: string): Promise<Response> {
	if (!ID_PATTERN.test(dungeonId)) return error(400, "invalid dungeon id");
	if (!sameOrigin(request)) return error(403, "cross-origin request rejected");
	const body = await readJson(request, MAX_SAVE_BYTES);
	if (body instanceof Response) return body;
	const save = parseSave(body, who, dungeonId);
	if (typeof save === "string") return error(400, save);
	await env.PLAYER_SAVE.put(key(who.playerId, dungeonId), JSON.stringify(save));
	return json({ ok: true, updatedAt: save.updatedAt }, { headers: { "cache-control": "no-store" } });
}
