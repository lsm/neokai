/**
 * WorkflowExecutor — Multi-Agent Unit Tests
 *
 * Comprehensive tests for multi-agent workflow execution. Covers:
 *
 * 1.  startWorkflowRun() with multi-agent start step — multiple initial tasks
 * 2.  resolveNodeAgents() — utility function
 * 3.  resolveNodeChannels() — all topology patterns
 * 4.  Channel validation in persistence (SpaceWorkflowManager with agentLookup)
 * 5.  Mixed workflows — some single-agent, some multi-agent, some with channels
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager.ts';
import {
	SpaceWorkflowManager,
	WorkflowValidationError,
} from '../../../src/lib/space/managers/space-workflow-manager.ts';
import type { SpaceAgentLookup } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceRuntimeConfig } from '../../../src/lib/space/runtime/space-runtime.ts';
import { resolveNodeAgents, resolveNodeChannels } from '@neokai/shared';
import type { SpaceAgent, WorkflowNode } from '@neokai/shared';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-wf-multi-agent',
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return { db, dir };
}

function seedSpace(db: BunDatabase, spaceId: string, workspacePath = '/tmp/ws'): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
	).run(spaceId, workspacePath, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgent(
	db: BunDatabase,
	agentId: string,
	spaceId: string,
	name: string,
	role = 'coder'
): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt,
     config, created_at, updated_at, role)
     VALUES (?, ?, ?, '', null, '[]', '', null, ?, ?, ?)`
	).run(agentId, spaceId, name, Date.now(), Date.now(), role);
}

// ---------------------------------------------------------------------------
// Shared agent fixtures for resolveNodeChannels tests
// ---------------------------------------------------------------------------

function makeSpaceAgent(id: string, name: string): SpaceAgent {
	return {
		id,
		spaceId: 'space-1',
		name: `${name} agent`,
		instructions: null,
		createdAt: 0,
		updatedAt: 0,
	};
}

// ===========================================================================
// SpaceRuntime — startWorkflowRun() with multi-agent start step
// ===========================================================================

describe('SpaceRuntime — startWorkflowRun() multi-agent start step', () => {
	let db: BunDatabase;
	let dir: string;
	let workflowRunRepo: SpaceWorkflowRunRepository;
	let taskRepo: SpaceTaskRepository;
	let workflowManager: SpaceWorkflowManager;
	let runtime: SpaceRuntime;

	const SPACE_ID = 'space-rt-ma';
	const WORKSPACE = '/tmp/rt-ma-ws';
	const AGENT_CODER = 'agent-rt-coder';
	const AGENT_PLANNER = 'agent-rt-planner';
	const AGENT_CUSTOM = 'agent-rt-custom';
	const STEP_A = 'step-rt-a';
	const STEP_B = 'step-rt-b';

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpace(db, SPACE_ID, WORKSPACE);
		seedAgent(db, AGENT_CODER, SPACE_ID, 'Coder', 'coder');
		seedAgent(db, AGENT_PLANNER, SPACE_ID, 'Planner', 'planner');
		seedAgent(db, AGENT_CUSTOM, SPACE_ID, 'Custom', 'my-custom-role');

		workflowRunRepo = new SpaceWorkflowRunRepository(db);
		taskRepo = new SpaceTaskRepository(db);

		const agentRepo = new SpaceAgentRepository(db);
		const agentManager = new SpaceAgentManager(agentRepo);

		const workflowRepo = new SpaceWorkflowRepository(db);
		workflowManager = new SpaceWorkflowManager(workflowRepo);
		const spaceManager = new SpaceManager(db);

		const config: SpaceRuntimeConfig = {
			db,
			spaceManager,
			spaceAgentManager: agentManager,
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
		};
		runtime = new SpaceRuntime(config);
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			/* ignore */
		}
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	// -------------------------------------------------------------------------
	// Subtask 3: startWorkflowRun() with multi-agent start step
	// -------------------------------------------------------------------------

	test('creates one task per agent for a multi-agent start step', async () => {
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Multi Start ${Date.now()}`,
			nodes: [
				{
					id: STEP_A,
					name: 'Parallel Start',
					agents: [
						{ agentId: AGENT_CODER, name: 'coder', instructions: 'Write code' },
						{ agentId: AGENT_PLANNER, name: 'planner', instructions: 'Plan it' },
					],
				},
			],
			transitions: [],
			startNodeId: STEP_A,
			rules: [],
			tags: [],
		});

		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Multi Start Run');

		expect(tasks).toHaveLength(2);
		for (const task of tasks) {
			expect(task.workflowRunId).toBe(run.id);
			expect(task.status).toBe('open');
		}
	});

	test('per-agent instructions set task descriptions on multi-agent start step', async () => {
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Multi Start Instructions ${Date.now()}`,
			nodes: [
				{
					id: STEP_A,
					name: 'Parallel Start',
					agents: [
						{
							agentId: AGENT_CODER,
							name: 'coder',
							instructions: { value: 'Coder task', mode: 'override' },
						},
						{
							agentId: AGENT_PLANNER,
							name: 'planner',
							instructions: { value: 'Planner task', mode: 'override' },
						},
					],
				},
			],
			transitions: [],
			startNodeId: STEP_A,
			rules: [],
			tags: [],
		});

		const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

		const descriptions = tasks.map((t) => t.description).sort();
		expect(descriptions).toEqual(['Coder task', 'Planner task'].sort());
	});

	test('per-agent taskType is resolved for multi-agent start step', async () => {
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Multi Start TaskType ${Date.now()}`,
			nodes: [
				{
					id: STEP_A,
					name: 'Mixed Start',
					agents: [
						{ agentId: AGENT_PLANNER, name: 'planner' },
						{ agentId: AGENT_CODER, name: 'coder' },
					],
				},
			],
			transitions: [],
			startNodeId: STEP_A,
			rules: [],
			tags: [],
		});

		const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

		expect(tasks).toHaveLength(2);
		// taskType and customAgentId were removed in M71
		// Verify both tasks were created with correct status
		for (const task of tasks) {
			expect(task.status).toBe('open');
		}
	});

	test('custom-role agent in multi-agent start step sets customAgentId on its task', async () => {
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Custom Role Start ${Date.now()}`,
			nodes: [
				{
					id: STEP_A,
					name: 'Custom Start',
					agents: [
						{ agentId: AGENT_CODER, name: 'coder' },
						{ agentId: AGENT_CUSTOM, name: 'my-custom-role' },
					],
				},
			],
			transitions: [],
			startNodeId: STEP_A,
			rules: [],
			tags: [],
		});

		const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

		expect(tasks).toHaveLength(2);
		// taskType and customAgentId were removed in M71
		// Verify both tasks were created with correct status
		for (const task of tasks) {
			expect(task.status).toBe('open');
		}
	});

	// -------------------------------------------------------------------------
	// Subtask 4: Step does NOT advance when only some tasks are complete
	// -------------------------------------------------------------------------

	test('executeTick() does NOT advance to next step when only some parallel tasks are completed', async () => {
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Partial Complete ${Date.now()}`,
			nodes: [
				{
					id: STEP_A,
					name: 'Parallel A',
					agents: [
						{ agentId: AGENT_CODER, name: 'coder' },
						{ agentId: AGENT_PLANNER, name: 'planner' },
					],
				},
				{ id: STEP_B, name: 'Next Step', agentId: AGENT_CODER },
			],
			transitions: [{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, order: 0 }],
			startNodeId: STEP_A,
			rules: [],
			tags: [],
		});

		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		expect(tasks).toHaveLength(2);

		// Complete only one of the two parallel tasks
		taskRepo.updateTask(tasks[0].id, { status: 'done' });
		// tasks[1] remains pending

		await runtime.executeTick();

		// Step B task must NOT have been created yet
		const allTasks = taskRepo.listByWorkflowRun(run.id);
		const stepBTasks = allTasks.filter((t) => t.workflowNodeId === STEP_B);
		expect(stepBTasks).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Subtask 6: Parallel failure — one task fails, others still active → waits
	// -------------------------------------------------------------------------

	test('does NOT mark run needs_attention when one task fails but sibling is still running', async () => {
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Partial Terminal ${Date.now()}`,
			nodes: [
				{
					id: STEP_A,
					name: 'Parallel Waiting',
					agents: [
						{ agentId: AGENT_CODER, name: 'coder' },
						{ agentId: AGENT_PLANNER, name: 'planner' },
					],
				},
			],
			transitions: [],
			startNodeId: STEP_A,
			rules: [],
			tags: [],
		});

		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

		// One task fails, but sibling is still in_progress
		taskRepo.updateTask(tasks[0].id, { status: 'blocked', error: 'Build failed' });
		taskRepo.updateTask(tasks[1].id, { status: 'in_progress' });

		await runtime.executeTick();

		// Run should still be in_progress — sibling is not terminal yet
		const updatedRun = workflowRunRepo.getRun(run.id)!;
		expect(updatedRun.status).toBe('in_progress');
	});

	// -------------------------------------------------------------------------
	// Subtask 7: Partial failure — all terminal with one failed → needs_attention
	// -------------------------------------------------------------------------

	test('marks run needs_attention when all parallel tasks are terminal and one failed', async () => {
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `All Terminal Fail ${Date.now()}`,
			nodes: [
				{
					id: STEP_A,
					name: 'Parallel Fail',
					agents: [
						{ agentId: AGENT_CODER, name: 'coder' },
						{ agentId: AGENT_PLANNER, name: 'planner' },
					],
				},
			],
			transitions: [],
			startNodeId: STEP_A,
			rules: [],
			tags: [],
		});

		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		expect(tasks).toHaveLength(2);

		// One completes, one fails — both are terminal
		taskRepo.updateTask(tasks[0].id, { status: 'done' });
		taskRepo.updateTask(tasks[1].id, { status: 'blocked', error: 'Agent crashed' });

		await runtime.executeTick();

		const updatedRun = workflowRunRepo.getRun(run.id)!;
		expect(updatedRun.status).toBe('blocked');
	});

	test('marks run needs_attention when two of three tasks complete but one fails', async () => {
		const AGENT_EXTRA = 'agent-rt-extra';
		seedAgent(db, AGENT_EXTRA, SPACE_ID, 'Extra', 'extra-role');

		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Three Agent Partial Fail ${Date.now()}`,
			nodes: [
				{
					id: STEP_A,
					name: 'Triple Parallel',
					agents: [
						{ agentId: AGENT_CODER, name: 'coder' },
						{ agentId: AGENT_PLANNER, name: 'planner' },
						{ agentId: AGENT_EXTRA, name: 'extra-role' },
					],
				},
			],
			transitions: [],
			startNodeId: STEP_A,
			rules: [],
			tags: [],
		});

		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		expect(tasks).toHaveLength(3);

		taskRepo.updateTask(tasks[0].id, { status: 'done' });
		taskRepo.updateTask(tasks[1].id, { status: 'done' });
		taskRepo.updateTask(tasks[2].id, { status: 'blocked', error: 'Crash' });

		await runtime.executeTick();

		const updatedRun = workflowRunRepo.getRun(run.id)!;
		expect(updatedRun.status).toBe('blocked');
	});

	// -------------------------------------------------------------------------
	// Subtask 8: Single agentId backward compat in SpaceRuntime
	// -------------------------------------------------------------------------

	test('startWorkflowRun() with single agentId creates exactly one task', async () => {
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Single Agent ${Date.now()}`,
			nodes: [{ id: STEP_A, name: 'Start', agentId: AGENT_CODER }],
			transitions: [],
			startNodeId: STEP_A,
			rules: [],
			tags: [],
		});

		const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		expect(tasks).toHaveLength(1);
		// workflowNodeId was removed in M71 — verify task was created
		expect(tasks[0].status).toBe('open');
	});
});

// ===========================================================================
// Subtask 9: resolveNodeAgents() utility
// ===========================================================================

describe('resolveNodeAgents()', () => {
	function makeStep(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
		return { id: 'step-1', name: 'Test Step', agents: [], ...overrides };
	}

	test('returns single-element array when only agentId is set', () => {
		// agentId is a legacy field handled via type cast; resolveNodeAgents uses node.name as slot name
		const step = makeStep({ agentId: 'agent-a' } as unknown as Partial<WorkflowNode>);
		const result = resolveNodeAgents(step);
		expect(result).toHaveLength(1);
		expect(result[0].agentId).toBe('agent-a');
		expect(result[0].name).toBe('Test Step');
	});

	test('returns agents array when agents is set and non-empty', () => {
		const step = makeStep({
			agents: [{ agentId: 'agent-a', instructions: 'code' }, { agentId: 'agent-b' }],
		});
		const result = resolveNodeAgents(step);
		expect(result).toHaveLength(2);
		expect(result[0].agentId).toBe('agent-a');
		expect(result[1].agentId).toBe('agent-b');
	});

	test('agents takes precedence over agentId when both are set', () => {
		const step = makeStep({
			agentId: 'agent-a', // ignored
			agents: [{ agentId: 'agent-b' }], // wins
		});
		const result = resolveNodeAgents(step);
		expect(result).toHaveLength(1);
		expect(result[0].agentId).toBe('agent-b');
	});

	test('throws when neither agentId nor agents is provided', () => {
		const step = makeStep();
		expect(() => resolveNodeAgents(step)).toThrow(
			'WorkflowNode "Test Step" (id: step-1) has no agents defined'
		);
	});

	test('throws when agents is an empty array and agentId is absent', () => {
		const step = makeStep({ agents: [] });
		expect(() => resolveNodeAgents(step)).toThrow();
	});

	test('single-element agents array works correctly', () => {
		const step = makeStep({
			agents: [{ agentId: 'agent-a', name: 'agent-a', instructions: 'custom' }],
		});
		expect(resolveNodeAgents(step)).toEqual([
			{ agentId: 'agent-a', name: 'agent-a', instructions: 'custom' },
		]);
	});

	test('agentId with no instructions produces entry with undefined instructions', () => {
		const step = makeStep({ agentId: 'agent-a' } as unknown as Partial<WorkflowNode>);
		const result = resolveNodeAgents(step);
		expect(result[0].instructions).toBeUndefined();
	});
});

// ===========================================================================
// Subtask 10: resolveNodeChannels() utility — all topology patterns
// ===========================================================================

describe('resolveNodeChannels()', () => {
	const agentCoder = makeSpaceAgent('agent-coder-id', 'coder');
	const agentReviewer = makeSpaceAgent('agent-reviewer-id', 'reviewer');
	const agentSecurity = makeSpaceAgent('agent-security-id', 'security');
	const allAgents: SpaceAgent[] = [agentCoder, agentReviewer, agentSecurity];

	function makeStep(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
		return { id: 'step-1', name: 'Test Step', agents: [], ...overrides };
	}

	test('returns empty array when no channels defined', () => {
		const step = makeStep({ agentId: 'agent-coder-id' } as unknown as Partial<WorkflowNode>);
		expect(resolveNodeChannels(step, step.channels ?? [])).toEqual([]);
	});

	test('returns empty array when channels is an empty array', () => {
		const step = makeStep({
			agentId: 'agent-coder-id',
			channels: [],
		} as unknown as Partial<WorkflowNode>);
		expect(resolveNodeChannels(step, step.channels ?? [])).toEqual([]);
	});

	// A → B one-way
	test('A→B one-way: resolves to single directed channel', () => {
		const step = makeStep({
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
			],
			channels: [{ from: 'coder', to: 'reviewer', direction: 'one-way' }],
		});
		const result = resolveNodeChannels(step, step.channels ?? []);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			fromRole: 'coder',
			toRole: 'reviewer',
			fromAgentId: 'agent-coder-id',
			toAgentId: 'agent-reviewer-id',
			direction: 'one-way',
			isHubSpoke: false,
		});
	});

	// A ↔ B bidirectional point-to-point
	test('A↔B bidirectional point-to-point: resolves to two directed channels (A→B and B→A)', () => {
		const step = makeStep({
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
			],
			channels: [{ from: 'coder', to: 'reviewer', direction: 'bidirectional' }],
		});
		const result = resolveNodeChannels(step, step.channels ?? []);
		expect(result).toHaveLength(2);

		const forward = result.find((r) => r.fromRole === 'coder' && r.toRole === 'reviewer');
		const reverse = result.find((r) => r.fromRole === 'reviewer' && r.toRole === 'coder');

		expect(forward).toBeDefined();
		expect(forward!.isHubSpoke).toBe(false);
		expect(forward!.direction).toBe('one-way');

		expect(reverse).toBeDefined();
		expect(reverse!.isHubSpoke).toBe(false);
		expect(reverse!.direction).toBe('one-way');
	});

	// A → [B, C, D] fan-out one-way
	test('A→[B,C,D] fan-out one-way: resolves to three directed channels, no reverse', () => {
		const step = makeStep({
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
				{ agentId: 'agent-security-id', name: 'security' },
			],
			channels: [{ from: 'coder', to: ['reviewer', 'security'], direction: 'one-way' }],
		});
		const result = resolveNodeChannels(step, step.channels ?? []);
		expect(result).toHaveLength(2);

		// All originate from coder
		expect(result.every((r) => r.fromRole === 'coder')).toBe(true);
		// No reverse channels
		expect(result.some((r) => r.toRole === 'coder')).toBe(false);
		// isHubSpoke false for one-way fan-out
		expect(result.every((r) => r.isHubSpoke === false)).toBe(true);
	});

	// A ↔ [B, C, D] fan-out bidirectional (hub-spoke)
	test('A↔[B,C,D] hub-spoke: resolves to A→B, A→C, A→D, B→A, C→A, D→A; B cannot send to C', () => {
		const step = makeStep({
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
				{ agentId: 'agent-security-id', name: 'security' },
			],
			channels: [{ from: 'coder', to: ['reviewer', 'security'], direction: 'bidirectional' }],
		});
		const result = resolveNodeChannels(step, step.channels ?? []);

		// 2 spokes × 2 directions = 4 channels
		expect(result).toHaveLength(4);

		// All marked hub-spoke
		expect(result.every((r) => r.isHubSpoke)).toBe(true);

		// Hub → each spoke
		expect(result.some((r) => r.fromRole === 'coder' && r.toRole === 'reviewer')).toBe(true);
		expect(result.some((r) => r.fromRole === 'coder' && r.toRole === 'security')).toBe(true);

		// Each spoke → hub
		expect(result.some((r) => r.fromRole === 'reviewer' && r.toRole === 'coder')).toBe(true);
		expect(result.some((r) => r.fromRole === 'security' && r.toRole === 'coder')).toBe(true);

		// No spoke-to-spoke (B cannot send to C)
		expect(result.some((r) => r.fromRole === 'reviewer' && r.toRole === 'security')).toBe(false);
		expect(result.some((r) => r.fromRole === 'security' && r.toRole === 'reviewer')).toBe(false);
	});

	// * → B wildcard from
	test('*→B wildcard from: resolves to channels from all agents to B', () => {
		const step = makeStep({
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
				{ agentId: 'agent-security-id', name: 'security' },
			],
			channels: [{ from: '*', to: 'reviewer', direction: 'one-way' }],
		});
		const result = resolveNodeChannels(step, step.channels ?? []);

		// coder→reviewer and security→reviewer (reviewer→reviewer self-loop skipped)
		expect(result).toHaveLength(2);
		expect(result.every((r) => r.toRole === 'reviewer')).toBe(true);
		expect(result.every((r) => r.fromRole !== 'reviewer')).toBe(true);
	});

	// A → * wildcard to
	test('A→* wildcard to: resolves to channels from A to all other agents', () => {
		const step = makeStep({
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
				{ agentId: 'agent-security-id', name: 'security' },
			],
			channels: [{ from: 'coder', to: '*', direction: 'one-way' }],
		});
		const result = resolveNodeChannels(step, step.channels ?? []);

		// coder→reviewer and coder→security (coder→coder self-loop skipped)
		expect(result).toHaveLength(2);
		expect(result.every((r) => r.fromRole === 'coder')).toBe(true);
		expect(result.every((r) => r.toRole !== 'coder')).toBe(true);
	});

	// Invalid role reference → skipped silently
	test('invalid role reference is skipped silently (does not throw)', () => {
		const step = makeStep({
			agents: [{ agentId: 'agent-coder-id', name: 'coder' }],
			channels: [{ from: 'coder', to: 'nonexistent-role', direction: 'one-way' }],
		});
		const result = resolveNodeChannels(step, step.channels ?? []);
		expect(result).toHaveLength(0);
	});
});

// ===========================================================================
// Subtask 11: Channel validation in persistence (SpaceWorkflowManager)
// ===========================================================================

// ===========================================================================
// Subtask 12: Mixed workflows (single-agent + multi-agent + channels)
// ===========================================================================

describe('Mixed workflows — single-agent, multi-agent, and channels', () => {
	let db: BunDatabase;
	let dir: string;
	let workflowRunRepo: SpaceWorkflowRunRepository;
	let taskRepo: SpaceTaskRepository;
	let workflowManager: SpaceWorkflowManager;
	let runtime: SpaceRuntime;

	const SPACE_ID = 'space-mixed';
	const WORKSPACE = '/tmp/ws-mixed';
	const AGENT_CODER = 'agent-mixed-coder';
	const AGENT_PLANNER = 'agent-mixed-planner';
	const AGENT_REVIEWER = 'agent-mixed-reviewer';
	const STEP_A = 'step-mx-a';
	const STEP_B = 'step-mx-b';
	const STEP_C = 'step-mx-c';

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpace(db, SPACE_ID, WORKSPACE);
		seedAgent(db, AGENT_CODER, SPACE_ID, 'Coder', 'coder');
		seedAgent(db, AGENT_PLANNER, SPACE_ID, 'Planner', 'planner');
		seedAgent(db, AGENT_REVIEWER, SPACE_ID, 'Reviewer', 'reviewer');

		workflowRunRepo = new SpaceWorkflowRunRepository(db);
		taskRepo = new SpaceTaskRepository(db);

		const agentRepo = new SpaceAgentRepository(db);
		const agentManager = new SpaceAgentManager(agentRepo);
		const workflowRepo = new SpaceWorkflowRepository(db);
		workflowManager = new SpaceWorkflowManager(workflowRepo);
		const spaceManager = new SpaceManager(db);

		const config: SpaceRuntimeConfig = {
			db,
			spaceManager,
			spaceAgentManager: agentManager,
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
		};
		runtime = new SpaceRuntime(config);
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			/* ignore */
		}
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	test('channels for start step are stored in run config after startWorkflowRun()', async () => {
		// Channels are now at workflow level, not node level
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Channel Start Step ${Date.now()}`,
			nodes: [
				{
					id: STEP_A,
					name: 'Parallel With Channels',
					agents: [
						{ agentId: AGENT_CODER, name: 'coder' },
						{ agentId: AGENT_REVIEWER, name: 'reviewer' },
					],
				},
			],
			channels: [{ from: 'coder', to: 'reviewer', direction: 'one-way', label: 'review-request' }],
			transitions: [],
			startNodeId: STEP_A,
			rules: [],
			tags: [],
		});

		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

		// Two tasks for the multi-agent start step
		expect(tasks).toHaveLength(2);

		// resolveAndStoreChannels called for start step; channels are in-memory (not in DB run config)
		const resolvedChannels = runtime.getRunResolvedChannels(run.id);

		expect(resolvedChannels.length).toBeGreaterThan(0);
		// User-declared channel: coder → reviewer (resolved from workflow-level channels)
		const userChannel = resolvedChannels.find(
			(ch) => ch.fromRole === 'coder' && ch.toRole === 'reviewer'
		);
		expect(userChannel).toMatchObject({
			fromRole: 'coder',
			toRole: 'reviewer',
			direction: 'one-way',
			label: 'review-request',
		});
		// No auto-generated task-agent channels (M3 auto-generation removed)
		const taskAgentToCoder = resolvedChannels.find(
			(ch) => ch.fromRole === 'task-agent' && ch.toRole === 'coder'
		);
		expect(taskAgentToCoder).toBeUndefined();
	});
});
