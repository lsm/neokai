/**
 * Agent State Integration Tests
 *
 * DEPRECATED: These tests were written for the old agent.state event pattern.
 * Agent state is now part of the unified state.session channel.
 *
 * See state-sync.test.ts for tests covering the unified state.session channel.
 *
 * TODO: Remove this file or rewrite tests to use state.session channel.
 * For now, all tests are skipped.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { TestContext } from "../test-utils";
import {
  createTestApp,
  callRPCHandler,
  createWebSocket,
  waitForWebSocketState,
  waitForWebSocketMessage,
  hasAnyCredentials,
} from "../test-utils";
import { MessageType } from "@liuboer/shared";

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || "/tmp";

describe.skip("Agent State Event Broadcasting (DEPRECATED)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  describe("Initial State", () => {
    test("should start with idle state", async () => {
      const session = await callRPCHandler(ctx.messageHub, "session.create", {
        workspacePath: `${TMP_DIR}/test-workspace`,
      });

      // Get initial processing state
      const agentSession = ctx.sessionManager.getSession(session.sessionId);
      expect(agentSession).toBeDefined();

      const state = agentSession!.getProcessingState();
      expect(state.status).toBe("idle");
    });
  });

  describe("State Transition: idle → queued → processing → idle", () => {
    test.skipIf(!hasAnyCredentials())("should broadcast state events during message flow", async () => {
      // Create session
      const session = await callRPCHandler(ctx.messageHub, "session.create", {
        workspacePath: `${TMP_DIR}/test-workspace`,
      });

      // Create WebSocket connection for the session
      const ws = createWebSocket(ctx.baseUrl, session.sessionId);
      await waitForWebSocketState(ws, WebSocket.OPEN);

      // Subscribe to agent.state events
      ws.send(JSON.stringify({
        id: "subscribe-1",
        type: MessageType.SUBSCRIBE,
        method: "agent.state",
        data: {},
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      }));

      // Wait for subscription acknowledgment
      const subAck = await waitForWebSocketMessage(ws);
      expect(subAck.type).toBe(MessageType.SUBSCRIBED);

      // Send a message (triggers state transitions)
      ws.send(JSON.stringify({
        id: "send-1",
        type: MessageType.CALL,
        method: "message.send",
        data: { content: "Hello!", sessionId: session.sessionId },
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      }));

      // Collect state transition events
      const events: any[] = [];

      // We need to collect messages until we see the complete state cycle
      // Expected: queued → processing → idle (plus RESULT from message.send)
      let gotQueued = false;
      let gotProcessing = false;
      let gotIdle = false;

      for (let i = 0; i < 20; i++) {
        try {
          const msg = await waitForWebSocketMessage(ws, 15000);
          if (msg.type === MessageType.EVENT && msg.method === "agent.state") {
            events.push(msg.data);
            const status = msg.data.state.status;
            if (status === "queued") gotQueued = true;
            if (status === "processing") gotProcessing = true;
            if (status === "idle" && gotProcessing) {
              gotIdle = true;
              break; // Got complete cycle
            }
          }
        } catch (error) {
          // Timeout - might have gotten all events
          break;
        }
      }

      // Verify we got the expected state transitions
      const stateSequence = events.map(e => e.state.status);
      expect(stateSequence).toContain("queued");
      expect(stateSequence).toContain("processing");
      expect(stateSequence).toContain("idle");

      // NOTE: Due to async nature, queued and processing might come in either order
      // What matters is that we eventually reach idle after processing
      const hasQueued = stateSequence.includes("queued");
      const hasProcessing = stateSequence.includes("processing");
      const hasIdle = stateSequence.includes("idle");

      expect(hasQueued).toBe(true);
      expect(hasProcessing).toBe(true);
      expect(hasIdle).toBe(true);

      // Verify timestamps are present
      events.forEach(event => {
        expect(event.timestamp).toBeNumber();
        expect(event.timestamp).toBeGreaterThan(0);
      });

      ws.close();
    }, 30000); // Longer timeout for API call

    test.skipIf(!hasAnyCredentials())("should include messageId in queued and processing states", async () => {
      const session = await callRPCHandler(ctx.messageHub, "session.create", {
        workspacePath: `${TMP_DIR}/test-workspace`,
      });

      const ws = createWebSocket(ctx.baseUrl, session.sessionId);
      await waitForWebSocketState(ws, WebSocket.OPEN);

      // Subscribe to agent.state
      ws.send(JSON.stringify({
        id: "subscribe-1",
        type: MessageType.SUBSCRIBE,
        method: "agent.state",
        data: {},
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      }));

      await waitForWebSocketMessage(ws); // subscription ack (SUBSCRIBED)

      // Send message
      ws.send(JSON.stringify({
        id: "send-1",
        type: MessageType.CALL,
        method: "message.send",
        data: { content: "Test message", sessionId: session.sessionId },
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      }));

      // Collect messages until we get both queued and processing states
      let queuedEvent: any = null;
      let processingEvent: any = null;
      const allStateEvents: any[] = [];

      for (let i = 0; i < 20; i++) {
        try {
          const msg = await waitForWebSocketMessage(ws, 15000);
          if (msg.type === MessageType.EVENT && msg.method === "agent.state") {
            allStateEvents.push(msg.data);
            if (msg.data.state.status === "queued") {
              queuedEvent = msg.data;
            } else if (msg.data.state.status === "processing") {
              processingEvent = msg.data;
            }
            // Keep collecting until we have both or reach idle
            if (queuedEvent && processingEvent) {
              break;
            }
            if (msg.data.state.status === "idle" && processingEvent) {
              break; // Done processing
            }
          }
        } catch (error) {
          // Timeout - stop collecting
          break;
        }
      }

      // Debug: log what we received
      console.log("Received state events:", allStateEvents.map(e => e.state.status));

      // Verify we got at least processing state with messageId
      // (queued might be too fast to catch in some cases)
      expect(processingEvent).toBeDefined();
      expect(processingEvent.state.messageId).toBeString();
      expect(processingEvent.state.messageId).toBeTruthy();

      // If we caught queued state, verify it too
      if (queuedEvent) {
        expect(queuedEvent.state.messageId).toBeString();
        expect(queuedEvent.state.messageId).toBeTruthy();
        expect(queuedEvent.state.messageId).toBe(processingEvent.state.messageId);
      }

      ws.close();
    }, 30000);
  });

  describe("State Transition: Interruption", () => {
    test("should broadcast interrupted state when session is interrupted", async () => {
      const session = await callRPCHandler(ctx.messageHub, "session.create", {
        workspacePath: `${TMP_DIR}/test-workspace`,
      });

      const ws = createWebSocket(ctx.baseUrl, session.sessionId);
      await waitForWebSocketState(ws, WebSocket.OPEN);

      // Subscribe to agent.state
      ws.send(JSON.stringify({
        id: "subscribe-1",
        type: MessageType.SUBSCRIBE,
        method: "agent.state",
        data: {},
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      }));

      await waitForWebSocketMessage(ws); // subscription ack (SUBSCRIBED)

      // Trigger interrupt (can interrupt even when idle)
      ws.send(JSON.stringify({
        id: "interrupt-1",
        type: MessageType.CALL,
        method: "client.interrupt",
        data: { sessionId: session.sessionId },
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      }));

      // Collect messages
      const events: any[] = [];
      for (let i = 0; i < 5; i++) {
        const msg = await waitForWebSocketMessage(ws, 5000);
        if (msg.type === MessageType.EVENT && msg.method === "agent.state") {
          events.push(msg.data);
        }
        // Stop after we get idle state
        if (msg.type === MessageType.EVENT && msg.method === "agent.state" && msg.data.state.status === "idle") {
          break;
        }
      }

      // Verify we got interrupted → idle transition
      const stateSequence = events.map(e => e.state.status);
      expect(stateSequence).toContain("interrupted");
      expect(stateSequence).toContain("idle");

      // Verify interrupted comes before idle
      const interruptedIndex = stateSequence.indexOf("interrupted");
      const idleIndex = stateSequence.indexOf("idle");
      expect(interruptedIndex).toBeLessThan(idleIndex);

      ws.close();
    }, 15000);

    test.skipIf(!hasAnyCredentials())("should transition from processing to interrupted when message is interrupted", async () => {
      const session = await callRPCHandler(ctx.messageHub, "session.create", {
        workspacePath: `${TMP_DIR}/test-workspace`,
      });

      const ws = createWebSocket(ctx.baseUrl, session.sessionId);
      await waitForWebSocketState(ws, WebSocket.OPEN);

      // Subscribe to agent.state
      ws.send(JSON.stringify({
        id: "subscribe-1",
        type: MessageType.SUBSCRIBE,
        method: "agent.state",
        data: {},
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      }));

      await waitForWebSocketMessage(ws); // subscription ack (SUBSCRIBED)

      // Send a message that will take some time to process
      ws.send(JSON.stringify({
        id: "send-1",
        type: MessageType.CALL,
        method: "message.send",
        data: { content: "Write a long story about a robot", sessionId: session.sessionId },
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      }));

      // Wait for processing state
      let inProcessing = false;
      for (let i = 0; i < 10; i++) {
        const msg = await waitForWebSocketMessage(ws, 10000);
        if (msg.type === MessageType.EVENT && msg.method === "agent.state" && msg.data.state.status === "processing") {
          inProcessing = true;
          break;
        }
      }

      expect(inProcessing).toBe(true);

      // Now interrupt while processing
      ws.send(JSON.stringify({
        id: "interrupt-1",
        type: MessageType.CALL,
        method: "client.interrupt",
        data: { sessionId: session.sessionId },
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      }));

      // Collect subsequent state events
      const events: any[] = [];
      for (let i = 0; i < 5; i++) {
        const msg = await waitForWebSocketMessage(ws, 5000);
        if (msg.type === MessageType.EVENT && msg.method === "agent.state") {
          events.push(msg.data);
        }
        // Stop after idle
        if (msg.type === MessageType.EVENT && msg.method === "agent.state" && msg.data.state.status === "idle") {
          break;
        }
      }

      // Verify we got interrupted → idle
      const stateSequence = events.map(e => e.state.status);
      expect(stateSequence).toContain("interrupted");
      expect(stateSequence).toContain("idle");

      ws.close();
    }, 30000);
  });

  describe("State Channel Subscription", () => {
    test("should allow multiple clients to subscribe to agent.state", async () => {
      const session = await callRPCHandler(ctx.messageHub, "session.create", {
        workspacePath: `${TMP_DIR}/test-workspace`,
      });

      // Create two WebSocket connections
      const ws1 = createWebSocket(ctx.baseUrl, session.sessionId);
      const ws2 = createWebSocket(ctx.baseUrl, session.sessionId);

      await Promise.all([
        waitForWebSocketState(ws1, WebSocket.OPEN),
        waitForWebSocketState(ws2, WebSocket.OPEN),
      ]);

      // Subscribe both clients
      const subscribeMessage = {
        id: "subscribe-1",
        type: MessageType.SUBSCRIBE,
        method: "agent.state",
        data: {},
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      };

      ws1.send(JSON.stringify({ ...subscribeMessage, id: "sub-ws1" }));
      ws2.send(JSON.stringify({ ...subscribeMessage, id: "sub-ws2" }));

      // Wait for subscription acks
      await Promise.all([
        waitForWebSocketMessage(ws1),
        waitForWebSocketMessage(ws2),
      ]);

      // Trigger interrupt (simple state change)
      ws1.send(JSON.stringify({
        id: "interrupt-1",
        type: MessageType.CALL,
        method: "client.interrupt",
        data: { sessionId: session.sessionId },
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      }));

      // Both clients should receive the interrupted state event
      const [msg1, msg2] = await Promise.all([
        waitForWebSocketMessage(ws1, 5000),
        waitForWebSocketMessage(ws2, 5000),
      ]);

      // At least one of the messages should be the interrupted state
      const isStateEvent = (msg: any) =>
        msg.type === MessageType.EVENT && msg.method === "agent.state" && msg.data.state.status === "interrupted";

      // If first message isn't the state event, try next
      let ws1HasInterrupted = isStateEvent(msg1);
      let ws2HasInterrupted = isStateEvent(msg2);

      if (!ws1HasInterrupted) {
        const nextMsg = await waitForWebSocketMessage(ws1, 5000);
        ws1HasInterrupted = isStateEvent(nextMsg);
      }

      if (!ws2HasInterrupted) {
        const nextMsg = await waitForWebSocketMessage(ws2, 5000);
        ws2HasInterrupted = isStateEvent(nextMsg);
      }

      expect(ws1HasInterrupted).toBe(true);
      expect(ws2HasInterrupted).toBe(true);

      ws1.close();
      ws2.close();
    }, 15000);

    test("should get current state when subscribing to agent.state", async () => {
      const session = await callRPCHandler(ctx.messageHub, "session.create", {
        workspacePath: `${TMP_DIR}/test-workspace`,
      });

      const ws = createWebSocket(ctx.baseUrl, session.sessionId);
      await waitForWebSocketState(ws, WebSocket.OPEN);

      // Subscribe to agent.state
      ws.send(JSON.stringify({
        id: "subscribe-1",
        type: MessageType.SUBSCRIBE,
        method: "agent.state",
        data: {},
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      }));

      const subAck = await waitForWebSocketMessage(ws);
      expect(subAck.type).toBe(MessageType.SUBSCRIBED);

      // The subscription result should include current state
      // NOTE: This depends on implementation - subscription might send initial state as event
      // For now, we verify that we can query the state via RPC
      ws.send(JSON.stringify({
        id: "get-state-1",
        type: MessageType.CALL,
        method: "agent.getState",
        data: { sessionId: session.sessionId },
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      }));

      const stateResult = await waitForWebSocketMessage(ws);
      expect(stateResult.type).toBe(MessageType.RESULT);
      expect(stateResult.data.state).toBeDefined();
      expect(stateResult.data.state.status).toBe("idle");

      ws.close();
    });
  });

  describe("Concurrent Sessions", () => {
    test.skipIf(!hasAnyCredentials())("should maintain independent state for multiple sessions", async () => {
      // Create two sessions
      const session1 = await callRPCHandler(ctx.messageHub, "session.create", {
        workspacePath: `${TMP_DIR}/test-workspace-1`,
      });
      const session2 = await callRPCHandler(ctx.messageHub, "session.create", {
        workspacePath: `${TMP_DIR}/test-workspace-2`,
      });

      // Create WebSocket connections
      const ws1 = createWebSocket(ctx.baseUrl, session1.sessionId);
      const ws2 = createWebSocket(ctx.baseUrl, session2.sessionId);

      await Promise.all([
        waitForWebSocketState(ws1, WebSocket.OPEN),
        waitForWebSocketState(ws2, WebSocket.OPEN),
      ]);

      // Subscribe both to agent.state
      ws1.send(JSON.stringify({
        id: "sub-1",
        type: MessageType.SUBSCRIBE,
        method: "agent.state",
        data: {},
        sessionId: session1.sessionId,
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      }));

      ws2.send(JSON.stringify({
        id: "sub-2",
        type: MessageType.SUBSCRIBE,
        method: "agent.state",
        data: {},
        sessionId: session2.sessionId,
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      }));

      await Promise.all([
        waitForWebSocketMessage(ws1),
        waitForWebSocketMessage(ws2),
      ]);

      // Send message only on session1
      ws1.send(JSON.stringify({
        id: "send-1",
        type: MessageType.CALL,
        method: "message.send",
        data: { content: "Hello session 1", sessionId: session1.sessionId },
        sessionId: session1.sessionId,
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      }));

      // Session 1 should receive state events
      let session1GotQueued = false;
      for (let i = 0; i < 5; i++) {
        const msg = await waitForWebSocketMessage(ws1, 10000);
        if (msg.type === MessageType.EVENT && msg.method === "agent.state" && msg.data.state.status === "queued") {
          session1GotQueued = true;
          break;
        }
      }

      expect(session1GotQueued).toBe(true);

      // Session 2 should remain idle (verify by querying state directly)
      const agentSession2 = ctx.sessionManager.getSession(session2.sessionId);
      const state2 = agentSession2!.getProcessingState();
      expect(state2.status).toBe("idle");

      ws1.close();
      ws2.close();
    }, 30000);
  });

  describe("Error Handling", () => {
    test("should handle subscription to agent.state for non-existent session", async () => {
      const ws = createWebSocket(ctx.baseUrl, "non-existent-session");
      await waitForWebSocketState(ws, WebSocket.OPEN);

      // Try to subscribe to non-existent session
      ws.send(JSON.stringify({
        id: "subscribe-1",
        type: MessageType.SUBSCRIBE,
        method: "agent.state",
        data: {},
        sessionId: "non-existent-session",
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      }));

      // Should receive subscription acknowledgment
      const response = await waitForWebSocketMessage(ws);

      // Subscriptions are allowed for non-existent sessions
      // (events just won't be delivered until session exists)
      expect(response.type).toBe(MessageType.SUBSCRIBED);

      ws.close();
    });

    test("should not receive state events after unsubscribing", async () => {
      const session = await callRPCHandler(ctx.messageHub, "session.create", {
        workspacePath: `${TMP_DIR}/test-workspace`,
      });

      const ws = createWebSocket(ctx.baseUrl, session.sessionId);
      await waitForWebSocketState(ws, WebSocket.OPEN);

      // Subscribe
      ws.send(JSON.stringify({
        id: "subscribe-1",
        type: MessageType.SUBSCRIBE,
        method: "agent.state",
        data: {},
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      }));

      await waitForWebSocketMessage(ws); // sub ack

      // Unsubscribe
      ws.send(JSON.stringify({
        id: "unsubscribe-1",
        type: MessageType.UNSUBSCRIBE,
        method: "agent.state",
        data: {},
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      }));

      await waitForWebSocketMessage(ws); // unsub ack

      // Trigger state change
      ws.send(JSON.stringify({
        id: "interrupt-1",
        type: MessageType.CALL,
        method: "client.interrupt",
        data: { sessionId: session.sessionId },
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      }));

      // Wait for interrupt result
      const interruptResult = await waitForWebSocketMessage(ws, 5000);
      expect(interruptResult.type).toBe(MessageType.RESULT);

      // Should NOT receive agent.state events after unsubscribing
      // Try to get next message with short timeout - should timeout or get non-state event
      try {
        const nextMsg = await waitForWebSocketMessage(ws, 2000);
        // If we get a message, it should NOT be an agent.state event
        if (nextMsg.type === MessageType.EVENT) {
          expect(nextMsg.method).not.toBe("agent.state");
        }
      } catch (error) {
        // Timeout is acceptable - no more messages
        expect(error).toBeDefined();
      }

      ws.close();
    }, 15000);
  });
});
