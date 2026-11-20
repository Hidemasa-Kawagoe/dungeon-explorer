import { defineConfig } from "vitest/config";

// Pure logic only: runs in plain Node, no Workers runtime needed.
export default defineConfig({
	test: { environment: "node", include: ["test/**/*.spec.ts"] },
});
