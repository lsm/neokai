/// <reference types="vitest" />
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { resolve } from "path";

export default defineConfig({
  plugins: [preact()],

  test: {
    environment: "happy-dom",
    include: ["src/**/*.{test,spec}.{js,ts,tsx}"],
    exclude: ["node_modules", "dist"],
    globals: true,
    setupFiles: [],
  },

  resolve: {
    alias: [
      // Handle subpath imports (e.g., @liuboer/shared/sdk/type-guards)
      {
        find: /^@liuboer\/shared\/(.+)$/,
        replacement: resolve(__dirname, "../shared/src/$1"),
      },
      // Handle main package import
      {
        find: "@liuboer/shared",
        replacement: resolve(__dirname, "../shared/src/mod.ts"),
      },
    ],
  },
});
