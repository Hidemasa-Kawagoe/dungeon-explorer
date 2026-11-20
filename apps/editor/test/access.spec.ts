import { describe, expect, it } from "vitest";
import { authenticate, verifyAccessJwt, type Jwk } from "../src/access";

const TEAM = "team.example.cloudflareaccess.com";
const AUD = "aud-123";
const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array | string) => {
	const bytes = typeof b === "string" ? enc.encode(b) : new Uint8Array(b);
	let s = "";
	for (const x of bytes) s += String.fromCharCode(x);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function makeKey(kid: string) {
	const pair = (await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true, ["sign", "verify"],
	)) as CryptoKeyPair;
	const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256" } as Jwk;
	return { priv: pair.privateKey, jwk, kid };
}

async function sign(k: { priv: CryptoKey; kid: string }, claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
	const h = b64url(JSON.stringify({ alg: "RS256", kid: k.kid, typ: "JWT", ...header }));
	const p = b64url(JSON.stringify(claims));
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", k.priv, enc.encode(`${h}.${p}`));
	return `${h}.${p}.${b64url(sig)}`;
}

const NOW = 1_800_000_000;
const good = { iss: `https://${TEAM}`, aud: [AUD], exp: NOW + 300, email: "me@example.com" };

describe("verifyAccessJwt", () => {
	it("accepts a valid token and returns the identity", async () => {
		const k = await makeKey("k1");
		const id = await verifyAccessJwt(await sign(k, good), { teamDomain: TEAM, aud: AUD }, async () => [k.jwk], NOW);
		expect(id).toEqual({ id: "me@example.com" });
	});
	it("uses common_name for service tokens", async () => {
		const k = await makeKey("k1");
		const { email: _e, ...rest } = good;
		const t = await sign(k, { ...rest, common_name: "svc.access" });
		expect((await verifyAccessJwt(t, { teamDomain: TEAM, aud: AUD }, async () => [k.jwk], NOW)).id).toBe("svc.access");
	});
	it.each([
		["wrong audience", { ...good, aud: ["other"] }],
		["wrong issuer", { ...good, iss: "https://evil.example.com" }],
		["expired", { ...good, exp: NOW - 1 }],
		["no exp", { ...good, exp: undefined }],
		["not yet valid", { ...good, nbf: NOW + 3600 }],
		["no identity", { iss: good.iss, aud: good.aud, exp: good.exp }],
	])("rejects %s", async (_n, claims) => {
		const k = await makeKey("k1");
		await expect(verifyAccessJwt(await sign(k, claims as any), { teamDomain: TEAM, aud: AUD }, async () => [k.jwk], NOW)).rejects.toThrow();
	});
	it("rejects a token signed by a different key with the same kid", async () => {
		const real = await makeKey("k1"), attacker = await makeKey("k1");
		await expect(verifyAccessJwt(await sign(attacker, good), { teamDomain: TEAM, aud: AUD }, async () => [real.jwk], NOW)).rejects.toThrow(/signature/);
	});
	it("rejects alg none / HS256 and malformed tokens", async () => {
		const k = await makeKey("k1");
		const cfg = { teamDomain: TEAM, aud: AUD };
		const unsigned = `${b64url(JSON.stringify({ alg: "none", kid: "k1" }))}.${b64url(JSON.stringify(good))}.`;
		await expect(verifyAccessJwt(unsigned, cfg, async () => [k.jwk], NOW)).rejects.toThrow();
		await expect(verifyAccessJwt(await sign(k, good, { alg: "HS256" }), cfg, async () => [k.jwk], NOW)).rejects.toThrow(/algorithm/);
		await expect(verifyAccessJwt("a.b", cfg, async () => [k.jwk], NOW)).rejects.toThrow();
		await expect(verifyAccessJwt("a.b.c", cfg, async () => [k.jwk], NOW)).rejects.toThrow();
	});
	it("refetches keys once when the kid is unknown (rotation), then fails", async () => {
		const k = await makeKey("new");
		const calls: boolean[] = [];
		const t = await sign(k, good);
		const id = await verifyAccessJwt(t, { teamDomain: TEAM, aud: AUD }, async (force) => (calls.push(force), force ? [k.jwk] : []), NOW);
		expect(id.id).toBe("me@example.com");
		expect(calls).toEqual([false, true]);
		await expect(verifyAccessJwt(t, { teamDomain: TEAM, aud: AUD }, async () => [], NOW)).rejects.toThrow(/unknown signing key/);
	});
});

describe("authenticate", () => {
	const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
	it("fails closed when Access is not configured", async () => {
		const r = new Request("https://editor.example.com/api/me", { headers: { "cf-access-jwt-assertion": "x.y.z" } });
		expect(await authenticate(r, { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" })).toBeNull();
	});
	it("rejects a request without the header", async () => {
		expect(await authenticate(new Request("https://editor.example.com/"), env, async () => [])).toBeNull();
	});
	it("honours DEV_BYPASS_EMAIL only on localhost", async () => {
		const withBypass = { ...env, DEV_BYPASS_EMAIL: "dev@example.com" };
		expect(await authenticate(new Request("http://localhost:8788/"), withBypass)).toEqual({ id: "dev@example.com" });
		expect(await authenticate(new Request("https://editor.example.com/"), withBypass, async () => [])).toBeNull();
	});
	it("accepts a verified token via the header", async () => {
		const k = await makeKey("k1");
		const t = await sign(k, { ...good, exp: Math.floor(Date.now() / 1000) + 300 });
		const r = new Request("https://editor.example.com/", { headers: { "cf-access-jwt-assertion": t } });
		expect(await authenticate(r, env, async () => [k.jwk])).toEqual({ id: "me@example.com" });
	});
});
