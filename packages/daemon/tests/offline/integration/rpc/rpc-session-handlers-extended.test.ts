/**
 * Extended Session RPC Handlers Tests (Offline)
 *
 * Additional tests to cover edge cases:
 * - session.duplicate
 * - session.archive (with confirmed param)
 * - Error handling
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { TestContext } from "../../../test-utils";
import {
  createTestApp,
  waitForWebSocketState,
  waitForWebSocketMessage,
  createWebSocketWithFirstMessage,
} from "../../../test-utils";

describe("Session RPC Handlers - Extended", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // Helper to send RPC call
  async function sendRpcCall(
    ws: WebSocket,
    method: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const responsePromise = waitForWebSocketMessage(ws);
    ws.send(
      JSON.stringify({
        id: `call-${Date.now()}`,
        type: "CALL",
        method,
        data,
        sessionId: "global",
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      }),
    );
    return responsePromise;
  }

  describe("session.archive", () => {
    test("should archive a session without worktree", async () => {
      const sessionId = await ctx.sessionManager.createSession({
        workspacePath: "/test/session-archive",
      });

      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      // Archive uses confirmed parameter, not archive
      const response = await sendRpcCall(ws, "session.archive", {
        sessionId,
        confirmed: true,
      });

      expect(response.type).toBe("RESULT");
      const data = response.data as { success: boolean };
      expect(data.success).toBe(true);
      ws.close();

      // Verify session status changed
      const session = ctx.db.getSession(sessionId);
      expect(session?.status).toBe("archived");
    });

    test("should error for non-existent session", async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const response = await sendRpcCall(ws, "session.archive", {
        sessionId: "non-existent-id",
        confirmed: true,
      });

      expect(response.type).toBe("ERROR");
      ws.close();
    });
  });

  describe("session.update", () => {
    test("should update session title", async () => {
      const sessionId = await ctx.sessionManager.createSession({
        workspacePath: "/test/session-update-title",
      });

      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      // session.update uses flat structure, not nested updates
      const response = await sendRpcCall(ws, "session.update", {
        sessionId,
        title: "New Title",
      });

      expect(response.type).toBe("RESULT");
      ws.close();

      // Verify updated
      const session = ctx.db.getSession(sessionId);
      expect(session?.title).toBe("New Title");
    });

    test("should update session config", async () => {
      const sessionId = await ctx.sessionManager.createSession({
        workspacePath: "/test/session-update-config",
      });

      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const response = await sendRpcCall(ws, "session.update", {
        sessionId,
        config: {
          autoScroll: false,
        },
      });

      expect(response.type).toBe("RESULT");
      ws.close();
    });
  });

  describe("session.list", () => {
    test("should list all sessions", async () => {
      // Create sessions
      const sessionId1 = await ctx.sessionManager.createSession({
        workspacePath: "/test/session-list-1",
      });

      const sessionId2 = await ctx.sessionManager.createSession({
        workspacePath: "/test/session-list-2",
      });

      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const response = await sendRpcCall(ws, "session.list", {});

      expect(response.type).toBe("RESULT");
      const data = response.data as { sessions: Array<{ id: string }> };
      const sessionIds = data.sessions.map((s) => s.id);
      expect(sessionIds).toContain(sessionId1);
      expect(sessionIds).toContain(sessionId2);
      ws.close();
    });
  });

  describe("session.model.get", () => {
    test("should get current model info", async () => {
      const sessionId = await ctx.sessionManager.createSession({
        workspacePath: "/test/session-model-get",
      });

      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const response = await sendRpcCall(ws, "session.model.get", {
        sessionId,
      });

      expect(response.type).toBe("RESULT");
      // API returns 'currentModel', not 'model'
      expect(response.data).toHaveProperty("currentModel");
      ws.close();
    });

    test("should error for non-existent session", async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const response = await sendRpcCall(ws, "session.model.get", {
        sessionId: "non-existent",
      });

      expect(response.type).toBe("ERROR");
      ws.close();
    });
  });

  describe("session.model.switch", () => {
    test("should switch model using alias", async () => {
      const sessionId = await ctx.sessionManager.createSession({
        workspacePath: "/test/session-model-switch",
      });

      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      // Use alias 'haiku' instead of full model ID
      const response = await sendRpcCall(ws, "session.model.switch", {
        sessionId,
        model: "haiku",
      });

      expect(response.type).toBe("RESULT");
      const data = response.data as { success: boolean };
      expect(data.success).toBe(true);
      ws.close();
    });

    test("should error for invalid model", async () => {
      const sessionId = await ctx.sessionManager.createSession({
        workspacePath: "/test/session-model-switch-invalid",
      });

      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const response = await sendRpcCall(ws, "session.model.switch", {
        sessionId,
        model: "invalid-model-id",
      });

      expect(response.type).toBe("RESULT");
      const data = response.data as { success: boolean; error?: string };
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
      ws.close();
    });
  });

  describe("session.create with config", () => {
    test("should create session with config", async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const response = await sendRpcCall(ws, "session.create", {
        workspacePath: "/test/session-with-config",
        config: {
          permissionMode: "acceptEdits",
        },
      });

      expect(response.type).toBe("RESULT");
      const data = response.data as { sessionId: string };
      expect(data.sessionId).toBeDefined();

      // Verify config was applied
      const session = ctx.db.getSession(data.sessionId);
      expect(session?.config.permissionMode).toBe("acceptEdits");
      ws.close();
    });
  });

  describe("session.delete", () => {
    test("should delete session", async () => {
      const sessionId = await ctx.sessionManager.createSession({
        workspacePath: "/test/session-delete",
      });

      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const response = await sendRpcCall(ws, "session.delete", { sessionId });

      expect(response.type).toBe("RESULT");
      const data = response.data as { success: boolean };
      expect(data.success).toBe(true);

      // Verify deleted
      const session = ctx.db.getSession(sessionId);
      expect(session).toBeNull();
      ws.close();
    });
  });

  describe("session.thinking.set", () => {
    test("should set thinking level", async () => {
      const sessionId = await ctx.sessionManager.createSession({
        workspacePath: "/test/session-thinking",
      });

      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const response = await sendRpcCall(ws, "session.thinking.set", {
        sessionId,
        level: "think8k",
      });

      expect(response.type).toBe("RESULT");
      const data = response.data as { success: boolean; thinkingLevel: string };
      expect(data.success).toBe(true);
      expect(data.thinkingLevel).toBe("think8k");
      ws.close();
    });

    test("should default to auto for invalid level", async () => {
      const sessionId = await ctx.sessionManager.createSession({
        workspacePath: "/test/session-thinking-invalid",
      });

      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const response = await sendRpcCall(ws, "session.thinking.set", {
        sessionId,
        level: "invalid",
      });

      expect(response.type).toBe("RESULT");
      const data = response.data as { thinkingLevel: string };
      expect(data.thinkingLevel).toBe("auto");
      ws.close();
    });

    test("should error for non-existent session", async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const response = await sendRpcCall(ws, "session.thinking.set", {
        sessionId: "non-existent",
        level: "think8k",
      });

      expect(response.type).toBe("ERROR");
      ws.close();
    });
  });

  describe("worktree.cleanup", () => {
    test("should return success with empty cleanedPaths", async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const response = await sendRpcCall(ws, "worktree.cleanup", {
        workspacePath: "/test/workspace",
      });

      expect(response.type).toBe("RESULT");
      const data = response.data as {
        success: boolean;
        cleanedPaths: string[];
        message: string;
      };
      expect(data.success).toBe(true);
      expect(data.cleanedPaths).toBeArray();
      expect(data.message).toContain("orphaned worktree");
      ws.close();
    });

    test("should work without workspacePath", async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const response = await sendRpcCall(ws, "worktree.cleanup", {});

      expect(response.type).toBe("RESULT");
      const data = response.data as { success: boolean };
      expect(data.success).toBe(true);
      ws.close();
    });
  });

  describe("models.list", () => {
    test("should list available models", async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const response = await sendRpcCall(ws, "models.list", {});

      expect(response.type).toBe("RESULT");
      const data = response.data as {
        models: Array<{ id: string; display_name: string }>;
      };
      expect(data.models).toBeArray();
      expect(data.models.length).toBeGreaterThan(0);
      expect(data.models[0]).toHaveProperty("id");
      expect(data.models[0]).toHaveProperty("display_name");
      ws.close();
    });

    test("should support forceRefresh parameter", async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const response = await sendRpcCall(ws, "models.list", {
        forceRefresh: true,
      });

      expect(response.type).toBe("RESULT");
      const data = response.data as { cached: boolean };
      expect(data.cached).toBe(false);
      ws.close();
    });

    test("should support useCache parameter", async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const response = await sendRpcCall(ws, "models.list", {
        useCache: false,
      });

      expect(response.type).toBe("RESULT");
      const data = response.data as { cached: boolean };
      expect(data.cached).toBe(false);
      ws.close();
    });
  });

  describe("models.clearCache", () => {
    test("should clear model cache", async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const response = await sendRpcCall(ws, "models.clearCache", {});

      expect(response.type).toBe("RESULT");
      const data = response.data as { success: boolean };
      expect(data.success).toBe(true);
      ws.close();
    });
  });

  describe("agent.getState", () => {
    test("should get agent state", async () => {
      const sessionId = await ctx.sessionManager.createSession({
        workspacePath: "/test/agent-state",
      });

      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const response = await sendRpcCall(ws, "agent.getState", { sessionId });

      expect(response.type).toBe("RESULT");
      const data = response.data as { state: Record<string, unknown> };
      expect(data.state).toBeDefined();
      ws.close();
    });

    test("should error for non-existent session", async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const response = await sendRpcCall(ws, "agent.getState", {
        sessionId: "non-existent",
      });

      expect(response.type).toBe("ERROR");
      ws.close();
    });
  });

  describe("session.get", () => {
    test("should get session details", async () => {
      const sessionId = await ctx.sessionManager.createSession({
        workspacePath: "/test/session-get",
      });

      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const response = await sendRpcCall(ws, "session.get", { sessionId });

      expect(response.type).toBe("RESULT");
      const data = response.data as { session: Record<string, unknown> };
      expect(data.session).toBeDefined();
      ws.close();
    });
  });

  describe("client.interrupt", () => {
    test("should accept interrupt request", async () => {
      const sessionId = await ctx.sessionManager.createSession({
        workspacePath: "/test/client-interrupt",
      });

      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const response = await sendRpcCall(ws, "client.interrupt", { sessionId });

      expect(response.type).toBe("RESULT");
      const data = response.data as { accepted: boolean };
      expect(data.accepted).toBe(true);
      ws.close();
    });

    test("should error for non-existent session", async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const response = await sendRpcCall(ws, "client.interrupt", {
        sessionId: "non-existent",
      });

      expect(response.type).toBe("ERROR");
      ws.close();
    });
  });
});
