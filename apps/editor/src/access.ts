/**
 * Cloudflare Access JWT verification (defence in depth behind the Access application).
 * https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */

export interface AccessConfig {
	/** e.g. "myteam.cloudflareaccess.com" */
	teamDomain: string;
	/** AUD tag of the Access application */
	aud: string;
}

export interface Jwk {
	kid: string;
	kty: string;
	n?: string;
	e?: string;
	alg?: string;
	[k: string]: unknown;
}

export class AccessError extends Error {}

const enc = new TextEncoder();

function b64urlToBytes(s: string): Uint8Array {
	const pad = "=".repeat((4 - (s.length % 4)) % 4);
	const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodeJson(part: string): Record<string, unknown> {
	try {
		const v = JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));
		if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
	} catch {
		/* fallthrough */
	}
	throw new AccessError("malformed token");
}

export interface Identity {
	/** email for users; common_name/sub for service tokens */
	id: string;
}

/**
 * Verify an Access JWT. `getKeys(force)` returns the team's JWKS; `force` asks the caller to
 * bypass its cache (used once when the token's `kid` is unknown, i.e. keys rotated).
 */
export async function verifyAccessJwt(
	token: string,
	cfg: AccessConfig,
	getKeys: (force: boolean) => Promise<Jwk[]>,
	nowSec = Math.floor(Date.now() / 1000),
): Promise<Identity> {
	const parts = token.split(".");
	if (parts.length !== 3) throw new AccessError("malformed token");
	const [h, p, s] = parts as [string, string, string];
	const header = decodeJson(h);
	if (header.alg !== "RS256" || typeof header.kid !== "string") throw new AccessError("unsupported algorithm");

	let key = (await getKeys(false)).find((k) => k.kid === header.kid);
	if (!key) key = (await getKeys(true)).find((k) => k.kid === header.kid);
	if (!key) throw new AccessError("unknown signing key");

	let cryptoKey: CryptoKey;
	try {
		cryptoKey = await crypto.subtle.importKey("jwk", key as JsonWebKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
	} catch {
		throw new AccessError("bad signing key");
	}
	const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, b64urlToBytes(s), enc.encode(`${h}.${p}`));
	if (!ok) throw new AccessError("bad signature");

	const c = decodeJson(p);
	if (c.iss !== `https://${cfg.teamDomain}`) throw new AccessError("bad issuer");
	const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
	if (!aud.includes(cfg.aud)) throw new AccessError("bad audience");
	if (typeof c.exp !== "number" || c.exp <= nowSec) throw new AccessError("token expired");
	if (typeof c.nbf === "number" && c.nbf > nowSec + 60) throw new AccessError("token not yet valid");

	const id = [c.email, c.common_name, c.sub].find((v): v is string => typeof v === "string" && v.length > 0);
	if (!id) throw new AccessError("token has no identity");
	return { id };
}

let keyCache: { team: string; keys: Jwk[]; at: number } | null = null;
const KEY_TTL_MS = 10 * 60 * 1000;

/** JWKS fetch with a small per-isolate cache. */
export async function fetchTeamKeys(teamDomain: string, force: boolean): Promise<Jwk[]> {
	if (!force && keyCache && keyCache.team === teamDomain && Date.now() - keyCache.at < KEY_TTL_MS) return keyCache.keys;
	const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
	if (!res.ok) throw new AccessError(`cannot load Access keys (${res.status})`);
	const body = (await res.json()) as { keys?: Jwk[] };
	keyCache = { team: teamDomain, keys: body.keys ?? [], at: Date.now() };
	return keyCache.keys;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Resolve the caller. Returns an identity, or null (-> respond 403).
 * `DEV_BYPASS_EMAIL` is honoured only for requests whose host is localhost, so a stray
 * variable in production can't open the editor to the internet.
 */
export async function authenticate(
	request: Request,
	env: { ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string; DEV_BYPASS_EMAIL?: string },
	getKeys: (team: string, force: boolean) => Promise<Jwk[]> = fetchTeamKeys,
): Promise<Identity | null> {
	const url = new URL(request.url);
	if (env.DEV_BYPASS_EMAIL && LOCAL_HOSTS.has(url.hostname)) return { id: env.DEV_BYPASS_EMAIL };

	const team = env.ACCESS_TEAM_DOMAIN, aud = env.ACCESS_AUD;
	if (!team || !aud) return null; // not configured: fail closed
	const token = request.headers.get("cf-access-jwt-assertion");
	if (!token) return null;
	try {
		return await verifyAccessJwt(token, { teamDomain: team, aud }, (force) => getKeys(team, force));
	} catch (e) {
		if (!(e instanceof AccessError)) console.error("access verification error", e);
		return null;
	}
}
