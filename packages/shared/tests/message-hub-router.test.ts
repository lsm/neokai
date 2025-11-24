import { describe, test, expect, beforeEach, mock } from "bun:test";
import { MessageHubRouter } from "../src/message-hub/router";
import type { HubMessage } from "../src/message-hub/types";
import {
  MessageType,
  createEventMessage,
  createCallMessage,
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
      expect(info?.connection.metadata?.ws).toBe(mockWs1);
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
    test("should route EVENT message to subscribed client", () => {
      const clientId = router.registerClient(mockWs1 as any);
      router.subscribe("session1", "user.created", clientId);

      const eventMessage = createEventMessage({
        method: "user.created",
        data: { userId: "123" },
        sessionId: "session1",
      });

      router.routeEvent(eventMessage);

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

      const eventMessage = createEventMessage({
        method: "user.created",
        data: { userId: "123" },
        sessionId: "session1",
      });

      router.routeEvent(eventMessage);

      expect(mockWs1.sentMessages.length).toBe(1);
      expect(mockWs2.sentMessages.length).toBe(1);
    });

    test("should not route to unsubscribed clients", () => {
      const clientId1 = router.registerClient(mockWs1 as any);
      const clientId2 = router.registerClient(mockWs2 as any);

      router.subscribe("session1", "user.created", clientId1);
      // clientId2 is not subscribed

      const eventMessage = createEventMessage({
        method: "user.created",
        data: { userId: "123" },
        sessionId: "session1",
      });

      router.routeEvent(eventMessage);

      expect(mockWs1.sentMessages.length).toBe(1);
      expect(mockWs2.sentMessages.length).toBe(0);
    });

    test("should not route to wrong session", () => {
      const clientId = router.registerClient(mockWs1 as any);
      router.subscribe("session1", "user.created", clientId);

      const eventMessage = createEventMessage({
        method: "user.created",
        data: { userId: "123" },
        sessionId: "session2", // Different session
      });

      router.routeEvent(eventMessage);

      expect(mockWs1.sentMessages.length).toBe(0);
    });

    test("should skip clients with closed WebSocket", () => {
      const clientId = router.registerClient(mockWs1 as any);
      router.subscribe("session1", "user.created", clientId);

      mockWs1.close();

      const eventMessage = createEventMessage({
        method: "user.created",
        data: { userId: "123" },
        sessionId: "session1",
      });

      router.routeEvent(eventMessage);

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
    test("should handle routing non-EVENT message gracefully", () => {
      const callMessage = createCallMessage({
        method: "user.created",
        data: {},
        sessionId: "session1",
      });

      // Should not throw
      expect(() => {
        router.routeEvent(callMessage);
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

  describe("Phase 1 Improvements", () => {
    describe("Duplicate Registration Prevention", () => {
      test("should return existing clientId when registering same WebSocket twice", () => {
        const clientId1 = router.registerClient(mockWs1 as any);
        const clientId2 = router.registerClient(mockWs1 as any);

        expect(clientId1).toBe(clientId2);
        expect(router.getClientCount()).toBe(1);
      });
    });

    describe("O(1) Client Lookup", () => {
      test("should get client by clientId efficiently", () => {
        const clientId = router.registerClient(mockWs1 as any);
        const client = router.getClientById(clientId);

        expect(client).toBeDefined();
        expect(client?.clientId).toBe(clientId);
        expect(client?.connection.metadata?.ws).toBe(mockWs1);
      });

      test("should return undefined for non-existent clientId", () => {
        const client = router.getClientById("non-existent");
        expect(client).toBeUndefined();
      });
    });

    describe("Route Result Observability", () => {
      test("should return delivery statistics from routeEvent", () => {
        const clientId1 = router.registerClient(mockWs1 as any);
        const clientId2 = router.registerClient(mockWs2 as any);
        const mockWs3 = new MockWebSocket();
        const clientId3 = router.registerClient(mockWs3 as any);

        router.subscribe("session1", "user.created", clientId1);
        router.subscribe("session1", "user.created", clientId2);
        router.subscribe("session1", "user.created", clientId3);

        // Close one websocket to create a failure
        mockWs3.close();

        const eventMessage = createEventMessage({
          method: "user.created",
          data: { userId: "123" },
          sessionId: "session1",
        });

        const result = router.routeEvent(eventMessage);

        expect(result.sent).toBe(2);  // mockWs1 and mockWs2
        expect(result.failed).toBe(1); // mockWs3 is closed
        expect(result.totalSubscribers).toBe(3);
        expect(result.sessionId).toBe("session1");
        expect(result.method).toBe("user.created");
      });

      test("should return zero stats for unsubscribed event", () => {
        router.registerClient(mockWs1 as any);

        const eventMessage = createEventMessage({
          method: "unsubscribed.event",
          data: {},
          sessionId: "session1",
        });

        const result = router.routeEvent(eventMessage);

        expect(result.sent).toBe(0);
        expect(result.failed).toBe(0);
        expect(result.totalSubscribers).toBe(0);
      });

      test("broadcast should return delivery statistics", () => {
        router.registerClient(mockWs1 as any);
        router.registerClient(mockWs2 as any);
        const mockWs3 = new MockWebSocket();
        mockWs3.close();
        router.registerClient(mockWs3 as any);

        const message: HubMessage = {
          id: "msg1",
          type: MessageType.EVENT,
          method: "broadcast.event",
          sessionId: "global",
          data: {},
          timestamp: Date.now(),
        };

        const result = router.broadcast(message);

        expect(result.sent).toBe(2);  // mockWs1 and mockWs2
        expect(result.failed).toBe(1); // mockWs3 is closed
      });

      test("sendToClient should return boolean success indicator", () => {
        const clientId = router.registerClient(mockWs1 as any);

        const message: HubMessage = {
          id: "msg1",
          type: MessageType.EVENT,
          method: "test.event",
          sessionId: "session1",
          data: {},
          timestamp: Date.now(),
        };

        const success = router.sendToClient(clientId, message);
        expect(success).toBe(true);

        const failure = router.sendToClient("non-existent", message);
        expect(failure).toBe(false);
      });
    });

    describe("Memory Leak Prevention", () => {
      test("should cleanup empty subscription Maps", () => {
        const clientId = router.registerClient(mockWs1 as any);

        router.subscribe("session1", "user.created", clientId);
        router.subscribe("session1", "user.updated", clientId);

        // Unsubscribe all
        router.unsubscribeClient("session1", "user.created", clientId);
        router.unsubscribeClient("session1", "user.updated", clientId);

        // Verify cleanup by checking subscriptions
        const subs = router.getSubscriptions();
        expect(subs.has("session1")).toBe(false);
      });

      test("should cleanup nested Maps when last method is unsubscribed", () => {
        const clientId1 = router.registerClient(mockWs1 as any);
        const clientId2 = router.registerClient(mockWs2 as any);

        router.subscribe("session1", "user.created", clientId1);
        router.subscribe("session1", "user.created", clientId2);

        // Unsubscribe first client
        router.unsubscribeClient("session1", "user.created", clientId1);
        expect(router.getSubscriptionCount("session1", "user.created")).toBe(1);

        // Unsubscribe second client - should cleanup Maps
        router.unsubscribeClient("session1", "user.created", clientId2);
        expect(router.getSubscriptionCount("session1", "user.created")).toBe(0);

        const subs = router.getSubscriptions();
        expect(subs.has("session1")).toBe(false);
      });
    });

    describe("Subscription Key Validation", () => {
      test("should reject sessionId with colon", () => {
        const clientId = router.registerClient(mockWs1 as any);

        expect(() => {
          router.subscribe("session:1", "user.created", clientId);
        }).toThrow("SessionId and method cannot contain colon character");
      });

      test("should reject method with colon", () => {
        const clientId = router.registerClient(mockWs1 as any);

        expect(() => {
          router.subscribe("session1", "user:created", clientId);
        }).toThrow("SessionId and method cannot contain colon character");
      });
    });

    describe("Custom Logger", () => {
      test("should use custom logger", () => {
        const mockLogger = {
          log: mock(() => {}),
          warn: mock(() => {}),
          error: mock(() => {}),
        };

        const customRouter = new MessageHubRouter({
          logger: mockLogger,
          debug: true,
        });

        customRouter.registerClient(mockWs1 as any);

        expect(mockLogger.log).toHaveBeenCalled();
      });

      test("should not log when debug is false", () => {
        const mockLogger = {
          log: mock(() => {}),
          warn: mock(() => {}),
          error: mock(() => {}),
        };

        const customRouter = new MessageHubRouter({
          logger: mockLogger,
          debug: false,
        });

        customRouter.registerClient(mockWs1 as any);

        // Should still call for registration (not debug log)
        // But internal debug logs should be skipped
        expect(mockLogger.log).toHaveBeenCalledTimes(0);
      });
    });

    describe("Configurable Auto-Subscribe", () => {
      test("should use custom auto-subscribe config", () => {
        const customRouter = new MessageHubRouter({
          autoSubscribe: {
            global: ["custom.global.event"],
            session: ["custom.session.event"],
          },
        });

        const clientId = customRouter.registerClient(mockWs1 as any);
        customRouter.autoSubscribe(mockWs1 as any, "session1");

        expect(customRouter.getSubscriptionCount("session1", "custom.session.event")).toBe(1);
        expect(customRouter.getSubscriptionCount("session1", "sdk.message")).toBe(0);
      });
    });

    describe("Subscription Storage", () => {
      test("should track subscriptions as Map<sessionId, Set<method>>", () => {
        const clientId = router.registerClient(mockWs1 as any);

        router.subscribe("session1", "user.created", clientId);
        router.subscribe("session1", "user.updated", clientId);
        router.subscribe("session2", "user.deleted", clientId);

        const client = router.getClientById(clientId);
        expect(client?.subscriptions.size).toBe(2); // 2 sessions
        expect(client?.subscriptions.get("session1")?.size).toBe(2); // 2 methods in session1
        expect(client?.subscriptions.get("session2")?.size).toBe(1); // 1 method in session2
      });
    });
  });
});
