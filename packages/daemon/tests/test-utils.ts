/**
 * Test utilities for Bun+Elysia integration tests
 */

import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import "dotenv/config";
import { Database } from "../src/storage/database";
import { SessionManager } from "../src/lib/session-manager";
import { EventBus } from "../src/lib/event-bus";
import { AuthManager } from "../src/lib/auth-manager";
import { createSessionsRouter } from "../src/routes/sessions";
import { createSystemRouter } from "../src/routes/system";
import { createFilesRouter } from "../src/routes/files";
import { createAuthRouter } from "../src/routes/auth";
import { setupWebSocket } from "../src/routes/websocket";
import type { Config } from "../src/config";

export interface TestContext {
  app: Elysia;
  db: Database;
  sessionManager: SessionManager;
  eventBus: EventBus;
  authManager: AuthManager;
  baseUrl: string;
  config: Config;
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

  // Test config
  const config: Config = {
    host: "localhost",
    port: 0, // Will be assigned randomly
    defaultModel: "claude-sonnet-4-5-20250929",
    maxTokens: 8192,
    temperature: 1.0,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
    claudeCodeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    dbPath,
    maxSessions: 10,
    oauthAuthUrl: "https://console.anthropic.com/oauth/authorize",
    oauthTokenUrl: "https://console.anthropic.com/oauth/token",
    oauthClientId: "test-client-id",
    oauthRedirectUri: "http://localhost:3000/oauth/callback",
    oauthScopes: "public limited",
  };

  // Initialize event bus
  const eventBus = new EventBus();

  // Initialize authentication manager
  // Note: Credentials are read from environment variables, not set in database
  const authManager = new AuthManager(db, config);
  await authManager.initialize();

  // Check authentication status
  const authStatus = await authManager.getAuthStatus();
  console.log("[TEST] Auth status:", authStatus.isAuthenticated ? `Authenticated via ${authStatus.method}` : "Not authenticated");
  if (!authStatus.isAuthenticated) {
    console.log("[TEST] WARNING: No authentication configured! Tests requiring API calls will be skipped.");
  }

  // Create session manager
  const sessionManager = new SessionManager(db, eventBus, authManager, {
    defaultModel: config.defaultModel,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
  });

  // Create application
  const app = new Elysia()
    .use(
      cors({
        origin: "*",
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type"],
      }),
    )
    .onError(({ error, set }) => {
      console.error("Test app error:", error);
      set.status = 500;
      return {
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      };
    })
    .get("/", () => ({
      name: "Liuboer Test Daemon",
      version: "0.1.0",
      status: "running",
    }));

  // Mount routers
  createAuthRouter(app, authManager);
  createSessionsRouter(app, sessionManager);
  createSystemRouter(app, sessionManager, config, authManager);
  createFilesRouter(app, sessionManager);
  setupWebSocket(app, eventBus, sessionManager);

  // Start server on random available port (0 = OS assigns free port)
  app.listen({
    hostname: "localhost",
    port: 0,
  });

  // Wait for server to actually be listening
  await Bun.sleep(200);

  // Get the actual port assigned by OS (Elysia exposes via app.server)
  if (!app.server) {
    throw new Error("Server failed to start");
  }
  const port = app.server.port;
  const baseUrl = `http://localhost:${port}`;

  // Verify server is ready by making a test request
  let retries = 5;
  while (retries > 0) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) break;
    } catch (error) {
      retries--;
      if (retries === 0) {
        throw new Error(`Server failed to start at ${baseUrl}: ${error}`);
      }
      await Bun.sleep(100);
    }
  }

  return {
    app,
    db,
    sessionManager,
    eventBus,
    authManager,
    baseUrl,
    config,
    cleanup: async () => {
      authManager.destroy();
      eventBus.clear();
      db.close();
      app.stop();
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
  headers?: Record<string, string>,
): Promise<Response> {
  const url = `${baseUrl}${path}`;
  const options: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
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
  if (response.status !== expectedStatus) {
    const text = await response.text();
    throw new Error(
      `Expected status ${expectedStatus}, got ${response.status}. Body: ${text}`,
    );
  }

  const body = await response.json();
  if (!body) {
    throw new Error("Response body is empty");
  }
  return body as T;
}

/**
 * Assert response is an error
 */
export async function assertErrorResponse(
  response: Response,
  expectedStatus: number,
): Promise<{ error: string; message?: string }> {
  if (response.status !== expectedStatus) {
    const text = await response.text();
    throw new Error(
      `Expected error status ${expectedStatus}, got ${response.status}. Body: ${text}`,
    );
  }

  const body = await response.json();
  if (!body) {
    throw new Error("Error response body is empty");
  }
  if (!body.error) {
    throw new Error("Error response should have 'error' field");
  }
  return body as { error: string; message?: string };
}

/**
 * Create WebSocket connection to test server and return both the WebSocket and a promise for the first message
 */
export function createWebSocketWithFirstMessage(
  baseUrl: string,
  sessionId: string,
  timeout = 5000,
): { ws: WebSocket; firstMessagePromise: Promise<any> } {
  const wsUrl = baseUrl.replace("http://", "ws://");
  const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`);

  // Set up message listener IMMEDIATELY (synchronously)
  const firstMessagePromise = new Promise((resolve, reject) => {
    const messageHandler = (event: MessageEvent) => {
      clearTimeout(timer);
      ws.removeEventListener("message", messageHandler);
      ws.removeEventListener("error", errorHandler);
      try {
        const data = JSON.parse(event.data as string);
        resolve(data);
      } catch (error) {
        reject(new Error("Failed to parse WebSocket message"));
      }
    };

    const errorHandler = (error: Event) => {
      clearTimeout(timer);
      ws.removeEventListener("message", messageHandler);
      ws.removeEventListener("error", errorHandler);
      reject(error);
    };

    ws.addEventListener("message", messageHandler);
    ws.addEventListener("error", errorHandler);

    const timer = setTimeout(() => {
      ws.removeEventListener("message", messageHandler);
      ws.removeEventListener("error", errorHandler);
      reject(new Error(`No WebSocket message received within ${timeout}ms`));
    }, timeout);
  });

  return { ws, firstMessagePromise };
}

/**
 * Create WebSocket connection to test server (legacy, for backward compatibility)
 */
export function createWebSocket(
  baseUrl: string,
  sessionId: string,
): WebSocket {
  const wsUrl = baseUrl.replace("http://", "ws://");
  const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`);

  // Set up error handler immediately to catch early errors
  ws.addEventListener("error", (error) => {
    console.error("WebSocket error in test:", error);
  });

  return ws;
}

/**
 * Wait for WebSocket to be in a specific state
 */
export async function waitForWebSocketState(
  ws: WebSocket,
  state: number,
  timeout = 5000,
): Promise<void> {
  const startTime = Date.now();
  while (ws.readyState !== state) {
    if (Date.now() - startTime > timeout) {
      throw new Error(
        `WebSocket did not reach state ${state} within ${timeout}ms`,
      );
    }
    await Bun.sleep(10);
  }
}

/**
 * Wait for WebSocket message
 * Sets up listener immediately to avoid race conditions
 */
export async function waitForWebSocketMessage(
  ws: WebSocket,
  timeout = 5000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    // Set up handlers first, before any timing checks
    const messageHandler = (event: MessageEvent) => {
      clearTimeout(timer);
      ws.removeEventListener("message", messageHandler);
      ws.removeEventListener("error", errorHandler);
      try {
        const data = JSON.parse(event.data as string);
        resolve(data);
      } catch (error) {
        reject(new Error("Failed to parse WebSocket message"));
      }
    };

    const errorHandler = (error: Event) => {
      clearTimeout(timer);
      ws.removeEventListener("message", messageHandler);
      ws.removeEventListener("error", errorHandler);
      reject(error);
    };

    // Add listeners immediately
    ws.addEventListener("message", messageHandler);
    ws.addEventListener("error", errorHandler);

    // Then set timeout
    const timer = setTimeout(() => {
      ws.removeEventListener("message", messageHandler);
      ws.removeEventListener("error", errorHandler);
      reject(new Error(`No WebSocket message received within ${timeout}ms (readyState: ${ws.readyState})`));
    }, timeout);
  });
}

/**
 * Wait for WebSocket to open and receive the first message
 * This avoids race conditions by setting up the message listener before waiting for OPEN
 */
export async function waitForWebSocketOpenAndMessage(
  ws: WebSocket,
  timeout = 5000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const messageHandler = (event: MessageEvent) => {
      clearTimeout(timer);
      ws.removeEventListener("message", messageHandler);
      ws.removeEventListener("error", errorHandler);
      ws.removeEventListener("open", openHandler);
      try {
        const data = JSON.parse(event.data as string);
        resolve(data);
      } catch (error) {
        reject(new Error("Failed to parse WebSocket message"));
      }
    };

    const errorHandler = (error: Event) => {
      clearTimeout(timer);
      ws.removeEventListener("message", messageHandler);
      ws.removeEventListener("error", errorHandler);
      ws.removeEventListener("open", openHandler);
      reject(error);
    };

    const openHandler = () => {
      console.log(`WebSocket opened on client side, waiting for message...`);
    };

    // Add all listeners immediately when WebSocket is created
    ws.addEventListener("message", messageHandler);
    ws.addEventListener("error", errorHandler);
    ws.addEventListener("open", openHandler);

    const timer = setTimeout(() => {
      ws.removeEventListener("message", messageHandler);
      ws.removeEventListener("error", errorHandler);
      ws.removeEventListener("open", openHandler);
      reject(new Error(`No WebSocket message received within ${timeout}ms (readyState: ${ws.readyState}, elapsed: ${Date.now() - startTime}ms)`));
    }, timeout);
  });
}

/**
 * Assertions
 */
export function assertEquals<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(
      message ||
        `Assertion failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function assertExists<T>(value: T, message?: string): asserts value {
  if (value === null || value === undefined) {
    throw new Error(message || "Assertion failed: value does not exist");
  }
}

export function assertNotEquals<T>(actual: T, expected: T, message?: string) {
  if (actual === expected) {
    throw new Error(
      message ||
        `Assertion failed: expected not to equal ${JSON.stringify(expected)}`,
    );
  }
}

export function assertTrue(value: boolean, message?: string) {
  if (!value) {
    throw new Error(message || "Assertion failed: expected true");
  }
}

export function assertFalse(value: boolean, message?: string) {
  if (value) {
    throw new Error(message || "Assertion failed: expected false");
  }
}

export function assertGreaterThan(actual: number, expected: number, message?: string) {
  if (actual <= expected) {
    throw new Error(
      message || `Assertion failed: ${actual} is not greater than ${expected}`,
    );
  }
}

export function assertContains<T>(array: T[], item: T, message?: string) {
  if (!array.includes(item)) {
    throw new Error(
      message ||
        `Assertion failed: array does not contain ${JSON.stringify(item)}`,
    );
  }
}

/**
 * Credential check utilities
 *
 * These functions check for the presence of authentication credentials in the test environment.
 * Tests that make actual API calls to Claude (sending messages, etc.) should use test.skipIf()
 * to skip when credentials are not available.
 *
 * Example usage:
 *   test.skipIf(!hasAnyCredentials())("test name", async () => { ... });
 */

/**
 * Check if API key is available in test environment
 */
export function hasApiKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Check if OAuth token is available in test environment
 */
export function hasOAuthToken(): boolean {
  return !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

/**
 * Check if any authentication credentials are available
 */
export function hasAnyCredentials(): boolean {
  return hasApiKey() || hasOAuthToken();
}

/**
 * Skip test if no API key is available
 */
export function requiresApiKey(test: any) {
  if (!hasApiKey()) {
    test.skip();
  }
}

/**
 * Skip test if no OAuth token is available
 */
export function requiresOAuthToken(test: any) {
  if (!hasOAuthToken()) {
    test.skip();
  }
}

/**
 * Skip test if no credentials are available
 */
export function requiresCredentials(test: any) {
  if (!hasAnyCredentials()) {
    test.skip();
  }
}
