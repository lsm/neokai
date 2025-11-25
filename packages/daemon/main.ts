import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { getConfig } from "./src/config";
import { Database } from "./src/storage/database";
import { SessionManager } from "./src/lib/session-manager";
import { AuthManager } from "./src/lib/auth-manager";
import { StateManager } from "./src/lib/state-manager";
import { SubscriptionManager } from "./src/lib/subscription-manager";
import { MessageHub, MessageHubRouter, EventBus } from "@liuboer/shared";
import { setupRPCHandlers } from "./src/lib/rpc-handlers";
import { WebSocketServerTransport } from "./src/lib/websocket-server-transport";
import { setupMessageHubWebSocket } from "./src/routes/setup-websocket";

const config = getConfig();

// Initialize database
const db = new Database(config.dbPath);
await db.initialize();
console.log(`✅ Database initialized at ${config.dbPath}`);

// Initialize authentication manager
const authManager = new AuthManager(db, config);
await authManager.initialize();
console.log("✅ Authentication manager initialized");

// Check authentication status - MUST be configured via environment variables
const authStatus = await authManager.getAuthStatus();
if (authStatus.isAuthenticated) {
  console.log(`✅ Authenticated via ${authStatus.method} (source: ${authStatus.source})`);
} else {
  console.error("\n❌ AUTHENTICATION REQUIRED");
  console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.error("Authentication credentials must be provided via environment variables.");
  console.error("\nOption 1: Anthropic API Key (Recommended)");
  console.error("  export ANTHROPIC_API_KEY=sk-ant-...");
  console.error("\nOption 2: Claude Code OAuth Token");
  console.error("  export CLAUDE_CODE_OAUTH_TOKEN=...");
  console.error("\nGet your API key from: https://console.anthropic.com/");
  console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  process.exit(1);
}

// PHASE 3 ARCHITECTURE (FIXED): MessageHub owns Router, Transport is pure I/O
// 1. Initialize MessageHubRouter (routing layer - pure routing, no app logic)
const router = new MessageHubRouter({
  logger: console,
  debug: config.nodeEnv === "development",
  // Higher rate limit for E2E testing (default: 10 ops/sec)
  // E2E tests run 7 parallel workers that all connect and subscribe rapidly
  subscriptionRateLimit: config.nodeEnv === "test" ? 100 : 10,
});
console.log("✅ MessageHubRouter initialized (clean - no application logic)");

// 2. Initialize MessageHub (protocol layer)
const messageHub = new MessageHub({
  defaultSessionId: "global",
  debug: config.nodeEnv === "development",
});

// 3. Register Router with MessageHub (MessageHub owns routing)
messageHub.registerRouter(router);
console.log("✅ Router registered with MessageHub");

// 4. Initialize Transport (I/O layer) - needs router for client management
const transport = new WebSocketServerTransport({
  name: "websocket-server",
  debug: config.nodeEnv === "development",
  router, // For client management only, not routing
});

// 5. Register Transport with MessageHub
messageHub.registerTransport(transport);
console.log("✅ MessageHub initialized with corrected architecture");
console.log("   Flow: MessageHub (protocol) → Router (routing) → ClientConnection (I/O)");

// FIX: Initialize EventBus (breaks circular dependency!)
const eventBus = new EventBus({
  debug: config.nodeEnv === "development",
});
console.log("✅ EventBus initialized (mediator pattern for component coordination)");

// Initialize session manager (with EventBus, no StateManager dependency!)
const sessionManager = new SessionManager(db, messageHub, authManager, eventBus, {
  defaultModel: config.defaultModel,
  maxTokens: config.maxTokens,
  temperature: config.temperature,
  workspaceRoot: config.workspaceRoot,
});
console.log("✅ Session manager initialized (no circular dependency!)");
console.log(`   Environment: ${config.nodeEnv}`);
console.log(`   Workspace root: ${config.workspaceRoot}`);

// Initialize State Manager (listens to EventBus, clean dependency graph!)
const stateManager = new StateManager(
  messageHub,
  sessionManager,
  authManager,
  config,
  eventBus,  // FIX: Listens to events instead of being called directly
);
console.log("✅ State manager initialized (fine-grained channels + per-channel versioning)");

// Setup RPC handlers
setupRPCHandlers({
  messageHub,
  sessionManager,
  authManager,
  config,
});
console.log("✅ RPC handlers registered");

// Initialize Subscription Manager (application layer)
const subscriptionManager = new SubscriptionManager(messageHub);
console.log("✅ Subscription manager initialized (application-level subscription patterns)");

// Create application
const app = new Elysia()
  .use(cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  }))
  .onError(({ error, set }) => {
    console.error("Error:", error);
    set.status = 500;
    return {
      error: "Internal server error",
      message: error instanceof Error ? error.message : String(error),
    };
  })
  .get("/", () => ({
    name: "Liuboer Daemon",
    version: "0.1.0",
    status: "running",
    protocol: "WebSocket-only (MessageHub RPC + Pub/Sub)",
    endpoints: {
      webSocket: "/ws",
    },
    note: "All operations use MessageHub protocol with bidirectional RPC and Pub/Sub. Session routing via message.sessionId field. REST API has been removed.",
  }));

// Mount MessageHub WebSocket routes
setupMessageHubWebSocket(app, transport, sessionManager, subscriptionManager);

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
    // 1. Stop accepting new connections
    console.log("   1/5 Stopping server...");
    app.stop();

    // 2. Wait for pending RPC calls (with 5s timeout)
    console.log("   2/5 Waiting for pending RPC calls...");
    const pendingCallsCount = messageHub["pendingCalls"]?.size || 0;
    if (pendingCallsCount > 0) {
      console.log(`       ${pendingCallsCount} pending calls detected`);
      await Promise.race([
        new Promise(resolve => {
          const checkInterval = setInterval(() => {
            const remaining = messageHub["pendingCalls"]?.size || 0;
            if (remaining === 0) {
              clearInterval(checkInterval);
              resolve(null);
            }
          }, 100);
        }),
        new Promise(resolve => setTimeout(resolve, 5000)),
      ]);
      const remaining = messageHub["pendingCalls"]?.size || 0;
      if (remaining > 0) {
        console.log(`       ⚠️  Timeout: ${remaining} calls still pending`);
      } else {
        console.log(`       ✅ All pending calls completed`);
      }
    }

    // 3. Cleanup MessageHub (rejects remaining calls)
    console.log("   3/5 Cleaning up MessageHub...");
    messageHub.cleanup();

    // 4. Stop all agent sessions
    console.log("   4/5 Stopping agent sessions...");
    await sessionManager.cleanup();

    // 5. Close database
    console.log("   5/5 Closing database...");
    db.close();

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
