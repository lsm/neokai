/**
 * Tests for MessageHub Critical Fixes
 *
 * Tests for features added during comprehensive architecture review:
 * - Subscription persistence and auto-resubscription
 * - Runtime message validation
 * - Request deduplication
 * - Message sequence numbers
 * - PING/PONG handlers
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MessageHub } from "../src/message-hub/message-hub";
import type {
  IMessageTransport,
  ConnectionState,
  HubMessage,
} from "../src/message-hub/types";
import {
  MessageType,
  createEventMessage,
  createCallMessage,
  isValidMessage,
} from "../src/message-hub/protocol";

class MockTransport implements IMessageTransport {
  readonly name = "mock-transport";
  private state: ConnectionState = "connected";
  private messageHandlers: Set<(message: HubMessage) => void> = new Set();
  private stateHandlers: Set<(state: ConnectionState) => void> = new Set();
  public sentMessages: HubMessage[] = [];

  async initialize(): Promise<void> {
    this.state = "connected";
    this.notifyStateChange("connected");
  }

  async close(): Promise<void> {
    this.state = "disconnected";
    this.notifyStateChange("disconnected");
  }

  async send(message: HubMessage): Promise<void> {
    this.sentMessages.push(message);
  }

  onMessage(handler: (message: HubMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onConnectionChange(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  getState(): ConnectionState {
    return this.state;
  }

  isReady(): boolean {
    return this.state === "connected";
  }

  // Test helpers
  simulateMessage(message: HubMessage): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  simulateStateChange(state: ConnectionState): void {
    this.state = state;
    this.notifyStateChange(state);
  }

  private notifyStateChange(state: ConnectionState): void {
    for (const handler of this.stateHandlers) {
      handler(state);
    }
  }

  clearSentMessages(): void {
    this.sentMessages = [];
  }
}

describe("MessageHub Critical Fixes", () => {
  let messageHub: MessageHub;
  let transport: MockTransport;

  beforeEach(async () => {
    messageHub = new MessageHub({
      defaultSessionId: "test-session",
      debug: false,
    });

    transport = new MockTransport();
    messageHub.registerTransport(transport);
    await transport.initialize();
  });

  afterEach(() => {
    messageHub.cleanup();
  });

  describe("Subscription Persistence & Auto-Resubscription", () => {
    test("should persist subscriptions across reconnections", async () => {
      let callCount = 0;
      const handler = () => {
        callCount++;
      };

      // Subscribe to an event
      messageHub.subscribe("user.created", handler);

      // Simulate event before disconnect
      transport.simulateMessage(
        createEventMessage({
          method: "user.created",
          data: { userId: "123" },
          sessionId: "test-session",
        }),
      );

      expect(callCount).toBe(1);

      // Simulate disconnect and reconnect
      transport.simulateStateChange("disconnected");
      await new Promise((resolve) => setTimeout(resolve, 10));
      transport.simulateStateChange("connected");
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Handler should still work after reconnection
      transport.simulateMessage(
        createEventMessage({
          method: "user.created",
          data: { userId: "456" },
          sessionId: "test-session",
        }),
      );

      expect(callCount).toBe(2);
    });

    test("should not resubscribe after manual unsubscribe", async () => {
      let callCount = 0;
      const handler = () => {
        callCount++;
      };

      // Subscribe and then immediately unsubscribe
      const unsub = messageHub.subscribe("user.created", handler);
      unsub();

      // Simulate reconnection
      transport.simulateStateChange("disconnected");
      await new Promise((resolve) => setTimeout(resolve, 10));
      transport.simulateStateChange("connected");
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Handler should NOT be called
      transport.simulateMessage(
        createEventMessage({
          method: "user.created",
          data: { userId: "789" },
          sessionId: "test-session",
        }),
      );

      expect(callCount).toBe(0);
    });
  });

  describe("Runtime Message Validation", () => {
    test("should validate message structure", () => {
      const validMessage: HubMessage = {
        id: "test-id",
        type: MessageType.EVENT,
        sessionId: "test-session",
        method: "test.method",
        timestamp: new Date().toISOString(),
      };

      expect(isValidMessage(validMessage)).toBe(true);
    });

    test("should reject message with missing required fields", () => {
      const invalidMessage = {
        id: "test-id",
        type: MessageType.EVENT,
        // Missing sessionId and method
        timestamp: new Date().toISOString(),
      };

      expect(isValidMessage(invalidMessage)).toBe(false);
    });

    test("should reject message with invalid type", () => {
      const invalidMessage = {
        id: "test-id",
        type: "INVALID_TYPE",
        sessionId: "test-session",
        method: "test.method",
        timestamp: new Date().toISOString(),
      };

      expect(isValidMessage(invalidMessage)).toBe(false);
    });

    test("should reject RESULT message without requestId", () => {
      const invalidMessage = {
        id: "test-id",
        type: MessageType.RESULT,
        sessionId: "test-session",
        method: "test.method",
        timestamp: new Date().toISOString(),
        // Missing requestId
      };

      expect(isValidMessage(invalidMessage)).toBe(false);
    });

    test("should reject ERROR message without error field", () => {
      const invalidMessage = {
        id: "test-id",
        type: MessageType.ERROR,
        sessionId: "test-session",
        method: "test.method",
        timestamp: new Date().toISOString(),
        requestId: "req-id",
        // Missing error field
      };

      expect(isValidMessage(invalidMessage)).toBe(false);
    });

    test("should reject message with invalid method format", () => {
      const invalidMessage = {
        id: "test-id",
        type: MessageType.EVENT,
        sessionId: "test-session",
        method: "invalid-no-dot", // No dot separator
        timestamp: new Date().toISOString(),
      };

      expect(isValidMessage(invalidMessage)).toBe(false);
    });

    test("should reject message with colon in method name", () => {
      const invalidMessage = {
        id: "test-id",
        type: MessageType.EVENT,
        sessionId: "test-session",
        method: "test:with.colon", // Colons are reserved
        timestamp: new Date().toISOString(),
      };

      expect(isValidMessage(invalidMessage)).toBe(false);
    });
  });

  describe("Request Deduplication", () => {
    test("should deduplicate identical concurrent RPC calls", async () => {
      // Register a handler
      messageHub.handle("test.slow", async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { result: "success" };
      });

      // Make two identical calls concurrently
      const call1 = messageHub.call("test.slow", { value: 42 });
      const call2 = messageHub.call("test.slow", { value: 42 });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should only send ONE CALL message
      const callMessages = transport.sentMessages.filter(
        (m) => m.type === MessageType.CALL,
      );
      expect(callMessages.length).toBe(1);

      // Both promises should resolve to same result
      transport.simulateMessage({
        id: "response-id",
        type: MessageType.RESULT,
        sessionId: "test-session",
        method: "test.slow",
        requestId: callMessages[0].id,
        data: { result: "success" },
        timestamp: new Date().toISOString(),
      });

      const [result1, result2] = await Promise.all([call1, call2]);
      expect(result1).toEqual({ result: "success" });
      expect(result2).toEqual({ result: "success" });
    });

    test("should NOT deduplicate calls with different data", async () => {
      const call1 = messageHub.call("test.method", { value: 1 });
      const call2 = messageHub.call("test.method", { value: 2 });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should send TWO different CALL messages
      const callMessages = transport.sentMessages.filter(
        (m) => m.type === MessageType.CALL,
      );
      expect(callMessages.length).toBe(2);

      // Cleanup
      call1.catch(() => {});
      call2.catch(() => {});
    });
  });

  describe("Message Sequence Numbers", () => {
    test("should add sequence numbers to outgoing messages", async () => {
      await messageHub.publish("test.event", { data: "test" });
      await messageHub.publish("test.event2", { data: "test2" });

      const events = transport.sentMessages.filter(
        (m) => m.type === MessageType.EVENT,
      );

      // All messages should have sequence numbers
      expect(events[0].sequence).toBeDefined();
      expect(events[1].sequence).toBeDefined();

      // Sequence numbers should be monotonically increasing
      expect(events[1].sequence!).toBeGreaterThan(events[0].sequence!);
    });

    test("should maintain sequence across different message types", async () => {
      const call1 = messageHub.call("test.method1", {});
      await new Promise((resolve) => setTimeout(resolve, 5));
      await messageHub.publish("test.event", {});
      await new Promise((resolve) => setTimeout(resolve, 5));
      const call2 = messageHub.call("test.method2", {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sequences = transport.sentMessages.map((m) => m.sequence!);

      // All should have sequences
      expect(sequences.every((seq) => seq !== undefined)).toBe(true);

      // Should be strictly increasing
      for (let i = 1; i < sequences.length; i++) {
        expect(sequences[i]).toBeGreaterThan(sequences[i - 1]);
      }

      // Cleanup
      call1.catch(() => {});
      call2.catch(() => {});
    });
  });

  describe("PING/PONG Handlers", () => {
    test("should respond to PING with PONG", async () => {
      transport.clearSentMessages();

      // Simulate incoming PING
      transport.simulateMessage({
        id: "ping-id",
        type: MessageType.PING,
        sessionId: "test-session",
        method: "heartbeat",
        timestamp: new Date().toISOString(),
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should send PONG response
      const pongMessages = transport.sentMessages.filter(
        (m) => m.type === MessageType.PONG,
      );

      expect(pongMessages.length).toBe(1);
      expect(pongMessages[0].requestId).toBe("ping-id");
      expect(pongMessages[0].sessionId).toBe("test-session");
    });

    test("should handle PONG messages without error", async () => {
      // Should not throw when receiving PONG
      expect(() => {
        transport.simulateMessage({
          id: "pong-id",
          type: MessageType.PONG,
          sessionId: "test-session",
          method: "heartbeat",
          requestId: "original-ping-id",
          timestamp: new Date().toISOString(),
        });
      }).not.toThrow();
    });
  });

  describe("Method Name Validation", () => {
    test("should reject method names with colons", () => {
      expect(() => {
        messageHub.handle("test:invalid.method", async () => ({}));
      }).toThrow();
    });

    test("should accept valid method names", () => {
      expect(() => {
        messageHub.handle("test.valid-method_name", async () => ({}));
      }).not.toThrow();
    });

    test("should reject method names without dots", () => {
      expect(() => {
        messageHub.handle("testinvalid", async () => ({}));
      }).toThrow();
    });

    test("should reject method names starting with dot", () => {
      expect(() => {
        messageHub.handle(".test.invalid", async () => ({}));
      }).toThrow();
    });

    test("should reject method names ending with dot", () => {
      expect(() => {
        messageHub.handle("test.invalid.", async () => ({}));
      }).toThrow();
    });
  });
});
