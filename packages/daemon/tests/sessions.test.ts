import { assertEquals, assertExists } from "@std/assert";
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
  assertErrorResponse,
  assertSuccessResponse,
  createTestApp,
  request,
} from "./test-utils.ts";

Deno.test("Sessions API - Create session with defaults", async () => {
  const ctx = await createTestApp();

  try {
    const createReq: CreateSessionRequest = {};
    const response = await request(ctx.baseUrl, "POST", "/api/sessions", createReq);
    const result = await assertSuccessResponse<CreateSessionResponse>(response, 201);

    assertExists(result.sessionId);
    assertEquals(typeof result.sessionId, "string");
    assertEquals(result.sessionId.length, 36); // UUID length
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("Sessions API - Create session with custom config", async () => {
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

    const response = await request(ctx.baseUrl, "POST", "/api/sessions", createReq);
    const result = await assertSuccessResponse<CreateSessionResponse>(response, 201);

    assertExists(result.sessionId);

    // Verify session was created with custom config
    const getResponse = await request(ctx.baseUrl, "GET", `/api/sessions/${result.sessionId}`);
    const session = await assertSuccessResponse<GetSessionResponse>(getResponse);

    assertEquals(session.session.workspacePath, "/custom/path");
    assertEquals(session.session.config.model, "claude-opus-4-20250514");
    assertEquals(session.session.config.maxTokens, 4096);
    assertEquals(session.session.config.temperature, 0.5);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("Sessions API - List sessions", async () => {
  const ctx = await createTestApp();

  try {
    // Create multiple sessions
    const session1Res = await request(ctx.baseUrl, "POST", "/api/sessions", {});
    const session1 = await assertSuccessResponse<CreateSessionResponse>(session1Res, 201);

    const session2Res = await request(ctx.baseUrl, "POST", "/api/sessions", {});
    const session2 = await assertSuccessResponse<CreateSessionResponse>(session2Res, 201);

    // List sessions
    const listResponse = await request(ctx.baseUrl, "GET", "/api/sessions");
    const result = await assertSuccessResponse<ListSessionsResponse>(listResponse);

    assertEquals(result.sessions.length, 2);
    assertEquals(result.sessions[0].id, session2.sessionId); // Most recent first
    assertEquals(result.sessions[1].id, session1.sessionId);

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

Deno.test("Sessions API - Get session", async () => {
  const ctx = await createTestApp();

  try {
    // Create session
    const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
    const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(createRes, 201);

    // Get session
    const getResponse = await request(ctx.baseUrl, "GET", `/api/sessions/${sessionId}`);
    const result = await assertSuccessResponse<GetSessionResponse>(getResponse);

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

Deno.test("Sessions API - Get non-existent session", async () => {
  const ctx = await createTestApp();

  try {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const response = await request(ctx.baseUrl, "GET", `/api/sessions/${fakeId}`);
    const error = await assertErrorResponse(response, 404);

    assertEquals(error.error, "Session not found");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("Sessions API - Update session", async () => {
  const ctx = await createTestApp();

  try {
    // Create session
    const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
    const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(createRes, 201);

    // Update session
    const updateReq: UpdateSessionRequest = {
      title: "Updated Title",
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
    const getResponse = await request(ctx.baseUrl, "GET", `/api/sessions/${sessionId}`);
    const result = await assertSuccessResponse<GetSessionResponse>(getResponse);

    assertEquals(result.session.title, "Updated Title");
    assertEquals(result.session.workspacePath, "/new/path");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("Sessions API - Update non-existent session", async () => {
  const ctx = await createTestApp();

  try {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const updateReq: UpdateSessionRequest = { title: "New Title" };
    const response = await request(ctx.baseUrl, "PATCH", `/api/sessions/${fakeId}`, updateReq);
    const error = await assertErrorResponse(response, 404);

    assertEquals(error.error, "Session not found");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("Sessions API - Delete session", async () => {
  const ctx = await createTestApp();

  try {
    // Create session
    const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
    const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(createRes, 201);

    // Delete session
    const deleteResponse = await request(ctx.baseUrl, "DELETE", `/api/sessions/${sessionId}`);
    assertEquals(deleteResponse.status, 204);

    // Verify deletion
    const getResponse = await request(ctx.baseUrl, "GET", `/api/sessions/${sessionId}`);
    await assertErrorResponse(getResponse, 404);

    // Verify not in list
    const listResponse = await request(ctx.baseUrl, "GET", "/api/sessions");
    const result = await assertSuccessResponse<ListSessionsResponse>(listResponse);
    assertEquals(result.sessions.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("Sessions API - Send message", async () => {
  const ctx = await createTestApp();

  try {
    // Create session
    const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
    const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(createRes, 201);

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
    const result = await assertSuccessResponse<SendMessageResponse>(sendResponse, 201);

    assertExists(result.messageId);
    assertEquals(result.status, "processing");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("Sessions API - Send message to non-existent session", async () => {
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

Deno.test("Sessions API - Get messages", async () => {
  const ctx = await createTestApp();

  try {
    // Create session
    const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {});
    const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(createRes, 201);

    // Send messages
    const msg1Res = await request(
      ctx.baseUrl,
      "POST",
      `/api/sessions/${sessionId}/messages`,
      { content: "First message" },
    );
    await msg1Res.json(); // Consume response
    const msg2Res = await request(
      ctx.baseUrl,
      "POST",
      `/api/sessions/${sessionId}/messages`,
      { content: "Second message" },
    );
    await msg2Res.json(); // Consume response

    // Get messages
    const getResponse = await request(ctx.baseUrl, "GET", `/api/sessions/${sessionId}/messages`);
    const result = await getResponse.json();

    assertExists(result.messages);
    // Each message creates user + assistant message (placeholder)
    assertEquals(result.messages.length, 4);

    // Verify message structure
    const userMsg = result.messages[0];
    assertEquals(userMsg.role, "user");
    assertEquals(userMsg.content, "First message");
    assertExists(userMsg.id);
    assertExists(userMsg.timestamp);
    assertEquals(userMsg.sessionId, sessionId);

    const assistantMsg = result.messages[1];
    assertEquals(assistantMsg.role, "assistant");
    assertExists(assistantMsg.content);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("Sessions API - Get messages from non-existent session", async () => {
  const ctx = await createTestApp();

  try {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const response = await request(ctx.baseUrl, "GET", `/api/sessions/${fakeId}/messages`);
    const error = await assertErrorResponse(response, 404);

    assertEquals(error.error, "Session not found");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("Sessions API - Full workflow", async () => {
  const ctx = await createTestApp();

  try {
    // 1. Create session
    const createRes = await request(ctx.baseUrl, "POST", "/api/sessions", {
      workspacePath: "/test/workspace",
    });
    const { sessionId } = await assertSuccessResponse<CreateSessionResponse>(createRes, 201);

    // 2. Send messages
    const msgRes = await request(
      ctx.baseUrl,
      "POST",
      `/api/sessions/${sessionId}/messages`,
      { content: "What is 2+2?" },
    );
    await msgRes.json(); // Consume response

    // 3. Get session with messages
    const getRes = await request(ctx.baseUrl, "GET", `/api/sessions/${sessionId}`);
    const session = await assertSuccessResponse<GetSessionResponse>(getRes);

    assertEquals(session.session.id, sessionId);
    assertEquals(session.session.workspacePath, "/test/workspace");
    assertEquals(session.messages.length, 2); // user + assistant

    // 4. Update session
    const updateRes = await request(
      ctx.baseUrl,
      "PATCH",
      `/api/sessions/${sessionId}`,
      { title: "Math Questions" },
    );
    await updateRes.text(); // Consume response (204 has no body but may have stream)

    // 5. Verify in list
    const listRes = await request(ctx.baseUrl, "GET", "/api/sessions");
    const list = await assertSuccessResponse<ListSessionsResponse>(listRes);

    assertEquals(list.sessions.length, 1);
    assertEquals(list.sessions[0].title, "Math Questions");

    // 6. Delete session
    const delRes = await request(ctx.baseUrl, "DELETE", `/api/sessions/${sessionId}`);
    await delRes.text(); // Consume response

    // 7. Verify deletion
    const finalListRes = await request(ctx.baseUrl, "GET", "/api/sessions");
    const finalList = await assertSuccessResponse<ListSessionsResponse>(finalListRes);
    assertEquals(finalList.sessions.length, 0);
  } finally {
    await ctx.cleanup();
  }
});
