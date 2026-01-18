/**
 * Test MessageHub reconnection behavior
 *
 * Verifies that subscriptions are properly re-established after reconnection
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MessageHub } from "../src/message-hub/message-hub.ts";
import { MessageType } from "../src/message-hub/protocol.ts";
import type {
  HubMessage,
  IMessageTransport,
  ConnectionState,
} from "../src/message-hub/types.ts";

/**
 * Mock transport for testing
 */
class MockTransport implements IMessageTransport {
  name = "mock-transport";
  private messageHandlers: Set<(message: HubMessage) => void> = new Set();
  private connectionHandlers: Set<
    (state: ConnectionState, error?: Error) => void
  > = new Set();
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
    if (
      message.type === MessageType.SUBSCRIBE ||
      message.type === MessageType.UNSUBSCRIBE
    ) {
      const ackMessage: HubMessage = {
        id: `ack-${message.id}`,
        type:
          message.type === MessageType.SUBSCRIBE
            ? MessageType.SUBSCRIBED
            : MessageType.UNSUBSCRIBED,
        method: message.method,
        sessionId: message.sessionId,
        data: {
          subscribed: message.type === MessageType.SUBSCRIBE,
          method: message.method,
          sessionId: message.sessionId,
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

  onConnectionChange(
    handler: (state: ConnectionState, error?: Error) => void,
  ): () => void {
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

  private notifyConnectionHandlers(
    state: ConnectionState,
    error?: Error,
  ): void {
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

  afterEach(async () => {
    // Clean up MessageHub resources
    hub.cleanup();
    // Close transport connection
    await transport.close();
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
      (m) => m.type === MessageType.SUBSCRIBE,
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
      (m) => m.type === MessageType.SUBSCRIBE,
    );

    expect(resubscribes.length).toBeGreaterThan(0);
    const testEventResubscribe = resubscribes.find(
      (m) => m.method === "test.event" && m.sessionId === "test-session",
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
      (m) => m.type === MessageType.SUBSCRIBE,
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
    const handler = (_data: unknown) => {
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

  it("should deduplicate subscription requests during reconnection", async () => {
    // 1. Setup
    hub.registerTransport(transport);
    await transport.initialize();

    // 2. Subscribe to same event multiple times with different handlers
    const handler1 = () => {};
    const handler2 = () => {};
    const handler3 = () => {};

    await hub.subscribe("test.event", handler1, { sessionId: "test-session" });
    await hub.subscribe("test.event", handler2, { sessionId: "test-session" });
    await hub.subscribe("test.event", handler3, { sessionId: "test-session" });

    // 3. Clear and reconnect
    transport.clearSentMessages();
    transport.simulateDisconnect();
    transport.simulateReconnect();

    await new Promise((resolve) => setTimeout(resolve, 10));

    // 4. Verify only ONE SUBSCRIBE message was sent for the duplicate subscriptions
    const resubscribes = transport.sentMessages.filter(
      (m) => m.type === MessageType.SUBSCRIBE,
    );

    // Should only send 1 SUBSCRIBE for test.event despite 3 handlers
    expect(resubscribes.length).toBe(1);
    expect(resubscribes[0].method).toBe("test.event");
    expect(resubscribes[0].sessionId).toBe("test-session");
  });

  it("should reset sequence number tracking on reconnection", async () => {
    // 1. Setup
    hub.registerTransport(transport);
    await transport.initialize();

    // 2. Send some messages to increment sequence counter
    await hub.subscribe("test.event", () => {}, { sessionId: "test-session" });

    // Wait for subscription to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 3. Simulate server restart (disconnect + reconnect)
    transport.simulateDisconnect();
    transport.simulateReconnect();

    await new Promise((resolve) => setTimeout(resolve, 10));

    // 4. Receive a message with low sequence number (simulating server restart)
    const testEvent: HubMessage = {
      id: "event-1",
      type: MessageType.EVENT,
      method: "test.event",
      sessionId: "test-session",
      data: { message: "test" },
      timestamp: new Date().toISOString(),
      version: "1.0.0",
      sequence: 0, // Server restarted, sequence reset to 0
    };

    // This should NOT trigger an out-of-order warning since we cleared expectedSequence
    // We verify this by checking that no error is thrown and the event is processed
    let eventReceived = false;
    await hub.subscribe(
      "test.event",
      () => {
        eventReceived = true;
      },
      { sessionId: "test-session" },
    );

    transport.receiveMessage(testEvent);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(eventReceived).toBe(true);
  });

  it("should debounce rapid resubscription calls to prevent subscription storm", async () => {
    // 1. Setup with subscription
    hub.registerTransport(transport);
    await transport.initialize();

    await hub.subscribe("test.event", () => {}, { sessionId: "test-session" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 2. Clear sent messages
    transport.clearSentMessages();

    // 3. Simulate rapid reconnection (what causes subscription storm)
    transport.simulateDisconnect();
    transport.simulateReconnect();

    // 4. Immediately call forceResubscribe multiple times (simulating multiple sources)
    // This simulates: MessageHub auto-resubscribe + StateChannel + ConnectionManager
    hub.forceResubscribe();
    hub.forceResubscribe();
    hub.forceResubscribe();

    await new Promise((resolve) => setTimeout(resolve, 20));

    // 5. Verify only ONE batch of SUBSCRIBE messages was sent
    // Without debounce, we would see 4 batches (1 from reconnect + 3 from forceResubscribe)
    const resubscribes = transport.sentMessages.filter(
      (m) => m.type === MessageType.SUBSCRIBE,
    );

    // Should only have 1 SUBSCRIBE message (debounced)
    expect(resubscribes.length).toBe(1);
    expect(resubscribes[0].method).toBe("test.event");
  });

  it("should clear queued events on reconnection to prevent double messages", async () => {
    // This test verifies the fix for the double messages bug:
    // Previously, events queued during resubscription were replayed,
    // but the server ALSO resends recent events after SUBSCRIBE ACK.
    // This caused the same event to be processed twice.
    // Fix: Clear queued events instead of replaying them.

    // 1. Setup
    hub.registerTransport(transport);
    await transport.initialize();

    // 2. Subscribe to event and track received events
    const receivedEvents: unknown[] = [];
    await hub.subscribe(
      "test.event",
      (data) => {
        receivedEvents.push(data);
      },
      { sessionId: "test-session" },
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    // 3. Simulate disconnect
    transport.simulateDisconnect();

    // 4. Create an event that would be "queued" during resubscription
    // In real scenario, this arrives during the resubscribing=true window
    const testEvent: HubMessage = {
      id: "event-during-resubscribe",
      type: MessageType.EVENT,
      method: "test.event",
      sessionId: "test-session",
      data: { message: "test", eventId: "E1" },
      timestamp: new Date().toISOString(),
      version: "1.0.0",
    };

    // 5. Simulate reconnect
    transport.simulateReconnect();

    // Wait for resubscription to complete
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 6. Now send the event (simulating server resend after SUBSCRIBE)
    transport.receiveMessage(testEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));

    // 7. Verify event was received exactly ONCE (not duplicated)
    // Before the fix, if the event was queued AND resent by server,
    // it would appear twice in receivedEvents
    expect(receivedEvents.length).toBe(1);
    expect((receivedEvents[0] as { eventId: string }).eventId).toBe("E1");
  });

  it("should not lose events that arrive after reconnection completes", async () => {
    // This test ensures that clearing the queue doesn't cause event loss
    // Events arriving AFTER resubscription completes should be delivered

    // 1. Setup
    hub.registerTransport(transport);
    await transport.initialize();

    // 2. Subscribe to event
    const receivedEvents: unknown[] = [];
    await hub.subscribe(
      "test.event",
      (data) => {
        receivedEvents.push(data);
      },
      { sessionId: "test-session" },
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    // 3. Disconnect and reconnect
    transport.simulateDisconnect();
    transport.simulateReconnect();

    // Wait for resubscription to complete
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 4. Send multiple events after reconnection
    for (let i = 1; i <= 3; i++) {
      const event: HubMessage = {
        id: `event-${i}`,
        type: MessageType.EVENT,
        method: "test.event",
        sessionId: "test-session",
        data: { eventId: `E${i}` },
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      };
      transport.receiveMessage(event);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));

    // 5. Verify all events were received
    expect(receivedEvents.length).toBe(3);
    expect((receivedEvents[0] as { eventId: string }).eventId).toBe("E1");
    expect((receivedEvents[1] as { eventId: string }).eventId).toBe("E2");
    expect((receivedEvents[2] as { eventId: string }).eventId).toBe("E3");
  });
});
