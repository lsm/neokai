/**
 * Additional tests to achieve 100% coverage for message-hub.ts
 * Focuses on edge cases and uncovered code paths
 */

import { describe, test, expect, beforeEach, afterEach, jest } from "bun:test";
import { MessageHub } from "../src/message-hub/message-hub.ts";
import { MessageHubRouter } from "../src/message-hub/router.ts";
import type {
  IMessageTransport,
  ConnectionState,
} from "../src/message-hub/types.ts";
import {
  MessageType,
  createEventMessage,
  createSubscribeMessage,
  createUnsubscribeMessage,
  createSubscribedMessage,
  createUnsubscribedMessage,
  type HubMessage,
} from "../src/message-hub/protocol.ts";

// Mock transport
class MockTransport implements IMessageTransport {
  name = "mock-transport";
  private messageHandler: ((message: HubMessage) => void) | null = null;
  private connectionHandler:
    | ((state: ConnectionState, error?: Error) => void)
    | null = null;
  private _state: ConnectionState = "connected";
  public sentMessages: HubMessage[] = [];
  public autoAck: boolean = true; // Can be disabled for timeout tests

  async initialize(): Promise<void> {
    // Mock implementation - transport is immediately ready
  }

  async close(): Promise<void> {
    this._state = "disconnected";
  }

  send(message: HubMessage): Promise<void> {
    this.sentMessages.push(message);

    // Auto-respond to SUBSCRIBE/UNSUBSCRIBE messages with ACKs (if enabled)
    if (this.autoAck) {
      if (message.type === MessageType.SUBSCRIBE && this.messageHandler) {
        setTimeout(() => {
          if (this.messageHandler) {
            const ack = createSubscribedMessage({
              method: message.method,
              sessionId: message.sessionId,
              requestId: message.id,
            });
            this.messageHandler(ack);
          }
        }, 10);
      } else if (
        message.type === MessageType.UNSUBSCRIBE &&
        this.messageHandler
      ) {
        setTimeout(() => {
          if (this.messageHandler) {
            const ack = createUnsubscribedMessage({
              method: message.method,
              sessionId: message.sessionId,
              requestId: message.id,
            });
            this.messageHandler(ack);
          }
        }, 10);
      }
    }

    return Promise.resolve();
  }

  onMessage(handler: (message: HubMessage) => void): () => void {
    this.messageHandler = handler;
    return () => {
      this.messageHandler = null;
    };
  }

  onConnectionChange(
    handler: (state: ConnectionState, error?: Error) => void,
  ): () => void {
    this.connectionHandler = handler;
    return () => {
      this.connectionHandler = null;
    };
  }

  getState(): ConnectionState {
    return this._state;
  }

  isReady(): boolean {
    return this._state === "connected";
  }

  // Test helpers
  simulateMessage(message: HubMessage): void {
    if (this.messageHandler) {
      this.messageHandler(message);
    }
  }

  simulateConnectionChange(state: ConnectionState, error?: Error): void {
    this._state = state;
    if (this.connectionHandler) {
      this.connectionHandler(state, error);
    }
  }

  disconnect(): void {
    this._state = "disconnected";
  }

  reconnect(): void {
    this._state = "connected";
    if (this.connectionHandler) {
      this.connectionHandler("connected");
    }
  }
}

describe("MessageHub - Coverage Tests", () => {
  let hub: MessageHub;
  let transport: MockTransport;

  beforeEach(() => {
    hub = new MessageHub({ debug: true });
    transport = new MockTransport();
    hub.registerTransport(transport);
  });

  afterEach(() => {
    hub.cleanup();
  });

  describe("Router Management", () => {
    test("should allow replacing existing router", () => {
      const router1 = new MessageHubRouter();
      const router2 = new MessageHubRouter();

      hub.registerRouter(router1);
      hub.registerRouter(router2); // Should replace without error

      // Verify the second router is now registered
      expect(hub.getRouter()).toBe(router2);
    });

    test("should return registered router", () => {
      const router = new MessageHubRouter();
      hub.registerRouter(router);
      expect(hub.getRouter()).toBe(router);
    });

    test("should return null when no router registered", () => {
      expect(hub.getRouter()).toBeNull();
    });
  });

  describe("Unsubscribe with Timeout", () => {
    test("should handle unsubscribe timeout gracefully", async () => {
      // Create hub with short timeout
      const shortHub = new MessageHub({ timeout: 100, debug: false });
      const shortTransport = new MockTransport();
      shortTransport.autoAck = false; // Disable auto-ACK for timeout test
      shortHub.registerTransport(shortTransport);

      const handler = jest.fn();

      // Subscribe with ACK enabled first
      shortTransport.autoAck = true;
      const unsubscribe = await shortHub.subscribe("test.event", handler, {
        sessionId: "test-session",
      });

      // Now disable ACK for unsubscribe - will timeout
      shortTransport.autoAck = false;

      // Unsubscribe should complete (may timeout but doesn't throw)
      await unsubscribe();

      shortHub.cleanup();
    });

    test("should continue local cleanup even if unsubscribe fails", async () => {
      const handler = jest.fn();
      const unsubscribe = await hub.subscribe("test.event", handler, {
        sessionId: "test-session",
      });

      // Disconnect transport before unsubscribe
      transport.disconnect();

      // Should not throw when disconnected - just does local cleanup
      await unsubscribe();

      // Verify local cleanup happened - handler should be removed from subscriptions
      const count = hub.getSubscriptionCount("test.event", "test-session");
      expect(count).toBe(0);
    });
  });

  describe("Server-side Message Handlers", () => {
    test("should handle SUBSCRIBE message server-side", async () => {
      // These tests verify server-side SUBSCRIBE/UNSUBSCRIBE handling
      // WITHOUT router - just MessageHub direct handling
      // Full routing tests are in message-hub-router.test.ts

      const subscribeMsg = createSubscribeMessage({
        method: "test.event",
        sessionId: "test-session",
        id: "sub-123",
      });

      // Add clientId to message (normally added by transport)
      (subscribeMsg as unknown as { clientId: string }).clientId = "client-1";

      // Register router to enable server-side handling
      const router = new MessageHubRouter();
      hub.registerRouter(router);

      // Register a mock client connection with the router
      const mockConnection = {
        id: "client-1",
        send: jest.fn(),
        isOpen: () => true,
      };
      router.registerConnection(mockConnection);

      // Clear any previous messages
      transport.sentMessages = [];
      transport.autoAck = false; // Disable auto-ACK

      // Simulate incoming SUBSCRIBE
      transport.simulateMessage(subscribeMsg);

      // Wait for async handling
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify the router subscription was registered
      const subCount = router.getSubscriptionCount(
        "test-session",
        "test.event",
      );
      expect(subCount).toBeGreaterThan(0);
    });

    test("should handle UNSUBSCRIBE message server-side", async () => {
      const router = new MessageHubRouter();
      hub.registerRouter(router);

      // Register a mock client connection with the router
      const mockConnection = {
        id: "client-1",
        send: jest.fn(),
        isOpen: () => true,
      };
      router.registerConnection(mockConnection);

      // First subscribe
      const subscribeMsg = createSubscribeMessage({
        method: "test.event",
        sessionId: "test-session",
        id: "sub-123",
      });
      (subscribeMsg as unknown as { clientId: string }).clientId = "client-1";
      transport.autoAck = false;
      transport.simulateMessage(subscribeMsg);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify subscription exists
      let subCount = router.getSubscriptionCount("test-session", "test.event");
      expect(subCount).toBeGreaterThan(0);

      // Now unsubscribe
      const unsubscribeMsg = createUnsubscribeMessage({
        method: "test.event",
        sessionId: "test-session",
        id: "unsub-123",
      });
      (unsubscribeMsg as unknown as { clientId: string }).clientId = "client-1";

      transport.simulateMessage(unsubscribeMsg);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify subscription was removed
      subCount = router.getSubscriptionCount("test-session", "test.event");
      expect(subCount).toBe(0);
    });

    test("should ignore SUBSCRIBE when no router registered", async () => {
      // No router registered
      const subscribeMsg = createSubscribeMessage({
        method: "test.event",
        sessionId: "test-session",
      });

      (subscribeMsg as unknown as { clientId: string }).clientId = "client-1";

      // Should not throw
      transport.simulateMessage(subscribeMsg);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should not send any response
      expect(transport.sentMessages.length).toBe(0);
    });

    test("should handle SUBSCRIBE without clientId gracefully", async () => {
      const router = new MessageHubRouter();
      hub.registerRouter(router);

      const subscribeMsg = createSubscribeMessage({
        method: "test.event",
        sessionId: "test-session",
      });

      // Send SUBSCRIBE without clientId - should be handled gracefully
      expect(() => transport.simulateMessage(subscribeMsg)).not.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    test("should handle UNSUBSCRIBE without clientId gracefully", async () => {
      const router = new MessageHubRouter();
      hub.registerRouter(router);

      const unsubscribeMsg = createUnsubscribeMessage({
        method: "test.event",
        sessionId: "test-session",
      });

      // Send UNSUBSCRIBE without clientId - should be handled gracefully
      expect(() => transport.simulateMessage(unsubscribeMsg)).not.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    test("should handle SUBSCRIBE error and send ERROR response", async () => {
      const router = new MessageHubRouter();
      hub.registerRouter(router);

      // Mock router.subscribe to throw
      const originalSubscribe = router.subscribe.bind(router);
      router.subscribe = () => {
        throw new Error("Subscription failed");
      };

      const subscribeMsg = createSubscribeMessage({
        method: "test.event",
        sessionId: "test-session",
        id: "sub-123",
      });

      (subscribeMsg as unknown as { clientId: string }).clientId = "client-1";

      transport.simulateMessage(subscribeMsg);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have sent ERROR response
      const errors = transport.sentMessages.filter(
        (m) => m.type === MessageType.ERROR,
      );
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].error).toContain("Subscription failed");

      // Restore
      router.subscribe = originalSubscribe;
    });
  });

  describe("PING/PONG Handling", () => {
    test("should respond to PING with PONG", async () => {
      const pingMsg: HubMessage = {
        id: "ping-123",
        type: MessageType.PING,
        sessionId: "test-session",
        method: "heartbeat",
        timestamp: new Date().toISOString(),
      };

      transport.simulateMessage(pingMsg);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have sent PONG
      const pongs = transport.sentMessages.filter(
        (m) => m.type === MessageType.PONG,
      );
      expect(pongs.length).toBe(1);
      expect(pongs[0].requestId).toBe("ping-123");
    });

    test("should handle PONG message", async () => {
      const pongMsg: HubMessage = {
        id: "pong-123",
        type: MessageType.PONG,
        sessionId: "test-session",
        method: "heartbeat",
        requestId: "ping-123",
        timestamp: new Date().toISOString(),
      };

      // Should not throw
      transport.simulateMessage(pongMsg);

      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  });

  describe("Event Depth Tracking Cleanup", () => {
    test("should cleanup event depth map after handling", async () => {
      const handler = jest.fn();
      await hub.subscribe("test.event", handler, { sessionId: "test-session" });

      const eventMsg = createEventMessage({
        method: "test.event",
        data: { test: true },
        sessionId: "test-session",
      });

      transport.simulateMessage(eventMsg);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Depth map should be cleaned up
      expect(hub["eventDepthMap"].size).toBe(0);
    });

    test("should cleanup depth map even if handler throws", async () => {
      const handler = jest.fn(() => {
        throw new Error("Handler error");
      });

      await hub.subscribe("test.event", handler, { sessionId: "test-session" });

      const eventMsg = createEventMessage({
        method: "test.event",
        data: { test: true },
        sessionId: "test-session",
      });

      const originalError = console.error;
      console.error = jest.fn(); // Suppress error logs

      transport.simulateMessage(eventMsg);

      await new Promise((resolve) => setTimeout(resolve, 50));

      console.error = originalError;

      // Depth map should still be cleaned up
      expect(hub["eventDepthMap"].size).toBe(0);
    });
  });

  describe("Subscription Timeout Edge Cases", () => {
    test("should handle subscription timeout during subscribe", async () => {
      const shortHub = new MessageHub({ timeout: 50, debug: false });
      const shortTransport = new MockTransport();
      shortTransport.autoAck = false; // Disable auto-ACK for timeout test
      shortHub.registerTransport(shortTransport);

      const handler = jest.fn();

      // Don't send SUBSCRIBED response - let it timeout
      let timeoutError: Error | null = null;
      try {
        await shortHub.subscribe("test.event", handler, {
          sessionId: "test-session",
        });
      } catch (error) {
        timeoutError = error as Error;
      }

      expect(timeoutError).toBeTruthy();
      expect(timeoutError?.message).toContain("Subscription timeout");

      shortHub.cleanup();
    });
  });

  describe("Resubscription Error Handling", () => {
    test("should handle failed SUBSCRIBE during reconnection", async () => {
      // This tests the error handler in resubscribeAll() at lines 1147-1150
      const handler = jest.fn();

      // Subscribe initially
      await hub.subscribe("test.event", handler, { sessionId: "test-session" });

      // Mock sendMessage to throw error during resubscription
      const originalSendMessage = hub["sendMessage"].bind(hub);
      hub["sendMessage"] = async (message: HubMessage) => {
        // Only fail for SUBSCRIBE messages during resubscription
        if (message.type === MessageType.SUBSCRIBE) {
          throw new Error("Failed to send SUBSCRIBE");
        }
        return originalSendMessage(message);
      };

      // Trigger reconnection (this calls resubscribeAll)
      transport.simulateConnectionChange("disconnected");
      await new Promise((resolve) => setTimeout(resolve, 10));
      transport.simulateConnectionChange("connected");

      // Wait for resubscription attempt
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Restore
      hub["sendMessage"] = originalSendMessage;

      // Should handle error gracefully - connection remains active
      expect(transport["_state"]).toBe("connected");
    });
  });

  describe("Additional Utility Methods", () => {
    test("should get pending call count", () => {
      expect(hub.getPendingCallCount()).toBe(0);

      // Make a call (won't complete because no handler)
      hub.call("test.method", {}).catch(() => {});

      expect(hub.getPendingCallCount()).toBe(1);
    });

    test("should get subscription count", async () => {
      const handler = jest.fn();
      await hub.subscribe("test.event", handler, { sessionId: "test-session" });

      expect(hub.getSubscriptionCount("test.event", "test-session")).toBe(1);
      expect(hub.getSubscriptionCount("other.event", "test-session")).toBe(0);
    });
  });
});
