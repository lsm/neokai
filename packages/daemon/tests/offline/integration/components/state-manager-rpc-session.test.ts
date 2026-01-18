/**
 * StateManager RPC Tests - Session-Specific State Channels
 *
 * Tests for session-specific state channel RPC handlers:
 * - Session State
 * - Session Snapshot
 * - SDK Messages State
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { TestContext } from "../../../test-utils";
import {
  createTestApp,
  waitForWebSocketState,
  waitForWebSocketMessage,
  createWebSocketWithFirstMessage,
} from "../../../test-utils";
import { STATE_CHANNELS } from "@liuboer/shared";

describe("StateManager RPC - Session State", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  describe("Session State", () => {
    test("should return session state via RPC", async () => {
      const sessionId = await ctx.sessionManager.createSession({
        workspacePath: "/test/state-manager",
      });

      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const responsePromise = waitForWebSocketMessage(ws);

      ws.send(
        JSON.stringify({
          id: "session-state-1",
          type: "CALL",
          method: STATE_CHANNELS.SESSION,
          data: { sessionId },
          sessionId: "global",
          timestamp: new Date().toISOString(),
          version: "1.0.0",
        }),
      );

      const response = await responsePromise;

      expect(response.type).toBe("RESULT");
      // Unified session state uses sessionInfo (not session)
      expect(response.data.sessionInfo).toBeDefined();
      expect(response.data.sessionInfo.id).toBe(sessionId);
      expect(response.data.agentState).toBeDefined();
      expect(response.data.commandsData).toBeDefined();

      ws.close();
    });

    test("should throw error for non-existent session", async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const responsePromise = waitForWebSocketMessage(ws);

      ws.send(
        JSON.stringify({
          id: "session-state-2",
          type: "CALL",
          method: STATE_CHANNELS.SESSION,
          data: { sessionId: "non-existent" },
          sessionId: "global",
          timestamp: new Date().toISOString(),
          version: "1.0.0",
        }),
      );

      const response = await responsePromise;

      expect(response.type).toBe("ERROR");
      expect(response.error).toContain("Session not found");

      ws.close();
    });
  });

  describe("Session Snapshot", () => {
    test("should return session snapshot via RPC", async () => {
      const sessionId = await ctx.sessionManager.createSession({
        workspacePath: "/test/state-manager",
      });

      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const responsePromise = waitForWebSocketMessage(ws);

      ws.send(
        JSON.stringify({
          id: "snapshot-2",
          type: "CALL",
          method: STATE_CHANNELS.SESSION_SNAPSHOT,
          data: { sessionId },
          sessionId: "global",
          timestamp: new Date().toISOString(),
          version: "1.0.0",
        }),
      );

      const response = await responsePromise;

      expect(response.type).toBe("RESULT");
      expect(response.data.session).toBeDefined();
      expect(response.data.sdkMessages).toBeDefined();
      expect(response.data.meta).toBeDefined();
      expect(response.data.meta.sessionId).toBe(sessionId);

      ws.close();
    });
  });

  describe("SDK Messages State", () => {
    test("should return SDK messages state via RPC", async () => {
      const sessionId = await ctx.sessionManager.createSession({
        workspacePath: "/test/state-manager",
      });

      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const responsePromise = waitForWebSocketMessage(ws);

      ws.send(
        JSON.stringify({
          id: "sdk-msgs-1",
          type: "CALL",
          method: STATE_CHANNELS.SESSION_SDK_MESSAGES,
          data: { sessionId },
          sessionId: "global",
          timestamp: new Date().toISOString(),
          version: "1.0.0",
        }),
      );

      const response = await responsePromise;

      expect(response.type).toBe("RESULT");
      expect(response.data.sdkMessages).toBeArray();
      expect(response.data.timestamp).toBeNumber();

      ws.close();
    });
  });
});
