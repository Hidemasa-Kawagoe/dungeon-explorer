const COOKIE = "pid";
const ONE_YEAR = 60 * 60 * 24 * 365;
const PLAYER_ID = /^[0-9a-f-]{36}$/;

export interface PlayerIdentity {
	playerId: string;
	/** Set-Cookie value to attach to the response when the id was newly issued. */
	setCookie?: string;
}

/** Anonymous player id from a cookie; issues a new one if absent or malformed. */
export function identify(request: Request): PlayerIdentity {
	const cookies = request.headers.get("cookie") ?? "";
	for (const part of cookies.split(";")) {
		const [k, ...v] = part.trim().split("=");
		if (k === COOKIE) {
			const val = v.join("=");
			if (PLAYER_ID.test(val)) return { playerId: val };
		}
	}
	const playerId = crypto.randomUUID();
	return {
		playerId,
		setCookie: `${COOKIE}=${playerId}; Path=/; Max-Age=${ONE_YEAR}; HttpOnly; Secure; SameSite=Lax`,
	};
}

export function withIdentity(res: Response, who: PlayerIdentity): Response {
	if (!who.setCookie) return res;
	const out = new Response(res.body, res);
	out.headers.append("set-cookie", who.setCookie);
	return out;
}
