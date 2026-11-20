export function json(data: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("content-type", "application/json; charset=utf-8");
	headers.set("cache-control", "no-store");
	return new Response(JSON.stringify(data), { ...init, headers });
}

export const error = (status: number, message: string, extra: Record<string, unknown> = {}) =>
	json({ error: message, ...extra }, { status });

export async function readJson(request: Request, maxBytes: number): Promise<unknown | Response> {
	const type = request.headers.get("content-type") ?? "";
	if (!type.toLowerCase().startsWith("application/json")) return error(415, "content-type must be application/json");
	if (Number(request.headers.get("content-length") ?? "0") > maxBytes) return error(413, "payload too large");
	const text = await request.text();
	if (text.length > maxBytes) return error(413, "payload too large");
	try {
		return JSON.parse(text);
	} catch {
		return error(400, "invalid JSON");
	}
}

/** State-changing requests must come from this origin (or a non-browser client). */
export function sameOrigin(request: Request): boolean {
	const origin = request.headers.get("origin");
	return !origin || origin === new URL(request.url).origin;
}
