import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Runs the upstream package's tests with this workspace's vitest (the
// package's own vitest.config.ts needs upstream dev dependencies).
export default defineConfig({
  root: fileURLToPath(new URL("./typescript/packages/mechanisms/obyte", import.meta.url)),
  test: { include: ["test/**/*.test.ts"] },
});
