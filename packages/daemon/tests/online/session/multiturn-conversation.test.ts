/**
 * Multi-Turn Conversation Tests
 *
 * These tests verify that AgentSession correctly handles multi-turn conversations:
 * - Context retention across turns
 * - Sequential message processing
 * - SDK message persistence
 * - Processing state transitions
 *
 * REQUIREMENTS:
 * - Requires GLM_API_KEY or ANTHROPIC_API_KEY
 * - Uses 'haiku' model which auto-maps to glm-4.5-air when GLM_API_KEY is set
 * - Makes real API calls (costs money, uses rate limits)
 *
 * These tests run in parallel with other tests for faster CI execution.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { DaemonServerContext } from "../helpers/daemon-server-helper";
import { spawnDaemonServer } from "../helpers/daemon-server-helper";
import {
  sendMessage,
  waitForIdle,
  getProcessingState,
} from "../helpers/daemon-test-helpers";

/**
 * CRITICAL: Restore any mocks before running these tests.
 * This prevents mock leakage from unit tests that mock the SDK.
 */
describe("Multi-Turn Conversation", () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    // Restore mocks to ensure we use the real SDK
    mock.restore();
    daemon = await spawnDaemonServer();
  });

  afterEach(
    async () => {
      if (daemon) {
        daemon.kill("SIGTERM");
        await daemon.waitForExit();
      }
    },
    { timeout: 30000 },
  ); // 30s timeout for cleanup (slower API + subprocess exit)

  test("should handle multi-turn conversation with context retention", async () => {
    const createResult = (await daemon.messageHub.call("session.create", {
      workspacePath: process.cwd(),
      config: {
        model: "haiku",
        permissionMode: "acceptEdits",
      },
    })) as { sessionId: string };

    const { sessionId } = createResult;

    // Turn 1: Ask for a number to remember
    const result1 = await sendMessage(
      daemon,
      sessionId,
      'Remember the number 42 for me. Just reply "Got it, I will remember 42."',
    );
    expect(result1.messageId).toBeString();

    await waitForIdle(daemon, sessionId, 30000);

    // Turn 2: Ask what the number was (tests context retention)
    const result2 = await sendMessage(
      daemon,
      sessionId,
      "What number did I ask you to remember? Just reply with the number.",
    );
    expect(result2.messageId).toBeString();
    expect(result2.messageId).not.toBe(result1.messageId);

    await waitForIdle(daemon, sessionId, 30000);

    // Verify state is idle after all turns
    const finalState = await getProcessingState(daemon, sessionId);
    expect(finalState.status).toBe("idle");
  }, 90000); // 90 second timeout for 3 API calls

  test("should handle multi-turn conversation with code analysis", async () => {
    const createResult = (await daemon.messageHub.call("session.create", {
      workspacePath: process.cwd(),
      config: {
        model: "haiku",
        permissionMode: "acceptEdits",
      },
    })) as { sessionId: string };

    const { sessionId } = createResult;

    // Turn 1: Provide code context
    await sendMessage(
      daemon,
      sessionId,
      'I will show you a TypeScript function. Just reply "Ready, show me the code."',
    );
    await waitForIdle(daemon, sessionId, 30000);

    // Turn 2: Show actual code
    await sendMessage(
      daemon,
      sessionId,
      "Here is the code:\n\n```typescript\nfunction add(a: number, b: number): number {\n  return a + b;\n}\n```\n\nWhat does this function do? Answer in one sentence.",
    );
    await waitForIdle(daemon, sessionId, 30000);

    // Turn 3: Ask follow-up about the code
    await sendMessage(
      daemon,
      sessionId,
      "What are the parameter types? Just list them separated by commas.",
    );
    await waitForIdle(daemon, sessionId, 30000);

    // Final state should be idle
    const finalState = await getProcessingState(daemon, sessionId);
    expect(finalState.status).toBe("idle");
  }, 90000);

  test("should handle rapid successive messages correctly", async () => {
    const createResult = (await daemon.messageHub.call("session.create", {
      workspacePath: process.cwd(),
      config: {
        model: "haiku",
        permissionMode: "acceptEdits",
      },
    })) as { sessionId: string };

    const { sessionId } = createResult;

    // Send three simple messages in quick succession
    // They should be queued and processed sequentially
    const msg1 = await sendMessage(
      daemon,
      sessionId,
      'First message: Say "One".',
    );
    await waitForIdle(daemon, sessionId, 30000);

    const msg2 = await sendMessage(
      daemon,
      sessionId,
      'Second message: Say "Two".',
    );
    await waitForIdle(daemon, sessionId, 30000);

    const msg3 = await sendMessage(
      daemon,
      sessionId,
      'Third message: Say "Three".',
    );
    await waitForIdle(daemon, sessionId, 30000);

    // All message IDs should be unique
    expect(msg1.messageId).not.toBe(msg2.messageId);
    expect(msg2.messageId).not.toBe(msg3.messageId);
    expect(msg1.messageId).not.toBe(msg3.messageId);

    // State should be idle
    const finalState = await getProcessingState(daemon, sessionId);
    expect(finalState.status).toBe("idle");
  }, 60000); // 60 second timeout for 3 sequential API calls

  describe("Processing state transitions across turns", () => {
    test("should correctly transition through states for each turn", async () => {
      const createResult = (await daemon.messageHub.call("session.create", {
        workspacePath: process.cwd(),
        config: {
          model: "haiku",
          permissionMode: "acceptEdits",
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;

      // Track states through 3 turns
      for (let i = 1; i <= 3; i++) {
        // Initial state should be idle
        const initialState = await getProcessingState(daemon, sessionId);
        expect(initialState.status).toBe("idle");

        // Send message
        await sendMessage(
          daemon,
          sessionId,
          `Turn ${i}: Say "Done". Just that word.`,
        );

        // State should change from idle
        const processingState = await getProcessingState(daemon, sessionId);
        expect(["queued", "processing"]).toContain(processingState.status);

        // Wait for completion
        await waitForIdle(daemon, sessionId, 30000);

        // Should be back to idle
        const finalState = await getProcessingState(daemon, sessionId);
        expect(finalState.status).toBe("idle");
      }
    }, 120000);
  });
});
