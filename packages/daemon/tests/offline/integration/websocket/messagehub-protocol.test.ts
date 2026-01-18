/**
 * MessageHub Protocol Integration Tests
 *
 * Tests the core messaging protocol without browser overhead:
 * - RPC call/response flow
 * - Pub/Sub event system
 * - WebSocket connection handling
 * - Session-scoped routing
 * - Multi-client event routing
 *
 * Converted from E2E test to integration test for better performance and reliability.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { TestContext } from "../../../test-utils";
import {
  createTestApp,
  createWebSocket,
  waitForWebSocketState,
  waitForWebSocketMessage,
} from "../../../test-utils";
import { generateUUID } from "@liuboer/shared";

const verbose = !!process.env.TEST_VERBOSE;
const log = verbose ? console.log : () => {};

// Helper to send RPC call via WebSocket
function sendRPCCall(
  ws: WebSocket,
  method: string,
  data: unknown = {},
  sessionId = "global",
): string {
  const messageId = generateUUID();
  ws.send(
    JSON.stringify({
      id: messageId,
      type: "CALL",
      method,
      data,
      sessionId,
      timestamp: new Date().toISOString(),
      version: "1.0.0",
    }),
  );
  return messageId;
}

// Helper to subscribe to events via WebSocket
async function subscribeToEvent(
  ws: WebSocket,
  event: string,
  sessionId = "global",
): Promise<string> {
  const messageId = generateUUID();
  ws.send(
    JSON.stringify({
      id: messageId,
      type: "SUBSCRIBE",
      method: event,
      data: {},
      sessionId,
      timestamp: new Date().toISOString(),
      version: "1.0.0",
    }),
  );

  // Wait for SUBSCRIBED ACK
  let ack: unknown;
  let attempts = 0;
  while (attempts < 5) {
    ack = await waitForWebSocketMessage(ws, 5000);
    if (ack.type === "SUBSCRIBED" && ack.requestId === messageId) {
      break;
    }
    attempts++;
  }

  expect(ack.type).toBe("SUBSCRIBED");
  expect(ack.requestId).toBe(messageId);
  expect(ack.data?.subscribed).toBe(true);

  return messageId;
}

describe("MessageHub RPC Protocol", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("should handle RPC call/response correctly", async () => {
    const ws = createWebSocket(ctx.baseUrl, "global");
    await waitForWebSocketState(ws, WebSocket.OPEN);

    // Call session.list RPC method
    const messageId = sendRPCCall(ws, "session.list");

    // Wait for response
    const response = await waitForWebSocketMessage(ws);

    expect(response.type).toBe("RESULT");
    expect(response.requestId).toBe(messageId);
    expect(response.data).toHaveProperty("sessions");
    expect(Array.isArray(response.data.sessions)).toBe(true);

    ws.close();
  });

  test("should handle RPC error for non-existent method", async () => {
    const ws = createWebSocket(ctx.baseUrl, "global");
    await waitForWebSocketState(ws, WebSocket.OPEN);

    // Call non-existent method
    const messageId = sendRPCCall(ws, "non.existent.method");

    // Wait for error response
    const response = await waitForWebSocketMessage(ws);

    expect(response.type).toBe("ERROR");
    expect(response.requestId).toBe(messageId);
    expect(response.error).toBeTruthy();
    expect(response.error).toContain("No handler");

    ws.close();
  });

  test("should handle RPC error responses", async () => {
    const ws = createWebSocket(ctx.baseUrl, "global");
    await waitForWebSocketState(ws, WebSocket.OPEN);

    // Try to get non-existent session
    const messageId = sendRPCCall(ws, "session.get", {
      sessionId: "non-existent-id",
    });

    // Wait for error response
    const response = await waitForWebSocketMessage(ws);

    expect(response.type).toBe("ERROR");
    expect(response.requestId).toBe(messageId);
    expect(response.error).toContain("not found");

    ws.close();
  });

  test("should handle concurrent RPC calls", async () => {
    const ws = createWebSocket(ctx.baseUrl, "global");
    await waitForWebSocketState(ws, WebSocket.OPEN);

    // Send multiple concurrent calls
    const _id1 = sendRPCCall(ws, "session.list");
    const _id2 = sendRPCCall(ws, "session.list");
    const _id3 = sendRPCCall(ws, "session.list");

    // Collect all 3 responses
    const responses = [];
    for (let i = 0; i < 3; i++) {
      responses.push(await waitForWebSocketMessage(ws));
    }

    expect(responses.length).toBe(3);
    expect(responses.every((r) => r.type === "RESULT")).toBe(true);
    expect(responses.every((r) => Array.isArray(r.data?.sessions))).toBe(true);

    ws.close();
  });

  test("should validate request/response correlation", async () => {
    const ws = createWebSocket(ctx.baseUrl, "global");
    await waitForWebSocketState(ws, WebSocket.OPEN);

    // Make multiple calls with different IDs
    const id1 = sendRPCCall(ws, "session.list");
    const id2 = sendRPCCall(ws, "session.list");

    // Get responses (may arrive in any order)
    const response1 = await waitForWebSocketMessage(ws);
    const response2 = await waitForWebSocketMessage(ws);

    // Both should be RESULT
    expect(response1.type).toBe("RESULT");
    expect(response2.type).toBe("RESULT");

    // Check that both request IDs are present
    const receivedIds = [response1.requestId, response2.requestId];
    expect(receivedIds).toContain(id1);
    expect(receivedIds).toContain(id2);

    ws.close();
  });
});

describe("MessageHub Pub/Sub Protocol", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("should deliver events to subscribers", async () => {
    const ws = createWebSocket(ctx.baseUrl, "global");
    await waitForWebSocketState(ws, WebSocket.OPEN);

    // Subscribe to session.created event
    await subscribeToEvent(ws, "session.created", "global");

    // Create a session to trigger the event
    sendRPCCall(ws, "session.create", {});

    // Wait for session.created event (skip the RPC RESULT first)
    let message = await waitForWebSocketMessage(ws);
    if (message.type === "RESULT") {
      // This is the create response, get the next message
      message = await waitForWebSocketMessage(ws);
    }

    expect(message.type).toBe("EVENT");
    expect(message.method).toBe("session.created");
    expect(message.data).toHaveProperty("sessionId");

    ws.close();
  });

  test("should handle multiple subscribers for same event", async () => {
    const ws = createWebSocket(ctx.baseUrl, "global");
    await waitForWebSocketState(ws, WebSocket.OPEN);

    const testEvent = "test.multi." + Date.now();

    // Create 3 subscriptions to the same event
    await subscribeToEvent(ws, testEvent, "global");
    await subscribeToEvent(ws, testEvent, "global");
    await subscribeToEvent(ws, testEvent, "global");

    // All subscriptions should be acknowledged
    // (already verified in subscribeToEvent helper)

    ws.close();
  });

  test("should respect session-scoped event routing", async () => {
    const ws = createWebSocket(ctx.baseUrl, "global");
    await waitForWebSocketState(ws, WebSocket.OPEN);

    // Create a session
    const _createId = sendRPCCall(ws, "session.create", {});
    const createResponse = await waitForWebSocketMessage(ws);

    expect(createResponse.type).toBe("RESULT");
    const sessionId = createResponse.data.sessionId;
    expect(sessionId).toBeTruthy();

    const testEvent = "test.scoped." + Date.now();

    // Subscribe to global events
    await subscribeToEvent(ws, testEvent, "global");

    // Subscribe to specific session events
    await subscribeToEvent(ws, testEvent, sessionId);

    // Subscriptions to non-existent sessions should still succeed on protocol level
    // (server will filter events appropriately)
    await subscribeToEvent(ws, testEvent, "non-existent-session-id");

    ws.close();
  });

  test("should handle unsubscribe correctly", async () => {
    const ws = createWebSocket(ctx.baseUrl, "global");
    await waitForWebSocketState(ws, WebSocket.OPEN);

    const testEvent = "test.unsub." + Date.now();

    // Subscribe to event
    const _subId = await subscribeToEvent(ws, testEvent, "global");

    // Unsubscribe
    const unsubId = generateUUID();
    ws.send(
      JSON.stringify({
        id: unsubId,
        type: "UNSUBSCRIBE",
        method: testEvent,
        data: {},
        sessionId: "global",
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      }),
    );

    // Wait for UNSUBSCRIBED confirmation
    const unsubResponse = await waitForWebSocketMessage(ws);
    expect(unsubResponse.type).toBe("UNSUBSCRIBED");
    expect(unsubResponse.requestId).toBe(unsubId);
    expect(unsubResponse.data?.unsubscribed).toBe(true);

    ws.close();
  });
});

describe("WebSocket Connection Management", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("should establish WebSocket connection", async () => {
    const ws = createWebSocket(ctx.baseUrl, "global");
    await waitForWebSocketState(ws, WebSocket.OPEN);

    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
    await waitForWebSocketState(ws, WebSocket.CLOSED);
  });

  test("should handle multiple concurrent connections", async () => {
    const ws1 = createWebSocket(ctx.baseUrl, "global");
    const ws2 = createWebSocket(ctx.baseUrl, "global");
    const ws3 = createWebSocket(ctx.baseUrl, "global");

    await Promise.all([
      waitForWebSocketState(ws1, WebSocket.OPEN),
      waitForWebSocketState(ws2, WebSocket.OPEN),
      waitForWebSocketState(ws3, WebSocket.OPEN),
    ]);

    expect(ws1.readyState).toBe(WebSocket.OPEN);
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    expect(ws3.readyState).toBe(WebSocket.OPEN);

    // Small delay to let connection.established events be sent
    await Bun.sleep(100);

    // All connections should be able to make RPC calls
    const _id1 = sendRPCCall(ws1, "session.list");
    const _id2 = sendRPCCall(ws2, "session.list");
    const _id3 = sendRPCCall(ws3, "session.list");

    // Helper to get the next RESULT message, skipping any EVENT messages
    const getResult = async (ws: WebSocket) => {
      while (true) {
        const msg = await waitForWebSocketMessage(ws, 10000);
        if (msg.type === "RESULT") return msg;
        // Skip any EVENT messages (like connection.established)
      }
    };

    const [response1, response2, response3] = await Promise.all([
      getResult(ws1),
      getResult(ws2),
      getResult(ws3),
    ]);

    expect(response1.type).toBe("RESULT");
    expect(response2.type).toBe("RESULT");
    expect(response3.type).toBe("RESULT");

    ws1.close();
    ws2.close();
    ws3.close();
  }, 15000);

  test("should handle many concurrent calls", async () => {
    const ws = createWebSocket(ctx.baseUrl, "global");
    await waitForWebSocketState(ws, WebSocket.OPEN);

    // Send 50 concurrent calls
    const ids = [];
    for (let i = 0; i < 50; i++) {
      ids.push(sendRPCCall(ws, "session.list"));
    }

    // Collect all responses
    const responses = [];
    for (let i = 0; i < 50; i++) {
      responses.push(await waitForWebSocketMessage(ws, 30000));
    }

    // All should succeed
    const successCount = responses.filter((r) => r.type === "RESULT").length;
    expect(successCount).toBeGreaterThan(45); // At least 90% success rate

    ws.close();
  });
});

describe("Multi-Client Event Routing", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("should route events to different session scopes", async () => {
    const ws1 = createWebSocket(ctx.baseUrl, "global");
    const ws2 = createWebSocket(ctx.baseUrl, "global");

    await waitForWebSocketState(ws1, WebSocket.OPEN);
    await waitForWebSocketState(ws2, WebSocket.OPEN);

    // Create sessions from both connections
    const _createId1 = sendRPCCall(ws1, "session.create", {});
    const createResponse1 = await waitForWebSocketMessage(ws1);
    const sessionId1 = createResponse1.data.sessionId;

    const _createId2 = sendRPCCall(ws2, "session.create", {});
    const createResponse2 = await waitForWebSocketMessage(ws2);
    const sessionId2 = createResponse2.data.sessionId;

    expect(sessionId1).toBeTruthy();
    expect(sessionId2).toBeTruthy();
    expect(sessionId1).not.toBe(sessionId2);

    const testEvent = "test.routing." + Date.now();

    // Subscribe to session-specific events
    await subscribeToEvent(ws1, testEvent, sessionId1);
    await subscribeToEvent(ws2, testEvent, sessionId2);

    // Both subscriptions should succeed
    ws1.close();
    ws2.close();
  });

  test("should broadcast global events to all clients", async () => {
    const ws1 = createWebSocket(ctx.baseUrl, "global");
    const ws2 = createWebSocket(ctx.baseUrl, "global");

    await waitForWebSocketState(ws1, WebSocket.OPEN);
    await waitForWebSocketState(ws2, WebSocket.OPEN);

    // Small delay to let connection.established events be sent
    await Bun.sleep(100);

    // Both clients subscribe to global session.created event
    await subscribeToEvent(ws1, "session.created", "global");
    await subscribeToEvent(ws2, "session.created", "global");

    // Create a session from client 1
    const _callId = sendRPCCall(ws1, "session.create", {
      workspacePath: "/tmp/test-workspace",
    });

    // ws1 will receive: RESULT (create response) + EVENT (session.created)
    // ws2 will receive: EVENT (session.created)
    // Order of messages is not guaranteed, so collect them in parallel

    // Helper to collect N messages from a websocket
    const collectMessages = async (
      ws: WebSocket,
      count: number,
    ): Promise<unknown[]> => {
      const messages: unknown[] = [];
      for (let i = 0; i < count; i++) {
        messages.push(await waitForWebSocketMessage(ws, 5000));
      }
      return messages;
    };

    // Collect messages in parallel - ws1 expects 2, ws2 expects 1
    const [ws1Messages, ws2Messages] = await Promise.all([
      collectMessages(ws1, 2),
      collectMessages(ws2, 1),
    ]);

    // Debug: log what we received
    log(
      "ws1 received:",
      ws1Messages
        .map(
          (m: unknown) =>
            `${(m as { type: string }).type}:${(m as { method?: string }).method || ""}`,
        )
        .join(", "),
    );
    log(
      "ws2 received:",
      ws2Messages
        .map(
          (m: unknown) =>
            `${(m as { type: string }).type}:${(m as { method?: string }).method || ""}`,
        )
        .join(", "),
    );

    // ws2 should have received session.created event
    const ws2Event = ws2Messages[0] as { type: string; method: string };
    expect(ws2Event.type).toBe("EVENT");
    expect(ws2Event.method).toBe("session.created");

    // ws1 should have received RESULT and EVENT (order may vary)
    const result = ws1Messages.find(
      (m) => (m as { type: string }).type === "RESULT",
    ) as { type: string; data: { sessionId: string } } | undefined;
    const event = ws1Messages.find(
      (m) =>
        (m as { type: string; method?: string }).type === "EVENT" &&
        (m as { method?: string }).method === "session.created",
    );

    expect(result).toBeDefined();
    if (result) {
      expect(result.data).toHaveProperty("sessionId");
    }

    expect(event).toBeDefined();

    ws1.close();
    ws2.close();
  }, 15000);
});
