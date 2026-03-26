/**
 * Planner WebSearch Capability (API-dependent)
 *
 * Verifies that the planner agent session can invoke the `WebSearch` tool.
 * Creates a room, triggers planning with a goal that requires web research,
 * and asserts that a `WebSearch` tool_use block appears in the planner's
 * message history.
 *
 * MODES:
 * - Dev Proxy (default for this test): NEOKAI_USE_DEV_PROXY=1
 *   The mock response for the unique goal body fragment returns a WebSearch
 *   tool_use block, proving the planner session has WebSearch capability.
 * - Real API: Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 *
 * Run with Dev Proxy:
 *   NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/room/planner-websearch.test.ts
 *
 * REQUIREMENTS:
 * - Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY (real API mode)
 * - OR Dev Proxy running (NEOKAI_USE_DEV_PROXY=1)
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { createRoom, createGoal, setupGitEnvironment, waitForTask } from './room-test-helpers';

// Unique fragment embedded in the goal description — the dev proxy mock matches this
// to return a response that includes a WebSearch tool_use block.
const WEBSEARCH_PROBE_FRAGMENT = 'planner-websearch-probe-2025-v1';

const IS_MOCK = !!process.env.NEOKAI_USE_DEV_PROXY;

// Faster timeouts in mock mode; generous timeouts for real API
const SETUP_TIMEOUT = IS_MOCK ? 15_000 : 60_000;
const TEST_TIMEOUT = IS_MOCK ? 60_000 : 300_000;
const POLL_TIMEOUT = IS_MOCK ? 30_000 : 180_000;

// Use Sonnet for room agents
const savedModel = process.env.DEFAULT_MODEL;
process.env.DEFAULT_MODEL = 'sonnet';

describe('Planner WebSearch Capability (API-dependent)', () => {
	let daemon: DaemonServerContext;
	let roomId: string;

	beforeAll(async () => {
		daemon = await createDaemonServer();
		setupGitEnvironment(process.env.NEOKAI_WORKSPACE_PATH!);
		roomId = await createRoom(daemon, 'Planner WebSearch');
	}, SETUP_TIMEOUT);

	afterAll(
		async () => {
			if (savedModel !== undefined) {
				process.env.DEFAULT_MODEL = savedModel;
			} else {
				delete process.env.DEFAULT_MODEL;
			}
			if (daemon) {
				daemon.kill('SIGTERM');
				await daemon.waitForExit();
			}
		},
		{ timeout: 20_000 }
	);

	test(
		'planner invokes WebSearch tool when goal requires current technology information',
		async () => {
			// Create a goal whose description contains the probe fragment so the
			// dev proxy mock can match it and return a WebSearch tool_use response.
			await createGoal(
				daemon,
				roomId,
				'Research current JavaScript framework ecosystem',
				`Use WebSearch to find the most popular JavaScript framework in 2025. ` +
					`Report your findings in a brief planning document. ` +
					`Probe: ${WEBSEARCH_PROBE_FRAGMENT}`
			);

			// Wait for the planning task to appear and start executing
			const planningTask = await waitForTask(
				daemon,
				roomId,
				{
					taskType: 'planning',
					status: ['pending', 'in_progress', 'completed', 'review', 'needs_attention'],
				},
				POLL_TIMEOUT
			);
			expect(planningTask.taskType).toBe('planning');

			// Poll for the session group to be created (may not exist yet if task is pending)
			const group = await waitForGroup(daemon, roomId, planningTask.id, POLL_TIMEOUT);
			expect(group).toBeTruthy();
			const { workerSessionId } = group!;

			// Poll the planner's SDK messages until we see a WebSearch tool_use block
			// or until the timeout expires.
			const found = await pollForWebSearchToolUse(daemon, workerSessionId, POLL_TIMEOUT);

			// Hard assertion: WebSearch must appear in the planner's message history.
			// If this fails, the planner lacks WebSearch capability or the mock is misconfigured.
			expect(found).toBe(true);
		},
		TEST_TIMEOUT
	);
});

/**
 * Poll `task.getGroup` until the session group is created for the given task,
 * or until `timeout` ms elapses.
 */
async function waitForGroup(
	daemon: DaemonServerContext,
	roomId: string,
	taskId: string,
	timeout: number
): Promise<{
	id: string;
	workerSessionId: string;
	leaderSessionId: string;
	workerRole: string;
} | null> {
	const deadline = Date.now() + timeout;

	while (Date.now() < deadline) {
		const result = (await daemon.messageHub.request('task.getGroup', {
			roomId,
			taskId,
		})) as {
			group: {
				id: string;
				workerSessionId: string;
				leaderSessionId: string;
				workerRole: string;
			} | null;
		};

		if (result.group) return result.group;
		await Bun.sleep(500);
	}

	return null;
}

/**
 * Poll `message.sdkMessages` for the given session until a `WebSearch` tool_use
 * block appears in any assistant message, or until `timeout` ms elapses.
 *
 * Returns true if found, false if timeout expires without finding it.
 */
async function pollForWebSearchToolUse(
	daemon: DaemonServerContext,
	sessionId: string,
	timeout: number
): Promise<boolean> {
	const deadline = Date.now() + timeout;

	while (Date.now() < deadline) {
		const result = (await daemon.messageHub.request('message.sdkMessages', {
			sessionId,
			limit: 200,
		})) as { sdkMessages: Array<Record<string, unknown>> };

		if (containsWebSearchToolUse(result.sdkMessages)) {
			return true;
		}

		await Bun.sleep(1_000);
	}

	return false;
}

/**
 * Returns true if any assistant message in the list contains a `WebSearch` tool_use block.
 */
function containsWebSearchToolUse(messages: Array<Record<string, unknown>>): boolean {
	for (const msg of messages) {
		if (msg['type'] !== 'assistant') continue;

		const betaMessage = msg['message'] as
			| { content?: Array<{ type: string; name?: string }> }
			| undefined;

		if (!betaMessage?.content) continue;

		for (const block of betaMessage.content) {
			if (block.type === 'tool_use' && block.name === 'WebSearch') {
				return true;
			}
		}
	}
	return false;
}
