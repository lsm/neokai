import { Application } from "@oak/oak";
import { Database } from "../src/storage/database.ts";
import { SessionManager } from "../src/lib/session-manager.ts";
import { createSessionsRouter } from "../src/routes/sessions.ts";
import { createSystemRouter } from "../src/routes/system.ts";
import { assertEquals, assertExists } from "@std/assert";

export interface TestContext {
  app: Application;
  db: Database;
  sessionManager: SessionManager;
  baseUrl: string;
  cleanup: () => Promise<void>;
}

/**
 * Create a test application instance with in-memory database
 */
export async function createTestApp(): Promise<TestContext> {
  // Use in-memory database for tests
  const dbPath = `:memory:`;
  const db = new Database(dbPath);
  await db.initialize();

  // Create session manager
  const sessionManager = new SessionManager(db, {
    defaultModel: "claude-sonnet-4-20250514",
    maxTokens: 8192,
    temperature: 1.0,
  });

  // Create application
  const app = new Application();

  // Error handling
  app.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      console.error("Test app error:", err);
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

  // Routes
  const sessionsRouter = createSessionsRouter(sessionManager);
  const systemRouter = createSystemRouter(sessionManager, {
    host: "localhost",
    port: 8080,
    defaultModel: "claude-sonnet-4-20250514",
    maxTokens: 8192,
    temperature: 1.0,
    anthropicApiKey: "test-key",
    dbPath,
    maxSessions: 10,
  });

  app.use(sessionsRouter.routes());
  app.use(sessionsRouter.allowedMethods());
  app.use(systemRouter.routes());
  app.use(systemRouter.allowedMethods());

  // Start server on random port
  const port = 9000 + Math.floor(Math.random() * 1000);
  const controller = new AbortController();
  const { signal } = controller;

  app.listen({ hostname: "localhost", port, signal });

  // Wait a bit for server to start
  await new Promise((resolve) => setTimeout(resolve, 100));

  const baseUrl = `http://localhost:${port}`;

  return {
    app,
    db,
    sessionManager,
    baseUrl,
    cleanup: async () => {
      controller.abort();
      db.close();
    },
  };
}

/**
 * Make HTTP request to test server
 */
export async function request(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = `${baseUrl}${path}`;
  const options: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  return await fetch(url, options);
}

/**
 * Assert response is successful and return JSON body
 */
export async function assertSuccessResponse<T>(
  response: Response,
  expectedStatus = 200,
): Promise<T> {
  assertEquals(
    response.status,
    expectedStatus,
    `Expected status ${expectedStatus}, got ${response.status}`,
  );

  const body = await response.json();
  assertExists(body);
  return body as T;
}

/**
 * Assert response is an error
 */
export async function assertErrorResponse(
  response: Response,
  expectedStatus: number,
): Promise<{ error: string; message?: string }> {
  assertEquals(
    response.status,
    expectedStatus,
    `Expected error status ${expectedStatus}, got ${response.status}`,
  );

  const body = await response.json();
  assertExists(body);
  assertExists(body.error, "Error response should have 'error' field");
  return body as { error: string; message?: string };
}
