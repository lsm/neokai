import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { getConfig } from "./src/config";
import { Database } from "./src/storage/database";
import { SessionManager } from "./src/lib/session-manager";
import { AuthManager } from "./src/lib/auth-manager";
import { StateManager } from "./src/lib/state-manager";
import { MessageHub } from "@liuboer/shared";
import { MessageHubRPCRouter } from "./src/lib/messagehub-rpc-router";
import { ElysiaWebSocketTransport } from "./src/lib/elysia-websocket-transport";
import { setupMessageHubWebSocket } from "./src/routes/messagehub-websocket";

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

// Initialize MessageHub with ElysiaWebSocketTransport
const messageHub = new MessageHub({
  defaultSessionId: "global",
  debug: config.nodeEnv === "development",
});

const transport = new ElysiaWebSocketTransport({
  name: "elysia-ws",
  debug: config.nodeEnv === "development",
});

// Register transport with MessageHub
messageHub.registerTransport(transport);
console.log("✅ MessageHub initialized with Elysia WebSocket transport");

// Initialize session manager (after MessageHub)
const sessionManager = new SessionManager(db, messageHub, authManager, {
  defaultModel: config.defaultModel,
  maxTokens: config.maxTokens,
  temperature: config.temperature,
  workspaceRoot: config.workspaceRoot,
});
console.log("✅ Session manager initialized");
console.log(`   Environment: ${config.nodeEnv}`);
console.log(`   Workspace root: ${config.workspaceRoot}`);

// Initialize State Manager (before RPC router)
const stateManager = new StateManager(
  messageHub,
  sessionManager,
  authManager,
  config,
);
// Wire up state manager to session manager
sessionManager.setStateManager(stateManager);
console.log("✅ State manager initialized (fine-grained channels)");

// Initialize MessageHub RPC Router
const messageHubRPCRouter = new MessageHubRPCRouter(
  messageHub,
  sessionManager,
  authManager,
  config,
);
messageHubRPCRouter.setupHandlers();
console.log("✅ MessageHub RPC router initialized");

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
      globalWebSocket: "/ws",
      sessionWebSocket: "/ws/:sessionId",
    },
    note: "All operations use MessageHub protocol with bidirectional RPC and Pub/Sub. REST API has been removed.",
  }));

// Mount MessageHub WebSocket routes
setupMessageHubWebSocket(app, messageHub, transport, sessionManager);

// Start server
console.log(`\n🚀 Liuboer Daemon starting...`);
console.log(`   Host: ${config.host}`);
console.log(`   Port: ${config.port}`);
console.log(`   Model: ${config.defaultModel}`);

app.listen({
  hostname: config.host,
  port: config.port,
});

console.log(`\n📡 Global WebSocket: ws://${app.server?.hostname}:${app.server?.port}/ws`);
console.log(`📡 Session WebSocket: ws://${app.server?.hostname}:${app.server?.port}/ws/:sessionId`);
console.log(`\n✨ MessageHub mode! Unified RPC + Pub/Sub over WebSocket.\n`);

// Cleanup on exit
process.on("SIGINT", async () => {
  console.log("\n👋 Shutting down...");
  db.close();
  app.stop();
  process.exit(0);
});
