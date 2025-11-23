import { describe, test, expect, beforeEach, mock } from "bun:test";
import { MessageHubRouter } from "../src/message-hub/router";
import type { HubMessage } from "../src/message-hub/types";
import {
  MessageType,
  createPublishMessage,
  createEventMessage,
} from "../src/message-hub/protocol";

// Mock WebSocket
class MockWebSocket {
  public readyState = 1; // WebSocket.OPEN
  public sentMessages: string[] = [];

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = 3; // WebSocket.CLOSED
  }
}

describe("MessageHubRouter", () => {
  let router: MessageHubRouter;
  let mockWs1: MockWebSocket;
  let mockWs2: MockWebSocket;

  beforeEach(() => {
    router = new MessageHubRouter();
    mockWs1 = new MockWebSocket();
    mockWs2 = new MockWebSocket();
  });

  describe("Client Registration", () => {
    test("should register a client and return clientId", () => {
      const clientId = router.registerClient(mockWs1 as any);

      expect(clientId).toBeTruthy();
      expect(router.getClientCount()).toBe(1);
    });

    test("should register multiple clients", () => {
      const clientId1 = router.registerClient(mockWs1 as any);
      const clientId2 = router.registerClient(mockWs2 as any);

      expect(clientId1).toBeTruthy();
      expect(clientId2).toBeTruthy();
      expect(clientId1).not.toBe(clientId2);
      expect(router.getClientCount()).toBe(2);
    });

    test("should unregister a client", () => {
      router.registerClient(mockWs1 as any);
      expect(router.getClientCount()).toBe(1);

      router.unregisterClient(mockWs1 as any);
      expect(router.getClientCount()).toBe(0);
    });

    test("should get client info by WebSocket", () => {
      const clientId = router.registerClient(mockWs1 as any);
      const info = router.getClientInfo(mockWs1 as any);

      expect(info).toBeDefined();
      expect(info?.clientId).toBe(clientId);
      expect(info?.ws).toBe(mockWs1);
    });
  });

  describe("Subscription Management", () => {
    test("should subscribe client to method", () => {
      const clientId = router.registerClient(mockWs1 as any);
      router.subscribe("session1", "user.created", clientId);

      const count = router.getSubscriptionCount("session1", "user.created");
      expect(count).toBe(1);
    });

    test("should subscribe multiple clients to same method", () => {
      const clientId1 = router.registerClient(mockWs1 as any);
      const clientId2 = router.registerClient(mockWs2 as any);

      router.subscribe("session1", "user.created", clientId1);
      router.subscribe("session1", "user.created", clientId2);

      const count = router.getSubscriptionCount("session1", "user.created");
      expect(count).toBe(2);
    });

    test("should unsubscribe client from method", () => {
      const clientId = router.registerClient(mockWs1 as any);
      router.subscribe("session1", "user.created", clientId);

      router.unsubscribeClient("session1", "user.created", clientId);

      const count = router.getSubscriptionCount("session1", "user.created");
      expect(count).toBe(0);
    });

    test("should track subscriptions per session", () => {
      const clientId = router.registerClient(mockWs1 as any);

      router.subscribe("session1", "user.created", clientId);
      router.subscribe("session2", "user.created", clientId);

      expect(router.getSubscriptionCount("session1", "user.created")).toBe(1);
      expect(router.getSubscriptionCount("session2", "user.created")).toBe(1);
    });

    test("should unregister all subscriptions when client is removed", () => {
      const clientId = router.registerClient(mockWs1 as any);

      router.subscribe("session1", "user.created", clientId);
      router.subscribe("session1", "user.updated", clientId);

      router.unregisterClient(mockWs1 as any);

      expect(router.getSubscriptionCount("session1", "user.created")).toBe(0);
      expect(router.getSubscriptionCount("session1", "user.updated")).toBe(0);
    });
  });

  describe("Message Routing", () => {
    test("should route PUBLISH message to subscribed client", () => {
      const clientId = router.registerClient(mockWs1 as any);
      router.subscribe("session1", "user.created", clientId);

      const publishMessage = createPublishMessage({
        method: "user.created",
        data: { userId: "123" },
        sessionId: "session1",
      });

      router.routePublish(publishMessage);

      expect(mockWs1.sentMessages.length).toBe(1);

      const sentMessage = JSON.parse(mockWs1.sentMessages[0]);
      expect(sentMessage.type).toBe(MessageType.EVENT);
      expect(sentMessage.method).toBe("user.created");
      expect(sentMessage.data).toEqual({ userId: "123" });
    });

    test("should route to multiple subscribed clients", () => {
      const clientId1 = router.registerClient(mockWs1 as any);
      const clientId2 = router.registerClient(mockWs2 as any);

      router.subscribe("session1", "user.created", clientId1);
      router.subscribe("session1", "user.created", clientId2);

      const publishMessage = createPublishMessage({
        method: "user.created",
        data: { userId: "123" },
        sessionId: "session1",
      });

      router.routePublish(publishMessage);

      expect(mockWs1.sentMessages.length).toBe(1);
      expect(mockWs2.sentMessages.length).toBe(1);
    });

    test("should not route to unsubscribed clients", () => {
      const clientId1 = router.registerClient(mockWs1 as any);
      const clientId2 = router.registerClient(mockWs2 as any);

      router.subscribe("session1", "user.created", clientId1);
      // clientId2 is not subscribed

      const publishMessage = createPublishMessage({
        method: "user.created",
        data: { userId: "123" },
        sessionId: "session1",
      });

      router.routePublish(publishMessage);

      expect(mockWs1.sentMessages.length).toBe(1);
      expect(mockWs2.sentMessages.length).toBe(0);
    });

    test("should not route to wrong session", () => {
      const clientId = router.registerClient(mockWs1 as any);
      router.subscribe("session1", "user.created", clientId);

      const publishMessage = createPublishMessage({
        method: "user.created",
        data: { userId: "123" },
        sessionId: "session2", // Different session
      });

      router.routePublish(publishMessage);

      expect(mockWs1.sentMessages.length).toBe(0);
    });

    test("should skip clients with closed WebSocket", () => {
      const clientId = router.registerClient(mockWs1 as any);
      router.subscribe("session1", "user.created", clientId);

      mockWs1.close();

      const publishMessage = createPublishMessage({
        method: "user.created",
        data: { userId: "123" },
        sessionId: "session1",
      });

      router.routePublish(publishMessage);

      // Should not send to closed WebSocket
      expect(mockWs1.sentMessages.length).toBe(0);
    });
  });

  describe("Direct Messaging", () => {
    test("should send message to specific client", () => {
      const clientId = router.registerClient(mockWs1 as any);

      const message: HubMessage = {
        id: "msg1",
        type: MessageType.EVENT,
        method: "test.event",
        sessionId: "session1",
        data: { test: true },
        timestamp: Date.now(),
      };

      router.sendToClient(clientId, message);

      expect(mockWs1.sentMessages.length).toBe(1);

      const sentMessage = JSON.parse(mockWs1.sentMessages[0]);
      expect(sentMessage.method).toBe("test.event");
    });

    test("should not send to non-existent client", () => {
      router.sendToClient("non-existent-id", {
        id: "msg1",
        type: MessageType.EVENT,
        method: "test.event",
        sessionId: "session1",
        data: {},
        timestamp: Date.now(),
      });

      // Should not throw, just log warning
      expect(mockWs1.sentMessages.length).toBe(0);
    });

    test("should broadcast to all clients", () => {
      router.registerClient(mockWs1 as any);
      router.registerClient(mockWs2 as any);

      const message: HubMessage = {
        id: "msg1",
        type: MessageType.EVENT,
        method: "broadcast.event",
        sessionId: "global",
        data: { test: true },
        timestamp: Date.now(),
      };

      router.broadcast(message);

      expect(mockWs1.sentMessages.length).toBe(1);
      expect(mockWs2.sentMessages.length).toBe(1);
    });
  });

  describe("Auto-subscription", () => {
    test("should auto-subscribe to global session events", () => {
      router.registerClient(mockWs1 as any);
      router.autoSubscribe(mockWs1 as any, "global");

      expect(router.getSubscriptionCount("global", "session.created")).toBeGreaterThan(0);
      expect(router.getSubscriptionCount("global", "session.updated")).toBeGreaterThan(0);
      expect(router.getSubscriptionCount("global", "session.deleted")).toBeGreaterThan(0);
    });

    test("should auto-subscribe to session-specific events", () => {
      router.registerClient(mockWs1 as any);
      router.autoSubscribe(mockWs1 as any, "session1");

      expect(router.getSubscriptionCount("session1", "sdk.message")).toBeGreaterThan(0);
      expect(router.getSubscriptionCount("session1", "context.updated")).toBeGreaterThan(0);
      expect(router.getSubscriptionCount("session1", "message.queued")).toBeGreaterThan(0);
    });
  });

  describe("Error Handling", () => {
    test("should handle routing non-PUBLISH message gracefully", () => {
      const eventMessage = createEventMessage({
        method: "user.created",
        data: {},
        sessionId: "session1",
      });

      // Should not throw
      expect(() => {
        router.routePublish(eventMessage);
      }).not.toThrow();
    });

    test("should handle sending to closed WebSocket gracefully", () => {
      const clientId = router.registerClient(mockWs1 as any);
      mockWs1.close();

      const message: HubMessage = {
        id: "msg1",
        type: MessageType.EVENT,
        method: "test.event",
        sessionId: "session1",
        data: {},
        timestamp: Date.now(),
      };

      // Should not throw
      expect(() => {
        router.sendToClient(clientId, message);
      }).not.toThrow();
    });
  });
});
