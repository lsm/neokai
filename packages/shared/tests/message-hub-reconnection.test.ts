/**
 * Test MessageHub reconnection behavior
 *
 * Verifies that subscriptions are properly re-established after reconnection
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { MessageHub } from "../src/message-hub/message-hub.ts";
import { MessageType, createSubscribeMessage } from "../src/message-hub/protocol.ts";
import type { HubMessage, IMessageTransport, ConnectionState } from "../src/message-hub/types.ts";

/**
 * Mock transport for testing
 */
class MockTransport implements IMessageTransport {
  name = "mock-transport";
  private messageHandlers: Set<(message: HubMessage) => void> = new Set();
  private connectionHandlers: Set<(state: ConnectionState, error?: Error) => void> = new Set();
  private state: ConnectionState = "disconnected";
  sentMessages: HubMessage[] = [];

  async initialize(): Promise<void> {
    this.state = "connected";
    this.notifyConnectionHandlers("connected");
  }

  async close(): Promise<void> {
    this.state = "disconnected";
    this.notifyConnectionHandlers("disconnected");
  }

  async send(message: HubMessage): Promise<void> {
    this.sentMessages.push(message);

    // Auto-respond to SUBSCRIBE/UNSUBSCRIBE messages with ACK
    if (message.type === MessageType.SUBSCRIBE || message.type === MessageType.UNSUBSCRIBE) {
      const ackMessage: HubMessage = {
        id: `ack-${message.id}`,
        type: MessageType.RESULT,
        method: message.method,
        sessionId: message.sessionId,
        data: {
          subscribed: message.type === MessageType.SUBSCRIBE,
          method: message.method,
          sessionId: message.sessionId
        },
        timestamp: new Date().toISOString(),
        version: "1.0.0",
        requestId: message.id,
      };

      // Send ACK after a small delay to simulate network
      setTimeout(() => this.receiveMessage(ackMessage), 5);
    }
  }

  onMessage(handler: (message: HubMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onConnectionChange(handler: (state: ConnectionState, error?: Error) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  isReady(): boolean {
    return this.state === "connected";
  }

  getState(): ConnectionState {
    return this.state;
  }

  // Test helpers
  simulateDisconnect(): void {
    this.state = "disconnected";
    this.notifyConnectionHandlers("disconnected");
  }

  simulateReconnect(): void {
    this.state = "connected";
    this.notifyConnectionHandlers("connected");
  }

  receiveMessage(message: HubMessage): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  clearSentMessages(): void {
    this.sentMessages = [];
  }

  private notifyConnectionHandlers(state: ConnectionState, error?: Error): void {
    for (const handler of this.connectionHandlers) {
      handler(state, error);
    }
  }
}

describe("MessageHub Reconnection", () => {
  let hub: MessageHub;
  let transport: MockTransport;

  beforeEach(() => {
    transport = new MockTransport();
    hub = new MessageHub({ debug: true });
  });

  it("should send SUBSCRIBE messages to server after reconnection", async () => {
    // 1. Register transport and initialize
    hub.registerTransport(transport);
    await transport.initialize();

    // 2. Subscribe to an event
    const handler = () => {};
    await hub.subscribe("test.event", handler, { sessionId: "test-session" });

    // Verify initial SUBSCRIBE was sent
    const initialSubscribes = transport.sentMessages.filter(
      (m) => m.type === MessageType.SUBSCRIBE
    );
    expect(initialSubscribes.length).toBe(1);
    expect(initialSubscribes[0].method).toBe("test.event");
    expect(initialSubscribes[0].sessionId).toBe("test-session");

    // 3. Clear sent messages
    transport.clearSentMessages();

    // 4. Simulate disconnect
    transport.simulateDisconnect();
    expect(hub.isConnected()).toBe(false);

    // 5. Simulate reconnect
    transport.simulateReconnect();
    expect(hub.isConnected()).toBe(true);

    // Wait a bit for async resubscribe to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 6. Verify SUBSCRIBE messages were sent again after reconnection
    const resubscribes = transport.sentMessages.filter(
      (m) => m.type === MessageType.SUBSCRIBE
    );

    expect(resubscribes.length).toBeGreaterThan(0);
    const testEventResubscribe = resubscribes.find(
      (m) => m.method === "test.event" && m.sessionId === "test-session"
    );
    expect(testEventResubscribe).toBeDefined();
  });

  it("should send SUBSCRIBE for multiple subscriptions after reconnection", async () => {
    // 1. Setup
    hub.registerTransport(transport);
    await transport.initialize();

    // 2. Subscribe to multiple events
    const handler1 = () => {};
    const handler2 = () => {};
    const handler3 = () => {};

    await hub.subscribe("event.1", handler1, { sessionId: "session-1" });
    await hub.subscribe("event.2", handler2, { sessionId: "session-2" });
    await hub.subscribe("event.3", handler3, { sessionId: "session-1" });

    // 3. Clear and reconnect
    transport.clearSentMessages();
    transport.simulateDisconnect();
    transport.simulateReconnect();

    await new Promise((resolve) => setTimeout(resolve, 10));

    // 4. Verify all subscriptions were re-established
    const resubscribes = transport.sentMessages.filter(
      (m) => m.type === MessageType.SUBSCRIBE
    );

    expect(resubscribes.length).toBe(3);

    const methods = resubscribes.map((m) => m.method).sort();
    expect(methods).toEqual(["event.1", "event.2", "event.3"]);
  });

  it("should handle events after reconnection", async () => {
    // 1. Setup
    hub.registerTransport(transport);
    await transport.initialize();

    // 2. Subscribe to event
    let eventReceived = false;
    const handler = (data: any) => {
      eventReceived = true;
    };

    await hub.subscribe("test.event", handler, { sessionId: "test-session" });

    // 3. Reconnect
    transport.clearSentMessages();
    transport.simulateDisconnect();
    transport.simulateReconnect();

    await new Promise((resolve) => setTimeout(resolve, 10));

    // 4. Receive event after reconnection
    const testEvent: HubMessage = {
      id: "event-1",
      type: MessageType.EVENT,
      method: "test.event",
      sessionId: "test-session",
      data: { message: "test" },
      timestamp: new Date().toISOString(),
      version: "1.0.0",
    };

    transport.receiveMessage(testEvent);

    // Wait for event to be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 5. Verify event was received
    expect(eventReceived).toBe(true);
  });
});
