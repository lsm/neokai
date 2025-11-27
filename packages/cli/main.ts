#!/usr/bin/env bun
import { getConfig } from "@liuboer/daemon/config";

const isDev = process.env.NODE_ENV !== "production";
const config = getConfig();

console.log(`\n🚀 Liuboer ${isDev ? "Development" : "Production"} Server`);
console.log(`   Mode: ${config.nodeEnv}`);
console.log(`   Model: ${config.defaultModel}\n`);

if (isDev) {
  // Development mode: Vite dev server + Daemon
  const { startDevServer } = await import("./src/dev-server");
  await startDevServer(config);
} else {
  // Production mode: Static files + Daemon
  const { startProdServer } = await import("./src/prod-server");
  await startProdServer(config);
}
