import type { Server } from "bun";
import type { Config } from "./config";
import type { WebSocketData } from "./types/websocket";
import { Database } from "./storage/database";
import { SessionManager } from "./lib/session-manager";
import { AuthManager } from "./lib/auth-manager";
import { SettingsManager } from "./lib/settings-manager";
import { StateManager } from "./lib/state-manager";
import { SubscriptionManager } from "./lib/subscription-manager";
import { MessageHub, MessageHubRouter } from "@liuboer/shared";
import { createDaemonHub } from "./lib/daemon-hub";
import { setupRPCHandlers } from "./lib/rpc-handlers";
import { WebSocketServerTransport } from "./lib/websocket-server-transport";
import { createWebSocketHandlers } from "./routes/setup-websocket";

export interface CreateDaemonAppOptions {
  config: Config;
  /**
   * Whether to log initialization steps to console.
   * Default: true
   */
  verbose?: boolean;
  /**
   * Whether this is running in standalone mode.
   * In standalone mode, adds a GET / route with daemon info.
   * In embedded mode (default), skips the root route.
   * Default: false
   */
  standalone?: boolean;
}

export interface DaemonAppContext {
  server: Server<WebSocketData>;
  db: Database;
  messageHub: MessageHub;
  sessionManager: SessionManager;
  authManager: AuthManager;
  settingsManager: SettingsManager;
  stateManager: StateManager;
  subscriptionManager: SubscriptionManager;
  transport: WebSocketServerTransport;
  /**
   * Cleanup function for graceful shutdown.
   * Closes all connections, stops sessions, and closes database.
   */
  cleanup: () => Promise<void>;
}

/**
 * Creates and initializes the Liuboer daemon application.
 *
 * This factory function sets up:
 * - Database connection
 * - Authentication manager
 * - MessageHub with WebSocket transport
 * - Session manager for Claude Agent SDK
 * - State synchronization channels
 * - RPC handlers
 *
 * @param options Configuration and options
 * @returns Initialized Bun server and context for management
 */
export async function createDaemonApp(
  options: CreateDaemonAppOptions,
): Promise<DaemonAppContext> {
  const { config, verbose = true, standalone = false } = options;
  const log = verbose ? console.log : () => {};
  const logError = verbose ? console.error : () => {};

  // Initialize database
  const db = new Database(config.dbPath);
  await db.initialize();
  log(`✅ Database initialized at ${config.dbPath}`);

  // Initialize authentication manager
  const authManager = new AuthManager(db, config);
  await authManager.initialize();
  log("✅ Authentication manager initialized");

  // Initialize settings manager
  const settingsManager = new SettingsManager(db, config.workspaceRoot);
  log("✅ Settings manager initialized");

  // Check authentication status - MUST be configured via environment variables
  const authStatus = await authManager.getAuthStatus();
  if (authStatus.isAuthenticated) {
    log(
      `✅ Authenticated via ${authStatus.method} (source: ${authStatus.source})`,
    );
  } else {
    logError("\n❌ AUTHENTICATION REQUIRED");
    logError("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    logError(
      "Authentication credentials must be provided via environment variables.",
    );
    logError("\nOption 1: GLM API Key (Recommended for E2E tests)");
    logError("  export GLM_API_KEY=...");
    logError("\nOption 2: Anthropic API Key");
    logError("  export ANTHROPIC_API_KEY=sk-ant-...");
    logError("\nOption 3: Claude Code OAuth Token");
    logError("  export CLAUDE_CODE_OAUTH_TOKEN=...");
    logError("\nGet your API key from: https://console.anthropic.com/");
    logError("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    throw new Error("Authentication required");
  }

  // Initialize dynamic models on app startup (global cache fallback)
  log("Loading dynamic models from Claude SDK...");
  const { initializeModels } = await import("./lib/model-service");
  await initializeModels();
  log("✅ Model service initialized");

  // PHASE 3 ARCHITECTURE (FIXED): MessageHub owns Router, Transport is pure I/O
  // 1. Initialize MessageHubRouter (routing layer - pure routing, no app logic)
  const router = new MessageHubRouter({
    logger: console,
    debug: config.nodeEnv === "development",
    // Rate limit: Allow burst of subscriptions on connection
    // Development/Production: 50 ops/sec (18 subscriptions on connect + overhead)
    // E2E tests: 100 ops/sec (7 parallel workers connecting simultaneously)
    subscriptionRateLimit: config.nodeEnv === "test" ? 100 : 50,
  });
  log("✅ MessageHubRouter initialized (clean - no application logic)");

  // 2. Initialize MessageHub (protocol layer)
  const messageHub = new MessageHub({
    defaultSessionId: "global",
    debug: config.nodeEnv === "development",
  });

  // 3. Register Router with MessageHub (MessageHub owns routing)
  messageHub.registerRouter(router);
  log("✅ Router registered with MessageHub");

  // 4. Initialize Transport (I/O layer) - needs router for client management
  const transport = new WebSocketServerTransport({
    name: "websocket-server",
    debug: config.nodeEnv === "development",
    router, // For client management only, not routing
  });

  // 5. Register Transport with MessageHub
  messageHub.registerTransport(transport);
  log("✅ MessageHub initialized with corrected architecture");
  log(
    "   Flow: MessageHub (protocol) → Router (routing) → ClientConnection (I/O)",
  );

  // Initialize DaemonHub (TypedHub-based event coordination)
  const eventBus = createDaemonHub("daemon");
  await eventBus.initialize();
  log("✅ DaemonHub initialized (async event coordination)");

  // Initialize session manager (with EventBus, SettingsManager, no StateManager dependency!)
  const sessionManager = new SessionManager(
    db,
    messageHub,
    authManager,
    settingsManager,
    eventBus,
    {
      defaultModel: config.defaultModel,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      workspaceRoot: config.workspaceRoot,
    },
  );
  log("✅ Session manager initialized (no circular dependency!)");
  log(`   Environment: ${config.nodeEnv}`);
  log(`   Workspace root: ${config.workspaceRoot}`);

  // Initialize State Manager (listens to EventBus, clean dependency graph!)
  const stateManager = new StateManager(
    messageHub,
    sessionManager,
    authManager,
    settingsManager,
    config,
    eventBus, // FIX: Listens to events instead of being called directly
  );
  log(
    "✅ State manager initialized (fine-grained channels + per-channel versioning)",
  );

  // Setup RPC handlers
  setupRPCHandlers({
    messageHub,
    sessionManager,
    authManager,
    settingsManager,
    config,
    daemonHub: eventBus,
    db,
  });
  log("✅ RPC handlers registered");

  // Initialize Subscription Manager (application layer)
  const subscriptionManager = new SubscriptionManager(messageHub);
  log(
    "✅ Subscription manager initialized (application-level subscription patterns)",
  );

  // Create WebSocket handlers
  const wsHandlers = createWebSocketHandlers(
    transport,
    sessionManager,
    subscriptionManager,
  );

  // Create Bun server with native WebSocket support
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

      // WebSocket upgrade at /ws
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req, {
          data: {
            // Initial connection session is 'global'
            connectionSessionId: "global",
          },
        });

        if (upgraded) {
          return; // WebSocket upgrade successful
        }

        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      // Root info route (only in standalone mode)
      if (standalone && url.pathname === "/") {
        return Response.json(
          {
            name: "Liuboer Daemon",
            version: "0.1.0",
            status: "running",
            protocol: "WebSocket-only (MessageHub RPC + Pub/Sub)",
            endpoints: {
              webSocket: "/ws",
            },
            note: "All operations use MessageHub protocol with bidirectional RPC and Pub/Sub. Session routing via message.sessionId field. REST API has been removed.",
          },
          {
            headers: { "Access-Control-Allow-Origin": "*" },
          },
        );
      }

      // 404 for unknown routes
      return new Response("Not found", {
        status: 404,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    },

    websocket: wsHandlers,

    error(error) {
      logError("Server error:", error);
      return new Response(
        JSON.stringify({
          error: "Internal server error",
          message: error instanceof Error ? error.message : String(error),
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    },
  });

  log(`✅ Bun server listening on ${config.host}:${config.port}`);

  // Cleanup function for graceful shutdown
  let isCleanedUp = false;
  const cleanup = async () => {
    if (isCleanedUp) {
      log("⚠️  Cleanup already in progress or completed, skipping");
      return;
    }
    isCleanedUp = true;

    try {
      log("   1/5 Stopping server...");
      try {
        server.stop();
      } catch {
        log("       (server already stopped)");
      }

      // Wait for pending RPC calls (with 3s timeout)
      log("   2/5 Waiting for pending RPC calls...");
      const pendingCallsCount = messageHub.getPendingCallCount();
      if (pendingCallsCount > 0) {
        log(`       ${pendingCallsCount} pending calls detected`);
        let checkInterval: ReturnType<typeof setInterval> | null = null;
        await Promise.race([
          new Promise((resolve) => {
            checkInterval = setInterval(() => {
              const remaining = messageHub.getPendingCallCount();
              if (remaining === 0) {
                clearInterval(checkInterval!);
                checkInterval = null;
                resolve(null);
              }
            }, 100);
          }),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
        // CRITICAL: Clear interval if timeout fired first (prevents hang on exit)
        if (checkInterval) {
          clearInterval(checkInterval);
        }
        const remaining = messageHub.getPendingCallCount();
        if (remaining > 0) {
          log(`       ⚠️  Timeout: ${remaining} calls still pending`);
        } else {
          log(`       ✅ All pending calls completed`);
        }
      }

      // Cleanup MessageHub (rejects remaining calls)
      log("   3/5 Cleaning up MessageHub...");
      messageHub.cleanup();

      // Stop all agent sessions
      log("   4/5 Stopping agent sessions...");
      await sessionManager.cleanup();

      // Close database
      log("   5/5 Closing database...");
      db.close();

      log("✅ Graceful shutdown complete");
    } catch (error) {
      log("❌ Error during cleanup:", error);
      throw error;
    }
  };

  return {
    server,
    db,
    messageHub,
    sessionManager,
    authManager,
    settingsManager,
    stateManager,
    subscriptionManager,
    transport,
    cleanup,
  };
}
