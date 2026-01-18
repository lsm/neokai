/**
 * Data Integrity Database Tests
 *
 * Tests for cascade deletes, session isolation, and referential integrity
 */

import { describe, test } from "bun:test";
import {
  createTestDb,
  createTestSession,
  assertEquals,
} from "./fixtures/database-test-utils";

describe("Database", () => {
  describe("Data Integrity", () => {
    test("should cascade delete SDK messages when session is deleted", async () => {
      const db = await createTestDb();

      const session = createTestSession("session-1");
      db.createSession(session);

      const sdkMsg = {
        type: "user" as const,
        message: {
          role: "user" as const,
          content: "Test",
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000001" as const,
        session_id: "session-1",
      };
      db.saveSDKMessage("session-1", sdkMsg);

      assertEquals(db.getSDKMessages("session-1").length, 1);

      // Delete session should cascade delete SDK messages
      db.deleteSession("session-1");

      // Session should be gone
      assertEquals(db.getSession("session-1"), null);
      assertEquals(db.getSDKMessages("session-1").length, 0);

      db.close();
    });

    test("should maintain session isolation", async () => {
      const db = await createTestDb();

      const session1 = createTestSession("session-1");
      const session2 = createTestSession("session-2");

      db.createSession(session1);
      db.createSession(session2);

      const sdkMsg1 = {
        type: "user" as const,
        message: {
          role: "user" as const,
          content: "Session 1 message",
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000001" as const,
        session_id: "session-1",
      };

      const sdkMsg2 = {
        type: "user" as const,
        message: {
          role: "user" as const,
          content: "Session 2 message",
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000002" as const,
        session_id: "session-2",
      };

      db.saveSDKMessage("session-1", sdkMsg1);
      db.saveSDKMessage("session-2", sdkMsg2);

      const messages1 = db.getSDKMessages("session-1");
      const messages2 = db.getSDKMessages("session-2");

      assertEquals(messages1.length, 1);
      assertEquals(messages1[0].message.content, "Session 1 message");

      assertEquals(messages2.length, 1);
      assertEquals(messages2[0].message.content, "Session 2 message");

      db.close();
    });
  });
});
