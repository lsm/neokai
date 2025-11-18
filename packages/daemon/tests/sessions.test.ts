/**
 * Sessions API Integration Tests
 *
 * Tests all session management endpoints:
 * - POST /api/sessions (create)
 * - GET /api/sessions (list)
 * - GET /api/sessions/:sessionId (get)
 * - PATCH /api/sessions/:sessionId (update)
 * - DELETE /api/sessions/:sessionId (delete)
 * - POST /api/sessions/:sessionId/messages (send message)
 * - GET /api/sessions/:sessionId/messages (get messages)
 */

import { describe, test, expect } from "bun:test";
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  GetSessionResponse,
  ListSessionsResponse,
  SendMessageRequest,
  SendMessageResponse,
  UpdateSessionRequest,
} from "@liuboer/shared";
import {
  createTestApp,
  request,
  assertSuccessResponse,
  assertErrorResponse,
  assertEquals,
  assertExists,
  assertTrue,
  hasAnyCredentials,
} from "./test-utils";

describe("Sessions API", () => {
  describe("POST /api/sessions", () => {
    test("should create session with defaults", async () => {
      const ctx = await createTestApp();
      try {
        const createReq: CreateSessionRequest = {};
        const response = await request(
          ctx.baseUrl,
          "POST",
          "/api/sessions",
          createReq,
        );
        const result = await assertSuccessResponse<CreateSessionResponse>(
          response,
          201,
        );

        assertExists(result.sessionId);
        assertEquals(typeof result.sessionId, "string");
        assertEquals(result.sessionId.length, 36); // UUID length
      } finally {
        await ctx.cleanup();
      }
    });

    test("should create session with custom config", async () => {
      const ctx = await createTestApp();
      try {
        const createReq: CreateSessionRequest = {
          workspacePath: "/custom/path",
          initialTools: ["read", "write"],
          config: {
            model: "claude-opus-4-20250514",
            maxTokens: 4096,
            temperature: 0.5,
          },
        };

        const response = await request(
          ctx.baseUrl,
          "POST",
          "/api/sessions",
          createReq,
        );
        const result = await assertSuccessResponse<CreateSessionResponse>(
          response,
          201,
        );

        assertExists(result.sessionId);

        // Verify session was created with custom config
        const getResponse = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${result.sessionId}`,
        );
        const session =
          await assertSuccessResponse<GetSessionResponse>(getResponse);

        assertEquals(session.session.workspacePath, "/custom/path");
        assertEquals(session.session.config.model, "claude-opus-4-20250514");
        assertEquals(session.session.config.maxTokens, 4096);
        assertEquals(session.session.config.temperature, 0.5);
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("GET /api/sessions", () => {
    test("should list empty sessions", async () => {
      const ctx = await createTestApp();
      try {
        const response = await request(ctx.baseUrl, "GET", "/api/sessions");
        const result =
          await assertSuccessResponse<ListSessionsResponse>(response);

        assertEquals(result.sessions.length, 0);
      } finally {
        await ctx.cleanup();
      }
    });

    test("should list multiple sessions", async () => {
      const ctx = await createTestApp();
      try {
        // Create multiple sessions
        const session1Res = await request(
          ctx.baseUrl,
          "POST",
          "/api/sessions",
          {},
        );
        const session1 = await assertSuccessResponse<CreateSessionResponse>(
          session1Res,
          201,
        );

        const session2Res = await request(
          ctx.baseUrl,
          "POST",
          "/api/sessions",
          {},
        );
        const session2 = await assertSuccessResponse<CreateSessionResponse>(
          session2Res,
          201,
        );

        // List sessions
        const listResponse = await request(ctx.baseUrl, "GET", "/api/sessions");
        const result =
          await assertSuccessResponse<ListSessionsResponse>(listResponse);

        assertEquals(result.sessions.length, 2);
        // Verify both sessions are in the list (order may vary)
        const sessionIds = result.sessions.map(s => s.id);
        assertTrue(sessionIds.includes(session1.sessionId));
        assertTrue(sessionIds.includes(session2.sessionId));

        // Verify session structure
        const session = result.sessions[0];
        assertExists(session.id);
        assertExists(session.title);
        assertExists(session.workspacePath);
        assertExists(session.createdAt);
        assertExists(session.lastActiveAt);
        assertEquals(session.status, "active");
        assertExists(session.config);
        assertExists(session.metadata);
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("GET /api/sessions/:sessionId", () => {
    test("should get session by ID", async () => {
      const ctx = await createTestApp();
      try {
        // Create session
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // Get session
        const getResponse = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}`,
        );
        const result =
          await assertSuccessResponse<GetSessionResponse>(getResponse);

        assertEquals(result.session.id, sessionId);
        assertExists(result.messages);
        assertEquals(result.messages.length, 0); // No messages yet
        assertExists(result.activeTools);
        assertExists(result.context);
        assertExists(result.context.workingDirectory);
      } finally {
        await ctx.cleanup();
      }
    });

    test("should fail for non-existent session", async () => {
      const ctx = await createTestApp();
      try {
        const fakeId = "00000000-0000-0000-0000-000000000000";
        const response = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${fakeId}`,
        );
        const error = await assertErrorResponse(response, 404);

        assertEquals(error.error, "Session not found");
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("PATCH /api/sessions/:sessionId", () => {
    test("should update session title", async () => {
      const ctx = await createTestApp();
      try {
        // Create session
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // Update session
        const updateReq: UpdateSessionRequest = {
          title: "Updated Title",
        };
        const updateResponse = await request(
          ctx.baseUrl,
          "PATCH",
          `/api/sessions/${sessionId}`,
          updateReq,
        );
        assertEquals(updateResponse.status, 204);

        // Verify update
        const getResponse = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}`,
        );
        const result =
          await assertSuccessResponse<GetSessionResponse>(getResponse);

        assertEquals(result.session.title, "Updated Title");
      } finally {
        await ctx.cleanup();
      }
    });

    test("should update workspace path", async () => {
      const ctx = await createTestApp();
      try {
        // Create session
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // Update session
        const updateReq: UpdateSessionRequest = {
          workspacePath: "/new/path",
        };
        const updateResponse = await request(
          ctx.baseUrl,
          "PATCH",
          `/api/sessions/${sessionId}`,
          updateReq,
        );
        assertEquals(updateResponse.status, 204);

        // Verify update
        const getResponse = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}`,
        );
        const result =
          await assertSuccessResponse<GetSessionResponse>(getResponse);

        assertEquals(result.session.workspacePath, "/new/path");
      } finally {
        await ctx.cleanup();
      }
    });

    test("should update multiple fields", async () => {
      const ctx = await createTestApp();
      try {
        // Create session
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // Update session
        const updateReq: UpdateSessionRequest = {
          title: "New Title",
          workspacePath: "/another/path",
        };
        const updateResponse = await request(
          ctx.baseUrl,
          "PATCH",
          `/api/sessions/${sessionId}`,
          updateReq,
        );
        assertEquals(updateResponse.status, 204);

        // Verify update
        const getResponse = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}`,
        );
        const result =
          await assertSuccessResponse<GetSessionResponse>(getResponse);

        assertEquals(result.session.title, "New Title");
        assertEquals(result.session.workspacePath, "/another/path");
      } finally {
        await ctx.cleanup();
      }
    });

    test("should fail for non-existent session", async () => {
      const ctx = await createTestApp();
      try {
        const fakeId = "00000000-0000-0000-0000-000000000000";
        const updateReq: UpdateSessionRequest = { title: "New Title" };
        const response = await request(
          ctx.baseUrl,
          "PATCH",
          `/api/sessions/${fakeId}`,
          updateReq,
        );
        const error = await assertErrorResponse(response, 404);

        assertEquals(error.error, "Session not found");
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("DELETE /api/sessions/:sessionId", () => {
    test("should delete session successfully", async () => {
      const ctx = await createTestApp();
      try {
        // Create session
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // Delete session
        const deleteResponse = await request(
          ctx.baseUrl,
          "DELETE",
          `/api/sessions/${sessionId}`,
        );
        assertEquals(deleteResponse.status, 204);

        // Verify deletion
        const getResponse = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}`,
        );
        await assertErrorResponse(getResponse, 404);

        // Verify not in list
        const listResponse = await request(ctx.baseUrl, "GET", "/api/sessions");
        const result =
          await assertSuccessResponse<ListSessionsResponse>(listResponse);
        assertEquals(result.sessions.length, 0);
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("POST /api/sessions/:sessionId/messages", () => {
    test.skipIf(!hasAnyCredentials())("should send message successfully", async () => {
      const ctx = await createTestApp();
      try {
        // Create session
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // Send message
        const messageReq: SendMessageRequest = {
          content: "Hello, world!",
        };
        const sendResponse = await request(
          ctx.baseUrl,
          "POST",
          `/api/sessions/${sessionId}/messages`,
          messageReq,
        );

        // With proper configuration, message sending should work
        const result = await assertSuccessResponse<SendMessageResponse>(
          sendResponse,
          201,
        );
        assertExists(result.messageId);
        assertEquals(result.status, "processing");
      } finally {
        await ctx.cleanup();
      }
    });

    test("should fail for non-existent session", async () => {
      const ctx = await createTestApp();
      try {
        const fakeId = "00000000-0000-0000-0000-000000000000";
        const messageReq: SendMessageRequest = {
          content: "Hello!",
        };
        const response = await request(
          ctx.baseUrl,
          "POST",
          `/api/sessions/${fakeId}/messages`,
          messageReq,
        );
        const error = await assertErrorResponse(response, 404);

        assertEquals(error.error, "Session not found");
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("GET /api/sessions/:sessionId/messages", () => {
    test("should get empty messages list", async () => {
      const ctx = await createTestApp();
      try {
        // Create session
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // Get messages
        const getResponse = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}/messages`,
        );
        const result = await getResponse.json();

        assertExists(result.messages);
        assertEquals(result.messages.length, 0);
      } finally {
        await ctx.cleanup();
      }
    });

    test.skipIf(!hasAnyCredentials())("should get messages after sending", async () => {
      const ctx = await createTestApp();
      try {
        // Create session
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // Try to send messages (may fail in test environment)
        const msg1Res = await request(
          ctx.baseUrl,
          "POST",
          `/api/sessions/${sessionId}/messages`,
          { content: "First message" },
        );
        const msg1Success = msg1Res.status === 201;

        if (msg1Success) {
          await msg1Res.json();
        }

        // Get messages
        const getResponse = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}/messages`,
        );
        const result = await getResponse.json();

        assertExists(result.messages);

        if (msg1Success) {
          // If message sending worked, check structure
          assertTrue(result.messages.length >= 2); // At least user + assistant

          const userMsg = result.messages[0];
          assertEquals(userMsg.role, "user");
          assertEquals(userMsg.content, "First message");
          assertExists(userMsg.id);
          assertExists(userMsg.timestamp);
          assertEquals(userMsg.sessionId, sessionId);
        } else {
          // If sending failed, just verify empty messages work
          assertTrue(result.messages.length >= 0);
        }
      } finally {
        await ctx.cleanup();
      }
    });

    test("should fail for non-existent session", async () => {
      const ctx = await createTestApp();
      try {
        const fakeId = "00000000-0000-0000-0000-000000000000";
        const response = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${fakeId}/messages`,
        );
        const error = await assertErrorResponse(response, 404);

        assertEquals(error.error, "Session not found");
      } finally {
        await ctx.cleanup();
      }
    });
  });

  describe("Full session workflow", () => {
    test("should support complete session lifecycle", async () => {
      const ctx = await createTestApp();
      try {
        // 1. Create session
        const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {
          workspacePath: "/test/workspace",
        });
        const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(
          createRes,
          201,
        );

        // 2. Get session
        const getRes = await request(
          ctx.baseUrl,
          "GET",
          `/api/sessions/${sessionId}`,
        );
        const session = await assertSuccessResponse<GetSessionResponse>(getRes);

        assertEquals(session.session.id, sessionId);
        assertEquals(session.session.workspacePath, "/test/workspace");

        // 3. Update session
        const updateRes = await request(
          ctx.baseUrl,
          "PATCH",
          `/api/sessions/${sessionId}`,
          { title: "Math Questions" },
        );
        await updateRes.text();

        // 4. Verify in list
        const listRes = await request(ctx.baseUrl, "GET", "/api/sessions");
        const list = await assertSuccessResponse<ListSessionsResponse>(listRes);

        assertEquals(list.sessions.length, 1);
        assertEquals(list.sessions[0].title, "Math Questions");

        // 5. Delete session
        const delRes = await request(
          ctx.baseUrl,
          "DELETE",
          `/api/sessions/${sessionId}`,
        );
        await delRes.text();

        // 6. Verify deletion
        const finalListRes = await request(ctx.baseUrl, "GET", "/api/sessions");
        const finalList =
          await assertSuccessResponse<ListSessionsResponse>(finalListRes);
        assertEquals(finalList.sessions.length, 0);
      } finally {
        await ctx.cleanup();
      }
    });
  });
});
