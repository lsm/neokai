import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { getConfig } from "./src/config";
import { Database } from "./src/storage/database";
import { SessionManager } from "./src/lib/session-manager";
import { EventBusManager } from "./src/lib/event-bus-manager";
import { AuthManager } from "./src/lib/auth-manager";
import { WebSocketRPCRouter } from "./src/lib/websocket-rpc-router";
import { setupWebSocket } from "./src/routes/websocket";

const config = getConfig();

// Initialize database
const db = new Database(config.dbPath);
await db.initialize();
console.log(`✅ Database initialized at ${config.dbPath}`);

// Initialize event bus manager
const eventBusManager = new EventBusManager();
console.log("✅ Event bus manager initialized");

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

// Initialize session manager
const sessionManager = new SessionManager(db, eventBusManager, authManager, {
  defaultModel: config.defaultModel,
  maxTokens: config.maxTokens,
  temperature: config.temperature,
  workspaceRoot: config.workspaceRoot,
});
console.log("✅ Session manager initialized");
console.log(`   Environment: ${config.nodeEnv}`);
console.log(`   Workspace root: ${config.workspaceRoot}`);

// Initialize WebSocket RPC Router
const rpcRouter = new WebSocketRPCRouter(sessionManager, authManager, config);
const globalRPCManager = eventBusManager.getGlobalRPCManager();
if (globalRPCManager) {
  rpcRouter.setupHandlers(globalRPCManager, "global");
  console.log("✅ WebSocket RPC router initialized");
} else {
  console.error("❌ Failed to get global RPC manager");
  process.exit(1);
}

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
    protocol: "WebSocket-only (RPC over EventBus)",
    endpoints: {
      globalWebSocket: "/ws",
      sessionWebSocket: "/ws/:sessionId",
    },
    note: "All operations use WebSocket events with request/response pattern. REST API has been removed.",
  }));

// Mount WebSocket routes
setupWebSocket(app, eventBusManager, sessionManager);

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
console.log(`\n✨ WebSocket-only mode! All REST endpoints removed.\n`);

// Cleanup on exit
process.on("SIGINT", async () => {
  console.log("\n👋 Shutting down...");
  await eventBusManager.closeAll();
  db.close();
  app.stop();
  process.exit(0);
});
