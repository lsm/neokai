/**
 * SDK Messages Database Tests
 *
 * Tests for SDK message saving, retrieval, pagination, and tool extraction
 */

import { describe, test } from "bun:test";
import {
  createTestDb,
  createTestSession,
  assertEquals,
} from "./fixtures/database-test-utils";

describe("Database", () => {
  describe("Message Management", () => {
    test("should save and get messages via SDK messages", async () => {
      const db = await createTestDb();

      const session = createTestSession("session-1");
      db.createSession(session);

      // Save as SDK user message (new approach)
      const sdkMessage = {
        type: "user" as const,
        message: {
          role: "user" as const,
          content: "Hello, world!",
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000001" as const,
        session_id: "session-1",
      };

      db.saveSDKMessage("session-1", sdkMessage);

      // Get SDK messages directly
      const messages = db.getSDKMessages("session-1");

      assertEquals(messages.length, 1);
      assertEquals(messages[0].uuid, "00000000-0000-0000-0000-000000000001");
      assertEquals(messages[0].message.content, "Hello, world!");
      assertEquals(messages[0].type, "user");

      db.close();
    });

    test("should save assistant messages via SDK messages", async () => {
      const db = await createTestDb();

      const session = createTestSession("session-1");
      db.createSession(session);

      // Save as SDK assistant message
      const sdkMessage = {
        type: "assistant" as const,
        message: {
          role: "assistant" as const,
          content: [
            {
              type: "text" as const,
              text: "The answer is 42",
            },
          ],
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000001" as const,
        session_id: "session-1",
      };

      db.saveSDKMessage("session-1", sdkMessage);

      const messages = db.getSDKMessages("session-1");

      assertEquals(messages.length, 1);
      assertEquals(messages[0].message.content[0].text, "The answer is 42");
      assertEquals(messages[0].type, "assistant");

      db.close();
    });

    test("should order messages chronologically", async () => {
      const db = await createTestDb();

      const session = createTestSession("session-1");
      db.createSession(session);

      const sdkMsg1 = {
        type: "user" as const,
        message: {
          role: "user" as const,
          content: "First",
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000001" as const,
        session_id: "session-1",
      };

      const sdkMsg2 = {
        type: "assistant" as const,
        message: {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "Second" }],
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000002" as const,
        session_id: "session-1",
      };

      db.saveSDKMessage("session-1", sdkMsg2); // Save in reverse order
      db.saveSDKMessage("session-1", sdkMsg1);

      const messages = db.getSDKMessages("session-1");

      assertEquals(messages.length, 2);
      // SDK messages are stored chronologically
      assertEquals(messages[0].uuid, "00000000-0000-0000-0000-000000000002");
      assertEquals(messages[1].uuid, "00000000-0000-0000-0000-000000000001");

      db.close();
    });

    test("should support cursor-based pagination for SDK messages", async () => {
      const db = await createTestDb();

      const session = createTestSession("session-1");
      db.createSession(session);

      // Create 10 SDK messages with small delays to ensure distinct timestamps
      for (let i = 0; i < 10; i++) {
        const sdkMsg = {
          type: "user" as const,
          message: {
            role: "user" as const,
            content: `Message ${i}`,
          },
          parent_tool_use_id: null,
          uuid: `msg-${i}`,
          session_id: "session-1",
        };
        db.saveSDKMessage("session-1", sdkMsg);
        // Small delay to ensure different timestamps
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Initial load: get newest 5 messages (no cursor)
      const page1 = db.getSDKMessages("session-1", 5);
      assertEquals(page1.length, 5);
      assertEquals(page1[0].uuid, "msg-5"); // Oldest of the newest 5
      assertEquals(page1[4].uuid, "msg-9"); // Newest message

      // Get the timestamp of the oldest message in page1 for cursor
      const oldestInPage1 = page1[0] as { timestamp: number };
      const cursor = oldestInPage1.timestamp;

      // Load older: get messages before the cursor
      const page2 = db.getSDKMessages("session-1", 5, cursor);
      assertEquals(page2.length, 5);
      assertEquals(page2[0].uuid, "msg-0"); // Oldest message
      assertEquals(page2[4].uuid, "msg-4"); // Just before cursor

      // Verify count
      assertEquals(db.getSDKMessageCount("session-1"), 10);

      db.close();
    });
  });

  describe("Tool Call Management", () => {
    test("should extract tool calls from SDK messages", async () => {
      const db = await createTestDb();

      const session = createTestSession("session-1");
      db.createSession(session);

      // SDK assistant message with tool use
      const sdkMessage = {
        type: "assistant" as const,
        message: {
          role: "assistant" as const,
          content: [
            {
              type: "text" as const,
              text: "Reading file...",
            },
            {
              type: "tool_use" as const,
              id: "tool-1",
              name: "read_file",
              input: { path: "/test/file.txt" },
            },
          ],
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000001" as const,
        session_id: "session-1",
      };

      db.saveSDKMessage("session-1", sdkMessage);

      const messages = db.getSDKMessages("session-1");

      assertEquals(messages.length, 1);
      // Tool uses are in the SDK message content
      assertEquals(messages[0].message.content.length, 2);
      assertEquals(messages[0].message.content[1].name, "read_file");

      db.close();
    });

    test("should handle multiple tool uses in SDK messages", async () => {
      const db = await createTestDb();

      const session = createTestSession("session-1");
      db.createSession(session);

      // SDK assistant message with multiple tool uses
      const sdkMessage = {
        type: "assistant" as const,
        message: {
          role: "assistant" as const,
          content: [
            {
              type: "tool_use" as const,
              id: "tool-1",
              name: "read_file",
              input: { path: "/file1.txt" },
            },
            {
              type: "tool_use" as const,
              id: "tool-2",
              name: "write_file",
              input: { path: "/file2.txt", content: "data" },
            },
          ],
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000001" as const,
        session_id: "session-1",
      };

      db.saveSDKMessage("session-1", sdkMessage);

      const messages = db.getSDKMessages("session-1");

      assertEquals(messages[0].message.content.length, 2);
      assertEquals(messages[0].message.content[0].name, "read_file");
      assertEquals(messages[0].message.content[1].name, "write_file");

      db.close();
    });
  });
});
