import {
	ID_PATTERN, LIMITS, createDungeon, validateDungeon, validateDungeonShape,
	type DraftIndexEntry, type Dungeon,
} from "@dungeon/shared";
import type { DungeonEditorLock, Result } from "./do/DungeonEditorLock";
import { error, json, readJson, sameOrigin } from "./http";
import { floorKey, loadDungeon, manifestKey, readDraftIndex, readJsonObject } from "./store";

const MAX_BODY = 1_500_000;

const lock = (env: Env, id: string) =>
	env.EDITOR_LOCK.get(env.EDITOR_LOCK.idFromName(id)) as unknown as DurableObjectStub<DungeonEditorLock>;

function fromResult(r: Result<any>, okBody: (r: any) => unknown = () => ({ ok: true })): Response {
	if (r.ok) return json(okBody(r));
	return error(r.status, r.error, { ...(r.errors ? { errors: r.errors } : {}), ...(r.revision !== undefined ? { revision: r.revision } : {}) });
}

const intIn = (v: unknown, lo: number, hi: number, dflt: number): number | null =>
	v === undefined ? dflt : typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null;

export async function handleApi(request: Request, env: Env, url: URL, email: string): Promise<Response> {
	const parts = url.pathname.split("/").filter(Boolean).slice(1);
	const [resource, id, sub, n] = parts;
	const method = request.method;
	const isWrite = method !== "GET" && method !== "HEAD";
	if (isWrite && !sameOrigin(request)) return error(403, "cross-origin request rejected");

	if (resource === "me" && parts.length === 1 && method === "GET") return json({ email });
	if (resource !== "dungeons") return error(404, "not found");

	// collection
	if (!id) {
		if (method === "GET") return json(await readDraftIndex(env.DRAFT));
		if (method === "POST") return createDraft(request, env, email);
		return error(405, "method not allowed");
	}
	if (!ID_PATTERN.test(id)) return error(400, "invalid dungeon id");

	// item
	if (!sub) {
		if (method === "GET") {
			const d = await loadDungeon(env.DRAFT, id);
			if (!d) return error(404, "dungeon not found");
			const entry = (await readDraftIndex(env.DRAFT)).find((e) => e.id === id) as DraftIndexEntry | undefined;
			return json({ dungeon: d, publishedRevision: entry?.publishedRevision ?? null });
		}
		if (method === "PUT") return saveDraft(request, env, email, id);
		if (method === "DELETE") return fromResult(await lock(env, id).remove(id));
		return error(405, "method not allowed");
	}
	if (sub === "manifest" && method === "GET") {
		const m = await env.DRAFT.get(manifestKey(id));
		return m ? new Response(m.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } }) : error(404, "dungeon not found");
	}
	if (sub === "floors" && n && method === "GET" && /^\d{1,2}$/.test(n)) {
		const m = await readJsonObject<{ revision: number }>(env.DRAFT, manifestKey(id));
		const f = m && (await env.DRAFT.get(floorKey(id, m.revision, Number(n))));
		return f ? new Response(f.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } }) : error(404, "floor not found");
	}
	if (sub === "publish" && method === "POST") return fromResult(await lock(env, id).publish(email, id), (r) => ({ ok: true, publishedRevision: r.revision }));
	if (sub === "unpublish" && method === "POST") return fromResult(await lock(env, id).unpublish(id));
	return error(404, "not found");
}

async function createDraft(request: Request, env: Env, email: string): Promise<Response> {
	const body = await readJson(request, 10_000);
	if (body instanceof Response) return body;
	const b = (body ?? {}) as Record<string, unknown>;
	const name = typeof b.name === "string" ? b.name.trim() : "";
	if (!name || name.length > 100) return error(400, "name must be 1-100 characters");
	const width = intIn(b.width, LIMITS.minSize, LIMITS.maxSize, 10);
	const height = intIn(b.height, LIMITS.minSize, LIMITS.maxSize, 10);
	const floors = intIn(b.floors, 1, LIMITS.maxFloors, 1);
	const seed = intIn(b.seed, 0, 2 ** 31, Math.floor(Math.random() * 2 ** 31));
	if (width === null || height === null || floors === null || seed === null) return error(400, "invalid size, floors or seed");

	const id = "d" + [...crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, "0")).join("");
	const d = createDungeon({ id, name, width, height, floors, generate: b.generate === true, seed });
	const errors = validateDungeon(d);
	if (errors.length) return error(500, "generated dungeon is invalid", { errors });
	const r = await lock(env, id).create(email, d);
	return fromResult(r, (x) => ({ id, revision: x.revision }));
}

async function saveDraft(request: Request, env: Env, email: string, id: string): Promise<Response> {
	const ifMatch = /^"?(\d{1,9})"?$/.exec(request.headers.get("if-match") ?? "");
	if (!ifMatch) return error(428, "If-Match: <revision> header required");
	const body = await readJson(request, MAX_BODY);
	if (body instanceof Response) return body;

	const shape = validateDungeonShape(body);
	if (shape.length) return error(400, "invalid dungeon", { errors: shape });
	const d = body as Dungeon;
	if (d.id !== id) return error(400, "dungeon id does not match URL");
	const name = d.name.trim();
	if (!name || name.length > 100) return error(400, "name must be 1-100 characters");
	d.name = name;
	// Server-side validation: never trust the client's own checks. Chests/links/edges must already be consistent.
	const errors = validateDungeon(d);
	if (errors.length) return error(422, "dungeon failed validation", { errors });
	return fromResult(await lock(env, id).save(email, d, Number(ifMatch[1])), (r) => ({ ok: true, revision: r.revision }));
}

