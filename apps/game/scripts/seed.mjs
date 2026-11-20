// Local dev: `npm run seed -w @dungeon/game` writes a sample dungeon into wrangler's local R2/KV state.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const here = dirname(new URL(import.meta.url).pathname);
const tmp = mkdtempSync(join(tmpdir(), "dungeon-seed-"));
try {
	const out = join(tmp, "seed.mjs");
	await build({ entryPoints: [join(here, "seed.ts")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "error" });
	const { files, indexJson } = await import(pathToFileURL(out).href);
	const wrangler = (args) => execFileSync("npx", ["wrangler", ...args], { cwd: join(here, ".."), stdio: "inherit" });
	for (const [key, text] of Object.entries(files)) {
		const f = join(tmp, "obj", key);
		mkdirSync(dirname(f), { recursive: true });
		writeFileSync(f, text);
		wrangler(["r2", "object", "put", `dungeon-published/${key}`, "--local", "--file", f, "--content-type", "application/json"]);
	}
	wrangler(["kv", "key", "put", "dungeon:index", indexJson, "--binding", "DUNGEON_META", "--local"]);
	console.log("seeded sample dungeon");
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
