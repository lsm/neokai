/**
 * Space Agent Coordination — Online Tests with Dev Proxy
 *
 * Tests verify that the Space Agent session correctly processes [TASK_EVENT]
 * notifications and that the mocked LLM responses include the expected tool
 * calls or escalation text based on the space's autonomy level.
 *
 * ## How it works
 *
 * 1. The daemon auto-provisions the `spaces:global` session at startup.
 * 2. Tests inject [TASK_EVENT] messages via `message.send` to that session.
 * 3. Dev Proxy intercepts Anthropic API calls and returns pre-configured mocks.
 * 4. Mock responses are selected by body content matching on a unique "probe phrase"
 *    embedded in the [TASK_EVENT] `reason` field:
 *    - `probe_supervised_escalation`  → escalation text (supervised mode)
 *    - `probe_semi_autonomous_get_detail` → tool_use: get_task_detail
 *    - `probe_semi_autonomous_retry`  → tool_use: retry_task
 * 5. All tool-use mocks use `stop_reason: "end_turn"` to avoid follow-up API
 *    calls (no infinite loop), while still recording tool_use blocks in SDK
 *    messages that the test can assert on.
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
 * Build a realistic [TASK_EVENT] notification message — matches the format
 * produced by SessionNotificationSink.formatEventMessage().
 */
function buildTaskNeedsAttentionMessage(
	spaceId: string,
	taskId: string,
	reason: string,
	autonomyLevel: 'supervised' | 'semi_autonomous'
): string {
	const humanReadable = `Task ${taskId} in space ${spaceId} needs attention: ${reason}`;
	const payload = {
		kind: 'task_needs_attention',
		spaceId,
		taskId,
		reason,
		timestamp: new Date().toISOString(),
		autonomyLevel,
	};
	return [
		'[TASK_EVENT] task_needs_attention',
		'',
		humanReadable,
		'',
		`Autonomy level: ${autonomyLevel}`,
		'',
		'```json',
		JSON.stringify(payload, null, 2),
		'```',
	].join('\n');
}

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
	})) as { space: Space };
	return result.space;
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
		status: 'needs_attention',
	})) as { task: { id: string } };
	return result.task.id;
}

describe('Space Agent Coordination — Online Tests', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createDaemonServer();
		// Track the global spaces session for cleanup
		daemon.trackSession(GLOBAL_SPACES_SESSION_ID);
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
			const eventMessage = buildTaskNeedsAttentionMessage(
				space.id,
				taskId,
				'probe_supervised_escalation: agent returned a non-zero exit code',
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
		'task_needs_attention: agent calls get_task_detail to assess the situation',
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
				'A task to verify get_task_detail tool call'
			);

			// 2. Embed the probe phrase "probe_semi_autonomous_get_detail" in the reason.
			//    The dev proxy returns a mocked response with get_task_detail tool_use.
			const eventMessage = buildTaskNeedsAttentionMessage(
				space.id,
				taskId,
				'probe_semi_autonomous_get_detail: task exited with error code 1',
				'semi_autonomous'
			);

			// 3. Send notification to global spaces agent
			await sendMessage(daemon, GLOBAL_SPACES_SESSION_ID, eventMessage);
			await waitForIdle(daemon, GLOBAL_SPACES_SESSION_ID, IDLE_TIMEOUT);

			// 4. Verify the agent's response includes get_task_detail tool_use block
			const { sdkMessages } = await waitForSdkMessages(daemon, GLOBAL_SPACES_SESSION_ID, {
				minCount: 2,
				timeout: 5000,
			});

			const assistantMsgs = getAssistantMessages(sdkMessages);
			expect(assistantMsgs.length).toBeGreaterThan(0);

			const toolUses = extractToolUses(assistantMsgs);
			const getDetailUses = toolUses.filter((t) => t.name === 'get_task_detail');

			// The mocked LLM response includes a get_task_detail tool_use block
			expect(getDetailUses.length).toBeGreaterThan(0);
			expect(getDetailUses[0].name).toBe('get_task_detail');
		},
		TEST_TIMEOUT
	);

	test(
		'semi_autonomous mode: agent calls retry_task autonomously without human approval',
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
				'A task to verify retry_task autonomous behavior'
			);

			// 2. Embed the probe phrase "probe_semi_autonomous_retry" in the reason.
			//    The dev proxy returns a mocked response with retry_task tool_use.
			const eventMessage = buildTaskNeedsAttentionMessage(
				space.id,
				taskId,
				'probe_semi_autonomous_retry: transient failure, suitable for automatic retry',
				'semi_autonomous'
			);

			// 3. Send notification to global spaces agent
			await sendMessage(daemon, GLOBAL_SPACES_SESSION_ID, eventMessage);
			await waitForIdle(daemon, GLOBAL_SPACES_SESSION_ID, IDLE_TIMEOUT);

			// 4. Verify the mocked LLM response includes retry_task tool_use block
			const { sdkMessages } = await waitForSdkMessages(daemon, GLOBAL_SPACES_SESSION_ID, {
				minCount: 2,
				timeout: 5000,
			});

			const assistantMsgs = getAssistantMessages(sdkMessages);
			expect(assistantMsgs.length).toBeGreaterThan(0);

			const toolUses = extractToolUses(assistantMsgs);
			const retryUses = toolUses.filter((t) => t.name === 'retry_task');

			// The mocked LLM response includes a retry_task tool_use block — representing
			// the semi_autonomous agent attempting to retry without human approval
			expect(retryUses.length).toBeGreaterThan(0);
			expect(retryUses[0].name).toBe('retry_task');

			// Also verify the agent's text explains its autonomous reasoning
			const responseText = extractAssistantText(assistantMsgs);
			expect(responseText.toLowerCase()).toMatch(/semi.autonomous|retry|autonomous/i);
		},
		TEST_TIMEOUT
	);
});
