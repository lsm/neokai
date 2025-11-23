import { describe, test, expect, beforeEach } from "bun:test";
import { ElysiaWebSocketTransport } from "../src/lib/elysia-websocket-transport";
import type { HubMessage } from "@liuboer/shared";
import { MessageType } from "@liuboer/shared";

// Mock WebSocket
class MockWebSocket {
  sentMessages: string[] = [];

  send(data: string): void {
    this.sentMessages.push(data);
  }

  getLastMessage(): any {
    if (this.sentMessages.length === 0) return null;
    return JSON.parse(this.sentMessages[this.sentMessages.length - 1]);
  }

  clearSent(): void {
    this.sentMessages = [];
  }
}

describe("ElysiaWebSocketTransport", () => {
  let transport: ElysiaWebSocketTransport;
  let mockWs1: MockWebSocket;
  let mockWs2: MockWebSocket;

  beforeEach(() => {
    transport = new ElysiaWebSocketTransport({ debug: false });
    mockWs1 = new MockWebSocket();
    mockWs2 = new MockWebSocket();
  });

  describe("Client Registration", () => {
    test("should register a client and return clientId", () => {
      const clientId = transport.registerClient(mockWs1, "session1");

      expect(clientId).toBeTruthy();
      expect(typeof clientId).toBe("string");
      expect(transport.getClientCount()).toBe(1);
    });

    test("should register multiple clients", () => {
      const id1 = transport.registerClient(mockWs1, "session1");
      const id2 = transport.registerClient(mockWs2, "session2");

      expect(id1).not.toBe(id2);
      expect(transport.getClientCount()).toBe(2);
    });

    test("should unregister a client", () => {
      const clientId = transport.registerClient(mockWs1, "session1");
      expect(transport.getClientCount()).toBe(1);

      transport.unregisterClient(clientId);
      expect(transport.getClientCount()).toBe(0);
    });

    test("should get client by ID", () => {
      const clientId = transport.registerClient(mockWs1, "session1");
      const client = transport.getClient(clientId);

      expect(client).toBeDefined();
      expect(client?.id).toBe(clientId);
      expect(client?.sessionId).toBe("session1");
    });
  });

  describe("Connection State", () => {
    test("should start disconnected", () => {
      expect(transport.getState()).toBe("disconnected");
      expect(transport.isReady()).toBe(false);
    });

    test("should be connected when clients registered", () => {
      transport.registerClient(mockWs1, "session1");

      expect(transport.getState()).toBe("connected");
      expect(transport.isReady()).toBe(true);
    });

    test("should be disconnected when all clients unregistered", () => {
      const id1 = transport.registerClient(mockWs1, "session1");
      const id2 = transport.registerClient(mockWs2, "session2");

      expect(transport.getState()).toBe("connected");

      transport.unregisterClient(id1);
      expect(transport.getState()).toBe("connected"); // Still has client 2

      transport.unregisterClient(id2);
      expect(transport.getState()).toBe("disconnected"); // All gone
    });

    test("should notify connection handlers on state change", () => {
      const states: string[] = [];
      transport.onConnectionChange((state) => {
        states.push(state);
      });

      const id = transport.registerClient(mockWs1, "session1");
      expect(states).toContain("connected");

      transport.unregisterClient(id);
      expect(states).toContain("disconnected");
    });
  });

  describe("Message Handling", () => {
    test("should handle incoming client messages", () => {
      const receivedMessages: HubMessage[] = [];
      transport.onMessage((msg) => {
        receivedMessages.push(msg);
      });

      const message: HubMessage = {
        id: "msg1",
        type: MessageType.CALL,
        sessionId: "session1",
        method: "test.method",
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      };

      transport.handleClientMessage(message);

      expect(receivedMessages.length).toBe(1);
      expect(receivedMessages[0]).toEqual(message);
    });

    test("should notify multiple message handlers", () => {
      let handler1Called = false;
      let handler2Called = false;

      transport.onMessage(() => { handler1Called = true; });
      transport.onMessage(() => { handler2Called = true; });

      const message: HubMessage = {
        id: "msg1",
        type: MessageType.CALL,
        sessionId: "session1",
        method: "test.method",
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      };

      transport.handleClientMessage(message);

      expect(handler1Called).toBe(true);
      expect(handler2Called).toBe(true);
    });

    test("should unsubscribe message handlers", () => {
      const messages: HubMessage[] = [];
      const unsubscribe = transport.onMessage((msg) => {
        messages.push(msg);
      });

      const message: HubMessage = {
        id: "msg1",
        type: MessageType.CALL,
        sessionId: "session1",
        method: "test.method",
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      };

      transport.handleClientMessage(message);
      expect(messages.length).toBe(1);

      unsubscribe();

      transport.handleClientMessage(message);
      expect(messages.length).toBe(1); // Not called again
    });
  });

  describe("Message Sending", () => {
    test("should send message to client in matching session", async () => {
      transport.registerClient(mockWs1, "session1");

      const message: HubMessage = {
        id: "msg1",
        type: MessageType.RESULT,
        sessionId: "session1",
        method: "test.method",
        requestId: "req1",
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      };

      await transport.send(message);

      expect(mockWs1.sentMessages.length).toBe(1);
      const sent = mockWs1.getLastMessage();
      expect(sent.id).toBe("msg1");
      expect(sent.type).toBe("RESULT");
    });

    test("should not send to clients in different session", async () => {
      transport.registerClient(mockWs1, "session1");
      transport.registerClient(mockWs2, "session2");

      const message: HubMessage = {
        id: "msg1",
        type: MessageType.RESULT,
        sessionId: "session1",
        method: "test.method",
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      };

      await transport.send(message);

      expect(mockWs1.sentMessages.length).toBe(1);
      expect(mockWs2.sentMessages.length).toBe(0);
    });

    test("should broadcast to global session", async () => {
      transport.registerClient(mockWs1, "session1");
      transport.registerClient(mockWs2, "session2");

      const message: HubMessage = {
        id: "msg1",
        type: MessageType.EVENT,
        sessionId: "global",
        method: "system.shutdown",
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      };

      await transport.send(message);

      expect(mockWs1.sentMessages.length).toBe(1);
      expect(mockWs2.sentMessages.length).toBe(1);
    });

    test("should send to multiple clients in same session", async () => {
      const mockWs3 = new MockWebSocket();
      transport.registerClient(mockWs1, "session1");
      transport.registerClient(mockWs3, "session1");
      transport.registerClient(mockWs2, "session2");

      const message: HubMessage = {
        id: "msg1",
        type: MessageType.EVENT,
        sessionId: "session1",
        method: "session.updated",
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      };

      await transport.send(message);

      expect(mockWs1.sentMessages.length).toBe(1);
      expect(mockWs3.sentMessages.length).toBe(1);
      expect(mockWs2.sentMessages.length).toBe(0);
    });

    test("should handle sending to non-existent session gracefully", async () => {
      transport.registerClient(mockWs1, "session1");

      const message: HubMessage = {
        id: "msg1",
        type: MessageType.EVENT,
        sessionId: "non-existent",
        method: "test.method",
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      };

      // Should not throw
      await expect(transport.send(message)).resolves.toBeUndefined();
      expect(mockWs1.sentMessages.length).toBe(0);
    });
  });

  describe("Broadcast to Session", () => {
    test("should broadcast message to specific session", async () => {
      transport.registerClient(mockWs1, "session1");
      transport.registerClient(mockWs2, "session2");

      const message: HubMessage = {
        id: "msg1",
        type: MessageType.EVENT,
        sessionId: "wrong-session", // Will be overridden
        method: "test.event",
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      };

      await transport.broadcastToSession("session1", message);

      expect(mockWs1.sentMessages.length).toBe(1);
      expect(mockWs2.sentMessages.length).toBe(0);

      const sent = mockWs1.getLastMessage();
      expect(sent.sessionId).toBe("session1"); // Overridden
    });
  });
});
