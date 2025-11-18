/**
 * End-to-End Integration Tests
 *
 * Tests complex workflows that combine multiple features:
 * - Full session lifecycle with auth
 * - WebSocket + HTTP API interaction
 * - File operations with sessions
 * - Multi-session scenarios
 */

import { describe, test, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import type {
  CreateSessionResponse,
  GetSessionResponse,
  ListSessionsResponse,
} from "@liuboer/shared";
import {
  createTestApp,
  request,
  assertSuccessResponse,
  createWebSocket,
  createWebSocketWithFirstMessage,
  waitForWebSocketState,
  waitForWebSocketMessage,
  assertEquals,
  assertExists,
  assertTrue,
  hasAnyCredentials,
} from "./test-utils";

const E2E_WORKSPACE = join(import.meta.dir, ".e2e-workspace");

async function setupE2EWorkspace() {
  await mkdir(E2E_WORKSPACE, { recursive: true });
  await writeFile(join(E2E_WORKSPACE, "README.md"), "# Test Project");
  await writeFile(
    join(E2E_WORKSPACE, "package.json"),
    JSON.stringify({ name: "e2e-test" }, null, 2),
  );

  await mkdir(join(E2E_WORKSPACE, "src"), { recursive: true });
  await writeFile(
    join(E2E_WORKSPACE, "src", "main.ts"),
    'console.log("Hello from e2e test");',
  );
}

async function cleanupE2EWorkspace() {
  try {
    await rm(E2E_WORKSPACE, { recursive: true, force: true });
  } catch (error) {
    // Ignore cleanup errors
  }
}

describe("End-to-End Workflows", () => {
  beforeAll(async () => {
    await setupE2EWorkspace();
  });

  afterAll(async () => {
    await cleanupE2EWorkspace();
  });

  describe("Complete Session Workflow", () => {
    test.skipIf(!hasAnyCredentials())("should handle full session lifecycle", async () => {
      const ctx = await createTestApp();
      try {
        // 1. Check initial health
        const healthRes = await request(ctx.baseUrl, "GET", "/api/health");
        const health = await healthRes.json();
        assertEquals(health.sessions.total, 0);

        // 2. Create session
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {
          workspacePath: E2E_WORKSPACE,
        });
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // 3. Connect WebSocket
        const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, sessionId);
        const connMsg = await firstMessagePromise;
        assertEquals(connMsg.type, "connection.established");

        // 4. Send message via HTTP
        const msgRes = await request(
          ctx.baseUrl,
          "POST",
          `/api/sessions/${sessionId}/messages`,
          { content: "Hello!" },
        );
        await assertSuccessResponse(msgRes, 201);

        // 5. Get session state
        const getRes = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}`,
        );
        const session = await assertSuccessResponse<GetSessionResponse>(getRes);
        assertEquals(session.session.id, sessionId);
        assertEquals(session.messages.length, 2); // user + assistant

        // 6. Update session
        await request(ctx.baseUrl, "PATCH", `/api/sessions/${sessionId}`, {
          title: "E2E Test Session",
        });

        // 7. Verify in list
        const listRes = await request(ctx.baseUrl, "GET", "/api/sessions");
        const list = await assertSuccessResponse<ListSessionsResponse>(listRes);
        assertEquals(list.sessions.length, 1);
        assertEquals(list.sessions[0].title, "E2E Test Session");

        // 8. Check health reflects active session
        const health2Res = await request(ctx.baseUrl, "GET", "/api/health");
        const health2 = await health2Res.json();
        assertEquals(health2.sessions.total, 1);
        assertEquals(health2.sessions.active, 1);

        // 9. Close WebSocket
        ws.close();
        await waitForWebSocketState(ws, WebSocket.CLOSED);

        // 10. Delete session
        const delRes = await request(
          ctx.baseUrl,
          "DELETE",
          `/api/sessions/${sessionId}`,
        );
        assertEquals(delRes.status, 204);

        // 11. Verify deletion
        const finalHealthRes = await request(ctx.baseUrl, "GET", "/api/health");
        const finalHealth = await finalHealthRes.json();
        assertEquals(finalHealth.sessions.total, 0);
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("Auth + Session Workflow", () => {
    test.skipIf(!hasAnyCredentials())("should manage sessions with auth state changes", async () => {
      const ctx = await createTestApp();
      try {
        // 1. Verify initial auth
        const authRes = await request(ctx.baseUrl, "GET", "/api/auth/status");
        const auth = await authRes.json();
        assertEquals(auth.authStatus.isAuthenticated, true);

        // 2. Create session while authenticated
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // 3. Logout
        await request(ctx.baseUrl, "POST", "/api/auth/logout");

        // 4. Session should still exist
        const getRes = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}`,
        );
        const session = await assertSuccessResponse<GetSessionResponse>(getRes);
        assertEquals(session.session.id, sessionId);

        // 5. Re-authenticate with different method
        await request(ctx.baseUrl, "POST", "/api/auth/oauth-token", {
          token: "new-oauth-token",
        });

        const auth2Res = await request(ctx.baseUrl, "GET", "/api/auth/status");
        const auth2 = await auth2Res.json();
        assertEquals(auth2.authStatus.method, "oauth_token");

        // 6. Session should still work
        const getRes2 = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}`,
        );
        await assertSuccessResponse<GetSessionResponse>(getRes2);

        // 7. Config should reflect auth changes
        const configRes = await request(ctx.baseUrl, "GET", "/api/config");
        const config = await configRes.json();
        assertEquals(config.authMethod, "oauth_token");
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("File Operations + Sessions", () => {
    test.skipIf(!hasAnyCredentials())("should perform file operations within session context", async () => {
      const ctx = await createTestApp();
      try {
        // 1. Create session with workspace
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {
          workspacePath: E2E_WORKSPACE,
        });
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // 2. List files
        const listRes = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}/files/list`,
        );
        const files = await listRes.json();
        assertExists(files.files);
        assertTrue(files.files.length > 0);

        // 3. Read file
        const readRes = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}/files?path=README.md`,
        );
        const fileData = await readRes.json();
        assertEquals(fileData.content, "# Test Project");

        // 4. Get file tree
        const treeRes = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}/files/tree`,
        );
        const tree = await treeRes.json();
        assertExists(tree.tree);
        assertEquals(tree.tree.type, "directory");
        assertExists(tree.tree.children);

        // 5. Send message about files
        const msgRes = await request(
          ctx.baseUrl,
          "POST",
          `/api/sessions/${sessionId}/messages`,
          { content: "What files are in the workspace?" },
        );
        await assertSuccessResponse(msgRes, 201);

        // 6. Get messages
        const messagesRes = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}/messages`,
        );
        const messages = await messagesRes.json();
        assertTrue(messages.messages.length >= 2);
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("Multi-Session Scenarios", () => {
    test.skipIf(!hasAnyCredentials())("should handle multiple concurrent sessions", async () => {
      const ctx = await createTestApp();
      try {
        // 1. Create multiple sessions
        const session1Res = await request(
          ctx.baseUrl,
          "POST",
          "/api/sessions",
          { workspacePath: E2E_WORKSPACE },
        );
        const { sessionId: id1 } =
          await assertSuccessResponse<CreateSessionResponse>(session1Res, 201);

        const session2Res = await request(
          ctx.baseUrl,
          "POST",
          "/api/sessions",
          { workspacePath: E2E_WORKSPACE },
        );
        const { sessionId: id2 } =
          await assertSuccessResponse<CreateSessionResponse>(session2Res, 201);

        const session3Res = await request(
          ctx.baseUrl,
          "POST",
          "/api/sessions",
          { workspacePath: E2E_WORKSPACE },
        );
        const { sessionId: id3 } =
          await assertSuccessResponse<CreateSessionResponse>(session3Res, 201);

        // 2. Connect WebSockets for all with first message listeners
        const { ws: ws1, firstMessagePromise: msg1 } = createWebSocketWithFirstMessage(ctx.baseUrl, id1);
        const { ws: ws2, firstMessagePromise: msg2 } = createWebSocketWithFirstMessage(ctx.baseUrl, id2);
        const { ws: ws3, firstMessagePromise: msg3 } = createWebSocketWithFirstMessage(ctx.baseUrl, id3);

        // Consume initial messages
        await Promise.all([msg1, msg2, msg3]);

        // 3. Send messages to different sessions
        await request(ctx.baseUrl, "POST", `/api/sessions/${id1}/messages`, {
          content: "Message 1",
        });
        await request(ctx.baseUrl, "POST", `/api/sessions/${id2}/messages`, {
          content: "Message 2",
        });
        await request(ctx.baseUrl, "POST", `/api/sessions/${id3}/messages`, {
          content: "Message 3",
        });

        // 4. Update sessions with different titles
        await request(ctx.baseUrl, "PATCH", `/api/sessions/${id1}`, {
          title: "Session One",
        });
        await request(ctx.baseUrl, "PATCH", `/api/sessions/${id2}`, {
          title: "Session Two",
        });
        await request(ctx.baseUrl, "PATCH", `/api/sessions/${id3}`, {
          title: "Session Three",
        });

        // 5. List all sessions
        const listRes = await request(ctx.baseUrl, "GET", "/api/sessions");
        const list = await assertSuccessResponse<ListSessionsResponse>(listRes);
        assertEquals(list.sessions.length, 3);

        const titles = list.sessions.map((s) => s.title);
        assertTrue(titles.includes("Session One"));
        assertTrue(titles.includes("Session Two"));
        assertTrue(titles.includes("Session Three"));

        // 6. Verify health shows all sessions
        const healthRes = await request(ctx.baseUrl, "GET", "/api/health");
        const health = await healthRes.json();
        assertEquals(health.sessions.total, 3);
        assertEquals(health.sessions.active, 3);

        // 7. Delete one session
        await request(ctx.baseUrl, "DELETE", `/api/sessions/${id2}`);

        // 8. Verify count updated
        const health2Res = await request(ctx.baseUrl, "GET", "/api/health");
        const health2 = await health2Res.json();
        assertEquals(health2.sessions.total, 2);

        // 9. Other sessions still work
        const get1Res = await request(ctx.baseUrl, "GET", `/api/sessions/${id1}`);
        await assertSuccessResponse<GetSessionResponse>(get1Res);

        const get3Res = await request(ctx.baseUrl, "GET", `/api/sessions/${id3}`);
        await assertSuccessResponse<GetSessionResponse>(get3Res);

        // Cleanup
        ws1.close();
        ws2.close();
        ws3.close();
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("WebSocket + HTTP Integration", () => {
    test.skipIf(!hasAnyCredentials())("should sync state between WebSocket and HTTP", async () => {
      const ctx = await createTestApp();
      try {
        // 1. Create session
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // 2. Connect WebSocket and collect events
        const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, sessionId);
        await firstMessagePromise; // Initial connection

        const events: any[] = [];
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data as string);
            events.push(data);
          } catch (error) {
            // Ignore
          }
        };

        // 3. Send multiple messages via HTTP
        await request(ctx.baseUrl, "POST", `/api/sessions/${sessionId}/messages`, {
          content: "First",
        });
        await request(ctx.baseUrl, "POST", `/api/sessions/${sessionId}/messages`, {
          content: "Second",
        });

        // Wait for events
        await Bun.sleep(500);

        // 4. Update session via HTTP
        await request(ctx.baseUrl, "PATCH", `/api/sessions/${sessionId}`, {
          title: "Updated via HTTP",
        });

        // 5. Verify via HTTP
        const getRes = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}`,
        );
        const session = await assertSuccessResponse<GetSessionResponse>(getRes);
        assertEquals(session.session.title, "Updated via HTTP");
        assertEquals(session.messages.length, 4); // 2 user + 2 assistant

        // 6. Should have received events via WebSocket
        assertTrue(events.length > 0);

        ws.close();
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("Error Recovery", () => {
    test.skipIf(!hasAnyCredentials())("should handle errors gracefully in complex workflows", async () => {
      const ctx = await createTestApp();
      try {
        // 1. Create session
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // 2. Try to read non-existent file (should fail)
        const fileRes = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}/files?path=nonexistent.txt`,
        );
        assertEquals(fileRes.status, 500);

        // 3. Session should still work
        const getRes = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}`,
        );
        await assertSuccessResponse<GetSessionResponse>(getRes);

        // 4. Send message (should work)
        const msgRes = await request(
          ctx.baseUrl,
          "POST",
          `/api/sessions/${sessionId}/messages`,
          { content: "Still working" },
        );
        await assertSuccessResponse(msgRes, 201);

        // 5. Connect WebSocket (should work)
        const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, sessionId);
        await firstMessagePromise;

        // 6. Send invalid WebSocket message
        ws.send("invalid json");
        const error = await waitForWebSocketMessage(ws);
        assertEquals(error.type, "error");

        // 7. WebSocket should still work
        ws.send(JSON.stringify({ type: "ping" }));
        const pong = await waitForWebSocketMessage(ws);
        assertEquals(pong.type, "pong");

        ws.close();
      } finally {
        await ctx.cleanup();
      }
    });
  });
});
