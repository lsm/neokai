/**
 * Space Agent Coordination — Online Tests with Dev Proxy
 *
 * Tests verify that the Space Agent session correctly processes [TASK_EVENT]
 * notifications and that the mocked LLM responses match the expected behavior
 * based on the space's autonomy level.
 *
 * ## How it works
 *
 * 1. The daemon auto-provisions the `spaces:global` session at startup when
 *    `NEOKAI_ENABLE_SPACES_AGENT=1` is set (or in non-test environments).
 * 2. Tests inject [TASK_EVENT] messages via `sendMessage` to that session.
 * 3. Dev Proxy intercepts Anthropic API calls and returns pre-configured mocks.
 * 4. Mock responses are selected by body content matching on a unique "probe phrase"
 *    embedded in the [TASK_EVENT] `reason` field:
 *    - `probe_supervised_escalation`      → escalation text (supervised mode)
 *    - `probe_semi_autonomous_get_detail` → text describing intent to get_task_detail
 *    - `probe_semi_autonomous_retry`      → text describing intent to retry autonomously
 * 5. All probe mocks use `stop_reason: "end_turn"` with distinctive text responses.
 *    Tests assert on text content rather than tool_use blocks, because SDK behavior
 *    for tool_use blocks varies with stop_reason and the dev proxy cannot reliably
 *    distinguish an initial probe API call from a follow-up tool-result API call
 *    using body-content substring matching.
 *
 * ## What these tests verify
 *
 * These tests verify **mock routing correctness** — that the probe phrase
 * embedded in the [TASK_EVENT] reason field causes the dev proxy to return the
 * expected mock for that scenario. They also verify that the SDK correctly
 * records the mocked text responses in the session's SDK messages.
 *
 * What they do NOT verify: that a real LLM would make the same tool choice.
 * That requires live API testing (NEOKAI_USE_DEV_PROXY unset).
 *
 * ## Running
 *
 *   NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/space/space-agent-coordination.test.ts
 *
 * MODES:
 * - Dev Proxy (recommended): Set NEOKAI_USE_DEV_PROXY=1 for offline testing
 * - Real API (default): Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 *
 * The probe phrases in mock matching are unique strings that do not appear in
 * any other test, so adding these mocks to mocks.json does not affect other tests.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle, waitForSdkMessages } from '../../helpers/daemon-actions';
import { formatEventMessage } from '../../../src/lib/space/runtime/session-notification-sink';
import type { Space } from '@neokai/shared';

// Detect mock mode for faster timeouts
const IS_MOCK = !!process.env.NEOKAI_USE_DEV_PROXY;
const IDLE_TIMEOUT = IS_MOCK ? 8000 : 45000;
const SETUP_TIMEOUT = IS_MOCK ? 15000 : 30000;
const TEST_TIMEOUT = IS_MOCK ? 30000 : 120000;

/**
 * The global spaces agent session ID — auto-provisioned by the daemon at startup.
 * All space coordination notifications are sent to this session.
 */
const GLOBAL_SPACES_SESSION_ID = 'spaces:global';

/**
 * Read all SDK messages for a session and return the assistant messages
 * from the main thread (parent_tool_use_id === null).
 */
function getAssistantMessages(
	sdkMessages: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
	return sdkMessages.filter((msg) => msg.type === 'assistant' && msg.parent_tool_use_id === null);
}

/**
 * Extract tool_use blocks from an assistant message's content.
 */
function extractToolUses(
	assistantMessages: Array<Record<string, unknown>>
): Array<{ name: string; id: string; input: Record<string, unknown> }> {
	const toolUses: Array<{ name: string; id: string; input: Record<string, unknown> }> = [];
	for (const msg of assistantMessages) {
		const betaMsg = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
		if (!betaMsg?.content) continue;
		for (const block of betaMsg.content) {
			if (block.type === 'tool_use') {
				toolUses.push({
					name: block.name as string,
					id: block.id as string,
					input: (block.input as Record<string, unknown>) ?? {},
				});
			}
		}
	}
	return toolUses;
}

/**
 * Extract text content from assistant messages.
 */
function extractAssistantText(assistantMessages: Array<Record<string, unknown>>): string {
	const texts: string[] = [];
	for (const msg of assistantMessages) {
		const betaMsg = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
		if (!betaMsg?.content) continue;
		for (const block of betaMsg.content) {
			if (block.type === 'text') {
				texts.push(block.text as string);
			}
		}
	}
	return texts.join('\n');
}

/**
 * Create a test space with the specified autonomy level.
 */
async function createTestSpace(
	daemon: DaemonServerContext,
	name: string,
	autonomyLevel: 'supervised' | 'semi_autonomous'
): Promise<Space> {
	const result = (await daemon.messageHub.request('space.create', {
		name,
		description: `Test space for coordination online tests (${autonomyLevel})`,
		workspacePath: process.cwd(),
		autonomyLevel,
	})) as Space;
	return result;
}

/**
 * Create a task in the given space via RPC and return its ID.
 */
async function createTestTask(
	daemon: DaemonServerContext,
	spaceId: string,
	title: string,
	description: string
): Promise<string> {
	const result = (await daemon.messageHub.request('spaceTask.create', {
		spaceId,
		title,
		description,
	})) as { id: string };
	return result.id;
}

describe('Space Agent Coordination — Online Tests', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		// NEOKAI_ENABLE_SPACES_AGENT=1 opts in to spaces:global provisioning in test mode.
		// Without it, the daemon skips provisioning when NODE_ENV=test to avoid side-effects
		// on other test suites that don't need the global spaces agent.
		daemon = await createDaemonServer({ env: { NEOKAI_ENABLE_SPACES_AGENT: '1' } });
		// Track the global spaces session for cleanup
		daemon.trackSession(GLOBAL_SPACES_SESSION_ID);

		// provisionGlobalSpacesAgent is fire-and-forget inside setupRPCHandlers, so
		// the spaces:global session may not yet exist when beforeEach returns.
		// Poll session.get until the session is ready before proceeding to the test.
		const deadline = Date.now() + SETUP_TIMEOUT;
		let sessionReady = false;
		while (Date.now() < deadline) {
			try {
				await daemon.messageHub.request('session.get', {
					sessionId: GLOBAL_SPACES_SESSION_ID,
				});
				sessionReady = true;
				break; // session exists — ready to proceed
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
		}
		if (!sessionReady) {
			throw new Error(
				`spaces:global session was not ready within ${SETUP_TIMEOUT}ms — aborting test setup`
			);
		}
	}, SETUP_TIMEOUT);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, SETUP_TIMEOUT);

	test(
		'supervised mode: agent escalates to human when receiving task_needs_attention',
		async () => {
			// 1. Create a supervised space and task
			const space = await createTestSpace(daemon, 'Supervised Test Space', 'supervised');
			const taskId = await createTestTask(
				daemon,
				space.id,
				'Agent integration test task',
				'A test task to verify supervised escalation'
			);

			// 2. Build a [TASK_EVENT] message with the probe phrase embedded in the reason.
			//    The dev proxy matches on "probe_supervised_escalation" and returns
			//    an escalation text response (see mocks.json).
			const eventMessage = formatEventMessage(
				{
					kind: 'task_needs_attention',
					spaceId: space.id,
					taskId,
					reason: 'probe_supervised_escalation: agent returned a non-zero exit code',
					timestamp: new Date().toISOString(),
				},
				'supervised'
			);

			// 3. Send the notification to the global spaces agent session
			await sendMessage(daemon, GLOBAL_SPACES_SESSION_ID, eventMessage);

			// 4. Wait for the agent to finish processing
			await waitForIdle(daemon, GLOBAL_SPACES_SESSION_ID, IDLE_TIMEOUT);

			// 5. Read SDK messages and verify the response
			const { sdkMessages } = await waitForSdkMessages(daemon, GLOBAL_SPACES_SESSION_ID, {
				minCount: 2, // at least: user message + assistant response
				timeout: 5000,
			});

			const assistantMsgs = getAssistantMessages(sdkMessages);
			expect(assistantMsgs.length).toBeGreaterThan(0);

			const responseText = extractAssistantText(assistantMsgs);

			// Supervised mode must NOT autonomously call retry_task — verify escalation keywords
			expect(responseText.toLowerCase()).toMatch(/human|approval|supervised|wait|guidance|notify/i);

			// Supervised mode should NOT include autonomous tool calls for retry/cancel
			const toolUses = extractToolUses(assistantMsgs);
			const retryOrCancelUses = toolUses.filter(
				(t) => t.name === 'retry_task' || t.name === 'cancel_task'
			);
			expect(retryOrCancelUses).toHaveLength(0);
		},
		TEST_TIMEOUT
	);

	test(
		'task_needs_attention: agent responds with intent to assess via get_task_detail in semi_autonomous mode',
		async () => {
			// 1. Create a semi_autonomous space and task
			const space = await createTestSpace(
				daemon,
				'Semi-Autonomous Detail Test Space',
				'semi_autonomous'
			);
			const taskId = await createTestTask(
				daemon,
				space.id,
				'Detail assessment task',
				'A task to verify get_task_detail intent'
			);

			// 2. Embed the probe phrase "probe_semi_autonomous_get_detail" in the reason.
			//    The dev proxy returns a mocked text response describing get_task_detail intent.
			const eventMessage = formatEventMessage(
				{
					kind: 'task_needs_attention',
					spaceId: space.id,
					taskId,
					reason: 'probe_semi_autonomous_get_detail: task exited with error code 1',
					timestamp: new Date().toISOString(),
				},
				'semi_autonomous'
			);

			// 3. Send notification to global spaces agent
			await sendMessage(daemon, GLOBAL_SPACES_SESSION_ID, eventMessage);
			await waitForIdle(daemon, GLOBAL_SPACES_SESSION_ID, IDLE_TIMEOUT);

			// 4. Verify the agent's response describes the get_task_detail assessment intent.
			//    The mock returns distinctive text when "probe_semi_autonomous_get_detail" is
			//    matched, confirming correct mock routing for this probe phrase.
			const { sdkMessages } = await waitForSdkMessages(daemon, GLOBAL_SPACES_SESSION_ID, {
				minCount: 2,
				timeout: 5000,
			});

			const assistantMsgs = getAssistantMessages(sdkMessages);
			expect(assistantMsgs.length).toBeGreaterThan(0);

			const responseText = extractAssistantText(assistantMsgs);

			// The mocked response text contains "get_task_detail" and "semi-autonomous" —
			// verify the probe phrase routed to the correct mock
			expect(responseText.toLowerCase()).toMatch(/get.task.detail|get.*detail/i);
			expect(responseText.toLowerCase()).toMatch(/semi.autonomous/i);
		},
		TEST_TIMEOUT
	);

	test(
		'semi_autonomous mode: agent responds with intent to retry task autonomously',
		async () => {
			// 1. Create a semi_autonomous space and task
			const space = await createTestSpace(
				daemon,
				'Semi-Autonomous Retry Test Space',
				'semi_autonomous'
			);
			const taskId = await createTestTask(
				daemon,
				space.id,
				'Autonomous retry task',
				'A task to verify retry intent in semi-autonomous mode'
			);

			// 2. Embed the probe phrase "probe_semi_autonomous_retry" in the reason.
			//    The dev proxy returns a mocked text response describing retry intent.
			const eventMessage = formatEventMessage(
				{
					kind: 'task_needs_attention',
					spaceId: space.id,
					taskId,
					reason: 'probe_semi_autonomous_retry: transient failure, suitable for automatic retry',
					timestamp: new Date().toISOString(),
				},
				'semi_autonomous'
			);

			// 3. Send notification to global spaces agent
			await sendMessage(daemon, GLOBAL_SPACES_SESSION_ID, eventMessage);
			await waitForIdle(daemon, GLOBAL_SPACES_SESSION_ID, IDLE_TIMEOUT);

			// 4. Verify the mocked response describes autonomous retry intent.
			//    The mock returns distinctive text when "probe_semi_autonomous_retry" is
			//    matched, confirming correct mock routing for this probe phrase.
			const { sdkMessages } = await waitForSdkMessages(daemon, GLOBAL_SPACES_SESSION_ID, {
				minCount: 2,
				timeout: 5000,
			});

			const assistantMsgs = getAssistantMessages(sdkMessages);
			expect(assistantMsgs.length).toBeGreaterThan(0);

			// The mocked response text contains "semi-autonomous" and "retry" —
			// verify the probe phrase routed to the correct mock and not the escalation mock
			const responseText = extractAssistantText(assistantMsgs);
			expect(responseText.toLowerCase()).toMatch(/semi.autonomous|retry|autonomous/i);

			// Semi-autonomous retry must not contain escalation/approval language
			expect(responseText.toLowerCase()).not.toMatch(/\bneed your approval\b/i);
		},
		TEST_TIMEOUT
	);
});
