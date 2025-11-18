import { assertEquals, assertExists } from "@std/assert";
import type { Message, Session, ToolCall } from "@liuboer/shared";
import { Database } from "../src/storage/database.ts";

async function createTestDb(): Promise<Database> {
  const db = new Database(":memory:");
  await db.initialize();
  return db;
}

function createTestSession(id: string): Session {
  return {
    id,
    title: `Test Session ${id}`,
    workspacePath: "/test/workspace",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: "active",
    config: {
      model: "claude-sonnet-4-20250514",
      maxTokens: 8192,
      temperature: 1.0,
    },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      toolCallCount: 0,
    },
  };
}

Deno.test("Database - Initialize creates tables", async () => {
  const db = await createTestDb();

  // Should not throw
  db.createSession(createTestSession("test-1"));
  const session = db.getSession("test-1");

  assertExists(session);
  assertEquals(session.id, "test-1");

  db.close();
});

Deno.test("Database - Create and get session", async () => {
  const db = await createTestDb();

  const testSession = createTestSession("session-1");
  db.createSession(testSession);

  const retrieved = db.getSession("session-1");

  assertExists(retrieved);
  assertEquals(retrieved.id, testSession.id);
  assertEquals(retrieved.title, testSession.title);
  assertEquals(retrieved.workspacePath, testSession.workspacePath);
  assertEquals(retrieved.status, testSession.status);
  assertEquals(retrieved.config.model, testSession.config.model);
  assertEquals(retrieved.metadata.messageCount, 0);

  db.close();
});

Deno.test("Database - Get non-existent session returns null", async () => {
  const db = await createTestDb();

  const result = db.getSession("non-existent");
  assertEquals(result, null);

  db.close();
});

Deno.test("Database - List sessions ordered by last active", async () => {
  const db = await createTestDb();

  // Create sessions with explicit timestamps
  const now = Date.now();
  const session1 = createTestSession("session-1");
  session1.lastActiveAt = new Date(now).toISOString();

  const session2 = createTestSession("session-2");
  session2.lastActiveAt = new Date(now + 1000).toISOString();

  const session3 = createTestSession("session-3");
  session3.lastActiveAt = new Date(now + 2000).toISOString();

  db.createSession(session1);
  db.createSession(session2);
  db.createSession(session3);

  const sessions = db.listSessions();

  assertEquals(sessions.length, 3);
  // Should be ordered by last_active_at DESC (most recent first)
  assertEquals(sessions[0].id, "session-3");
  assertEquals(sessions[1].id, "session-2");
  assertEquals(sessions[2].id, "session-1");

  db.close();
});

Deno.test("Database - Update session", async () => {
  const db = await createTestDb();

  const session = createTestSession("session-1");
  db.createSession(session);

  db.updateSession("session-1", {
    title: "Updated Title",
    workspacePath: "/new/path",
    status: "paused",
  });

  const updated = db.getSession("session-1");

  assertExists(updated);
  assertEquals(updated.title, "Updated Title");
  assertEquals(updated.workspacePath, "/new/path");
  assertEquals(updated.status, "paused");

  db.close();
});

Deno.test("Database - Delete session", async () => {
  const db = await createTestDb();

  const session = createTestSession("session-1");
  db.createSession(session);

  assertEquals(db.listSessions().length, 1);

  db.deleteSession("session-1");

  assertEquals(db.getSession("session-1"), null);
  assertEquals(db.listSessions().length, 0);

  db.close();
});

Deno.test("Database - Save and get messages", async () => {
  const db = await createTestDb();

  const session = createTestSession("session-1");
  db.createSession(session);

  const message: Message = {
    id: "msg-1",
    sessionId: "session-1",
    role: "user",
    content: "Hello, world!",
    timestamp: new Date().toISOString(),
  };

  db.saveMessage(message);

  const messages = db.getMessages("session-1");

  assertEquals(messages.length, 1);
  assertEquals(messages[0].id, "msg-1");
  assertEquals(messages[0].content, "Hello, world!");
  assertEquals(messages[0].role, "user");

  db.close();
});

Deno.test("Database - Messages with thinking and metadata", async () => {
  const db = await createTestDb();

  const session = createTestSession("session-1");
  db.createSession(session);

  const message: Message = {
    id: "msg-1",
    sessionId: "session-1",
    role: "assistant",
    content: "The answer is 42",
    timestamp: new Date().toISOString(),
    thinking: "Let me think about this...",
    metadata: { tokens: 100, duration: 500 },
  };

  db.saveMessage(message);

  const messages = db.getMessages("session-1");

  assertEquals(messages.length, 1);
  assertEquals(messages[0].thinking, "Let me think about this...");
  assertExists(messages[0].metadata);
  assertEquals(messages[0].metadata!.tokens, 100);

  db.close();
});

Deno.test("Database - Messages ordered chronologically", async () => {
  const db = await createTestDb();

  const session = createTestSession("session-1");
  db.createSession(session);

  const msg1: Message = {
    id: "msg-1",
    sessionId: "session-1",
    role: "user",
    content: "First",
    timestamp: new Date(Date.now() - 1000).toISOString(),
  };

  const msg2: Message = {
    id: "msg-2",
    sessionId: "session-1",
    role: "assistant",
    content: "Second",
    timestamp: new Date().toISOString(),
  };

  db.saveMessage(msg2); // Save in reverse order
  db.saveMessage(msg1);

  const messages = db.getMessages("session-1");

  assertEquals(messages.length, 2);
  assertEquals(messages[0].id, "msg-1"); // Should be chronological
  assertEquals(messages[1].id, "msg-2");

  db.close();
});

Deno.test("Database - Messages with pagination", async () => {
  const db = await createTestDb();

  const session = createTestSession("session-1");
  db.createSession(session);

  const baseTime = Date.now();
  // Create 10 messages
  for (let i = 0; i < 10; i++) {
    const msg: Message = {
      id: `msg-${i}`,
      sessionId: "session-1",
      role: "user",
      content: `Message ${i}`,
      timestamp: new Date(baseTime + i * 1000).toISOString(),
    };
    db.saveMessage(msg);
  }

  // Get first 5 (most recent first, then reversed to chronological)
  const page1 = db.getMessages("session-1", 5, 0);
  assertEquals(page1.length, 5);
  // After reverse, should be in chronological order from msg-5 to msg-9
  assertEquals(page1[0].id, "msg-5");
  assertEquals(page1[4].id, "msg-9");

  // Get next 5
  const page2 = db.getMessages("session-1", 5, 5);
  assertEquals(page2.length, 5);
  // After reverse, should be msg-0 to msg-4
  assertEquals(page2[0].id, "msg-0");
  assertEquals(page2[4].id, "msg-4");

  db.close();
});

Deno.test("Database - Save and get tool calls", async () => {
  const db = await createTestDb();

  const session = createTestSession("session-1");
  db.createSession(session);

  const message: Message = {
    id: "msg-1",
    sessionId: "session-1",
    role: "assistant",
    content: "Reading file...",
    timestamp: new Date().toISOString(),
    toolCalls: [
      {
        id: "tool-1",
        messageId: "msg-1",
        tool: "read_file",
        input: { path: "/test/file.txt" },
        output: { content: "file contents" },
        status: "success",
        duration: 100,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  db.saveMessage(message);

  const messages = db.getMessages("session-1");

  assertEquals(messages.length, 1);
  assertExists(messages[0].toolCalls);
  assertEquals(messages[0].toolCalls!.length, 1);
  assertEquals(messages[0].toolCalls![0].tool, "read_file");
  assertEquals(messages[0].toolCalls![0].status, "success");
  assertEquals(messages[0].toolCalls![0].duration, 100);

  db.close();
});

Deno.test("Database - Tool call with error", async () => {
  const db = await createTestDb();

  const session = createTestSession("session-1");
  db.createSession(session);

  const toolCall: ToolCall = {
    id: "tool-1",
    messageId: "msg-1",
    tool: "read_file",
    input: { path: "/nonexistent" },
    status: "error",
    error: "File not found",
    timestamp: new Date().toISOString(),
  };

  const message: Message = {
    id: "msg-1",
    sessionId: "session-1",
    role: "assistant",
    content: "Error reading file",
    timestamp: new Date().toISOString(),
    toolCalls: [toolCall],
  };

  db.saveMessage(message);

  const messages = db.getMessages("session-1");

  assertEquals(messages[0].toolCalls![0].status, "error");
  assertEquals(messages[0].toolCalls![0].error, "File not found");

  db.close();
});

Deno.test("Database - Cascade delete messages", async () => {
  const db = await createTestDb();

  const session = createTestSession("session-1");
  db.createSession(session);

  const msg: Message = {
    id: "msg-1",
    sessionId: "session-1",
    role: "user",
    content: "Test",
    timestamp: new Date().toISOString(),
  };
  db.saveMessage(msg);

  assertEquals(db.getMessages("session-1").length, 1);

  // Delete session should cascade delete messages
  db.deleteSession("session-1");

  // Session should be gone
  assertEquals(db.getSession("session-1"), null);

  db.close();
});

Deno.test("Database - Multiple sessions isolation", async () => {
  const db = await createTestDb();

  const session1 = createTestSession("session-1");
  const session2 = createTestSession("session-2");

  db.createSession(session1);
  db.createSession(session2);

  const msg1: Message = {
    id: "msg-1",
    sessionId: "session-1",
    role: "user",
    content: "Session 1 message",
    timestamp: new Date().toISOString(),
  };

  const msg2: Message = {
    id: "msg-2",
    sessionId: "session-2",
    role: "user",
    content: "Session 2 message",
    timestamp: new Date().toISOString(),
  };

  db.saveMessage(msg1);
  db.saveMessage(msg2);

  const messages1 = db.getMessages("session-1");
  const messages2 = db.getMessages("session-2");

  assertEquals(messages1.length, 1);
  assertEquals(messages1[0].content, "Session 1 message");

  assertEquals(messages2.length, 1);
  assertEquals(messages2[0].content, "Session 2 message");

  db.close();
});
