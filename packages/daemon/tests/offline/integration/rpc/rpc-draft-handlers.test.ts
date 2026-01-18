/**
 * Draft RPC Handlers Tests (Offline)
 *
 * Tests for input draft persistence via session metadata:
 * - session.get (includes inputDraft)
 * - session.update (accepts inputDraft in metadata)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { TestContext } from "../../../test-utils";
import {
  createTestApp,
  waitForWebSocketState,
  waitForWebSocketMessage,
  createWebSocketWithFirstMessage,
} from "../../../test-utils";

describe("Draft RPC Handlers", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  describe("Draft persistence via RPC", () => {
    test("session.get should include inputDraft in response", async () => {
      // Create a session
      const sessionId = await ctx.sessionManager.createSession({
        workspacePath: "/test/draft-get",
      });

      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      // Set inputDraft via RPC
      const setPromise = waitForWebSocketMessage(ws);

      ws.send(
        JSON.stringify({
          id: "draft-get-set",
          type: "CALL",
          method: "session.update",
          data: {
            sessionId,
            metadata: {
              inputDraft: "test draft content",
            },
          },
          sessionId: "global",
          timestamp: new Date().toISOString(),
          version: "1.0.0",
        }),
      );

      const setResponse = await setPromise;
      expect(setResponse.type).toBe("RESULT");

      // Get session and verify inputDraft is included
      const getPromise = waitForWebSocketMessage(ws);

      ws.send(
        JSON.stringify({
          id: "draft-get-1",
          type: "CALL",
          method: "session.get",
          data: { sessionId },
          sessionId: "global",
          timestamp: new Date().toISOString(),
          version: "1.0.0",
        }),
      );

      const getResponse = await getPromise;

      expect(getResponse.type).toBe("RESULT");
      expect(getResponse.data.session).toBeDefined();
      expect(getResponse.data.session.metadata.inputDraft).toBe(
        "test draft content",
      );

      ws.close();
    });

    test("session.update should accept inputDraft in metadata", async () => {
      // Create a session
      const sessionId = await ctx.sessionManager.createSession({
        workspacePath: "/test/draft-update",
      });

      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const updatePromise = waitForWebSocketMessage(ws);

      ws.send(
        JSON.stringify({
          id: "draft-update-1",
          type: "CALL",
          method: "session.update",
          data: {
            sessionId,
            metadata: {
              inputDraft: "new draft content",
            },
          },
          sessionId: "global",
          timestamp: new Date().toISOString(),
          version: "1.0.0",
        }),
      );

      const updateResponse = await updatePromise;

      expect(updateResponse.type).toBe("RESULT");
      expect(updateResponse.data.success).toBe(true);

      // Verify database updated correctly via session.get
      const getPromise = waitForWebSocketMessage(ws);

      ws.send(
        JSON.stringify({
          id: "draft-update-2",
          type: "CALL",
          method: "session.get",
          data: { sessionId },
          sessionId: "global",
          timestamp: new Date().toISOString(),
          version: "1.0.0",
        }),
      );

      const getResponse = await getPromise;

      expect(getResponse.type).toBe("RESULT");
      expect(getResponse.data.session.metadata.inputDraft).toBe(
        "new draft content",
      );

      ws.close();
    });

    test("session.update should merge partial metadata including inputDraft", async () => {
      // Create session with existing metadata
      const sessionId = await ctx.sessionManager.createSession({
        workspacePath: "/test/draft-merge",
      });

      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      // Set some initial metadata via RPC
      const setInitialPromise = waitForWebSocketMessage(ws);

      ws.send(
        JSON.stringify({
          id: "draft-merge-set",
          type: "CALL",
          method: "session.update",
          data: {
            sessionId,
            metadata: {
              messageCount: 5,
              titleGenerated: true,
            },
          },
          sessionId: "global",
          timestamp: new Date().toISOString(),
          version: "1.0.0",
        }),
      );

      const setInitialResponse = await setInitialPromise;
      expect(setInitialResponse.type).toBe("RESULT");

      const updatePromise = waitForWebSocketMessage(ws);

      // Update only inputDraft
      ws.send(
        JSON.stringify({
          id: "draft-merge-1",
          type: "CALL",
          method: "session.update",
          data: {
            sessionId,
            metadata: {
              inputDraft: "merged draft",
            },
          },
          sessionId: "global",
          timestamp: new Date().toISOString(),
          version: "1.0.0",
        }),
      );

      const updateResponse = await updatePromise;

      expect(updateResponse.type).toBe("RESULT");
      expect(updateResponse.data.success).toBe(true);

      // Verify merge behavior (inputDraft updated, other fields preserved) via session.get
      const getPromise = waitForWebSocketMessage(ws);

      ws.send(
        JSON.stringify({
          id: "draft-merge-2",
          type: "CALL",
          method: "session.get",
          data: { sessionId },
          sessionId: "global",
          timestamp: new Date().toISOString(),
          version: "1.0.0",
        }),
      );

      const getResponse = await getPromise;

      expect(getResponse.type).toBe("RESULT");
      expect(getResponse.data.session.metadata.inputDraft).toBe("merged draft");
      expect(getResponse.data.session.metadata.messageCount).toBe(5);
      expect(getResponse.data.session.metadata.titleGenerated).toBe(true);

      ws.close();
    });

    test("should clear inputDraft via session.update", async () => {
      // Create session with inputDraft set
      const sessionId = await ctx.sessionManager.createSession({
        workspacePath: "/test/draft-clear",
      });

      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      // Set inputDraft via RPC
      const setPromise = waitForWebSocketMessage(ws);

      ws.send(
        JSON.stringify({
          id: "draft-clear-set",
          type: "CALL",
          method: "session.update",
          data: {
            sessionId,
            metadata: {
              inputDraft: "draft to clear",
            },
          },
          sessionId: "global",
          timestamp: new Date().toISOString(),
          version: "1.0.0",
        }),
      );

      const setResponse = await setPromise;
      expect(setResponse.type).toBe("RESULT");

      const updatePromise = waitForWebSocketMessage(ws);

      // Clear inputDraft (use null instead of undefined, as JSON.stringify strips undefined)
      ws.send(
        JSON.stringify({
          id: "draft-clear-1",
          type: "CALL",
          method: "session.update",
          data: {
            sessionId,
            metadata: {
              inputDraft: null,
            },
          },
          sessionId: "global",
          timestamp: new Date().toISOString(),
          version: "1.0.0",
        }),
      );

      const updateResponse = await updatePromise;

      expect(updateResponse.type).toBe("RESULT");
      expect(updateResponse.data.success).toBe(true);

      // Verify inputDraft cleared from database via session.get
      const getPromise = waitForWebSocketMessage(ws);

      ws.send(
        JSON.stringify({
          id: "draft-clear-2",
          type: "CALL",
          method: "session.get",
          data: { sessionId },
          sessionId: "global",
          timestamp: new Date().toISOString(),
          version: "1.0.0",
        }),
      );

      const getResponse = await getPromise;

      expect(getResponse.type).toBe("RESULT");
      expect(getResponse.data.session.metadata.inputDraft).toBeUndefined();

      ws.close();
    });
  });
});
