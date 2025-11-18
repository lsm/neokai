/**
 * WebSocket Integration Tests
 *
 * Tests WebSocket functionality:
 * - Connection establishment
 * - Ping/pong messages
 * - Subscribe messages
 * - Event streaming
 * - Connection lifecycle
 * - Error handling
 */

import { describe, test, expect } from "bun:test";
import type { CreateSessionResponse } from "@liuboer/shared";
import {
  createTestApp,
  request,
  assertSuccessResponse,
  createWebSocket,
  createWebSocketWithFirstMessage,
  waitForWebSocketState,
  waitForWebSocketMessage,
  waitForWebSocketOpenAndMessage,
  assertEquals,
  assertExists,
  assertTrue,
  hasAnyCredentials,
} from "./test-utils";

describe("WebSocket API", () => {
  describe("Connection Lifecycle", () => {
    test("should establish WebSocket connection", async () => {
      const ctx = await createTestApp();
      try {
        // Create session
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // Connect WebSocket with first message listener set up immediately
        const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
          ctx.baseUrl,
          sessionId,
        );
        const message = await firstMessagePromise;

        assertEquals(message.type, "connection.established");
        assertEquals(message.sessionId, sessionId);
        assertExists(message.timestamp);
        assertExists(message.data);
        assertEquals(message.data.sessionId, sessionId);

        ws.close();
      } finally {
        await ctx.cleanup();
      }
    });

    test("should reject connection for non-existent session", async () => {
      const ctx = await createTestApp();
      try {
        const fakeId = "00000000-0000-0000-0000-000000000000";
        const ws = createWebSocket(ctx.baseUrl, fakeId);

        // Wait a bit for connection attempt
        await Bun.sleep(200);

        // Connection should be closed or closing
        assertTrue(
          ws.readyState === WebSocket.CLOSING ||
            ws.readyState === WebSocket.CLOSED,
        );

        ws.close();
      } finally {
        await ctx.cleanup();
      }
    });

    test("should handle connection close", async () => {
      const ctx = await createTestApp();
      try {
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        const ws = createWebSocket(ctx.baseUrl, sessionId);
        await waitForWebSocketState(ws, WebSocket.OPEN);

        // Close connection
        ws.close();
        await waitForWebSocketState(ws, WebSocket.CLOSED);

        assertEquals(ws.readyState, WebSocket.CLOSED);
      } finally {
        await ctx.cleanup();
      }
    });

    test("should support multiple concurrent connections", async () => {
      const ctx = await createTestApp();
      try {
        // Create two sessions
        const session1Res = await request(
          ctx.baseUrl,
          "POST",
          "/api/sessions",
          {},
        );
        const { sessionId: sessionId1 } =
          await assertSuccessResponse<CreateSessionResponse>(session1Res, 201);

        const session2Res = await request(
          ctx.baseUrl,
          "POST",
          "/api/sessions",
          {},
        );
        const { sessionId: sessionId2 } =
          await assertSuccessResponse<CreateSessionResponse>(session2Res, 201);

        // Connect both WebSockets with first message listeners
        const { ws: ws1, firstMessagePromise: msg1Promise } = createWebSocketWithFirstMessage(ctx.baseUrl, sessionId1);
        const { ws: ws2, firstMessagePromise: msg2Promise } = createWebSocketWithFirstMessage(ctx.baseUrl, sessionId2);

        // Wait for initial messages
        const msg1 = await msg1Promise;
        const msg2 = await msg2Promise;

        assertEquals(ws1.readyState, WebSocket.OPEN);
        assertEquals(ws2.readyState, WebSocket.OPEN);

        assertEquals(msg1.sessionId, sessionId1);
        assertEquals(msg2.sessionId, sessionId2);

        ws1.close();
        ws2.close();
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("Ping/Pong", () => {
    test("should respond to ping with pong", async () => {
      const ctx = await createTestApp();
      try {
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // Connect and consume initial connection message
        const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, sessionId);
        await firstMessagePromise;

        // Send ping
        const pingMessage = {
          type: "ping",
        };

        ws.send(JSON.stringify(pingMessage));

        // Wait for pong response
        const pong = await waitForWebSocketMessage(ws);

        assertEquals(pong.type, "pong");
        assertExists(pong.timestamp);

        ws.close();
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("Subscribe Messages", () => {
    test("should handle subscribe message", async () => {
      const ctx = await createTestApp();
      try {
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // Connect and consume initial connection message
        const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, sessionId);
        await firstMessagePromise;

        // Send subscribe message
        const subscribeMessage = {
          type: "subscribe",
          events: ["message", "tool_use"],
        };

        ws.send(JSON.stringify(subscribeMessage));

        // Wait a bit for processing
        await Bun.sleep(100);

        // Connection should still be open
        assertEquals(ws.readyState, WebSocket.OPEN);

        ws.close();
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("Event Streaming", () => {
    test.skipIf(!hasAnyCredentials())("should receive events when messages are sent", async () => {
      const ctx = await createTestApp();
      try {
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // Connect and consume initial connection message
        const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, sessionId);
        await firstMessagePromise;

        // Collect messages in an array
        const messages: any[] = [];
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data as string);
            messages.push(data);
          } catch (error) {
            // Ignore parse errors
          }
        };

        // Send a message via HTTP API
        await request(
          ctx.baseUrl,
          "POST",
          `/api/sessions/${sessionId}/messages`,
          { content: "Test message" },
        );

        // Wait for events to be received
        await Bun.sleep(500);

        // Should have received some events
        assertTrue(messages.length > 0);

        ws.close();
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("Error Handling", () => {
    test("should handle invalid JSON message", async () => {
      const ctx = await createTestApp();
      try {
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // Connect and consume initial connection message
        const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, sessionId);
        await firstMessagePromise;

        // Send invalid JSON
        ws.send("invalid json {");

        // Wait for error response
        const error = await waitForWebSocketMessage(ws);

        assertEquals(error.type, "error");
        assertEquals(error.sessionId, sessionId);
        assertExists(error.data);
        assertEquals(error.data.error, "Invalid message format");

        ws.close();
      } finally {
        await ctx.cleanup();
      }
    });

    test("should handle malformed message", async () => {
      const ctx = await createTestApp();
      try {
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // Connect and consume initial connection message
        const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, sessionId);
        await firstMessagePromise;

        // Send valid JSON but invalid message structure
        ws.send(JSON.stringify({ unknown: "field" }));

        // Connection should remain open (we don't crash on unknown messages)
        await Bun.sleep(100);
        assertEquals(ws.readyState, WebSocket.OPEN);

        ws.close();
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("Reconnection", () => {
    test("should allow reconnection after disconnect", async () => {
      const ctx = await createTestApp();
      try {
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // First connection
        const { ws: ws1, firstMessagePromise: msg1 } = createWebSocketWithFirstMessage(ctx.baseUrl, sessionId);
        await msg1;
        ws1.close();
        await waitForWebSocketState(ws1, WebSocket.CLOSED);

        // Second connection - should receive connection message again
        const { ws: ws2, firstMessagePromise: msg2Promise } = createWebSocketWithFirstMessage(ctx.baseUrl, sessionId);
        const message = await msg2Promise;
        assertEquals(message.type, "connection.established");
        assertEquals(message.sessionId, sessionId);

        ws2.close();
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("Message Ordering", () => {
    test("should maintain message order", async () => {
      const ctx = await createTestApp();
      try {
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // Connect and consume initial connection message
        const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, sessionId);
        await firstMessagePromise;

        const receivedMessages: string[] = [];

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data as string);
            if (data.type === "pong") {
              receivedMessages.push(data.type);
            }
          } catch (error) {
            // Ignore parse errors
          }
        };

        // Send multiple pings
        ws.send(JSON.stringify({ type: "ping" }));
        ws.send(JSON.stringify({ type: "ping" }));
        ws.send(JSON.stringify({ type: "ping" }));

        // Wait for all pongs
        await Bun.sleep(200);

        // Should have received all pongs
        assertEquals(receivedMessages.length, 3);
        assertEquals(receivedMessages[0], "pong");
        assertEquals(receivedMessages[1], "pong");
        assertEquals(receivedMessages[2], "pong");

        ws.close();
      } finally {
        await ctx.cleanup();
      }
    });
  });
});
