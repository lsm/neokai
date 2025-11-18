import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { getConfig } from "./src/config";
import { Database } from "./src/storage/database";
import { SessionManager } from "./src/lib/session-manager";
import { EventBus } from "./src/lib/event-bus";
import { AuthManager } from "./src/lib/auth-manager";
import { createSessionsRouter } from "./src/routes/sessions";
import { createSystemRouter } from "./src/routes/system";
import { createFilesRouter } from "./src/routes/files";
import { createAuthRouter } from "./src/routes/auth";
import { setupWebSocket } from "./src/routes/websocket";

const config = getConfig();

// Note: API key is now optional - can use OAuth instead
// Authentication can be configured via the web UI

// Initialize database
const db = new Database(config.dbPath);
await db.initialize();
console.log(`✅ Database initialized at ${config.dbPath}`);

// Initialize event bus
const eventBus = new EventBus();
console.log("✅ Event bus initialized");

// Initialize authentication manager
const authManager = new AuthManager(db, config);
await authManager.initialize();
console.log("✅ Authentication manager initialized");

// Check authentication status
const authStatus = await authManager.getAuthStatus();
if (authStatus.isAuthenticated) {
  console.log(`✅ Authenticated via ${authStatus.method} (source: ${authStatus.source})`);
} else {
  console.log("⚠️  No authentication configured. Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in .env");
}

// Initialize session manager
const sessionManager = new SessionManager(db, eventBus, authManager, {
  defaultModel: config.defaultModel,
  maxTokens: config.maxTokens,
  temperature: config.temperature,
});
console.log("✅ Session manager initialized");

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
    endpoints: {
      health: "/api/health",
      config: "/api/config",
      sessions: "/api/sessions",
      files: "/api/sessions/:sessionId/files",
      websocket: "/ws/:sessionId",
    },
  }));

// Mount routers
createAuthRouter(app, authManager);
createSessionsRouter(app, sessionManager);
createSystemRouter(app, sessionManager, config, authManager);
createFilesRouter(app, sessionManager);
setupWebSocket(app, eventBus, sessionManager);

// Start server
console.log(`\n🚀 Liuboer Daemon starting...`);
console.log(`   Host: ${config.host}`);
console.log(`   Port: ${config.port}`);
console.log(`   Model: ${config.defaultModel}`);

app.listen({
  hostname: config.host,
  port: config.port,
});

console.log(`\n📡 HTTP Server: http://${app.server?.hostname}:${app.server?.port}`);
console.log(`📡 WebSocket: ws://${app.server?.hostname}:${app.server?.port}/ws/:sessionId`);
console.log(`\n✨ Ready to accept connections!\n`);

// Cleanup on exit
process.on("SIGINT", () => {
  console.log("\n👋 Shutting down...");
  authManager.destroy();
  eventBus.clear();
  db.close();
  app.stop();
  process.exit(0);
});
