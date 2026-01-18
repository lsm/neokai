/**
 * Message RPC Handlers Tests
 *
 * Unit tests use mocks for fast execution.
 * Integration tests use real WebSocket connections.
 */

import {
  describe,
  expect,
  it,
  test,
  beforeAll,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";
import { setupMessageHandlers } from "../../../../src/lib/rpc-handlers/message-handlers";
import type { TestContext } from "../../../test-utils";
import {
  createTestApp,
  waitForWebSocketState,
  waitForWebSocketMessage,
  createWebSocketWithFirstMessage,
} from "../../../test-utils";

describe("Message RPC Handlers", () => {
  let handlers: Map<string, Function>;
  let mockMessageHub: {
    handle: ReturnType<typeof mock>;
  };
  let mockSessionManager: {
    getSessionAsync: ReturnType<typeof mock>;
  };

  beforeAll(() => {
    handlers = new Map();
    mockMessageHub = {
      handle: mock((method: string, handler: Function) => {
        handlers.set(method, handler);
      }),
    };

    const mockSDKMessages = [
      { type: "user", message: { role: "user", content: "Hello" } },
      { type: "assistant", message: { role: "assistant", content: "Hi!" } },
    ];

    mockSessionManager = {
      getSessionAsync: mock(async (sessionId: string) => {
        if (sessionId === "valid-session") {
          return {
            getSDKMessages: mock(
              (_limit?: number, _before?: number, _since?: number) =>
                mockSDKMessages,
            ),
            getSDKMessageCount: mock(() => mockSDKMessages.length),
          };
        }
        return null;
      }),
    };

    setupMessageHandlers(mockMessageHub, mockSessionManager);
  });

  describe("message.sdkMessages", () => {
    it("should register handler", () => {
      expect(handlers.has("message.sdkMessages")).toBe(true);
    });

    it("should get SDK messages", async () => {
      const handler = handlers.get("message.sdkMessages")!;
      const result = await handler({
        sessionId: "valid-session",
      });

      expect(result.sdkMessages).toBeDefined();
      expect(Array.isArray(result.sdkMessages)).toBe(true);
      expect(result.sdkMessages).toHaveLength(2);
    });

    it("should support limit parameter", async () => {
      const handler = handlers.get("message.sdkMessages")!;
      const result = await handler({
        sessionId: "valid-session",
        limit: 10,
      });

      expect(result.sdkMessages).toBeDefined();
    });

    it("should support before parameter for cursor-based pagination", async () => {
      const handler = handlers.get("message.sdkMessages")!;
      const result = await handler({
        sessionId: "valid-session",
        before: Date.now(),
      });

      expect(result.sdkMessages).toBeDefined();
    });

    it("should support since parameter", async () => {
      const handler = handlers.get("message.sdkMessages")!;
      const result = await handler({
        sessionId: "valid-session",
        since: Date.now() - 1000,
      });

      expect(result.sdkMessages).toBeDefined();
    });

    it("should support all parameters together", async () => {
      const handler = handlers.get("message.sdkMessages")!;
      const result = await handler({
        sessionId: "valid-session",
        limit: 5,
        before: Date.now(),
        since: Date.now() - 10000,
      });

      expect(result.sdkMessages).toBeDefined();
    });

    it("should throw for invalid session", async () => {
      const handler = handlers.get("message.sdkMessages")!;
      await expect(
        handler({
          sessionId: "invalid",
        }),
      ).rejects.toThrow("Session not found");
    });
  });

  describe("message.count", () => {
    it("should register handler", () => {
      expect(handlers.has("message.count")).toBe(true);
    });

    it("should get message count", async () => {
      const handler = handlers.get("message.count")!;
      const result = await handler({
        sessionId: "valid-session",
      });

      expect(result.count).toBeDefined();
      expect(result.count).toBe(2);
    });

    it("should throw for invalid session", async () => {
      const handler = handlers.get("message.count")!;
      await expect(
        handler({
          sessionId: "invalid",
        }),
      ).rejects.toThrow("Session not found");
    });
  });
});

describe("Message RPC Handlers (Integration)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  describe("message.send", () => {
    test("should return error for non-existent session", async () => {
      const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(
        ctx.baseUrl,
        "global",
      );
      await waitForWebSocketState(ws, WebSocket.OPEN);
      await firstMessagePromise;

      const responsePromise = waitForWebSocketMessage(ws);

      ws.send(
        JSON.stringify({
          id: "msg-1",
          type: "CALL",
          method: "message.send",
          data: {
            sessionId: "non-existent",
            content: "Hello",
          },
          sessionId: "global",
          timestamp: new Date().toISOString(),
          version: "1.0.0",
        }),
      );

      const response = await responsePromise;

      expect(response.type).toBe("ERROR");
      // Could be either SESSION_NOT_FOUND from setup-websocket.ts or "Session not found" from handler
      expect(
        response.errorCode === "SESSION_NOT_FOUND" ||
          response.error?.includes("Session not found"),
      ).toBe(true);

      ws.close();
    });

    // Note: Test for successful message.send with real SDK is in tests/online/session-handlers.test.ts
  });
});
