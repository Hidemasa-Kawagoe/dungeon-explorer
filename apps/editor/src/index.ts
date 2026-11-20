import { authenticate } from "./access";
import { handleApi } from "./api";
import { error } from "./http";

export { DungeonEditorLock } from "./do/DungeonEditorLock";

export default {
	async fetch(request, env): Promise<Response> {
		// Every request (API and static assets) must carry a valid Access identity.
		const who = await authenticate(request, env as Env & { DEV_BYPASS_EMAIL?: string });
		if (!who) return error(403, "forbidden");

		const url = new URL(request.url);
		if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
			try {
				return await handleApi(request, env, url, who.id);
			} catch (e) {
				console.error("api error", e);
				return error(500, "internal error");
			}
		}
		const res = await env.ASSETS.fetch(request);
		// Authenticated, user-specific app shell: keep it out of shared caches.
		const out = new Response(res.body, res);
		out.headers.set("cache-control", "private, no-cache");
		return out;
	},
} satisfies ExportedHandler<Env>;
