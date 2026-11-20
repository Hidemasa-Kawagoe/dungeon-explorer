import type { DraftIndexEntry, Dungeon } from "@dungeon/shared";

export class ApiError extends Error {
	constructor(public status: number, message: string, public errors: string[] = [], public revision?: number) {
		super(message);
	}
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(path, init);
	const text = await res.text();
	let body: any = null;
	try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
	if (!res.ok) throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`, body?.errors ?? [], body?.revision);
	return body as T;
}

const jsonInit = (method: string, body?: unknown, headers: Record<string, string> = {}): RequestInit => ({
	method,
	headers: { "content-type": "application/json", ...headers },
	body: body === undefined ? undefined : JSON.stringify(body),
});

export const me = () => call<{ email: string }>("/api/me");
export const list = () => call<DraftIndexEntry[]>("/api/dungeons");
export const load = (id: string) => call<{ dungeon: Dungeon; publishedRevision: number | null }>(`/api/dungeons/${id}`);
export const create = (o: { name: string; width: number; height: number; floors: number; generate: boolean }) =>
	call<{ id: string; revision: number }>("/api/dungeons", jsonInit("POST", o));
export const save = (d: Dungeon, revision: number) =>
	call<{ revision: number }>(`/api/dungeons/${d.id}`, jsonInit("PUT", d, { "if-match": String(revision) }));
export const publish = (id: string) => call<{ publishedRevision: number }>(`/api/dungeons/${id}/publish`, jsonInit("POST"));
export const unpublish = (id: string) => call<{ ok: true }>(`/api/dungeons/${id}/unpublish`, jsonInit("POST"));
export const remove = (id: string) => call<{ ok: true }>(`/api/dungeons/${id}`, jsonInit("DELETE"));
