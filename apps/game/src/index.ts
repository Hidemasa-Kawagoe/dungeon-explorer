import { getFloor, getManifest, listDungeons } from "./api/dungeons";
import { getSave, putSave } from "./api/save";
import { error } from "./http";
import { identify, withIdentity } from "./player";

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
	const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
	const [resource, id, sub, n] = parts;
	const method = request.method;

	if (resource === "dungeons") {
		if (method !== "GET" && method !== "HEAD") return error(405, "method not allowed");
		if (!id) return listDungeons(env);
		if (!sub) return getManifest(env, id);
		if (sub === "floors" && n && parts.length === 4) return getFloor(env, id, n, url.searchParams.get("rev"));
	}

	if (resource === "save" && id && parts.length === 2) {
		const who = identify(request);
		if (method === "GET") return withIdentity(await getSave(env, who, id), who);
		if (method === "PUT") return withIdentity(await putSave(env, request, who, id), who);
		return error(405, "method not allowed");
	}

	return error(404, "not found");
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
			try {
				return await handleApi(request, env, url);
			} catch (e) {
				console.error("api error", e);
				return error(500, "internal error");
			}
		}
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
