/**
 * Auto-Title Generation Integration Tests
 *
 * These tests verify that the auto-title generation feature works correctly
 * with real SDK calls. The feature should:
 * - Generate a title during workspace initialization on first message
 * - Use Haiku model for title generation
 * - Update session metadata with titleGenerated flag
 * - Only generate title once per session
 * - Handle workspace paths correctly (critical for SDK query)
 *
 * REQUIREMENTS:
 * - Requires GLM_API_KEY (or ZHIPU_API_KEY)
 * - Makes real API calls (costs money, uses rate limits)
 * - Tests will SKIP if credentials are not available
 *
 * MODEL MAPPING:
 * - Uses 'haiku' model (provider-agnostic)
 * - With GLM_API_KEY: haiku → glm-4.5-air (via ANTHROPIC_DEFAULT_HAIKU_MODEL)
 * - With ANTHROPIC_API_KEY: haiku → Claude Haiku
 * - This makes tests provider-agnostic and easy to switch
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import "dotenv/config";
import type { DaemonServerContext } from "../../helpers/daemon-server-helper";
import { spawnDaemonServer } from "../../helpers/daemon-server-helper";
import {
  sendMessage,
  waitForIdle,
  getProcessingState,
  getSession,
} from "../../helpers/daemon-test-helpers";

// Check for GLM credentials
const GLM_API_KEY = process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY;

// Set up GLM provider environment if GLM_API_KEY is available
// This makes 'haiku' model automatically map to glm-4.5-air
if (GLM_API_KEY) {
  process.env.ANTHROPIC_AUTH_TOKEN = GLM_API_KEY;
  process.env.ANTHROPIC_BASE_URL = "https://open.bigmodel.cn/api/anthropic";
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "glm-4.5-air";
  process.env.API_TIMEOUT_MS = "3000000";
}

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || "/tmp";

// Tests will FAIL if GLM credentials are not available
describe("Auto-Title Generation", () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    // Restore mocks to ensure we use the real SDK
    mock.restore();
    daemon = await spawnDaemonServer();
  });

  afterEach(async () => {
    if (daemon) {
      daemon.kill("SIGTERM");
      await daemon.waitForExit();
    }
  });

  /**
   * Helper: Wait for title generation to complete
   * Title generation now happens in PARALLEL with SDK query (fire-and-forget)
   * We need to poll until titleGenerated is true or timeout
   */
  async function waitForTitleGeneration(
    sessionId: string,
    timeoutMs = 20000,
  ): Promise<void> {
    // First wait for agent to be idle
    await waitForIdle(daemon, sessionId, timeoutMs);

    // Then poll for title generation (runs in parallel, may take longer)
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const session = await getSession(daemon, sessionId);
      const metadata = session.metadata as
        | { titleGenerated?: boolean }
        | undefined;
      if (metadata?.titleGenerated) {
        return; // Title generated successfully
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Check if we timed out
    const session = await getSession(daemon, sessionId);
    const metadata = session.metadata as
      | { titleGenerated?: boolean }
      | undefined;
    const title = session.title as string;
    if (!metadata?.titleGenerated && title === "New Session") {
      console.warn("Title not generated after timeout");
    }
  }

  test("should auto-generate title after first user message", async () => {
    const workspacePath = `${TMP_DIR}/auto-title-test-${Date.now()}`;

    // Create session with workspace path
    const createResult = (await daemon.messageHub.call("session.create", {
      workspacePath,
      config: { model: "haiku" },
    })) as { sessionId: string };

    const { sessionId } = createResult;

    // Get initial session data
    let session = await getSession(daemon, sessionId);
    expect(session.title).toBe("New Session");
    expect(
      (session.metadata as { titleGenerated?: boolean }).titleGenerated,
    ).toBe(false);

    // Send first message (triggers workspace initialization with title generation)
    await sendMessage(daemon, sessionId, "What is 2+2?");

    // Wait for first response (title generated during workspace initialization)
    await waitForTitleGeneration(sessionId);

    // Title should be generated now (via background queue)
    session = await getSession(daemon, sessionId);
    expect(session.title).not.toBe("New Session");
    expect((session.title as string).length).toBeGreaterThan(0);
    expect((session.title as string).length).toBeLessThan(100); // Should be concise
    expect(
      (session.metadata as { titleGenerated: boolean }).titleGenerated,
    ).toBe(true);

    // Verify title doesn't have formatting artifacts
    expect(session.title).not.toMatch(/^["'`]/); // No leading quotes
    expect(session.title).not.toMatch(/["'`]$/); // No trailing quotes
    expect(session.title).not.toMatch(/\*\*/); // No bold markdown
    expect(session.title).not.toMatch(/`/); // No backticks

    console.log(`Generated title: "${session.title}"`);
  }, 30000); // 30s timeout for the entire test (1 message)

  test("should only generate title once per session", async () => {
    const workspacePath = `${TMP_DIR}/auto-title-test-${Date.now()}`;

    // Create session
    const createResult = (await daemon.messageHub.call("session.create", {
      workspacePath,
      config: { model: "haiku" },
    })) as { sessionId: string };

    const { sessionId } = createResult;

    // Send first message
    await sendMessage(daemon, sessionId, "What is 2+2?");

    // Wait for first response (title generated during workspace initialization)
    await waitForTitleGeneration(sessionId);

    // Get the generated title
    let session = await getSession(daemon, sessionId);
    const firstTitle = session.title as string;
    expect(firstTitle).not.toBe("New Session");
    expect(
      (session.metadata as { titleGenerated: boolean }).titleGenerated,
    ).toBe(true);

    // Send second message
    await sendMessage(daemon, sessionId, "What is 3+3?");

    // Wait for processing
    await waitForIdle(daemon, sessionId);

    // Wait a bit to ensure no title regeneration happens
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Title should remain the same (not regenerated)
    session = await getSession(daemon, sessionId);
    expect(session.title).toBe(firstTitle);

    // Send third message
    await sendMessage(daemon, sessionId, "What is 5+5?");

    // Wait for processing
    await waitForIdle(daemon, sessionId);

    // Wait a bit to ensure no title regeneration happens
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Title should still remain the same
    const thirdSession = await getSession(daemon, sessionId);
    expect(thirdSession.title).toBe(firstTitle);
  }, 40000); // 40s timeout (3 messages)

  test("should handle title generation with workspace path correctly", async () => {
    // This test specifically verifies the workspace path fix
    const workspacePath = `${TMP_DIR}/auto-title-workspace-test-${Date.now()}`;

    // Create session with explicit workspace path
    const createResult = (await daemon.messageHub.call("session.create", {
      workspacePath,
      config: { model: "haiku" },
    })) as { sessionId: string };

    const { sessionId } = createResult;

    // Verify workspace path is set
    const session = await getSession(daemon, sessionId);
    expect(session.workspacePath).toBe(workspacePath);

    // Send first message (title generation should happen after this)
    await sendMessage(daemon, sessionId, "What is 1+1?");

    // Wait for processing AND title generation (async via queue)
    await waitForTitleGeneration(sessionId);

    // Title should be generated (workspace path should be passed to SDK)
    const finalSession = await getSession(daemon, sessionId);
    expect(finalSession.title).not.toBe("New Session");
    expect(
      (finalSession.metadata as { titleGenerated: boolean }).titleGenerated,
    ).toBe(true);

    console.log(`Generated title with workspace path: "${finalSession.title}"`);
  }, 30000); // 30s timeout (1 message)

  test("should handle title generation failure gracefully", async () => {
    const workspacePath = `${TMP_DIR}/auto-title-graceful-test-${Date.now()}`;

    // Create session
    const createResult = (await daemon.messageHub.call("session.create", {
      workspacePath,
      config: { model: "haiku" },
    })) as { sessionId: string };

    const { sessionId } = createResult;

    // Send first message with minimal content
    await sendMessage(daemon, sessionId, "ok");

    // Wait for first response AND title generation
    // This ensures title generation completes before cleanup runs
    await waitForTitleGeneration(sessionId);

    // Session should still be functional even if title generation fails
    let session = await getSession(daemon, sessionId);
    // Title might be generated or might remain default - either is acceptable
    // The key is that the session is still functional
    expect(
      (session.metadata as { titleGenerated?: boolean }).titleGenerated,
    ).toBeBoolean();

    // Send another message to verify session is still working
    await sendMessage(daemon, sessionId, "What is 5+5?");

    await waitForIdle(daemon, sessionId);

    // Session should be idle and functional
    const state = await getProcessingState(daemon, sessionId);
    expect(state.status).toBe("idle");
  }, 30000); // 30s timeout (2 messages)
});
