/**
 * Test helper for waiting for agent session to reach idle state
 *
 * Provides a consistent way to wait for SDK processing to complete across tests.
 *
 * Note: State change logging was intentionally removed to reduce log noise.
 * The Logger system respects log levels (test=SILENT), while console.log
 * bypasses all filtering.
 *
 * Usage:
 * ```ts
 * import { waitForIdle } from '../../helpers/test-wait-for-idle';
 *
 * const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
 * await sendMessageSync(agentSession!, { content: 'Hello' });
 * await waitForIdle(agentSession!);
 * ```
 */

import type { AgentSession } from "../../src/lib/agent";

/**
 * Wait for agent session to reach idle state
 *
 * Polls the processing state until it becomes 'idle' or timeout is reached.
 * Throws detailed error on timeout with final state dump for debugging.
 *
 * @param agentSession - The agent session to monitor
 * @param timeoutMs - Timeout in milliseconds (default: 15000)
 * @throws Error if timeout is reached before idle state
 */
export async function waitForIdle(
  agentSession: AgentSession,
  timeoutMs = 15000, // 15s is sufficient for SDK init + API call
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const state = agentSession.getProcessingState();
    if (state.status === "idle") {
      return;
    }
    await Bun.sleep(100); // Poll every 100ms
  }
  const finalState = agentSession.getProcessingState();
  const phase = "phase" in finalState ? finalState.phase : "N/A";
  throw new Error(
    `Timeout waiting for idle state after ${timeoutMs}ms. Final state: ${finalState.status}, phase: ${phase}`,
  );
}
