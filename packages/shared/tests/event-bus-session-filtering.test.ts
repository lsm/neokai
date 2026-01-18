/**
 * Tests for EventBus session-based filtering
 *
 * Validates that the native session filtering functionality works correctly,
 * matching the pattern used by MessageHub for session-scoped subscriptions.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { EventBus } from "../src/event-bus";

describe("EventBus Session Filtering", () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus({ debug: false });
  });

  describe("on() with sessionId option", () => {
    test("should only call handler for matching sessionId", async () => {
      const handler = mock(() => {});

      // Subscribe with session filtering
      eventBus.on("message:persisted", handler, { sessionId: "session-1" });

      // Emit event for session-1 (should be called)
      await eventBus.emit("message:persisted", {
        sessionId: "session-1",
        messageId: "msg-1",
        messageContent: "test",
        userMessageText: "test",
        needsWorkspaceInit: false,
        hasDraftToClear: false,
      });

      expect(handler).toHaveBeenCalledTimes(1);

      // Emit event for session-2 (should NOT be called)
      await eventBus.emit("message:persisted", {
        sessionId: "session-2",
        messageId: "msg-2",
        messageContent: "test",
        userMessageText: "test",
        needsWorkspaceInit: false,
        hasDraftToClear: false,
      });

      // Handler should still be called only once
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test("should support multiple handlers for different sessions", async () => {
      const handler1 = mock(() => {});
      const handler2 = mock(() => {});
      const handler3 = mock(() => {});

      // Subscribe three handlers for different sessions
      eventBus.on("message:persisted", handler1, { sessionId: "session-1" });
      eventBus.on("message:persisted", handler2, { sessionId: "session-2" });
      eventBus.on("message:persisted", handler3, { sessionId: "session-3" });

      // Emit event for session-2
      await eventBus.emit("message:persisted", {
        sessionId: "session-2",
        messageId: "msg-1",
        messageContent: "test",
        userMessageText: "test",
        needsWorkspaceInit: false,
        hasDraftToClear: false,
      });

      // Only handler2 should be called
      expect(handler1).toHaveBeenCalledTimes(0);
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler3).toHaveBeenCalledTimes(0);
    });

    test("should work alongside global subscriptions", async () => {
      const globalHandler = mock(() => {});
      const sessionHandler = mock(() => {});

      // Global subscription (no sessionId)
      eventBus.on("message:persisted", globalHandler);

      // Session-scoped subscription
      eventBus.on("message:persisted", sessionHandler, {
        sessionId: "session-1",
      });

      // Emit event for session-1
      await eventBus.emit("message:persisted", {
        sessionId: "session-1",
        messageId: "msg-1",
        messageContent: "test",
        userMessageText: "test",
        needsWorkspaceInit: false,
        hasDraftToClear: false,
      });

      // Both handlers should be called
      expect(globalHandler).toHaveBeenCalledTimes(1);
      expect(sessionHandler).toHaveBeenCalledTimes(1);

      // Emit event for session-2
      await eventBus.emit("message:persisted", {
        sessionId: "session-2",
        messageId: "msg-2",
        messageContent: "test",
        userMessageText: "test",
        needsWorkspaceInit: false,
        hasDraftToClear: false,
      });

      // Global handler called again, session handler not called
      expect(globalHandler).toHaveBeenCalledTimes(2);
      expect(sessionHandler).toHaveBeenCalledTimes(1);
    });

    test("should correctly unsubscribe session-scoped handler", async () => {
      const handler = mock(() => {});

      // Subscribe with session filtering
      const unsubscribe = eventBus.on("message:persisted", handler, {
        sessionId: "session-1",
      });

      // Emit event (should be called)
      await eventBus.emit("message:persisted", {
        sessionId: "session-1",
        messageId: "msg-1",
        messageContent: "test",
        userMessageText: "test",
        needsWorkspaceInit: false,
        hasDraftToClear: false,
      });

      expect(handler).toHaveBeenCalledTimes(1);

      // Unsubscribe
      unsubscribe();

      // Emit event again (should NOT be called)
      await eventBus.emit("message:persisted", {
        sessionId: "session-1",
        messageId: "msg-2",
        messageContent: "test",
        userMessageText: "test",
        needsWorkspaceInit: false,
        hasDraftToClear: false,
      });

      // Handler should still be called only once
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test("should filter events by sessionId correctly", async () => {
      const handler = mock(() => {});

      // Subscribe with session filtering
      eventBus.on("session:created", handler, { sessionId: "session-1" });

      // Emit event with matching sessionId (should be called)
      await eventBus.emit("session:created", {
        sessionId: "session-1",
        session: {
          id: "session-1",
          workspacePath: "/test",
          status: "active",
          config: {
            model: "claude-sonnet-4-20250514",
            maxTokens: 8192,
            temperature: 1,
          },
          metadata: {
            messageCount: 0,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalCost: 0,
            toolCallCount: 0,
          },
          createdAt: new Date().toISOString(),
          title: "Test Session",
          lastActiveAt: new Date().toISOString(),
        },
      });

      // Handler should be called once
      expect(handler).toHaveBeenCalledTimes(1);

      // Emit event with different sessionId (should NOT be called)
      await eventBus.emit("session:created", {
        sessionId: "session-2",
        session: {
          id: "session-2",
          workspacePath: "/test",
          status: "active",
          config: {
            model: "claude-sonnet-4-20250514",
            maxTokens: 8192,
            temperature: 1,
          },
          metadata: {
            messageCount: 0,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalCost: 0,
            toolCallCount: 0,
          },
          createdAt: new Date().toISOString(),
          title: "Test Session",
          lastActiveAt: new Date().toISOString(),
        },
      });

      // Handler should still be called only once
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("once() with sessionId option", () => {
    test("should only call handler once for matching sessionId", async () => {
      const handler = mock(() => {});

      // Subscribe with session filtering (one-time)
      eventBus.once("message:persisted", handler, { sessionId: "session-1" });

      // Emit event for session-1 (should be called)
      await eventBus.emit("message:persisted", {
        sessionId: "session-1",
        messageId: "msg-1",
        messageContent: "test",
        userMessageText: "test",
        needsWorkspaceInit: false,
        hasDraftToClear: false,
      });

      expect(handler).toHaveBeenCalledTimes(1);

      // Emit event for session-1 again (should NOT be called - already unsubscribed)
      await eventBus.emit("message:persisted", {
        sessionId: "session-1",
        messageId: "msg-2",
        messageContent: "test",
        userMessageText: "test",
        needsWorkspaceInit: false,
        hasDraftToClear: false,
      });

      // Handler should still be called only once
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test("should not call handler for non-matching sessionId", async () => {
      const handler = mock(() => {});

      // Subscribe with session filtering (one-time)
      eventBus.once("message:persisted", handler, { sessionId: "session-1" });

      // Emit event for session-2 (should NOT be called)
      await eventBus.emit("message:persisted", {
        sessionId: "session-2",
        messageId: "msg-1",
        messageContent: "test",
        userMessageText: "test",
        needsWorkspaceInit: false,
        hasDraftToClear: false,
      });

      expect(handler).toHaveBeenCalledTimes(0);

      // Emit event for session-1 (should be called)
      await eventBus.emit("message:persisted", {
        sessionId: "session-1",
        messageId: "msg-2",
        messageContent: "test",
        userMessageText: "test",
        needsWorkspaceInit: false,
        hasDraftToClear: false,
      });

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("Performance", () => {
    test("should not call filtered handlers (efficiency test)", async () => {
      const handlers = Array.from({ length: 10 }, () => mock(() => {}));

      // Subscribe 10 handlers for different sessions
      handlers.forEach((handler, i) => {
        eventBus.on("message:persisted", handler, {
          sessionId: `session-${i}`,
        });
      });

      // Emit event for session-5
      await eventBus.emit("message:persisted", {
        sessionId: "session-5",
        messageId: "msg-1",
        messageContent: "test",
        userMessageText: "test",
        needsWorkspaceInit: false,
        hasDraftToClear: false,
      });

      // Only handler 5 should be called
      handlers.forEach((handler, i) => {
        if (i === 5) {
          expect(handler).toHaveBeenCalledTimes(1);
        } else {
          expect(handler).toHaveBeenCalledTimes(0);
        }
      });
    });
  });

  describe("Backward Compatibility", () => {
    test("should work without sessionId option (global subscription)", async () => {
      const handler = mock(() => {});

      // Subscribe without sessionId (global)
      eventBus.on("message:persisted", handler);

      // Emit event with sessionId
      await eventBus.emit("message:persisted", {
        sessionId: "session-1",
        messageId: "msg-1",
        messageContent: "test",
        userMessageText: "test",
        needsWorkspaceInit: false,
        hasDraftToClear: false,
      });

      // Handler should be called (no filtering)
      expect(handler).toHaveBeenCalledTimes(1);

      // Emit event with different sessionId
      await eventBus.emit("message:persisted", {
        sessionId: "session-2",
        messageId: "msg-2",
        messageContent: "test",
        userMessageText: "test",
        needsWorkspaceInit: false,
        hasDraftToClear: false,
      });

      // Handler should be called again
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });
});
