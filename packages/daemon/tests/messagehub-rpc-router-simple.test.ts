import { describe, test, expect, beforeEach } from "bun:test";
import { MessageHub } from "@liuboer/shared";
import { MessageHubRPCRouter } from "../src/lib/messagehub-rpc-router";
import { createTestApp } from "./test-utils";

describe("MessageHubRPCRouter - Handler Registration", () => {
  let messageHub: MessageHub;
  let router: MessageHubRPCRouter;
  let ctx: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => {
    ctx = await createTestApp();
    messageHub = new MessageHub({ defaultSessionId: "global" });
    router = new MessageHubRPCRouter(
      messageHub,
      ctx.sessionManager,
      ctx.authManager,
      ctx.config,
    );
  });

  test("should register all RPC handlers", () => {
    // Get initial handler count
    const initialHandlers = (messageHub as any).rpcHandlers.size;

    // Setup handlers
    router.setupHandlers();

    // Verify handlers were registered
    const finalHandlers = (messageHub as any).rpcHandlers.size;
    expect(finalHandlers).toBeGreaterThan(initialHandlers);

    // Should have at least 14 handlers (session, message, command, file, system, auth)
    expect(finalHandlers).toBeGreaterThanOrEqual(14);

    ctx.cleanup();
  });

  test("should register session operation handlers", () => {
    router.setupHandlers();

    const handlers = (messageHub as any).rpcHandlers;
    expect(handlers.has("session.create")).toBe(true);
    expect(handlers.has("session.list")).toBe(true);
    expect(handlers.has("session.get")).toBe(true);
    expect(handlers.has("session.update")).toBe(true);
    expect(handlers.has("session.delete")).toBe(true);

    ctx.cleanup();
  });

  test("should register message operation handlers", () => {
    router.setupHandlers();

    const handlers = (messageHub as any).rpcHandlers;
    expect(handlers.has("message.list")).toBe(true);
    expect(handlers.has("message.sdkMessages")).toBe(true);

    ctx.cleanup();
  });

  test("should register command operation handlers", () => {
    router.setupHandlers();

    const handlers = (messageHub as any).rpcHandlers;
    expect(handlers.has("commands.list")).toBe(true);

    ctx.cleanup();
  });

  test("should register file operation handlers", () => {
    router.setupHandlers();

    const handlers = (messageHub as any).rpcHandlers;
    expect(handlers.has("file.read")).toBe(true);
    expect(handlers.has("file.list")).toBe(true);
    expect(handlers.has("file.tree")).toBe(true);

    ctx.cleanup();
  });

  test("should register system operation handlers", () => {
    router.setupHandlers();

    const handlers = (messageHub as any).rpcHandlers;
    expect(handlers.has("system.health")).toBe(true);
    expect(handlers.has("system.config")).toBe(true);

    ctx.cleanup();
  });

  test("should register auth operation handlers", () => {
    router.setupHandlers();

    const handlers = (messageHub as any).rpcHandlers;
    expect(handlers.has("auth.status")).toBe(true);

    ctx.cleanup();
  });

  test("should use correct method names without request/response suffixes", () => {
    router.setupHandlers();

    const handlers = (messageHub as any).rpcHandlers;

    // Old pattern had .request suffix, new pattern doesn't
    expect(handlers.has("session.create.request")).toBe(false);
    expect(handlers.has("session.create")).toBe(true);

    expect(handlers.has("system.health.request")).toBe(false);
    expect(handlers.has("system.health")).toBe(true);

    ctx.cleanup();
  });
});
