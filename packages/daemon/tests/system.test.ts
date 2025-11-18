import { assertEquals, assertExists } from "@std/assert";
import type { DaemonConfig, HealthStatus } from "@liuboer/shared";
import { assertSuccessResponse, createTestApp, request } from "./test-utils.ts";

Deno.test("System API - Health endpoint", async () => {
  const ctx = await createTestApp();

  try {
    const response = await request(ctx.baseUrl, "GET", "/api/health");
    const health = await assertSuccessResponse<HealthStatus>(response);

    assertEquals(health.status, "ok");
    assertExists(health.version);
    assertExists(health.uptime);
    assertEquals(typeof health.uptime, "number");
    assertExists(health.sessions);
    assertEquals(health.sessions.active, 0);
    assertEquals(health.sessions.total, 0);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("System API - Config endpoint", async () => {
  const ctx = await createTestApp();

  try {
    const response = await request(ctx.baseUrl, "GET", "/api/config");
    const config = await assertSuccessResponse<DaemonConfig>(response);

    assertEquals(config.defaultModel, "claude-sonnet-4-20250514");
    assertEquals(config.maxSessions, 10);
    assertExists(config.version);
    assertExists(config.claudeSDKVersion);
    assertExists(config.storageLocation);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("System API - CORS headers", async () => {
  const ctx = await createTestApp();

  try {
    const response = await request(ctx.baseUrl, "OPTIONS", "/api/health");

    assertEquals(response.status, 204);
    assertEquals(
      response.headers.get("Access-Control-Allow-Origin"),
      "*",
    );
    assertEquals(
      response.headers.get("Access-Control-Allow-Methods"),
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    assertEquals(
      response.headers.get("Access-Control-Allow-Headers"),
      "Content-Type",
    );
  } finally {
    await ctx.cleanup();
  }
});
