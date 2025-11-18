import { defineConfig } from "vite";
import { fresh } from "@fresh/plugin-vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [fresh(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 9283,
    allowedHosts: ["tts"],
  },
});
