import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
    server: {
      fs: { allow: [repositoryRoot] },
    },
  },
});
