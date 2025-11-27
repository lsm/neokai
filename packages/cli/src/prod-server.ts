import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { createDaemonApp } from "@liuboer/daemon/app";
import type { Config } from "@liuboer/daemon/config";
import { resolve } from "path";

export async function startProdServer(config: Config) {
  console.log("🚀 Starting production server...");

  // Create daemon app in embedded mode (no root route)
  const daemonContext = await createDaemonApp({
    config,
    verbose: true,
    standalone: false  // Skip root info route in embedded mode
  });
  const { app: daemonApp } = daemonContext;

  // Get path to web dist folder
  const distPath = resolve(import.meta.dir, "../../web/dist");
  console.log(`📦 Serving static files from: ${distPath}`);

  // Create main Elysia app
  const app = new Elysia()
    // Mount daemon routes first (includes WebSocket at /ws)
    .use(daemonApp)
    // Serve static files from web/dist for everything else
    .use(
      await staticPlugin({
        assets: distPath,
        prefix: "/",
        alwaysStatic: true,
        noCache: false,
      })
    )
    // SPA fallback - serve index.html for unmatched routes
    .get("*", async () => {
      const indexFile = Bun.file(resolve(distPath, "index.html"));
      if (await indexFile.exists()) {
        return new Response(indexFile, {
          headers: { "Content-Type": "text/html" },
        });
      }
      return new Response("Not Found", { status: 404 });
    })
    .onStop(async () => {
      console.log("🛑 Stopping daemon...");
      await daemonContext.cleanup();
    });

  const port = 9283;
  app.listen({ hostname: "0.0.0.0", port });

  console.log(`\n✨ Production server running!`);
  console.log(`   🌐 UI: http://localhost:${port}`);
  console.log(`   🔌 WebSocket: ws://localhost:${port}/ws`);
  console.log(`\n📝 Press Ctrl+C to stop\n`);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n👋 Received ${signal}, shutting down gracefully...`);
    try {
      app.stop();
      process.exit(0);
    } catch (error) {
      console.error("❌ Error during shutdown:", error);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
