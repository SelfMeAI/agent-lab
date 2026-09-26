import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  esbuild: { jsx: "automatic" },
  test: {
    include: ["apps/desktop/src/**/*.test.ts", "packages/**/*.test.ts"],
  },
});
