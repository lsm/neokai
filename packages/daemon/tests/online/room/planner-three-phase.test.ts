/**
 * Planner 3-Phase Pipeline Tests
 *
 * Verifies the planner's 3-stage pipeline:
 *   Stage 1: planner-explorer  — read-only codebase exploration
 *   Stage 2: planner-fact-checker — web-based validation of findings
 *   Stage 3: plan-writer       — creates plan PR using accumulated context
 *
 * Two test sections:
 *
 * 1. Configuration tests (no daemon) — call factory functions directly to verify:
 *    - agents map completeness (Planner + 3 sub-agents)
 *    - plan-writer has no Task/TaskOutput/TaskStop tools
 *    - planner-fact-checker has only WebSearch/WebFetch
 *    - planner system prompt describes 3-phase pipeline
 *
 * 2. Integration test (dev-proxy) — create a planner session via the room
 *    runtime and verify that the pipeline actually executes, with context
 *    threaded correctly between stages.
 *
 *    The dev proxy mocks the entire pipeline:
 *    - Initial planner call → Task(planner-explorer)
 *    - planner-explorer     → ---EXPLORER_FINDINGS--- with PLNR_EXPL_3P_2025_SENTINEL
 *    - Planner after explorer → Task(planner-fact-checker, prompt includes sentinel)
 *    - planner-fact-checker  → ---FACT_CHECK_RESULT--- with PLNR_FACT_3P_2025_SENTINEL
 *    - Planner after fact-checker → Task(plan-writer, prompt includes both sentinels)
 *    - plan-writer           → ---PLAN_RESULT--- with PLNR_PLAN_3P_2025_SENTINEL
 *    - Planner after plan-writer → end_turn
 *
 *    Test assertions inspect the planner's SDK messages to find the Task tool_use
 *    blocks and verify their prompts contain the expected sentinel strings, proving
 *    context was threaded across pipeline stages.
 *
 * Run:
 *   NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/room/planner-three-phase.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { createRoom, createGoal, setupGitEnvironment, waitForTask } from './room-test-helpers';
import {
	buildPlannerExplorerAgentDef,
	buildPlannerFactCheckerAgentDef,
	buildPlanWriterAgentDef,
	buildPlannerSystemPrompt,
	createPlannerAgentInit,
	type PlannerAgentConfig,
} from '../../../src/lib/room/agents/planner-agent';

// ── Constants ────────────────────────────────────────────────────────────────

/** Unique probe fragment embedded in the goal description — dev proxy matches on this. */
const PIPELINE_PROBE_FRAGMENT = 'planner-3phase-ctx-probe-2025-v1';

/**
 * Sentinel strings included in mock sub-agent responses.
 * Used to verify context threading — each sentinel must appear in the prompt
 * of the NEXT stage's Task call to confirm the planner included the previous
 * stage's output verbatim.
 */
const EXPLORER_SENTINEL = 'PLNR_EXPL_3P_2025_SENTINEL';
const FACT_CHECK_SENTINEL = 'PLNR_FACT_3P_2025_SENTINEL';

// ── Timeouts (mock vs real API) ──────────────────────────────────────────────

const IS_MOCK = !!process.env.NEOKAI_USE_DEV_PROXY;

const SETUP_TIMEOUT = IS_MOCK ? 15_000 : 60_000;
const TEST_TIMEOUT = IS_MOCK ? 60_000 : 300_000;
const GROUP_POLL_TIMEOUT = IS_MOCK ? 10_000 : 60_000;
const PIPELINE_POLL_TIMEOUT = IS_MOCK ? 30_000 : 180_000;

// Use Sonnet for room agents — save and restore to avoid cross-test leakage.
const savedModel = process.env.DEFAULT_MODEL;
process.env.DEFAULT_MODEL = 'sonnet';

// ─────────────────────────────────────────────────────────────────────────────
// Section 1: Configuration tests (no daemon, no API calls)
// ─────────────────────────────────────────────────────────────────────────────

describe('Planner 3-phase pipeline — configuration', () => {
	/** Minimal PlannerAgentConfig for calling createPlannerAgentInit. */
	const config: PlannerAgentConfig = {
		task: {
			id: 'task-test',
			roomId: 'room-test',
			title: 'Plan: Test goal',
			description: 'Test',
			status: 'in_progress',
			priority: 'normal',
			createdAt: Date.now(),
			taskType: 'planning',
		},
		goal: {
			id: 'goal-test',
			roomId: 'room-test',
			title: 'Test goal',
			description: 'A test goal for verifying 3-phase pipeline configuration',
			status: 'active',
			priority: 'normal',
			progress: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		},
		room: {
			id: 'room-test',
			name: 'Test Room',
			allowedPaths: [{ path: '/workspace', label: 'ws' }],
			defaultPath: '/workspace',
			sessionIds: [],
			status: 'active',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		},
		sessionId: 'session-test',
		workspacePath: '/workspace',
		createDraftTask: async () => ({ id: 'draft-1', title: 'Draft' }),
		updateDraftTask: async () => ({ id: 'draft-1', title: 'Draft' }),
		removeDraftTask: async () => true,
	};

	test('agents map contains all four required agents', () => {
		const sessionInit = createPlannerAgentInit(config);
		const agentNames = Object.keys(sessionInit.agents ?? {});
		expect(agentNames).toHaveLength(4);
		expect(agentNames).toContain('Planner');
		expect(agentNames).toContain('planner-explorer');
		expect(agentNames).toContain('planner-fact-checker');
		expect(agentNames).toContain('plan-writer');
	});

	test('plan-writer does NOT include Task, TaskOutput, or TaskStop tools', () => {
		const def = buildPlanWriterAgentDef('test-plan');
		const tools = def.tools ?? [];
		expect(tools).not.toContain('Task');
		expect(tools).not.toContain('TaskOutput');
		expect(tools).not.toContain('TaskStop');
	});

	test('planner-fact-checker has only WebSearch and WebFetch tools', () => {
		const def = buildPlannerFactCheckerAgentDef();
		const tools = def.tools ?? [];
		expect(tools).toHaveLength(2);
		expect(tools).toContain('WebSearch');
		expect(tools).toContain('WebFetch');
		// Explicitly verify no codebase tools
		expect(tools).not.toContain('Read');
		expect(tools).not.toContain('Grep');
		expect(tools).not.toContain('Glob');
		expect(tools).not.toContain('Bash');
	});

	test('planner-explorer has no web tools', () => {
		const def = buildPlannerExplorerAgentDef();
		const tools = def.tools ?? [];
		expect(tools).not.toContain('WebSearch');
		expect(tools).not.toContain('WebFetch');
		// Has codebase tools
		expect(tools).toContain('Read');
		expect(tools).toContain('Grep');
		expect(tools).toContain('Glob');
		expect(tools).toContain('Bash');
	});

	test('planner system prompt describes 3-phase pipeline with all three stages', () => {
		const prompt = buildPlannerSystemPrompt('Test goal');
		// Phase 1: contains 3-stage pipeline description
		expect(prompt).toContain('3-Stage Pipeline');
		expect(prompt).toContain('Stage 1');
		expect(prompt).toContain('Stage 2');
		expect(prompt).toContain('Stage 3');
		// All three sub-agent names are mentioned
		expect(prompt).toContain('planner-explorer');
		expect(prompt).toContain('planner-fact-checker');
		expect(prompt).toContain('plan-writer');
		// Context-passing markers
		expect(prompt).toContain('---EXPLORER_FINDINGS---');
		expect(prompt).toContain('---FACT_CHECK_RESULT---');
		// Context threading instructions
		expect(prompt).toContain('## Explorer Findings');
		expect(prompt).toContain('## Fact-Check Results');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 2: Integration test (dev-proxy, daemon required)
// ─────────────────────────────────────────────────────────────────────────────

describe('Planner 3-phase pipeline — integration (dev-proxy)', () => {
	let daemon: DaemonServerContext;
	let roomId: string;

	beforeAll(async () => {
		daemon = await createDaemonServer();
		setupGitEnvironment(process.env.NEOKAI_WORKSPACE_PATH!);
		roomId = await createRoom(daemon, 'Planner 3-Phase Integration');
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
		'context-passing: planner threads explorer findings to fact-checker and plan-writer',
		async () => {
			// Create goal with unique probe fragment.
			// Dev proxy matches 'planner-3phase-ctx-probe-2025-v1' and returns Task(planner-explorer).
			// Subsequent sentinel-matched mocks drive the rest of the pipeline.
			await createGoal(
				daemon,
				roomId,
				'3-phase pipeline test',
				`Probe: ${PIPELINE_PROBE_FRAGMENT}. Implement a simple utility function.`
			);

			// --- Wait for planning task ---
			const planningTask = await waitForTask(
				daemon,
				roomId,
				{
					taskType: 'planning',
					status: ['pending', 'in_progress', 'completed', 'review', 'needs_attention'],
				},
				PIPELINE_POLL_TIMEOUT
			);
			expect(planningTask.taskType).toBe('planning');
			console.log(`Planning task: ${planningTask.id} (${planningTask.status})`);

			// --- Wait for session group to be created ---
			const group = await waitForGroup(daemon, roomId, planningTask.id, GROUP_POLL_TIMEOUT);
			const { workerSessionId } = group;
			console.log(`Worker session (planner): ${workerSessionId}`);

			// --- Poll SDK messages until all 3 Task calls appear ---
			const taskCalls = await pollForTaskCalls(daemon, workerSessionId, PIPELINE_POLL_TIMEOUT);

			// --- Verify all 3 sub-agents were spawned ---
			const explorerCall = taskCalls.find((c) => c.subagentType === 'planner-explorer');
			const factCheckerCall = taskCalls.find((c) => c.subagentType === 'planner-fact-checker');
			const planWriterCall = taskCalls.find((c) => c.subagentType === 'plan-writer');

			console.log(`Task calls found: [${taskCalls.map((c) => c.subagentType).join(', ')}]`);

			expect(explorerCall).toBeDefined();
			expect(factCheckerCall).toBeDefined();
			expect(planWriterCall).toBeDefined();

			// --- Verify context threading ---

			// Stage 2 (fact-checker) prompt MUST include the explorer findings sentinel.
			// This proves the planner threaded the explorer's output to the fact-checker.
			expect(factCheckerCall!.prompt).toContain(EXPLORER_SENTINEL);

			// Stage 3 (plan-writer) prompt MUST include BOTH sentinels.
			// This proves the planner accumulated context across all pipeline stages.
			expect(planWriterCall!.prompt).toContain(EXPLORER_SENTINEL);
			expect(planWriterCall!.prompt).toContain(FACT_CHECK_SENTINEL);

			console.log(
				`Pipeline context threading verified:\n` +
					`  planner-explorer     → spawned ✓\n` +
					`  planner-fact-checker → spawned with explorer context ✓\n` +
					`  plan-writer         → spawned with explorer + fact-check context ✓`
			);
		},
		TEST_TIMEOUT
	);
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Poll task.getGroup until the session group is created, or throw on timeout. */
async function waitForGroup(
	daemon: DaemonServerContext,
	roomId: string,
	taskId: string,
	timeout: number
): Promise<{ id: string; workerSessionId: string; leaderSessionId: string; workerRole: string }> {
	const deadline = Date.now() + timeout;

	while (Date.now() < deadline) {
		const result = (await daemon.messageHub.request('task.getGroup', { roomId, taskId })) as {
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

	const { tasks } = (await daemon.messageHub.request('task.list', { roomId })) as {
		tasks: Array<{ id: string; taskType: string; status: string; title: string }>;
	};
	const summary = tasks.map((t) => `  ${t.taskType}:${t.status} (${t.title})`).join('\n');
	throw new Error(
		`Timeout (${timeout}ms) waiting for session group on task ${taskId}\nCurrent tasks:\n${summary}`
	);
}

interface TaskCall {
	subagentType: string;
	prompt: string;
}

/**
 * Poll message.sdkMessages for the planner session until all three Task calls
 * (planner-explorer, planner-fact-checker, plan-writer) appear, or the timeout
 * elapses.
 *
 * Returns the calls found — test assertions are responsible for verifying
 * completeness and content.
 */
async function pollForTaskCalls(
	daemon: DaemonServerContext,
	sessionId: string,
	timeout: number
): Promise<TaskCall[]> {
	const deadline = Date.now() + timeout;
	let lastCalls: TaskCall[] = [];

	while (Date.now() < deadline) {
		const result = (await daemon.messageHub.request('message.sdkMessages', {
			sessionId,
			limit: 200,
		})) as { sdkMessages: Array<Record<string, unknown>> };

		lastCalls = extractTaskCalls(result.sdkMessages);

		const hasExplorer = lastCalls.some((c) => c.subagentType === 'planner-explorer');
		const hasFactChecker = lastCalls.some((c) => c.subagentType === 'planner-fact-checker');
		const hasPlanWriter = lastCalls.some((c) => c.subagentType === 'plan-writer');

		if (hasExplorer && hasFactChecker && hasPlanWriter) {
			return lastCalls;
		}

		await Bun.sleep(1_000);
	}

	// Log diagnostic info on timeout to help debug failing tests
	const found = lastCalls.map((c) => c.subagentType).join(', ');
	console.log(
		`pollForTaskCalls timed out after ${timeout}ms. ` +
			`Found Task calls: [${found || 'none'}] for session ${sessionId}`
	);

	return lastCalls;
}

/**
 * Extract all Task tool_use blocks from SDK messages.
 * Returns an array of { subagentType, prompt } for each Task call found.
 */
function extractTaskCalls(messages: Array<Record<string, unknown>>): TaskCall[] {
	const calls: TaskCall[] = [];

	for (const msg of messages) {
		if (msg['type'] !== 'assistant') continue;

		const betaMessage = msg['message'] as
			| { content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }> }
			| undefined;

		if (!betaMessage?.content) continue;

		for (const block of betaMessage.content) {
			if (block.type !== 'tool_use' || block.name !== 'Task') continue;
			const input = block.input;
			if (!input) continue;
			const subagentType = input['subagent_type'] as string | undefined;
			const prompt = input['prompt'] as string | undefined;
			if (subagentType && prompt !== undefined) {
				calls.push({ subagentType, prompt });
			}
		}
	}

	return calls;
}
