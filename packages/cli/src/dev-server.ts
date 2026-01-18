import { createDaemonApp } from "@liuboer/daemon/app";
import type { Config } from "@liuboer/daemon/config";
import { createServer as createViteServer } from "vite";
import { resolve } from "path";
import * as net from "net";
import { createLogger, generateUUID } from "@liuboer/shared";
import { UnixSocketTransport } from "@liuboer/shared/message-hub/unix-socket-transport";
import type { ClientConnection, HubMessage } from "@liuboer/shared";
import type { HubMessageWithMetadata } from "@liuboer/shared/message-hub/protocol";

const log = createLogger("liuboer:cli:dev-server");

/**
 * Find an available port by creating a temporary server
 */
async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to get port")));
      }
    });
    server.on("error", reject);
  });
}

export async function startDevServer(config: Config) {
  log.info("🔧 Starting unified development server...");

  // Create daemon app in embedded mode (no root route)
  const daemonContext = await createDaemonApp({
    config,
    verbose: true,
    standalone: false, // Skip root info route in embedded mode
  });

  // Stop the daemon's internal server (we'll create a unified one)
  daemonContext.server.stop();

  // Initialize IPC socket if configured (for yuanshen orchestrator)
  let ipcTransport: UnixSocketTransport | undefined;
  let ipcClientId: string | undefined;
  if (config.ipcSocketPath) {
    log.info(`🔌 Starting IPC socket server at ${config.ipcSocketPath}...`);
    ipcTransport = new UnixSocketTransport({
      name: "ipc-server",
      socketPath: config.ipcSocketPath,
      mode: "server",
      debug: true,
    });
    await ipcTransport.initialize();

    // Generate a unique client ID for the IPC connection
    ipcClientId = generateUUID();

    // Register IPC as a ClientConnection with the router
    // This allows the yuanshen orchestrator to receive events
    const router = daemonContext.messageHub.getRouter();
    if (router) {
      const ipcConnection: ClientConnection = {
        id: ipcClientId,
        send: (data: string) => {
          try {
            const message = JSON.parse(data) as HubMessage;
            ipcTransport!.send(message);
          } catch (error) {
            log.error("[IPC] Failed to send message:", error);
          }
        },
        isOpen: () => ipcTransport?.isReady() ?? false,
        canAccept: () => true,
        metadata: { type: "ipc", role: "yuanshen-orchestrator" },
      };
      router.registerConnection(ipcConnection);
      log.info(`[IPC] Registered as client: ${ipcClientId}`);
    }

    // Handle messages from yuanshen orchestrator
    // Forward ALL messages through the transport's message handler path
    ipcTransport.onMessage((message) => {
      log.info(`[IPC] Received: ${message.type} ${message.method}`);

      // Add clientId to message for proper routing/response handling
      (message as HubMessageWithMetadata).clientId = ipcClientId;

      // Forward to the transport's handler which notifies MessageHub
      // This enables full RPC support (CALL/RESULT/EVENT/SUBSCRIBE)
      daemonContext.transport.handleClientMessage(message, ipcClientId);
    });

    log.info(`✅ IPC socket server ready at ${config.ipcSocketPath}`);
  }

  // Find an available port for Vite dev server
  log.info("📦 Starting Vite dev server...");
  const vitePort = await findAvailablePort();
  log.info(`   Found available Vite port: ${vitePort}`);
  const vite = await createViteServer({
    configFile: resolve(import.meta.dir, "../../web/vite.config.ts"),
    root: resolve(import.meta.dir, "../../web/src"),
    server: {
      port: vitePort,
      strictPort: false, // Allow Vite to find another port if needed
      hmr: {
        protocol: "ws",
        host: "localhost",
        port: vitePort,
      },
    },
  });
  await vite.listen();
  log.info(`✅ Vite dev server running on port ${vitePort}`);

  // Get WebSocket handlers from daemon
  const { createWebSocketHandlers } =
    await import("@liuboer/daemon/routes/setup-websocket");
  const wsHandlers = createWebSocketHandlers(
    daemonContext.transport,
    daemonContext.sessionManager,
    daemonContext.subscriptionManager,
  );

  // Create unified Bun server that combines daemon + Vite proxy
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,

    async fetch(req, server) {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods":
              "GET, POST, PUT, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }

      // WebSocket upgrade at /ws (daemon WebSocket)
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req, {
          data: {
            connectionSessionId: "global",
          },
        });

        if (upgraded) {
          return; // WebSocket upgrade successful
        }

        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      // Proxy all other requests to Vite dev server
      try {
        const viteUrl = `http://localhost:${vitePort}${url.pathname}${url.search}`;

        // Build fetch options, including body for non-GET requests
        const fetchOptions: RequestInit = {
          method: req.method,
          headers: {
            ...Object.fromEntries(req.headers.entries()),
            // Override host to match Vite's expected host
            host: `localhost:${vitePort}`,
          },
        };

        // Forward request body for methods that may have one
        if (req.method !== "GET" && req.method !== "HEAD") {
          fetchOptions.body = req.body;
          // Bun supports streaming body via duplex
          (fetchOptions as Record<string, unknown>).duplex = "half";
        }

        const viteResponse = await fetch(viteUrl, fetchOptions);

        // Create response with Vite's response
        return new Response(viteResponse.body, {
          status: viteResponse.status,
          headers: viteResponse.headers,
        });
      } catch (error) {
        log.error("Vite proxy error:", error);
        return new Response("Failed to proxy to Vite", { status: 502 });
      }
    },

    websocket: wsHandlers,

    error(error) {
      log.error("Server error:", error);
      return new Response(
        JSON.stringify({
          error: "Internal server error",
          message: error instanceof Error ? error.message : String(error),
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    },
  });

  log.info(`\n✨ Unified development server running!`);
  log.info(`   🌐 Frontend: http://localhost:${config.port}`);
  log.info(`   🔌 WebSocket: ws://localhost:${config.port}/ws`);
  log.info(`   🔥 HMR enabled (Vite on port ${vitePort}, proxied)`);
  log.info(`\n📝 Press Ctrl+C to stop\n`);

  // Graceful shutdown - second Ctrl+C exits immediately
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      // Second Ctrl+C - force exit immediately
      log.warn("Forcing exit...");
      process.exit(1);
    }
    isShuttingDown = true;

    log.info(
      `\n👋 Received ${signal}, shutting down gracefully... (Press Ctrl+C again to force exit)`,
    );

    try {
      log.info("🛑 Stopping unified server...");
      server.stop();

      log.info("🛑 Stopping Vite dev server...");
      // Add timeout for Vite close - it can hang on active HMR connections
      await Promise.race([
        vite.close(),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            log.warn("⚠️  Vite close timed out after 3s, continuing...");
            resolve();
          }, 3000);
        }),
      ]);

      if (ipcTransport) {
        log.info("🛑 Closing IPC socket...");
        await ipcTransport.close();
      }

      log.info("🛑 Cleaning up daemon...");
      // Call cleanup but it will try to stop daemon's server (already stopped above)
      // Daemon cleanup handles: pending RPC calls, MessageHub, sessions, database
      // Add timeout for daemon cleanup as well
      await Promise.race([
        daemonContext.cleanup(),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            log.warn("⚠️  Daemon cleanup timed out after 5s, continuing...");
            resolve();
          }, 5000);
        }),
      ]);

      log.info("✨ Shutdown complete");
      process.exit(0);
    } catch (error) {
      log.error("❌ Error during shutdown:", error);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
