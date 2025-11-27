import { createDaemonApp } from "./src/app";
import { getConfig } from "./src/config";

const config = getConfig();

// Create daemon app in standalone mode
const { app, cleanup } = await createDaemonApp({
  config,
  verbose: true,
  standalone: true  // Show root info route in standalone mode
});

// Start server
console.log(`\n🚀 Liuboer Daemon starting...`);
console.log(`   Host: ${config.host}`);
console.log(`   Port: ${config.port}`);
console.log(`   Model: ${config.defaultModel}`);

app.listen({
  hostname: config.host,
  port: config.port,
});

console.log(`\n📡 WebSocket: ws://${app.server?.hostname}:${app.server?.port}/ws`);
console.log(`\n✨ MessageHub mode! Unified RPC + Pub/Sub over WebSocket.`);
console.log(`   Session routing via message.sessionId field.\n`);

// Graceful shutdown handler
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`\n👋 Received ${signal}, shutting down gracefully...`);

  try {
    await cleanup();
    console.log("\n✅ Graceful shutdown complete\n");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Error during shutdown:", error);
    process.exit(1);
  }
}

// Register shutdown handlers
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
