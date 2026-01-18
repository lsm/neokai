/**
 * Shared utilities for integration tests
 *
 * Provides common setup/teardown for tests that verify:
 * - Database persistence
 * - DaemonHub event emission
 * - MessageHub broadcasting
 */

import { Database } from "../../src/storage/database";
import { createDaemonHub, type DaemonHub } from "../../src/lib/daemon-hub";
import type { Session, SessionConfig, SessionMetadata } from "@liuboer/shared";
import type {
  PublishOptions,
  CallOptions,
  SubscribeOptions,
  RPCHandler,
  EventHandler,
  UnsubscribeFn,
} from "@liuboer/shared/message-hub/types";
import { generateUUID } from "@liuboer/shared";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * Mock MessageHub for broadcast verification
 * Captures all publish calls for assertion
 */
export class MockMessageHub {
  private handlers = new Map<string, RPCHandler>();
  private publishedMessages: Array<{
    method: string;
    data: unknown;
    options?: PublishOptions;
  }> = [];

  // Track published messages
  async publish(
    method: string,
    data: unknown,
    options?: PublishOptions,
  ): Promise<void> {
    this.publishedMessages.push({ method, data, options });
  }

  // Get published messages for verification
  getPublishedMessages() {
    return this.publishedMessages;
  }

  // Clear published messages
  clearPublishedMessages() {
    this.publishedMessages = [];
  }

  // RPC handler registration
  handle<TData = unknown, TResult = unknown>(
    method: string,
    handler: RPCHandler<TData, TResult>,
  ): void {
    this.handlers.set(method, handler as RPCHandler);
  }

  // RPC call (for testing handlers)
  async call<TResult = unknown>(
    method: string,
    data?: unknown,
    _options?: CallOptions,
  ): Promise<TResult> {
    const handler = this.handlers.get(method);
    if (!handler) {
      throw new Error(`No handler for method: ${method}`);
    }

    const context = {
      messageId: generateUUID(),
      sessionId: "test-session",
      method,
      timestamp: new Date().toISOString(),
    };

    return (await handler(data, context)) as TResult;
  }

  // Stub methods (not used in these tests)
  subscribe(
    _method: string,
    _handler: EventHandler,
    _options?: SubscribeOptions,
  ): UnsubscribeFn {
    return () => {};
  }

  unsubscribe(_method: string, _options?: SubscribeOptions): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Integration test environment
 */
export interface IntegrationTestEnv {
  db: Database;
  daemonHub: DaemonHub;
  mockMessageHub: MockMessageHub;
  tempDir: string;
  testWorkspace: string;
}

/**
 * Setup integration test environment
 * Creates in-memory database, DaemonHub, and MockMessageHub
 */
export async function setupIntegrationTestEnv(): Promise<IntegrationTestEnv> {
  // Create temporary directory for database and workspace
  const tempDir = mkdtempSync(join(tmpdir(), "integration-test-"));
  const testWorkspace = join(tempDir, "workspace");

  // Initialize in-memory database
  const db = new Database(":memory:");
  await db.initialize();

  // Initialize DaemonHub
  const daemonHub = createDaemonHub("test");
  await daemonHub.initialize();

  // Initialize mock MessageHub
  const mockMessageHub = new MockMessageHub();

  return {
    db,
    daemonHub,
    mockMessageHub,
    tempDir,
    testWorkspace,
  };
}

/**
 * Cleanup integration test environment
 */
export async function cleanupIntegrationTestEnv(
  env: IntegrationTestEnv,
): Promise<void> {
  // Cleanup
  env.db.close();
  // DaemonHub doesn't have a destroy method, just clear it by letting it go out of scope

  // Remove temp directory
  if (env.tempDir) {
    rmSync(env.tempDir, { recursive: true, force: true });
  }
}

/**
 * Create a test session with default values
 * Allows partial overrides for customization
 */
export function createTestSession(
  workspace: string,
  overrides?: {
    id?: string;
    title?: string;
    config?: Partial<SessionConfig>;
    metadata?: Partial<SessionMetadata>;
    availableCommands?: string[];
    processingState?: string;
  },
): Session {
  return {
    id: overrides?.id ?? generateUUID(),
    title: overrides?.title ?? "Test Session",
    workspacePath: workspace,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: "active",
    config: {
      model: "claude-sonnet-4-5-20250929",
      maxTokens: 8192,
      temperature: 1.0,
      ...overrides?.config,
    },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
      ...overrides?.metadata,
    },
    availableCommands: overrides?.availableCommands,
    processingState: overrides?.processingState,
  };
}
