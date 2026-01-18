import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { MessageHub } from "../src/message-hub/message-hub";
import type {
  IMessageTransport,
  ConnectionState,
  HubMessage,
} from "../src/message-hub/types";
import {
  MessageType,
  createCallMessage,
  createResultMessage,
  createErrorMessage,
  createEventMessage,
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

  async connect(): Promise<void> {
    this.state = "connected";
    this.notifyStateChange("connected");
  }

  async disconnect(): Promise<void> {
    this.state = "disconnected";
    this.notifyStateChange("disconnected");
  }

  async send(message: HubMessage): Promise<void> {
    this.sentMessages.push(message);

    // Auto-respond to SUBSCRIBE/UNSUBSCRIBE messages (simulate server ACK)
    if (
      message.type === MessageType.SUBSCRIBE ||
      message.type === MessageType.UNSUBSCRIBE
    ) {
      // Send ACK response immediately
      setTimeout(() => {
        const ackMessage = {
          id: `ack-${message.id}`,
          type:
            message.type === MessageType.SUBSCRIBE
              ? MessageType.SUBSCRIBED
              : MessageType.UNSUBSCRIBED,
          sessionId: message.sessionId,
          method: message.method,
          requestId: message.id,
          data: {
            [message.type === MessageType.SUBSCRIBE
              ? "subscribed"
              : "unsubscribed"]: true,
            method: message.method,
            sessionId: message.sessionId,
          },
          timestamp: new Date().toISOString(),
        };
        this.simulateMessage(ackMessage);
      }, 0);
    }
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

describe("MessageHub", () => {
  let messageHub: MessageHub;
  let transport: MockTransport;

  beforeEach(async () => {
    messageHub = new MessageHub({
      defaultSessionId: "test-session",
      debug: false,
    });

    transport = new MockTransport();
    messageHub.registerTransport(transport);
    await transport.connect();
  });

  afterEach(() => {
    messageHub.cleanup();
  });

  describe("Transport Management", () => {
    test("should register transport successfully", () => {
      const newHub = new MessageHub({ defaultSessionId: "test" });
      const newTransport = new MockTransport();

      newHub.registerTransport(newTransport);

      expect((newHub as unknown as { transport: unknown }).transport).toBe(
        newTransport,
      );
    });

    test("should unregister transport successfully", () => {
      const newHub = new MessageHub({ defaultSessionId: "test" });
      const newTransport = new MockTransport();

      const unregister = newHub.registerTransport(newTransport);
      expect((newHub as unknown as { transport: unknown }).transport).toBe(
        newTransport,
      );

      unregister();
      expect((newHub as unknown as { transport: unknown }).transport).toBe(
        null,
      );
    });

    test("should throw error when registering multiple transports", () => {
      const newTransport = new MockTransport();

      expect(() => {
        messageHub.registerTransport(newTransport);
      }).toThrow("Transport already registered");
    });

    test("should return disconnected state when no transport registered", () => {
      const newHub = new MessageHub({ defaultSessionId: "test" });
      expect(newHub.getState()).toBe("disconnected");
    });

    test("should handle connection state changes", async () => {
      const stateChanges: ConnectionState[] = [];
      messageHub.onConnection((state) => {
        stateChanges.push(state);
      });

      transport.simulateStateChange("connecting");
      transport.simulateStateChange("connected");
      transport.simulateStateChange("disconnected");

      // Small delay to allow handlers to execute
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(stateChanges).toContain("connecting");
      expect(stateChanges).toContain("connected");
      expect(stateChanges).toContain("disconnected");
    });

    test("should unsubscribe from connection state changes", async () => {
      const stateChanges: ConnectionState[] = [];
      const unsubscribe = messageHub.onConnection((state) => {
        stateChanges.push(state);
      });

      transport.simulateStateChange("connecting");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(stateChanges).toContain("connecting");

      unsubscribe();
      stateChanges.length = 0; // Clear array

      transport.simulateStateChange("disconnected");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(stateChanges).not.toContain("disconnected");
    });

    test("should return correct connection state", () => {
      expect(messageHub.isConnected()).toBe(true);

      transport.simulateStateChange("disconnected");
      expect(messageHub.isConnected()).toBe(false);

      transport.simulateStateChange("connecting");
      expect(messageHub.isConnected()).toBe(false);
    });
  });

  describe("RPC - Method Handlers", () => {
    test("should register RPC handler", () => {
      const handler = mock(async (_data: unknown) => ({ result: "success" }));

      messageHub.handle("test.method", handler);

      expect(
        (
          messageHub as unknown as { rpcHandlers: Map<string, unknown> }
        ).rpcHandlers.has("test.method"),
      ).toBe(true);
    });

    test("should execute RPC handler when call message received", async () => {
      const handler = mock(async (data: { message?: string }) => {
        return { echo: data.message };
      });

      messageHub.handle("test.echo", handler);

      const callMessage = createCallMessage({
        method: "test.echo",
        data: { message: "hello" },
        sessionId: "test-session",
      });

      transport.simulateMessage(callMessage);

      // Wait for async handler
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handler).toHaveBeenCalledWith(
        { message: "hello" },
        expect.objectContaining({
          sessionId: "test-session",
          method: "test.echo",
        }),
      );

      // Check that result was sent back
      const sentMessages = transport.sentMessages;
      const resultMessage = sentMessages.find(
        (msg) =>
          msg.type === MessageType.RESULT && msg.requestId === callMessage.id,
      );

      expect(resultMessage).toBeDefined();
      expect(resultMessage?.data).toEqual({ echo: "hello" });
    });

    test("should send error response when handler throws", async () => {
      const handler = mock(async () => {
        throw new Error("Handler failed");
      });

      messageHub.handle("test.error", handler);

      const callMessage = createCallMessage({
        method: "test.error",
        data: {},
        sessionId: "test-session",
      });

      transport.simulateMessage(callMessage);

      // Wait for async handler
      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessages = transport.sentMessages;
      const errorMessage = sentMessages.find(
        (msg) =>
          msg.type === MessageType.ERROR && msg.requestId === callMessage.id,
      );

      expect(errorMessage).toBeDefined();
      expect(errorMessage?.error).toContain("Handler failed");
    });

    test("should unregister RPC handler", () => {
      const handler = mock(async () => ({}));

      const unregister = messageHub.handle("test.method", handler);
      expect(
        (
          messageHub as unknown as { rpcHandlers: Map<string, unknown> }
        ).rpcHandlers.has("test.method"),
      ).toBe(true);

      unregister();
      expect(
        (
          messageHub as unknown as { rpcHandlers: Map<string, unknown> }
        ).rpcHandlers.has("test.method"),
      ).toBe(false);
    });
  });

  describe("RPC - Method Calls", () => {
    test("should send call message and receive result", async () => {
      const callPromise = messageHub.call("test.method", { value: 42 });

      // Simulate receiving result
      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessage = transport.sentMessages[0];
      expect(sentMessage.type).toBe(MessageType.CALL);
      expect(sentMessage.method).toBe("test.method");
      expect(sentMessage.data).toEqual({ value: 42 });

      // Simulate result from server
      const resultMessage = createResultMessage({
        method: sentMessage.method,
        data: { result: "success" },
        sessionId: sentMessage.sessionId,
        requestId: sentMessage.id, // Link back to the CALL message
      });

      transport.simulateMessage(resultMessage);

      const result = await callPromise;
      expect(result).toEqual({ result: "success" });
    });

    test("should handle RPC call timeout", async () => {
      const callPromise = messageHub.call("test.timeout", {}, { timeout: 100 });

      await expect(callPromise).rejects.toThrow("RPC timeout");
    });

    test("should receive error response for failed call", async () => {
      const callPromise = messageHub.call("test.error", {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessage = transport.sentMessages[0];

      // Simulate error from server
      const errorMessage = createErrorMessage({
        method: sentMessage.method,
        error: {
          code: "INTERNAL_ERROR",
          message: "Something went wrong",
        },
        sessionId: sentMessage.sessionId,
        requestId: sentMessage.id, // Link back to the CALL message
      });

      transport.simulateMessage(errorMessage);

      await expect(callPromise).rejects.toThrow("Something went wrong");
    });

    test("should throw error when not connected", async () => {
      transport.simulateStateChange("disconnected");

      await expect(messageHub.call("test.method", {})).rejects.toThrow(
        "Not connected to transport",
      );
    });

    test("should handle sendMessage error in call", async () => {
      // Create a transport that throws on send
      class FailingTransport extends MockTransport {
        async send(_message: HubMessage): Promise<void> {
          throw new Error("Transport send failed");
        }
      }

      const newHub = new MessageHub({ defaultSessionId: "test" });
      const failingTransport = new FailingTransport();
      newHub.registerTransport(failingTransport);
      await failingTransport.connect();

      await expect(newHub.call("test.method", {})).rejects.toThrow(
        "Transport send failed",
      );
    });

    test("should use custom session ID in call", async () => {
      const callPromise = messageHub.call(
        "test.method",
        {},
        { sessionId: "custom-session" },
      );

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessage = transport.sentMessages[0];
      expect(sentMessage.sessionId).toBe("custom-session");

      // Clean up pending call
      const resultMessage = createResultMessage({
        method: sentMessage.method,
        data: {},
        sessionId: sentMessage.sessionId,
        requestId: sentMessage.id, // Link back to the CALL message
      });
      transport.simulateMessage(resultMessage);
      await callPromise;
    });
  });

  describe("Pub/Sub - Publishing", () => {
    test("should publish event message", async () => {
      await messageHub.publish("user.created", { userId: "123" });

      const sentMessage = transport.sentMessages[0];
      expect(sentMessage.type).toBe(MessageType.EVENT);
      expect(sentMessage.method).toBe("user.created");
      expect(sentMessage.data).toEqual({ userId: "123" });
    });

    test("should use custom session ID when publishing", async () => {
      await messageHub.publish(
        "user.created",
        { userId: "123" },
        { sessionId: "custom-session" },
      );

      const sentMessage = transport.sentMessages[0];
      expect(sentMessage.sessionId).toBe("custom-session");
    });

    test("should not throw when publishing while disconnected (skips send)", async () => {
      transport.simulateStateChange("disconnected");

      // Should not throw, just skip sending
      await messageHub.publish("test.event", {});

      // No message should be sent
      expect(transport.sentMessages.length).toBe(0);
    });
  });

  describe("Pub/Sub - Subscribing", () => {
    test("should subscribe to event pattern", async () => {
      const handler = mock((_data: unknown) => {});

      await messageHub.subscribe("user.created", handler, {
        sessionId: "test-session",
      });

      const sessionSubs = (
        messageHub as unknown as {
          subscriptions: Map<string, Map<string, unknown>>;
        }
      ).subscriptions.get("test-session");
      expect(sessionSubs).toBeDefined();
      expect(sessionSubs?.has("user.created")).toBe(true);
    });

    test("should receive events matching subscription", async () => {
      const handler = mock((_data: unknown) => {});

      await messageHub.subscribe("user.created", handler);

      const eventMessage = createEventMessage({
        method: "user.created",
        data: { userId: "123" },
        sessionId: "test-session",
      });

      transport.simulateMessage(eventMessage);

      expect(handler).toHaveBeenCalledWith(
        { userId: "123" },
        expect.objectContaining({
          method: "user.created",
          sessionId: "test-session",
        }),
      );
    });

    test("should support wildcard subscriptions", async () => {
      const handler = mock((_data: unknown) => {});

      // Subscribe to specific methods and manually test wildcard pattern matching
      await messageHub.subscribe("user.created", handler);
      await messageHub.subscribe("user.updated", handler);

      const event1 = createEventMessage({
        method: "user.created",
        data: { userId: "123" },
        sessionId: "test-session",
      });

      const event2 = createEventMessage({
        method: "user.updated",
        data: { userId: "123" },
        sessionId: "test-session",
      });

      transport.simulateMessage(event1);
      transport.simulateMessage(event2);

      expect(handler).toHaveBeenCalledTimes(2);
    });

    test("should unsubscribe from events", async () => {
      const handler = mock((_data: unknown) => {});

      const unsubscribe = await messageHub.subscribe("user.created", handler);

      await unsubscribe();

      const eventMessage = createEventMessage({
        method: "user.created",
        data: { userId: "123" },
        sessionId: "test-session",
      });

      transport.simulateMessage(eventMessage);

      expect(handler).not.toHaveBeenCalled();
    });

    test("should track subscriptions internally", async () => {
      const handler = mock(() => {});
      await messageHub.subscribe("user.created", handler, {
        sessionId: "test-session",
      });

      const sessionSubs = (
        messageHub as unknown as {
          subscriptions: Map<string, Map<string, unknown>>;
        }
      ).subscriptions.get("test-session");
      expect(sessionSubs).toBeDefined();
      expect(sessionSubs?.has("user.created")).toBe(true);
    });

    test("should remove subscriptions on unsubscribe", async () => {
      const handler = mock(() => {});
      const unsubscribe = await messageHub.subscribe("user.created", handler, {
        sessionId: "test-session",
      });

      // Verify subscription exists first
      let sessionSubs = (
        messageHub as unknown as {
          subscriptions: Map<string, Map<string, unknown>>;
        }
      ).subscriptions.get("test-session");
      expect(sessionSubs?.has("user.created")).toBe(true);

      await unsubscribe();

      // After unsubscribe, the method should be removed from the set
      sessionSubs = (
        messageHub as unknown as {
          subscriptions: Map<string, Map<string, unknown>>;
        }
      ).subscriptions.get("test-session");
      const handlers = sessionSubs?.get("user.created") as
        | Set<unknown>
        | undefined;
      expect(!handlers || handlers.size === 0).toBe(true);
    });
  });

  describe("Hybrid - Call and Publish", () => {
    test("should execute RPC call and publish event", async () => {
      const handler = mock(async (_data: unknown) => {
        return { result: "success" };
      });

      messageHub.handle("user.create", handler);

      // Use call() directly and then publish separately to test the pattern
      const callPromise = messageHub.call("user.create", { name: "John" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should have CALL message
      const callMessage = transport.sentMessages.find(
        (msg) => msg.type === MessageType.CALL && msg.method === "user.create",
      );
      expect(callMessage).toBeDefined();

      // Simulate result to resolve the promise
      const resultMessage = createResultMessage({
        method: callMessage!.method,
        data: { result: "success" },
        sessionId: callMessage!.sessionId,
        requestId: callMessage!.id, // Link back to the CALL message
      });

      transport.simulateMessage(resultMessage);

      const result = await callPromise;
      expect(result).toEqual({ result: "success" });

      // Manually publish after call succeeds
      await messageHub.publish("user.created", { userId: "123" });

      // Should have EVENT message
      const eventMessage = transport.sentMessages.find(
        (msg) =>
          msg.type === MessageType.EVENT && msg.method === "user.created",
      );
      expect(eventMessage).toBeDefined();
    });

    test("should not publish if RPC call fails", async () => {
      transport.clearSentMessages();

      const callPromise = messageHub.callAndPublish(
        "test.fail",
        "test.event",
        {},
      );

      await new Promise((resolve) => setTimeout(resolve, 10));

      const callMessage = transport.sentMessages.find(
        (msg) => msg.type === MessageType.CALL,
      );

      // Simulate error
      const errorMessage = createErrorMessage({
        method: callMessage!.method,
        error: { code: "INTERNAL_ERROR", message: "Failed" },
        sessionId: callMessage!.sessionId,
        requestId: callMessage!.id, // Link back to the CALL message
      });

      transport.simulateMessage(errorMessage);

      await expect(callPromise).rejects.toThrow();

      // Should NOT have EVENT message
      const eventMessage = transport.sentMessages.find(
        (msg) => msg.type === MessageType.EVENT,
      );
      expect(eventMessage).toBeUndefined();
    });
  });

  describe("Message Routing", () => {
    test("should route messages to correct handlers", async () => {
      const rpcHandler = mock(async () => ({}));
      const eventHandler = mock(() => {});

      messageHub.handle("test.rpc", rpcHandler);
      await messageHub.subscribe("test.event", eventHandler);

      // Send RPC call
      const callMessage = createCallMessage({
        method: "test.rpc",
        data: {},
        sessionId: "test-session",
      });
      transport.simulateMessage(callMessage);

      // Send event
      const eventMessage = createEventMessage({
        method: "test.event",
        data: {},
        sessionId: "test-session",
      });
      transport.simulateMessage(eventMessage);

      expect(rpcHandler).toHaveBeenCalled();
      expect(eventHandler).toHaveBeenCalled();
    });

    test("should handle result messages for pending calls", async () => {
      const callPromise = messageHub.call("test.method", {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentMessage = transport.sentMessages[0];
      const resultMessage = createResultMessage({
        method: sentMessage.method,
        data: { value: 42 },
        sessionId: sentMessage.sessionId,
        requestId: sentMessage.id, // Link back to the CALL message
      });

      transport.simulateMessage(resultMessage);

      const result = await callPromise;
      expect(result).toEqual({ value: 42 });
    });

    test("should ignore result for unknown call ID", () => {
      const resultMessage = createResultMessage({
        method: "test.method",
        data: {},
        sessionId: "test-session",
        requestId: "unknown-id", // Non-existent request ID
      });

      // Should not throw
      expect(() => {
        transport.simulateMessage(resultMessage);
      }).not.toThrow();
    });

    test("should unsubscribe from onMessage handler on transport unregister", () => {
      const newHub = new MessageHub({ defaultSessionId: "test" });
      const newTransport = new MockTransport();

      const unregister = newHub.registerTransport(newTransport);

      // Verify transport is registered
      expect((newHub as unknown as { transport: unknown }).transport).toBe(
        newTransport,
      );

      // Verify transport has message handlers registered
      expect(newTransport["messageHandlers"].size).toBe(1);

      // Unregister transport
      unregister();

      // Verify transport is unregistered
      expect((newHub as unknown as { transport: unknown }).transport).toBe(
        null,
      );

      // Verify transport's message handlers are removed
      expect(newTransport["messageHandlers"].size).toBe(0);
    });
  });

  describe("Message Inspection", () => {
    test("should call message handler for incoming and outgoing messages", async () => {
      const handler = mock(() => {});
      messageHub.onMessage(handler);

      // Send a call (outgoing)
      const callPromise = messageHub.call("test.method", {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should have been called for outgoing CALL message
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.CALL,
          method: "test.method",
        }),
        "out",
      );

      // Simulate result (incoming)
      const sentMessage = transport.sentMessages[0];
      const resultMessage = createResultMessage({
        method: sentMessage.method,
        data: {},
        sessionId: sentMessage.sessionId,
        requestId: sentMessage.id,
      });

      transport.simulateMessage(resultMessage);

      // Should have been called for incoming RESULT message
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.RESULT,
        }),
        "in",
      );

      await callPromise;
    });

    test("should unsubscribe from message handler", async () => {
      const handler = mock(() => {});
      const unsubscribe = messageHub.onMessage(handler);

      // Send a message
      await messageHub.publish("test.event", {});

      // Handler should have been called
      expect(handler).toHaveBeenCalled();

      // Clear mock
      handler.mockClear();

      // Unsubscribe
      unsubscribe();

      // Send another message
      await messageHub.publish("test.event2", {});

      // Handler should NOT have been called
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("Cleanup and Disposal", () => {
    test("should cleanup pending calls on cleanup", async () => {
      const _call1 = messageHub.call("test.method1", {}).catch(() => {}); // Ignore rejection
      const _call2 = messageHub.call("test.method2", {}).catch(() => {}); // Ignore rejection

      await new Promise((resolve) => setTimeout(resolve, 10));

      messageHub.cleanup();

      expect(
        (messageHub as unknown as { pendingCalls: Map<string, unknown> })
          .pendingCalls.size,
      ).toBe(0);
    });

    test("should clear all handlers on cleanup", async () => {
      messageHub.handle("test.rpc", async () => ({}));
      await messageHub.subscribe("test.event", () => {});

      messageHub.cleanup();

      expect(
        (messageHub as unknown as { rpcHandlers: Map<string, unknown> })
          .rpcHandlers.size,
      ).toBe(0);
      expect(
        (messageHub as unknown as { subscriptions: Map<string, unknown> })
          .subscriptions.size,
      ).toBe(0);
    });

    test("should remove connection state handlers on cleanup", () => {
      messageHub.onConnection(() => {});

      messageHub.cleanup();

      expect(
        (messageHub as unknown as { connectionStateHandlers: Set<unknown> })
          .connectionStateHandlers.size,
      ).toBe(0);
    });

    test("should clear message inspection handlers on cleanup", () => {
      messageHub.onMessage(() => {});

      messageHub.cleanup();

      expect(
        (messageHub as unknown as { messageHandlers: Set<unknown> })
          .messageHandlers.size,
      ).toBe(0);
    });
  });

  // Debug Mode tests removed - logging has been intentionally reduced to minimize CI noise
  // The debug option is accepted but no longer used for console logging

  describe("Optimistic Subscriptions (Non-blocking)", () => {
    test("should subscribe synchronously and return immediately", () => {
      const handler = mock((_data: unknown) => {});

      const start = Date.now();
      const unsubscribe = messageHub.subscribeOptimistic(
        "user.created",
        handler,
        {
          sessionId: "test-session",
        },
      );
      const elapsed = Date.now() - start;

      // Should return immediately (< 10ms)
      expect(elapsed).toBeLessThan(10);
      expect(typeof unsubscribe).toBe("function");
    });

    test("should register handler locally immediately", () => {
      const handler = mock((_data: unknown) => {});

      messageHub.subscribeOptimistic("user.created", handler, {
        sessionId: "test-session",
      });

      const sessionSubs = (
        messageHub as unknown as {
          subscriptions: Map<string, Map<string, Set<unknown>>>;
        }
      ).subscriptions.get("test-session");
      expect(sessionSubs).toBeDefined();
      expect(sessionSubs?.has("user.created")).toBe(true);
      expect(sessionSubs?.get("user.created")?.has(handler)).toBe(true);
    });

    test("should receive events matching subscription", async () => {
      const handler = mock((_data: unknown) => {});

      messageHub.subscribeOptimistic("user.created", handler, {
        sessionId: "test-session",
      });

      const eventMessage = createEventMessage({
        method: "user.created",
        data: { userId: "123" },
        sessionId: "test-session",
      });

      transport.simulateMessage(eventMessage);

      expect(handler).toHaveBeenCalledWith(
        { userId: "123" },
        expect.objectContaining({
          method: "user.created",
          sessionId: "test-session",
        }),
      );
    });

    test("should send SUBSCRIBE message to server in background", async () => {
      const handler = mock((_data: unknown) => {});

      transport.clearSentMessages();
      messageHub.subscribeOptimistic("user.created", handler, {
        sessionId: "test-session",
      });

      // Wait for background send
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should have sent SUBSCRIBE message
      const subscribeMsg = transport.sentMessages.find(
        (msg) =>
          msg.type === MessageType.SUBSCRIBE && msg.method === "user.created",
      );
      expect(subscribeMsg).toBeDefined();
      expect(subscribeMsg?.sessionId).toBe("test-session");
    });

    test("should unsubscribe synchronously", async () => {
      const handler = mock((_data: unknown) => {});

      const unsubscribe = messageHub.subscribeOptimistic(
        "user.created",
        handler,
        {
          sessionId: "test-session",
        },
      );

      const start = Date.now();
      unsubscribe();
      const elapsed = Date.now() - start;

      // Should be synchronous (< 10ms)
      expect(elapsed).toBeLessThan(10);

      // Handler should be removed
      const eventMessage = createEventMessage({
        method: "user.created",
        data: { userId: "123" },
        sessionId: "test-session",
      });
      transport.simulateMessage(eventMessage);

      expect(handler).not.toHaveBeenCalled();
    });

    test("should send UNSUBSCRIBE message to server in background", async () => {
      const handler = mock((_data: unknown) => {});

      const unsubscribe = messageHub.subscribeOptimistic(
        "user.created",
        handler,
        {
          sessionId: "test-session",
        },
      );

      transport.clearSentMessages();
      unsubscribe();

      // Wait for background send
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should have sent UNSUBSCRIBE message
      const unsubscribeMsg = transport.sentMessages.find(
        (msg) =>
          msg.type === MessageType.UNSUBSCRIBE && msg.method === "user.created",
      );
      expect(unsubscribeMsg).toBeDefined();
    });

    test("should persist subscription for auto-resubscription", () => {
      const handler = mock((_data: unknown) => {});

      messageHub.subscribeOptimistic("user.created", handler, {
        sessionId: "test-session",
      });

      const persistedSubs = (
        messageHub as unknown as {
          persistedSubscriptions: Map<string, unknown>;
        }
      ).persistedSubscriptions;
      expect(persistedSubs.size).toBeGreaterThan(0);
    });

    test("should work when not connected (local-only subscription)", async () => {
      transport.simulateStateChange("disconnected");

      const handler = mock((_data: unknown) => {});

      // Should not throw
      const unsubscribe = messageHub.subscribeOptimistic(
        "user.created",
        handler,
        {
          sessionId: "test-session",
        },
      );
      expect(typeof unsubscribe).toBe("function");

      // Handler should be registered locally
      const sessionSubs = (
        messageHub as unknown as {
          subscriptions: Map<string, Map<string, Set<unknown>>>;
        }
      ).subscriptions.get("test-session");
      expect(sessionSubs?.get("user.created")?.has(handler)).toBe(true);

      unsubscribe();
    });

    test("should throw for invalid method name", () => {
      const handler = mock((_data: unknown) => {});

      expect(() => {
        messageHub.subscribeOptimistic("", handler);
      }).toThrow("Invalid method name");
    });

    test("should support multiple handlers for same event", async () => {
      const handler1 = mock((_data: unknown) => {});
      const handler2 = mock((_data: unknown) => {});

      messageHub.subscribeOptimistic("user.created", handler1, {
        sessionId: "test-session",
      });
      messageHub.subscribeOptimistic("user.created", handler2, {
        sessionId: "test-session",
      });

      const eventMessage = createEventMessage({
        method: "user.created",
        data: { userId: "123" },
        sessionId: "test-session",
      });

      transport.simulateMessage(eventMessage);

      // Wait for async event handling to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    test("should use default session ID when not specified", () => {
      const handler = mock((_data: unknown) => {});

      messageHub.subscribeOptimistic("user.created", handler);

      // Default session ID is 'test-session' from beforeEach
      const sessionSubs = (
        messageHub as unknown as {
          subscriptions: Map<string, Map<string, Set<unknown>>>;
        }
      ).subscriptions.get("test-session");
      expect(sessionSubs?.get("user.created")?.has(handler)).toBe(true);
    });
  });

  describe("Utility Methods", () => {
    test("should get pending call count", async () => {
      // No pending calls initially
      expect(messageHub.getPendingCallCount()).toBe(0);

      // Create some pending calls
      const call1 = messageHub.call("test.method1", {});
      const call2 = messageHub.call("test.method2", {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(messageHub.getPendingCallCount()).toBe(2);

      // Resolve one call
      const sentMessage1 = transport.sentMessages[0];
      transport.simulateMessage(
        createResultMessage({
          method: sentMessage1.method,
          data: {},
          sessionId: sentMessage1.sessionId,
          requestId: sentMessage1.id,
        }),
      );

      await call1;
      expect(messageHub.getPendingCallCount()).toBe(1);

      // Resolve second call
      const sentMessage2 = transport.sentMessages[1];
      transport.simulateMessage(
        createResultMessage({
          method: sentMessage2.method,
          data: {},
          sessionId: sentMessage2.sessionId,
          requestId: sentMessage2.id,
        }),
      );

      await call2;
      expect(messageHub.getPendingCallCount()).toBe(0);
    });

    test("should get subscription count", async () => {
      // Add subscriptions
      const unsub1 = await messageHub.subscribe("user.created", () => {});
      expect(messageHub.getSubscriptionCount("user.created")).toBe(1);

      const unsub2 = await messageHub.subscribe("user.updated", () => {});
      expect(messageHub.getSubscriptionCount("user.updated")).toBe(1);

      const unsub3 = await messageHub.subscribe("user.deleted", () => {});
      expect(messageHub.getSubscriptionCount("user.deleted")).toBe(1);

      // Multiple handlers for same event
      const unsub4 = await messageHub.subscribe("user.created", () => {});
      expect(messageHub.getSubscriptionCount("user.created")).toBe(2);

      // Unsubscribe
      await unsub1();
      expect(messageHub.getSubscriptionCount("user.created")).toBe(1);

      await unsub4();
      expect(messageHub.getSubscriptionCount("user.created")).toBe(0);

      await unsub2();
      expect(messageHub.getSubscriptionCount("user.updated")).toBe(0);

      await unsub3();
      expect(messageHub.getSubscriptionCount("user.deleted")).toBe(0);
    });
  });
});
