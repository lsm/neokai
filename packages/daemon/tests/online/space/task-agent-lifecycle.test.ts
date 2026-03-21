/**
 * Task Agent Lifecycle — Online Tests with Dev Proxy
 *
 * Tests verify the full Task Agent lifecycle end-to-end:
 * 1. SpaceRuntime detects a pending task and spawns a Task Agent session
 * 2. Task Agent session has correct type, context, and MCP tools attached
 * 3. Task Agent processes its initial context message
 * 4. Task Agent can call each workflow tool (spawn_step_agent, check_step_status,
 *    advance_workflow, report_result) verified via probe mocks
 * 5. When report_result is called (via full MCP name mock), task status becomes 'completed'
 * 6. Space Agent receives the completion notification event
 *
 * ## How probe mocks work
 *
 * Each tool-call test injects a unique probe phrase into the Task Agent session via
 * sendMessage(). The dev proxy intercepts the subsequent API call and matches the
 * bodyFragment (substring search on the serialized request body). Matching mocks
 * return a pre-configured response.
 *
 * Tool call verification tests (spawn_step_agent, check_step_status, advance_workflow)
 * use TEXT-ONLY mock responses. We cannot use tool_use blocks with the Claude Agent SDK
 * because it dispatches ALL tool_use content blocks regardless of stop_reason. Since the
 * short tool names (e.g. "spawn_step_agent") don't match the registered MCP names (e.g.
 * "mcp__task-agent__spawn_step_agent"), dispatch fails and the SDK retries indefinitely
 * (each retry re-sends the probe phrase, matching the same mock — infinite loop). Instead,
 * the mocks return text mentioning the tool name and relevant IDs for test assertions.
 *
 * The report_result test uses the full MCP name "mcp__task-agent__report_result" with
 * stop_reason "tool_use" so the SDK dispatches the tool, which updates the task status
 * to 'completed' and emits the DaemonHub space.task.completed event.
 *
 * ## Running
 *
 *   NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/space/task-agent-lifecycle.test.ts
 *
 * MODES:
 * - Dev Proxy (recommended): Set NEOKAI_USE_DEV_PROXY=1 for offline testing
 * - Real API (default): Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle, waitForSdkMessages } from '../../helpers/daemon-actions';
import type { Space, SpaceAgent, SpaceWorkflow } from '@neokai/shared';

// Detect mock mode for faster timeouts
const IS_MOCK = !!process.env.NEOKAI_USE_DEV_PROXY;
const IDLE_TIMEOUT = IS_MOCK ? 10_000 : 60_000;
const SETUP_TIMEOUT = IS_MOCK ? 20_000 : 60_000;
const TEST_TIMEOUT = IS_MOCK ? 60_000 : 240_000;

// How long to wait for SpaceRuntime tick loop to spawn a Task Agent (default tick: 5s)
const TASK_AGENT_SPAWN_TIMEOUT = IS_MOCK ? 15_000 : 45_000;

// The global spaces agent session ID — auto-provisioned when NEOKAI_ENABLE_SPACES_AGENT=1
const GLOBAL_SPACES_SESSION_ID = 'spaces:global';

// Pre-assigned step IDs used in all test workflows so mocks can reference them by ID.
// Fresh DB per test daemon means no cross-test ID conflicts.
const STEP_CODE_ID = 'step-code-lifecycle-001';
const STEP_REVIEW_ID = 'step-review-lifecycle-001';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

type TestFixtures = {
	space: Space;
	coderAgent: SpaceAgent;
	reviewerAgent: SpaceAgent;
	workflow: SpaceWorkflow;
};

/**
 * Create a Space with a 2-step Code→Review workflow.
 *
 * space.create auto-seeds preset agents (Coder, General, Planner, Reviewer).
 * This fixture looks up the pre-seeded Coder and Reviewer agents and creates
 * a workflow that references them. Step IDs are pre-assigned so dev proxy mocks
 * can reference them by ID.
 */
async function createTestFixtures(daemon: DaemonServerContext): Promise<TestFixtures> {
	const space = (await daemon.messageHub.request('space.create', {
		name: 'Task Agent Lifecycle Test Space',
		description: 'Test space for task agent lifecycle online tests',
		workspacePath: process.cwd(),
		autonomyLevel: 'supervised',
	})) as Space;

	// space.create auto-seeds preset agents — look up Coder and Reviewer by role
	const { agents } = (await daemon.messageHub.request('spaceAgent.list', {
		spaceId: space.id,
	})) as { agents: SpaceAgent[] };

	const coderAgent = agents.find((a) => a.role === 'coder');
	const reviewerAgent = agents.find((a) => a.role === 'reviewer');

	if (!coderAgent) throw new Error('Pre-seeded Coder agent not found');
	if (!reviewerAgent) throw new Error('Pre-seeded Reviewer agent not found');

	const workflowResult = (await daemon.messageHub.request('spaceWorkflow.create', {
		spaceId: space.id,
		name: 'Code Review Workflow',
		description: 'A simple code-then-review workflow for lifecycle testing',
		steps: [
			{ id: STEP_CODE_ID, name: 'Code Implementation', agentId: coderAgent.id },
			{ id: STEP_REVIEW_ID, name: 'Code Review', agentId: reviewerAgent.id },
		],
		transitions: [{ from: STEP_CODE_ID, to: STEP_REVIEW_ID }],
		startStepId: STEP_CODE_ID,
	})) as { workflow: SpaceWorkflow };

	return {
		space,
		coderAgent,
		reviewerAgent,
		workflow: workflowResult.workflow,
	};
}

/**
 * Start a workflow run and return the newly-created pending task.
 * spaceTask.list returns the task array directly (not wrapped in { tasks }).
 */
async function startWorkflowRunAndGetTask(
	daemon: DaemonServerContext,
	spaceId: string,
	workflowId: string,
	runTitle: string
): Promise<{
	runId: string;
	task: { id: string; status: string; taskAgentSessionId: string | null };
}> {
	const { run } = (await daemon.messageHub.request('spaceWorkflowRun.start', {
		spaceId,
		workflowId,
		title: runTitle,
	})) as { run: { id: string } };

	// spaceTask.list returns an array directly
	const tasks = (await daemon.messageHub.request('spaceTask.list', {
		spaceId,
	})) as Array<{
		id: string;
		workflowRunId: string;
		status: string;
		taskAgentSessionId: string | null;
	}>;

	const task = tasks.find((t) => t.workflowRunId === run.id && t.status === 'pending');
	if (!task) throw new Error(`No pending task found for workflow run ${run.id}`);

	return { runId: run.id, task };
}

/**
 * Poll spaceTask.get until taskAgentSessionId is set (Task Agent was spawned).
 * SpaceRuntime's tick loop runs every 5 s by default.
 * spaceTask.get returns the task directly (not wrapped in { task }).
 * The handler parameter is `taskId`, not `id`.
 */
async function waitForTaskAgentSpawned(
	daemon: DaemonServerContext,
	spaceId: string,
	taskId: string,
	timeout: number
): Promise<string> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const task = (await daemon.messageHub.request('spaceTask.get', {
			taskId,
			spaceId,
		})) as { taskAgentSessionId: string | null };

		if (task.taskAgentSessionId) return task.taskAgentSessionId;
		await new Promise((resolve) => setTimeout(resolve, 400));
	}
	throw new Error(`Task Agent session was not spawned within ${timeout}ms for task ${taskId}`);
}

/**
 * Poll spaceTask.get until the task status matches one of the expected statuses.
 * spaceTask.get returns the task directly (not wrapped in { task }).
 */
async function waitForTaskStatus(
	daemon: DaemonServerContext,
	spaceId: string,
	taskId: string,
	expectedStatuses: string[],
	timeout: number
): Promise<string> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const task = (await daemon.messageHub.request('spaceTask.get', {
			taskId,
			spaceId,
		})) as { status: string };

		if (expectedStatuses.includes(task.status)) return task.status;
		await new Promise((resolve) => setTimeout(resolve, 400));
	}
	throw new Error(
		`Task status did not reach one of [${expectedStatuses.join(', ')}] within ${timeout}ms`
	);
}

// ---------------------------------------------------------------------------
// Message extraction helpers
// ---------------------------------------------------------------------------

function getAssistantMessages(
	sdkMessages: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
	return sdkMessages.filter((msg) => msg.type === 'assistant' && msg.parent_tool_use_id === null);
}

function extractTextContent(assistantMessages: Array<Record<string, unknown>>): string {
	return assistantMessages
		.flatMap((msg) => {
			const betaMsg = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
			return (betaMsg?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text as string);
		})
		.join(' ');
}

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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Task Agent Lifecycle — Online Tests', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		// NEOKAI_ENABLE_SPACES_AGENT=1 enables the global spaces agent for notification tests.
		// Each test gets a fresh daemon with its own in-memory SQLite DB — no cross-test state.
		daemon = await createDaemonServer({ env: { NEOKAI_ENABLE_SPACES_AGENT: '1' } });
	}, SETUP_TIMEOUT);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, SETUP_TIMEOUT);

	// -------------------------------------------------------------------------
	// Test 1: Pending task pickup and Task Agent session creation
	// -------------------------------------------------------------------------
	test(
		'SpaceRuntime spawns a Task Agent session for a pending task',
		async () => {
			const { space, workflow } = await createTestFixtures(daemon);

			const { task } = await startWorkflowRunAndGetTask(
				daemon,
				space.id,
				workflow.id,
				'Lifecycle test run — spawning'
			);

			// Before the tick fires, taskAgentSessionId must not be set
			expect(task.taskAgentSessionId).toBeFalsy();
			expect(task.status).toBe('pending');

			// Wait for SpaceRuntime tick loop to detect the pending task and spawn a Task Agent
			const taskAgentSessionId = await waitForTaskAgentSpawned(
				daemon,
				space.id,
				task.id,
				TASK_AGENT_SPAWN_TIMEOUT
			);

			daemon.trackSession(taskAgentSessionId);

			// The session must exist — session.get returns { session, activeTools, context }
			const sessionResult = (await daemon.messageHub.request('session.get', {
				sessionId: taskAgentSessionId,
			})) as { session: Record<string, unknown> };

			const session = sessionResult.session;
			expect(session).toBeDefined();
			expect(session.id).toBe(taskAgentSessionId);

			// Session type must be 'space_task_agent'
			expect(session.type).toBe('space_task_agent');

			// Session ID follows the convention: space:${spaceId}:task:${taskId}
			expect(taskAgentSessionId).toContain(`task:${task.id}`);
			expect(taskAgentSessionId).toContain(`space:${space.id}`);

			// Session context must include spaceId and taskId
			const sessionContext = session.context as { spaceId?: string; taskId?: string } | undefined;
			expect(sessionContext?.spaceId).toBe(space.id);
			expect(sessionContext?.taskId).toBe(task.id);
		},
		TEST_TIMEOUT
	);

	// -------------------------------------------------------------------------
	// Test 2: Initial message delivery and processing
	// -------------------------------------------------------------------------
	test(
		'Task Agent processes its initial context message after spawning',
		async () => {
			const { space, workflow } = await createTestFixtures(daemon);

			const { task } = await startWorkflowRunAndGetTask(
				daemon,
				space.id,
				workflow.id,
				'Lifecycle test run — initial message'
			);

			const taskAgentSessionId = await waitForTaskAgentSpawned(
				daemon,
				space.id,
				task.id,
				TASK_AGENT_SPAWN_TIMEOUT
			);
			daemon.trackSession(taskAgentSessionId);

			// Wait for the Task Agent to finish processing its initial message
			await waitForIdle(daemon, taskAgentSessionId, IDLE_TIMEOUT);

			// There must be at least 2 SDK messages: the initial user message + assistant response
			const { sdkMessages } = await waitForSdkMessages(daemon, taskAgentSessionId, {
				minCount: 2,
				timeout: 5_000,
			});
			expect(sdkMessages.length).toBeGreaterThanOrEqual(2);

			// The first message in the thread must be a user message (the injected context)
			const userMessages = sdkMessages.filter((m) => m.type === 'user');
			expect(userMessages.length).toBeGreaterThan(0);

			// The initial context must reference the workflow/task
			const msgContent = JSON.stringify(
				(userMessages[0] as { message?: { content?: unknown } }).message?.content ?? ''
			);
			expect(msgContent).toMatch(/workflow|step|task/i);
		},
		TEST_TIMEOUT
	);

	// -------------------------------------------------------------------------
	// Test 3: spawn_step_agent tool invocation
	// -------------------------------------------------------------------------
	test(
		'Task Agent uses spawn_step_agent to create a sub-session for a workflow step',
		async () => {
			// NOTE: The probe mock returns a text-only response (no tool_use blocks) to
			// prevent the Claude Agent SDK from dispatching the short tool name
			// "spawn_step_agent" (registered as "mcp__task-agent__spawn_step_agent").
			// Dispatching a non-matching tool name causes the SDK to retry indefinitely.
			// We verify the mock was matched by checking the text content mentions the
			// tool name and step ID.
			// See probe mock "probe_task_agent_spawn_step_001" in .devproxy/mocks.json.
			const { space, workflow } = await createTestFixtures(daemon);

			const { task } = await startWorkflowRunAndGetTask(
				daemon,
				space.id,
				workflow.id,
				'Lifecycle test run — spawn step'
			);

			const taskAgentSessionId = await waitForTaskAgentSpawned(
				daemon,
				space.id,
				task.id,
				TASK_AGENT_SPAWN_TIMEOUT
			);
			daemon.trackSession(taskAgentSessionId);

			// Wait for initial message processing before injecting probe
			await waitForIdle(daemon, taskAgentSessionId, IDLE_TIMEOUT);

			// Inject a probe message that triggers the spawn_step_agent mock.
			// The probe phrase "probe_task_agent_spawn_step_001" is unique to this request
			// body at this point (earlier conversation does not contain it).
			await sendMessage(
				daemon,
				taskAgentSessionId,
				'probe_task_agent_spawn_step_001: Please spawn the step agent for the first workflow step.'
			);
			await waitForIdle(daemon, taskAgentSessionId, IDLE_TIMEOUT);

			// Verify the mock was matched: the probe response mentions spawn_step_agent and
			// the pre-assigned step ID step-code-lifecycle-001
			const { sdkMessages } = await waitForSdkMessages(daemon, taskAgentSessionId, {
				minCount: 4, // initial user + initial assistant + probe user + probe assistant
				timeout: 5_000,
			});

			const assistantMsgs = getAssistantMessages(sdkMessages);
			const textContent = extractTextContent(assistantMsgs);

			expect(textContent).toContain('spawn_step_agent');
			expect(textContent).toContain(STEP_CODE_ID);
		},
		TEST_TIMEOUT
	);

	// -------------------------------------------------------------------------
	// Test 4: check_step_status tool invocation
	// -------------------------------------------------------------------------
	test(
		'Task Agent uses check_step_status to monitor a spawned sub-session',
		async () => {
			// NOTE: The probe mock returns text-only (no tool_use blocks) to prevent the
			// SDK from dispatching the short tool name "check_step_status".
			// We verify the mock was matched by checking the text content.
			// See probe mock "probe_task_agent_check_step_001" in .devproxy/mocks.json.
			const { space, workflow } = await createTestFixtures(daemon);

			const { task } = await startWorkflowRunAndGetTask(
				daemon,
				space.id,
				workflow.id,
				'Lifecycle test run — check step'
			);

			const taskAgentSessionId = await waitForTaskAgentSpawned(
				daemon,
				space.id,
				task.id,
				TASK_AGENT_SPAWN_TIMEOUT
			);
			daemon.trackSession(taskAgentSessionId);

			await waitForIdle(daemon, taskAgentSessionId, IDLE_TIMEOUT);

			await sendMessage(
				daemon,
				taskAgentSessionId,
				'probe_task_agent_check_step_001: Please check the status of the running step agent.'
			);
			await waitForIdle(daemon, taskAgentSessionId, IDLE_TIMEOUT);

			const { sdkMessages } = await waitForSdkMessages(daemon, taskAgentSessionId, {
				minCount: 4,
				timeout: 5_000,
			});

			const assistantMsgs = getAssistantMessages(sdkMessages);
			const textContent = extractTextContent(assistantMsgs);

			expect(textContent).toContain('check_step_status');
		},
		TEST_TIMEOUT
	);

	// -------------------------------------------------------------------------
	// Test 5: advance_workflow tool invocation
	// -------------------------------------------------------------------------
	test(
		'Task Agent uses advance_workflow to move the workflow to the next step',
		async () => {
			// NOTE: The probe mock returns text-only (no tool_use blocks) to prevent the
			// SDK from dispatching the short tool name "advance_workflow".
			// We verify the mock was matched by checking the text content.
			// See probe mock "probe_task_agent_advance_wf_001" in .devproxy/mocks.json.
			const { space, workflow } = await createTestFixtures(daemon);

			const { task } = await startWorkflowRunAndGetTask(
				daemon,
				space.id,
				workflow.id,
				'Lifecycle test run — advance workflow'
			);

			const taskAgentSessionId = await waitForTaskAgentSpawned(
				daemon,
				space.id,
				task.id,
				TASK_AGENT_SPAWN_TIMEOUT
			);
			daemon.trackSession(taskAgentSessionId);

			await waitForIdle(daemon, taskAgentSessionId, IDLE_TIMEOUT);

			await sendMessage(
				daemon,
				taskAgentSessionId,
				'probe_task_agent_advance_wf_001: Please advance the workflow to the next step.'
			);
			await waitForIdle(daemon, taskAgentSessionId, IDLE_TIMEOUT);

			const { sdkMessages } = await waitForSdkMessages(daemon, taskAgentSessionId, {
				minCount: 4,
				timeout: 5_000,
			});

			const assistantMsgs = getAssistantMessages(sdkMessages);
			const textContent = extractTextContent(assistantMsgs);

			expect(textContent).toContain('advance_workflow');
		},
		TEST_TIMEOUT
	);

	// -------------------------------------------------------------------------
	// Test 6: report_result tool execution and task completion
	// -------------------------------------------------------------------------
	test(
		'Task Agent calls report_result to complete the task (full execution)',
		async () => {
			// This test uses the FULL MCP tool name "mcp__task-agent__report_result" with
			// stop_reason "tool_use" so the SDK dispatches the tool. The handler updates the
			// task status to 'completed' and emits the DaemonHub space.task.completed event.
			// See probe mock "probe_task_agent_report_complete_001" in .devproxy/mocks.json.
			const { space, workflow } = await createTestFixtures(daemon);

			const { task } = await startWorkflowRunAndGetTask(
				daemon,
				space.id,
				workflow.id,
				'Lifecycle test run — report result'
			);

			const taskAgentSessionId = await waitForTaskAgentSpawned(
				daemon,
				space.id,
				task.id,
				TASK_AGENT_SPAWN_TIMEOUT
			);
			daemon.trackSession(taskAgentSessionId);

			await waitForIdle(daemon, taskAgentSessionId, IDLE_TIMEOUT);

			// Inject probe message — mock returns report_result with full MCP name (stop_reason: tool_use)
			await sendMessage(
				daemon,
				taskAgentSessionId,
				'probe_task_agent_report_complete_001: Please call report_result to mark this task as completed.'
			);
			await waitForIdle(daemon, taskAgentSessionId, IDLE_TIMEOUT);

			// Verify the report_result tool_use block appears in SDK messages
			const { sdkMessages } = await waitForSdkMessages(daemon, taskAgentSessionId, {
				minCount: 4,
				timeout: 5_000,
			});

			const assistantMsgs = getAssistantMessages(sdkMessages);
			const toolUses = extractToolUses(assistantMsgs);
			const reportUses = toolUses.filter(
				(t) => t.name === 'report_result' || t.name === 'mcp__task-agent__report_result'
			);
			expect(reportUses.length).toBeGreaterThan(0);

			// The task status must have changed to 'completed' because the tool was executed
			const finalStatus = await waitForTaskStatus(
				daemon,
				space.id,
				task.id,
				['completed'],
				IS_MOCK ? 8_000 : 30_000
			);
			expect(finalStatus).toBe('completed');
		},
		TEST_TIMEOUT
	);

	// -------------------------------------------------------------------------
	// Test 7: Space Agent receives completion notification
	// -------------------------------------------------------------------------
	test(
		'Space Agent receives a completion notification when report_result completes a task',
		async () => {
			// Wait for the global spaces agent to be ready before proceeding.
			// provisionGlobalSpacesAgent() is fire-and-forget at startup.
			const spacesAgentDeadline = Date.now() + SETUP_TIMEOUT;
			let spacesAgentReady = false;
			while (Date.now() < spacesAgentDeadline) {
				try {
					await daemon.messageHub.request('session.get', {
						sessionId: GLOBAL_SPACES_SESSION_ID,
					});
					spacesAgentReady = true;
					break;
				} catch {
					await new Promise((resolve) => setTimeout(resolve, 200));
				}
			}
			if (!spacesAgentReady) {
				throw new Error(`spaces:global session was not ready within ${SETUP_TIMEOUT}ms — aborting`);
			}
			daemon.trackSession(GLOBAL_SPACES_SESSION_ID);

			const { space, workflow } = await createTestFixtures(daemon);

			const { task } = await startWorkflowRunAndGetTask(
				daemon,
				space.id,
				workflow.id,
				'Lifecycle test run — space agent notification'
			);

			const taskAgentSessionId = await waitForTaskAgentSpawned(
				daemon,
				space.id,
				task.id,
				TASK_AGENT_SPAWN_TIMEOUT
			);
			daemon.trackSession(taskAgentSessionId);

			await waitForIdle(daemon, taskAgentSessionId, IDLE_TIMEOUT);

			// Snapshot Space Agent SDK message count before triggering completion
			const { sdkMessages: beforeMessages } = await waitForSdkMessages(
				daemon,
				GLOBAL_SPACES_SESSION_ID,
				{ minCount: 0, timeout: 2_000 }
			).catch(() => ({ sdkMessages: [] as Array<Record<string, unknown>> }));
			const messageCountBefore = beforeMessages.length;

			// Trigger report_result via probe message (full MCP name → tool executed)
			await sendMessage(
				daemon,
				taskAgentSessionId,
				'probe_task_agent_report_complete_001: Please call report_result to mark this task as completed.'
			);
			await waitForIdle(daemon, taskAgentSessionId, IDLE_TIMEOUT);

			// Verify the task is completed (report_result tool was dispatched and executed)
			const finalStatus = await waitForTaskStatus(
				daemon,
				space.id,
				task.id,
				['completed'],
				IS_MOCK ? 8_000 : 30_000
			);
			expect(finalStatus).toBe('completed');

			// Wait for the Space Agent to receive and process the completion notification.
			// provision-global-agent.ts subscribes to space.task.completed and injects
			// a notification message into the spaces:global session.
			await waitForIdle(daemon, GLOBAL_SPACES_SESSION_ID, IDLE_TIMEOUT);

			// Space Agent must have at least one more SDK message than before (the notification)
			const { sdkMessages: afterMessages } = await waitForSdkMessages(
				daemon,
				GLOBAL_SPACES_SESSION_ID,
				{ minCount: messageCountBefore + 1, timeout: 10_000 }
			);
			expect(afterMessages.length).toBeGreaterThan(messageCountBefore);
		},
		TEST_TIMEOUT
	);
});
