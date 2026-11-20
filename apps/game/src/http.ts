export function json(data: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("content-type", "application/json; charset=utf-8");
	return new Response(JSON.stringify(data), { ...init, headers });
}

export function error(status: number, message: string): Response {
	return json({ error: message }, { status });
}

/** Parse a JSON body with a hard size cap. Returns a Response on failure. */
export async function readJson(request: Request, maxBytes: number): Promise<unknown | Response> {
	const type = request.headers.get("content-type") ?? "";
	if (!type.toLowerCase().startsWith("application/json")) return error(415, "content-type must be application/json");
	const len = Number(request.headers.get("content-length") ?? "0");
	if (len > maxBytes) return error(413, "payload too large");
	const text = await request.text();
	if (text.length > maxBytes) return error(413, "payload too large");
	try {
		return JSON.parse(text);
	} catch {
		return error(400, "invalid JSON");
	}
}

/** For state-changing requests: reject cross-origin browsers (CSRF defence in depth). */
export function sameOrigin(request: Request): boolean {
	const origin = request.headers.get("origin");
	if (!origin) return true; // non-browser clients
	return origin === new URL(request.url).origin;
}
