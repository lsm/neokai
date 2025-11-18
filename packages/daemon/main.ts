import { Application, Router } from "@oak/oak";
import { getConfig } from "./src/config.ts";
import { Database } from "./src/storage/database.ts";
import { SessionManager } from "./src/lib/session-manager.ts";
import { EventBus } from "./src/lib/event-bus.ts";
import { AuthManager } from "./src/lib/auth-manager.ts";
import { createSessionsRouter } from "./src/routes/sessions.ts";
import { createSystemRouter } from "./src/routes/system.ts";
import { createFilesRouter } from "./src/routes/files.ts";
import { createAuthRouter } from "./src/routes/auth.ts";
import { setupWebSocket } from "./src/routes/websocket.ts";

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

// Check for API key in config and auto-set if present
if (config.anthropicApiKey) {
  const authStatus = await authManager.getAuthStatus();
  if (!authStatus.isAuthenticated) {
    await authManager.setApiKey(config.anthropicApiKey);
    console.log("✅ API key from environment configured");
  }
}

// Initialize session manager
const sessionManager = new SessionManager(db, eventBus, authManager, {
  defaultModel: config.defaultModel,
  maxTokens: config.maxTokens,
  temperature: config.temperature,
});
console.log("✅ Session manager initialized");

// Create application
const app = new Application();

// Error handling
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error("Error:", err);
    ctx.response.status = 500;
    ctx.response.body = {
      error: "Internal server error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
});

// CORS middleware
app.use(async (ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");
  ctx.response.headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  ctx.response.headers.set("Access-Control-Allow-Headers", "Content-Type");

  if (ctx.request.method === "OPTIONS") {
    ctx.response.status = 204;
    return;
  }

  await next();
});

// Logging middleware
app.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(
    `${ctx.request.method} ${ctx.request.url} - ${ctx.response.status} (${ms}ms)`,
  );
});

// Routes
const sessionsRouter = createSessionsRouter(sessionManager);
const systemRouter = createSystemRouter(sessionManager, config, authManager);
const filesRouter = createFilesRouter(sessionManager);
const authRouter = createAuthRouter(authManager);

app.use(authRouter.routes());
app.use(authRouter.allowedMethods());
app.use(sessionsRouter.routes());
app.use(sessionsRouter.allowedMethods());
app.use(systemRouter.routes());
app.use(systemRouter.allowedMethods());
app.use(filesRouter.routes());
app.use(filesRouter.allowedMethods());

// WebSocket route
const wsRouter = new Router();
wsRouter.get("/ws/:sessionId", setupWebSocket(eventBus, sessionManager));
app.use(wsRouter.routes());
app.use(wsRouter.allowedMethods());

// Root endpoint
const rootRouter = new Router();
rootRouter.get("/", (ctx) => {
  ctx.response.body = {
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
  };
});
app.use(rootRouter.routes());

// Start server
console.log(`\n🚀 Liuboer Daemon starting...`);
console.log(`   Host: ${config.host}`);
console.log(`   Port: ${config.port}`);
console.log(`   Model: ${config.defaultModel}`);
console.log(`\n📡 HTTP Server: http://${config.host}:${config.port}`);
console.log(`📡 WebSocket: ws://${config.host}:${config.port}/ws/:sessionId`);
console.log(`\n✨ Ready to accept connections!\n`);

await app.listen({ hostname: config.host, port: config.port });

// Cleanup on exit
Deno.addSignalListener("SIGINT", () => {
  console.log("\n👋 Shutting down...");
  authManager.destroy();
  eventBus.clear();
  db.close();
  Deno.exit(0);
});
