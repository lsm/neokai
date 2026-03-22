/**
 * Unit tests for createTaskAgentToolHandlers()
 *
 * Covers all 7 Task Agent tools:
 *   spawn_step_agent    — creates sub-session, registers callback, injects message
 *   check_step_status   — polling detection of sub-session completion
 *   advance_workflow    — delegates to WorkflowExecutor.advance(), handles gate errors
 *   report_result       — transitions main task to final status
 *   request_human_input — pauses execution, marks task needs_attention
 *   list_group_members  — lists group members with session IDs and channel info
 *   relay_message       — injects a message into a target group member's session
 *
 * Tests use a real SQLite database (via runMigrations) and mock SubSessionFactory
 * so no real agent sessions are created.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceManager } from '../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../src/lib/space/runtime/space-runtime.ts';
import { SpaceSessionGroupRepository } from '../../../src/storage/repositories/space-session-group-repository.ts';
import {
	createTaskAgentToolHandlers,
	createTaskAgentMcpServer,
	type SubSessionFactory,
	type SubSessionMemberInfo,
	type SubSessionState,
	type TaskAgentToolsConfig,
} from '../../../src/lib/space/tools/task-agent-tools.ts';
import type { Space, SpaceWorkflow, SpaceTask } from '@neokai/shared';
import type { DaemonHub } from '../../../src/lib/daemon-hub.ts';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-task-agent-tools',
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return { db, dir };
}

function seedSpaceRow(db: BunDatabase, spaceId: string, workspacePath = '/tmp/workspace'): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', 'active', ?, ?)`
	).run(spaceId, workspacePath, `Space ${spaceId}`, Date.now(), Date.now());
}

function seedAgentRow(
	db: BunDatabase,
	agentId: string,
	spaceId: string,
	name: string,
	role: string
): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, role, description, model, tools, system_prompt,
     config, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', null, '[]', '', null, ?, ?)`
	).run(agentId, spaceId, name, role, Date.now(), Date.now());
}

function makeSpace(spaceId: string, workspacePath = '/tmp/workspace'): Space {
	return {
		id: spaceId,
		workspacePath,
		name: `Space ${spaceId}`,
		description: '',
		backgroundContext: '',
		instructions: '',
		sessionIds: [],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// Workflow helpers
// ---------------------------------------------------------------------------

function buildTwoStepWorkflow(
	spaceId: string,
	workflowManager: SpaceWorkflowManager,
	agentId: string,
	name = 'Two-Step WF'
): SpaceWorkflow {
	const step1Id = `step-1-${Math.random().toString(36).slice(2)}`;
	const step2Id = `step-2-${Math.random().toString(36).slice(2)}`;

	return workflowManager.createWorkflow({
		spaceId,
		name,
		description: 'Two-step test workflow',
		steps: [
			{ id: step1Id, name: 'Step One', agentId, instructions: 'Do the first thing' },
			{ id: step2Id, name: 'Step Two', agentId, instructions: 'Do the second thing' },
		],
		transitions: [{ from: step1Id, to: step2Id, condition: { type: 'always' } }],
		startStepId: step1Id,
		rules: [],
	});
}

function buildSingleStepWorkflow(
	spaceId: string,
	workflowManager: SpaceWorkflowManager,
	agentId: string,
	name = 'Single-Step WF'
): SpaceWorkflow {
	const stepId = `step-${Math.random().toString(36).slice(2)}`;
	return workflowManager.createWorkflow({
		spaceId,
		name,
		steps: [{ id: stepId, name: 'Only Step', agentId }],
		transitions: [],
		startStepId: stepId,
		rules: [],
	});
}

function buildHumanGateWorkflow(
	spaceId: string,
	workflowManager: SpaceWorkflowManager,
	agentId: string
): SpaceWorkflow {
	const step1Id = `step-1-${Math.random().toString(36).slice(2)}`;
	const step2Id = `step-2-${Math.random().toString(36).slice(2)}`;
	return workflowManager.createWorkflow({
		spaceId,
		name: 'Human Gate WF',
		steps: [
			{ id: step1Id, name: 'Work Step', agentId },
			{ id: step2Id, name: 'After Gate', agentId },
		],
		transitions: [{ from: step1Id, to: step2Id, condition: { type: 'human' } }],
		startStepId: step1Id,
		rules: [],
	});
}

function buildTaskResultWorkflow(
	spaceId: string,
	workflowManager: SpaceWorkflowManager,
	agentId: string,
	conditionExpression = 'passed'
): SpaceWorkflow {
	const step1Id = `step-1-${Math.random().toString(36).slice(2)}`;
	const step2Id = `step-2-${Math.random().toString(36).slice(2)}`;
	return workflowManager.createWorkflow({
		spaceId,
		name: 'Task Result WF',
		steps: [
			{ id: step1Id, name: 'Verify Step', agentId },
			{ id: step2Id, name: 'Next Step', agentId },
		],
		transitions: [
			{
				from: step1Id,
				to: step2Id,
				condition: { type: 'task_result', expression: conditionExpression },
			},
		],
		startStepId: step1Id,
		rules: [],
	});
}

// ---------------------------------------------------------------------------
// Mock SubSessionFactory
// ---------------------------------------------------------------------------

function makeMockSessionFactory(overrides?: {
	create?: (init: unknown, memberInfo?: SubSessionMemberInfo) => Promise<string>;
	getProcessingState?: (sessionId: string) => SubSessionState | null;
	onComplete?: (sessionId: string, callback: () => Promise<void>) => void;
}): SubSessionFactory & {
	_completionCallbacks: Map<string, () => Promise<void>>;
	_capturedMemberInfos: Map<string, SubSessionMemberInfo | undefined>;
} {
	const completionCallbacks = new Map<string, () => Promise<void>>();
	const sessionStates = new Map<string, SubSessionState>();
	const capturedMemberInfos = new Map<string, SubSessionMemberInfo | undefined>();

	return {
		_completionCallbacks: completionCallbacks,
		_capturedMemberInfos: capturedMemberInfos,

		async create(init: unknown, memberInfo?: SubSessionMemberInfo): Promise<string> {
			if (overrides?.create) return overrides.create(init, memberInfo);
			const id = `sub-session-${Math.random().toString(36).slice(2)}`;
			sessionStates.set(id, { isProcessing: true, isComplete: false });
			capturedMemberInfos.set(id, memberInfo);
			return id;
		},

		getProcessingState(sessionId: string): SubSessionState | null {
			if (overrides?.getProcessingState) return overrides.getProcessingState(sessionId);
			return sessionStates.get(sessionId) ?? null;
		},

		onComplete(sessionId: string, callback: () => Promise<void>): void {
			if (overrides?.onComplete) {
				overrides.onComplete(sessionId, callback);
				return;
			}
			completionCallbacks.set(sessionId, callback);
		},

		// Test helper: simulate a session completing
		async _triggerComplete(sessionId: string): Promise<void> {
			sessionStates.set(sessionId, { isProcessing: false, isComplete: true });
			const cb = completionCallbacks.get(sessionId);
			if (cb) await cb();
		},
	} as SubSessionFactory & {
		_completionCallbacks: Map<string, () => Promise<void>>;
		_capturedMemberInfos: Map<string, SubSessionMemberInfo | undefined>;
		_triggerComplete: (sessionId: string) => Promise<void>;
	};
}

// ---------------------------------------------------------------------------
// Test context
// ---------------------------------------------------------------------------

interface TestCtx {
	db: BunDatabase;
	dir: string;
	spaceId: string;
	agentId: string;
	space: Space;
	workflowManager: SpaceWorkflowManager;
	workflowRunRepo: SpaceWorkflowRunRepository;
	taskRepo: SpaceTaskRepository;
	taskManager: SpaceTaskManager;
	agentManager: SpaceAgentManager;
	runtime: SpaceRuntime;
	sessionGroupRepo: SpaceSessionGroupRepository;
}

function makeCtx(): TestCtx {
	const { db, dir } = makeDb();
	const spaceId = 'space-tat-test';
	const workspacePath = '/tmp/test-workspace';

	seedSpaceRow(db, spaceId, workspacePath);

	const agentId = 'agent-coder-1';
	seedAgentRow(db, agentId, spaceId, 'Coder', 'coder');

	const agentRepo = new SpaceAgentRepository(db);
	const agentManager = new SpaceAgentManager(agentRepo);

	const workflowRepo = new SpaceWorkflowRepository(db);
	const workflowManager = new SpaceWorkflowManager(workflowRepo);

	const workflowRunRepo = new SpaceWorkflowRunRepository(db);
	const taskRepo = new SpaceTaskRepository(db);
	const spaceManager = new SpaceManager(db);
	const taskManager = new SpaceTaskManager(db, spaceId);
	const sessionGroupRepo = new SpaceSessionGroupRepository(db);

	const runtime = new SpaceRuntime({
		db,
		spaceManager,
		spaceAgentManager: agentManager,
		spaceWorkflowManager: workflowManager,
		workflowRunRepo,
		taskRepo,
	});

	const space = makeSpace(spaceId, workspacePath);

	return {
		db,
		dir,
		spaceId,
		agentId,
		space,
		workflowManager,
		workflowRunRepo,
		taskRepo,
		taskManager,
		agentManager,
		runtime,
		sessionGroupRepo,
	};
}

function makeConfig(
	ctx: TestCtx,
	taskId: string,
	workflowRunId: string,
	sessionFactory: SubSessionFactory,
	options?: {
		messageInjector?: (sessionId: string, message: string) => Promise<void>;
		onSubSessionComplete?: (stepId: string, sessionId: string) => Promise<void>;
		/** Optional group ID — if provided, getGroupId() returns it */
		groupId?: string;
	}
): TaskAgentToolsConfig {
	return {
		taskId,
		space: ctx.space,
		workflowRunId,
		workspacePath: ctx.space.workspacePath,
		runtime: ctx.runtime,
		workflowManager: ctx.workflowManager,
		taskRepo: ctx.taskRepo,
		workflowRunRepo: ctx.workflowRunRepo,
		agentManager: ctx.agentManager,
		taskManager: ctx.taskManager,
		sessionFactory,
		messageInjector: options?.messageInjector ?? (async () => {}),
		onSubSessionComplete: options?.onSubSessionComplete ?? (async () => {}),
		sessionGroupRepo: ctx.sessionGroupRepo,
		getGroupId: () => options?.groupId,
	};
}

// ---------------------------------------------------------------------------
// Mock DaemonHub helper
// ---------------------------------------------------------------------------

interface MockDaemonHub {
	hub: DaemonHub;
	emittedEvents: Array<{ name: string; payload: Record<string, unknown> }>;
}

function makeMockDaemonHub(): MockDaemonHub {
	const emittedEvents: Array<{ name: string; payload: Record<string, unknown> }> = [];
	const hub = {
		// Synchronous recording so tests don't need setTimeout to flush async microtasks.
		// Returns Promise.resolve() to satisfy the async signature.
		emit: mock((name: string, payload: Record<string, unknown>) => {
			emittedEvents.push({ name, payload });
			return Promise.resolve();
		}),
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;
	return { hub, emittedEvents };
}

// ---------------------------------------------------------------------------
// Helper: start workflow run and get the main task + step task
// ---------------------------------------------------------------------------

async function startRun(
	ctx: TestCtx,
	workflow: SpaceWorkflow
): Promise<{ run: { id: string }; mainTask: SpaceTask; stepTask: SpaceTask }> {
	const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, workflow.id, 'Test run');
	const stepTask = tasks[0];

	// Create the main "task agent task" (the task that has a Task Agent session)
	const mainTask = ctx.taskRepo.createTask({
		spaceId: ctx.spaceId,
		title: 'Main orchestration task',
		description: 'The task being orchestrated',
		status: 'pending',
		workflowRunId: run.id,
	});

	return { run, mainTask, stepTask };
}

// ===========================================================================
// spawn_step_agent tests
// ===========================================================================

describe('createTaskAgentToolHandlers — spawn_step_agent', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('successfully spawns a sub-session for a valid step', async () => {
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask, stepTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		const result = await handlers.spawn_step_agent({ step_id: wf.startStepId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.sessionId).toBeString();
		expect(parsed.stepId).toBe(wf.startStepId);
		expect(parsed.taskId).toBe(stepTask.id);
	});

	test('transitions main task from pending to in_progress', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// Main task starts as pending
		const before = ctx.taskRepo.getTask(mainTask.id);
		expect(before?.status).toBe('pending');

		await handlers.spawn_step_agent({ step_id: wf.startStepId });

		const after = ctx.taskRepo.getTask(mainTask.id);
		expect(after?.status).toBe('in_progress');
	});

	test('stores sub-session ID on step task via taskAgentSessionId', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask, stepTask } = await startRun(ctx, wf);

		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		const result = await handlers.spawn_step_agent({ step_id: wf.startStepId });
		const parsed = JSON.parse(result.content[0].text);

		const updatedStepTask = ctx.taskRepo.getTask(stepTask.id);
		expect(updatedStepTask?.taskAgentSessionId).toBe(parsed.sessionId);
	});

	test('registers completion callback on the sub-session', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask, stepTask } = await startRun(ctx, wf);

		const completedSteps: string[] = [];
		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(
			makeConfig(ctx, mainTask.id, run.id, factory, {
				onSubSessionComplete: async (stepId) => {
					completedSteps.push(stepId);
					// Actually mark the step task as completed (as TaskAgentManager would do)
					ctx.taskRepo.updateTask(stepTask.id, {
						status: 'completed',
						completedAt: Date.now(),
					});
				},
			})
		);

		const result = await handlers.spawn_step_agent({ step_id: wf.startStepId });
		const parsed = JSON.parse(result.content[0].text);

		// Trigger sub-session completion
		await (factory as ReturnType<typeof makeMockSessionFactory>)._triggerComplete(parsed.sessionId);

		expect(completedSteps).toContain(wf.startStepId);
		const updatedStepTask = ctx.taskRepo.getTask(stepTask.id);
		expect(updatedStepTask?.status).toBe('completed');
	});

	test('injects the task context message into the sub-session', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		const injections: Array<{ sessionId: string; message: string }> = [];
		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(
			makeConfig(ctx, mainTask.id, run.id, factory, {
				messageInjector: async (sessionId, message) => {
					injections.push({ sessionId, message });
				},
			})
		);

		const result = await handlers.spawn_step_agent({ step_id: wf.startStepId });
		const parsed = JSON.parse(result.content[0].text);

		expect(injections).toHaveLength(1);
		expect(injections[0].sessionId).toBe(parsed.sessionId);
		expect(injections[0].message).toBeString();
		expect(injections[0].message.length).toBeGreaterThan(0);
	});

	test('applies instruction override when provided', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		const injections: Array<{ sessionId: string; message: string }> = [];
		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(
			makeConfig(ctx, mainTask.id, run.id, factory, {
				messageInjector: async (sessionId, message) => {
					injections.push({ sessionId, message });
				},
			})
		);

		await handlers.spawn_step_agent({
			step_id: wf.startStepId,
			instructions: 'Custom override instructions here',
		});

		expect(injections).toHaveLength(1);
		// The injected message should contain the override instructions
		expect(injections[0].message).toContain('Custom override instructions here');
	});

	test('returns error when step_id not found in workflow', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		const result = await handlers.spawn_step_agent({ step_id: 'step-does-not-exist' });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('step-does-not-exist');
	});

	test('returns error when no task found for step (advance_workflow not yet called)', async () => {
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// The second step has no task yet because advance_workflow hasn't been called
		const step2Id = wf.steps[1].id;
		const result = await handlers.spawn_step_agent({ step_id: step2Id });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain(step2Id);
	});

	test('returns error when workflow run not found', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Main task',
			description: '',
			status: 'pending',
		});
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(
			makeConfig(ctx, mainTask.id, 'run-does-not-exist', factory)
		);

		const result = await handlers.spawn_step_agent({ step_id: wf.startStepId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('run-does-not-exist');
	});

	test('returns error when sessionFactory.create throws', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		const factory = makeMockSessionFactory({
			create: async () => {
				throw new Error('Session creation failed: quota exceeded');
			},
		});

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		const result = await handlers.spawn_step_agent({ step_id: wf.startStepId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('quota exceeded');
	});

	test('does not re-transition main task if already in_progress', async () => {
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		// Manually transition to in_progress
		await ctx.taskManager.setTaskStatus(mainTask.id, 'in_progress');

		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		const result = await handlers.spawn_step_agent({ step_id: wf.startStepId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		const after = ctx.taskRepo.getTask(mainTask.id);
		expect(after?.status).toBe('in_progress');
	});

	test('double-spawn for same step_id returns success on second call (idempotent session reuse)', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// First spawn
		const first = await handlers.spawn_step_agent({ step_id: wf.startStepId });
		const firstParsed = JSON.parse(first.content[0].text);
		expect(firstParsed.success).toBe(true);
		const firstSessionId = firstParsed.sessionId;

		// Second spawn for same step — the step task already has taskAgentSessionId set
		// Handler should detect the existing session and return it without creating a new one
		const second = await handlers.spawn_step_agent({ step_id: wf.startStepId });
		const secondParsed = JSON.parse(second.content[0].text);

		// Must not error out — should succeed or return existing session info
		expect(secondParsed.success).toBe(true);
		// The returned sessionId should be the same as the first (no duplicate sessions)
		expect(secondParsed.sessionId).toBe(firstSessionId);
	});

	test('passes agentId and role as memberInfo to sessionFactory.create()', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		const result = await handlers.spawn_step_agent({ step_id: wf.startStepId });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);

		const sessionId = parsed.sessionId;
		const memberInfo = factory._capturedMemberInfos.get(sessionId);

		// memberInfo must carry the agent's ID and role
		expect(memberInfo).toBeDefined();
		expect(memberInfo?.agentId).toBe(ctx.agentId);
		// The seed agent has role 'coder' (see seedAgentRow in test context)
		expect(memberInfo?.role).toBe('coder');
	});
});

// ===========================================================================
// check_step_status tests
// ===========================================================================

describe('createTaskAgentToolHandlers — check_step_status', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns not_started when spawn has not been called yet', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		const result = await handlers.check_step_status({ step_id: wf.startStepId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.sessionStatus).toBe('not_started');
	});

	test('returns running when sub-session is actively processing', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// Spawn the step agent first
		const spawnResult = await handlers.spawn_step_agent({ step_id: wf.startStepId });
		const { sessionId } = JSON.parse(spawnResult.content[0].text);

		// Factory returns isProcessing: true by default
		const result = await handlers.check_step_status({ step_id: wf.startStepId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.sessionStatus).toBe('running');
		expect(sessionId).toBeString();
	});

	test('returns completed when task status is completed in DB', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask, stepTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// Mark the step task as completed directly (simulating completion callback)
		ctx.taskRepo.updateTask(stepTask.id, { status: 'completed', completedAt: Date.now() });

		const result = await handlers.check_step_status({ step_id: wf.startStepId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.taskStatus).toBe('completed');
		expect(parsed.sessionStatus).toBe('completed');
	});

	test('returns unknown when session state is not available', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask, stepTask } = await startRun(ctx, wf);

		const factory = makeMockSessionFactory({
			getProcessingState: () => null, // State not available
		});

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// Manually set taskAgentSessionId without spawning (simulate orphaned session)
		ctx.taskRepo.updateTask(stepTask.id, { taskAgentSessionId: 'orphaned-session-id' });

		const result = await handlers.check_step_status({ step_id: wf.startStepId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.sessionStatus).toBe('unknown');
	});

	test('uses current step from workflow run when step_id is omitted', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// Call without step_id — should use run.currentStepId
		const result = await handlers.check_step_status({});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.stepId).toBe(wf.startStepId);
	});

	test('returns not_found when step has no task yet', async () => {
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// Check step 2 which has no task (advance_workflow not yet called)
		const step2Id = wf.steps[1].id;
		const result = await handlers.check_step_status({ step_id: step2Id });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.taskStatus).toBe('not_found');
		expect(parsed.sessionStatus).toBe('not_started');
	});

	test('returns error when workflow run not found', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Main task',
			description: '',
			status: 'pending',
		});
		const factory = makeMockSessionFactory();

		// No step_id, so it tries to look up the run
		const handlers = createTaskAgentToolHandlers(
			makeConfig(ctx, mainTask.id, 'run-missing', factory)
		);

		const result = await handlers.check_step_status({});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('run-missing');
	});

	test('session state shows completed status when session isComplete=true', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// Spawn and then trigger complete (but don't update DB task status yet)
		const spawnResult = await handlers.spawn_step_agent({ step_id: wf.startStepId });
		const { sessionId } = JSON.parse(spawnResult.content[0].text);

		// Simulate session completing without the completion callback updating DB
		// Override getProcessingState to report the session as complete
		(
			factory as unknown as { getProcessingState: (id: string) => SubSessionState }
		).getProcessingState = (_id: string) => ({ isProcessing: false, isComplete: true });

		const result = await handlers.check_step_status({ step_id: wf.startStepId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.sessionStatus).toBe('completed');
		expect(sessionId).toBeString();
	});
});

// ===========================================================================
// advance_workflow tests
// ===========================================================================

describe('createTaskAgentToolHandlers — advance_workflow', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns error when executor not found for run', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Main task',
			description: '',
			status: 'in_progress',
		});
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(
			makeConfig(ctx, mainTask.id, 'run-missing', factory)
		);

		const result = await handlers.advance_workflow({});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('run-missing');
	});

	test('returns error when current step tasks are not completed', async () => {
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		await ctx.runtime.executeTick(); // Rehydrate executor
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// Step task is still pending — advance should fail
		const result = await handlers.advance_workflow({});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('not completed yet');
		expect(parsed.taskStatus).toBe('pending');
	});

	test('successfully advances to next step when current step is completed', async () => {
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask, stepTask } = await startRun(ctx, wf);
		await ctx.runtime.executeTick(); // Rehydrate executor
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// Mark the first step task as completed
		ctx.taskRepo.updateTask(stepTask.id, { status: 'completed', completedAt: Date.now() });

		const result = await handlers.advance_workflow({});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.terminal).toBe(false);
		expect(parsed.nextStep).toBeDefined();
		expect(parsed.nextStep.name).toBe('Step Two');
		expect(parsed.newTasks).toHaveLength(1);
	});

	test('returns terminal status when reaching a terminal step', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask, stepTask } = await startRun(ctx, wf);
		await ctx.runtime.executeTick();
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// Mark the single step task as completed
		ctx.taskRepo.updateTask(stepTask.id, { status: 'completed', completedAt: Date.now() });

		const result = await handlers.advance_workflow({});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.terminal).toBe(true);
		expect(parsed.message).toContain('report_result');
	});

	test('returns gateBlocked status for human gate condition', async () => {
		const wf = buildHumanGateWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask, stepTask } = await startRun(ctx, wf);
		await ctx.runtime.executeTick();
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// Mark the first step task as completed
		ctx.taskRepo.updateTask(stepTask.id, { status: 'completed', completedAt: Date.now() });

		const result = await handlers.advance_workflow({});
		const parsed = JSON.parse(result.content[0].text);

		// Human gate → gateBlocked, not an error
		expect(parsed.success).toBe(true);
		expect(parsed.gateBlocked).toBe(true);
		expect(parsed.instruction).toContain('request_human_input');
	});

	test('resets main task from needs_attention to in_progress when advancing', async () => {
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask, stepTask } = await startRun(ctx, wf);
		await ctx.runtime.executeTick();
		const factory = makeMockSessionFactory();

		// Set main task to in_progress first (required for needs_attention transition)
		await ctx.taskManager.setTaskStatus(mainTask.id, 'in_progress');
		// Set main task to needs_attention (simulating request_human_input was called)
		await ctx.taskManager.setTaskStatus(mainTask.id, 'needs_attention');

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// Mark the step task as completed
		ctx.taskRepo.updateTask(stepTask.id, { status: 'completed', completedAt: Date.now() });

		const result = await handlers.advance_workflow({});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		// Main task should be back to in_progress
		const mainTaskAfter = ctx.taskRepo.getTask(mainTask.id);
		expect(mainTaskAfter?.status).toBe('in_progress');
	});

	test('returns error when workflow run is already complete', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask, stepTask } = await startRun(ctx, wf);
		await ctx.runtime.executeTick();
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// Mark step completed and advance once to terminal
		ctx.taskRepo.updateTask(stepTask.id, { status: 'completed', completedAt: Date.now() });
		await handlers.advance_workflow({}); // First advance → terminal

		// Try to advance again — should fail
		const result = await handlers.advance_workflow({});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('complete');
	});

	test('forwards step_result to executor.advance() and follows matching task_result transition', async () => {
		// Build a workflow where the transition from step1→step2 requires task_result='passed'
		const wf = buildTaskResultWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'passed');
		const { run, mainTask, stepTask } = await startRun(ctx, wf);
		await ctx.runtime.executeTick(); // Rehydrate executor
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// Mark the first step task as completed
		ctx.taskRepo.updateTask(stepTask.id, { status: 'completed', completedAt: Date.now() });

		// Advance with step_result='passed' — should match the 'passed' condition and go to step2
		const result = await handlers.advance_workflow({ step_result: 'passed' });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.terminal).toBe(false);
		expect(parsed.nextStep.name).toBe('Next Step');
	});

	test('forwards step_result fallback when no DB result exists', async () => {
		// Same workflow as above — but we DON'T set the task result in the DB
		// The step_result passed to advance_workflow should be used as fallback
		const wf = buildTaskResultWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'verified');
		const { run, mainTask, stepTask } = await startRun(ctx, wf);
		await ctx.runtime.executeTick(); // Rehydrate executor
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// Mark the step as completed but DON'T set result in DB
		ctx.taskRepo.updateTask(stepTask.id, { status: 'completed', completedAt: Date.now() });

		// Advance with step_result='verified' — should match the 'verified' condition and go to step2
		const result = await handlers.advance_workflow({ step_result: 'verified' });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.terminal).toBe(false);
		expect(parsed.nextStep.name).toBe('Next Step');
	});
});

// ===========================================================================
// report_result tests
// ===========================================================================

describe('createTaskAgentToolHandlers — report_result', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('marks task as completed with summary', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Main task',
			description: '',
			status: 'in_progress',
		});
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, 'run-id', factory));

		const result = await handlers.report_result({
			status: 'completed',
			summary: 'All steps completed successfully.',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('completed');
		expect(parsed.summary).toBe('All steps completed successfully.');

		const updated = ctx.taskRepo.getTask(mainTask.id);
		expect(updated?.status).toBe('completed');
	});

	test('marks task as needs_attention with error', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Main task',
			description: '',
			status: 'in_progress',
		});
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, 'run-id', factory));

		const result = await handlers.report_result({
			status: 'needs_attention',
			summary: 'An error occurred.',
			error: 'Tests failed in CI.',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('needs_attention');

		const updated = ctx.taskRepo.getTask(mainTask.id);
		expect(updated?.status).toBe('needs_attention');
	});

	test('marks task as cancelled', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Main task',
			description: '',
			status: 'in_progress',
		});
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, 'run-id', factory));

		const result = await handlers.report_result({
			status: 'cancelled',
			summary: 'User cancelled the task.',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('cancelled');
	});

	test('returns error when task not found', async () => {
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(
			makeConfig(ctx, 'task-does-not-exist', 'run-id', factory)
		);

		const result = await handlers.report_result({
			status: 'completed',
			summary: 'Done.',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('task-does-not-exist');
	});

	test('returns error when status transition is invalid', async () => {
		// completed → completed is not a valid transition
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Already done',
			description: '',
			status: 'completed',
		});
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, 'run-id', factory));

		const result = await handlers.report_result({
			status: 'completed',
			summary: 'Done again?',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('transition');
	});
});

// ===========================================================================
// report_result — DaemonHub event emission tests
// ===========================================================================

describe('createTaskAgentToolHandlers — report_result DaemonHub events', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('emits space.task.completed event when status is completed', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Test Task',
			description: '',
			status: 'in_progress',
		});
		const factory = makeMockSessionFactory();
		const { hub, emittedEvents } = makeMockDaemonHub();

		const handlers = createTaskAgentToolHandlers({
			...makeConfig(ctx, mainTask.id, 'run-123', factory),
			daemonHub: hub,
		});

		await handlers.report_result({ status: 'completed', summary: 'All done.' });

		// The mock emit is synchronous (records events before returning Promise.resolve()),
		// so no async flush is needed — assertions can run immediately.
		expect(emittedEvents).toHaveLength(1);
		expect(emittedEvents[0].name).toBe('space.task.completed');
		expect(emittedEvents[0].payload.taskId).toBe(mainTask.id);
		expect(emittedEvents[0].payload.spaceId).toBe(ctx.spaceId);
		expect(emittedEvents[0].payload.status).toBe('completed');
		expect(emittedEvents[0].payload.summary).toBe('All done.');
		expect(emittedEvents[0].payload.workflowRunId).toBe('run-123');
		expect(emittedEvents[0].payload.taskTitle).toBe('Test Task');
	});

	test('emits space.task.failed event when status is needs_attention', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Failing Task',
			description: '',
			status: 'in_progress',
		});
		const factory = makeMockSessionFactory();
		const { hub, emittedEvents } = makeMockDaemonHub();

		const handlers = createTaskAgentToolHandlers({
			...makeConfig(ctx, mainTask.id, 'run-456', factory),
			daemonHub: hub,
		});

		await handlers.report_result({
			status: 'needs_attention',
			summary: 'Tests failed.',
			error: 'CI pipeline error',
		});

		expect(emittedEvents).toHaveLength(1);
		expect(emittedEvents[0].name).toBe('space.task.failed');
		expect(emittedEvents[0].payload.taskId).toBe(mainTask.id);
		expect(emittedEvents[0].payload.spaceId).toBe(ctx.spaceId);
		expect(emittedEvents[0].payload.status).toBe('needs_attention');
		expect(emittedEvents[0].payload.summary).toBe('Tests failed.');
		expect(emittedEvents[0].payload.taskTitle).toBe('Failing Task');
	});

	test('emits space.task.failed event when status is cancelled', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Cancelled Task',
			description: '',
			status: 'in_progress',
		});
		const factory = makeMockSessionFactory();
		const { hub, emittedEvents } = makeMockDaemonHub();

		const handlers = createTaskAgentToolHandlers({
			...makeConfig(ctx, mainTask.id, 'run-789', factory),
			daemonHub: hub,
		});

		await handlers.report_result({ status: 'cancelled', summary: 'User cancelled.' });

		expect(emittedEvents).toHaveLength(1);
		expect(emittedEvents[0].name).toBe('space.task.failed');
		expect(emittedEvents[0].payload.status).toBe('cancelled');
	});

	test('does not emit events when daemonHub is not provided', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Task Without Hub',
			description: '',
			status: 'in_progress',
		});
		const factory = makeMockSessionFactory();

		// No daemonHub in config
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, 'run-id', factory));

		const result = await handlers.report_result({ status: 'completed', summary: 'Done.' });
		const parsed = JSON.parse(result.content[0].text);

		// Should still succeed — hub is optional
		expect(parsed.success).toBe(true);
	});

	test('event payload includes sessionId: global', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Hub Test Task',
			description: '',
			status: 'in_progress',
		});
		const factory = makeMockSessionFactory();
		const { hub, emittedEvents } = makeMockDaemonHub();

		const handlers = createTaskAgentToolHandlers({
			...makeConfig(ctx, mainTask.id, 'run-id', factory),
			daemonHub: hub,
		});

		await handlers.report_result({ status: 'completed', summary: 'Done.' });

		expect(emittedEvents[0].payload.sessionId).toBe('global');
	});

	test('does not emit event when task is not found', async () => {
		const factory = makeMockSessionFactory();
		const { hub, emittedEvents } = makeMockDaemonHub();

		const handlers = createTaskAgentToolHandlers({
			...makeConfig(ctx, 'nonexistent-task', 'run-id', factory),
			daemonHub: hub,
		});

		const result = await handlers.report_result({ status: 'completed', summary: 'Done.' });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(emittedEvents).toHaveLength(0);
	});
});

// ===========================================================================
// request_human_input tests
// ===========================================================================

describe('createTaskAgentToolHandlers — request_human_input', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('marks task as needs_attention with question in currentStep', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Main task',
			description: '',
			status: 'in_progress',
		});
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, 'run-id', factory));

		const result = await handlers.request_human_input({
			question: 'Should we proceed with the current approach?',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.question).toBe('Should we proceed with the current approach?');

		const updated = ctx.taskRepo.getTask(mainTask.id);
		expect(updated?.status).toBe('needs_attention');
		expect(updated?.currentStep).toBe('Should we proceed with the current approach?');
	});

	test('includes context in the error field when provided', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Main task',
			description: '',
			status: 'in_progress',
		});
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, 'run-id', factory));

		await handlers.request_human_input({
			question: 'Approve the PR?',
			context: 'The PR includes breaking changes to the auth module.',
		});

		const updated = ctx.taskRepo.getTask(mainTask.id);
		// error field should contain both question and context
		expect(updated?.error).toContain('Approve the PR?');
		expect(updated?.error).toContain('breaking changes');
	});

	test('returns message instructing Task Agent to wait', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Main task',
			description: '',
			status: 'in_progress',
		});
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, 'run-id', factory));

		const result = await handlers.request_human_input({
			question: 'Which approach should we take?',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.message).toContain('Wait');
		expect(parsed.message).toContain('advance_workflow');
	});

	test('returns error when task not found', async () => {
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(
			makeConfig(ctx, 'task-missing', 'run-id', factory)
		);

		const result = await handlers.request_human_input({
			question: 'What to do?',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('task-missing');
	});

	test('returns error when task is not in valid state for human input request', async () => {
		// pending → needs_attention is not valid
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Main task',
			description: '',
			status: 'pending',
		});
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, 'run-id', factory));

		const result = await handlers.request_human_input({
			question: 'Approve?',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('pending');
	});

	test('works from review status too', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Main task',
			description: '',
			status: 'in_progress',
		});
		// Transition to review first
		await ctx.taskManager.setTaskStatus(mainTask.id, 'review');
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, 'run-id', factory));

		const result = await handlers.request_human_input({
			question: 'Review passed?',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		const updated = ctx.taskRepo.getTask(mainTask.id);
		expect(updated?.status).toBe('needs_attention');
	});
});

// ===========================================================================
// Integration: spawn → check → advance → report lifecycle
// ===========================================================================

describe('createTaskAgentToolHandlers — end-to-end lifecycle', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('full single-step workflow lifecycle: spawn → check(running) → check(done) → advance(terminal) → report', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask, stepTask } = await startRun(ctx, wf);
		await ctx.runtime.executeTick();

		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(
			makeConfig(ctx, mainTask.id, run.id, factory, {
				onSubSessionComplete: async (stepId) => {
					// TaskAgentManager marks the step task completed
					const tasks = ctx.taskRepo
						.listByWorkflowRun(run.id)
						.filter((t) => t.workflowStepId === stepId);
					if (tasks.length > 0) {
						ctx.taskRepo.updateTask(tasks[0].id, {
							status: 'completed',
							completedAt: Date.now(),
						});
					}
				},
			})
		);

		// 1. Spawn step agent
		const spawnResult = await handlers.spawn_step_agent({ step_id: wf.startStepId });
		const { sessionId } = JSON.parse(spawnResult.content[0].text);
		expect(sessionId).toBeString();

		// 2. Check status — running
		const checkRunning = await handlers.check_step_status({ step_id: wf.startStepId });
		expect(JSON.parse(checkRunning.content[0].text).sessionStatus).toBe('running');

		// 3. Trigger sub-session completion (fires onSubSessionComplete callback)
		await (factory as ReturnType<typeof makeMockSessionFactory>)._triggerComplete(sessionId);

		// 4. Check status — completed
		const checkDone = await handlers.check_step_status({ step_id: wf.startStepId });
		expect(JSON.parse(checkDone.content[0].text).taskStatus).toBe('completed');

		// 5. Advance workflow — terminal step
		const advanceResult = await handlers.advance_workflow({});
		const advanceParsed = JSON.parse(advanceResult.content[0].text);
		expect(advanceParsed.success).toBe(true);
		expect(advanceParsed.terminal).toBe(true);

		// 6. Report result
		const reportResult = await handlers.report_result({
			status: 'completed',
			summary: 'Workflow completed successfully.',
		});
		const reportParsed = JSON.parse(reportResult.content[0].text);
		expect(reportParsed.success).toBe(true);
		expect(reportParsed.status).toBe('completed');

		const finalTask = ctx.taskRepo.getTask(mainTask.id);
		expect(finalTask?.status).toBe('completed');
	});

	test('two-step workflow: spawn → advance → spawn step 2 → advance(terminal) → report', async () => {
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask, stepTask } = await startRun(ctx, wf);
		await ctx.runtime.executeTick();

		const completedStepTasks: Set<string> = new Set();
		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(
			makeConfig(ctx, mainTask.id, run.id, factory, {
				onSubSessionComplete: async (stepId) => {
					const tasks = ctx.taskRepo
						.listByWorkflowRun(run.id)
						.filter((t) => t.workflowStepId === stepId);
					if (tasks.length > 0) {
						ctx.taskRepo.updateTask(tasks[0].id, {
							status: 'completed',
							completedAt: Date.now(),
						});
						completedStepTasks.add(tasks[0].id);
					}
				},
			})
		);

		// Step 1: Spawn, complete, advance
		const spawn1 = await handlers.spawn_step_agent({ step_id: wf.steps[0].id });
		const { sessionId: sid1 } = JSON.parse(spawn1.content[0].text);
		await (factory as ReturnType<typeof makeMockSessionFactory>)._triggerComplete(sid1);

		const advance1 = await handlers.advance_workflow({});
		const adv1Parsed = JSON.parse(advance1.content[0].text);
		expect(adv1Parsed.success).toBe(true);
		expect(adv1Parsed.terminal).toBe(false);

		const step2Id = wf.steps[1].id;

		// Step 2: Spawn, complete, advance to terminal
		const spawn2 = await handlers.spawn_step_agent({ step_id: step2Id });
		const { sessionId: sid2 } = JSON.parse(spawn2.content[0].text);
		await (factory as ReturnType<typeof makeMockSessionFactory>)._triggerComplete(sid2);

		const advance2 = await handlers.advance_workflow({});
		const adv2Parsed = JSON.parse(advance2.content[0].text);
		expect(adv2Parsed.success).toBe(true);
		expect(adv2Parsed.terminal).toBe(true);

		// Report final result
		const report = await handlers.report_result({
			status: 'completed',
			summary: 'Both steps done.',
		});
		expect(JSON.parse(report.content[0].text).success).toBe(true);
	});
});

// ===========================================================================
// createTaskAgentMcpServer — MCP server factory
// ===========================================================================

describe('createTaskAgentMcpServer', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	// ---------------------------------------------------------------------------
	// Helper: build a minimal config + run for MCP server tests
	// ---------------------------------------------------------------------------

	async function makeServerCtx() {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();
		const config = makeConfig(ctx, mainTask.id, run.id, factory);
		const server = createTaskAgentMcpServer(config);
		return { wf, run, mainTask, factory, config, server };
	}

	// ---------------------------------------------------------------------------
	// Tool registration
	// ---------------------------------------------------------------------------

	test('returns an object with type "sdk" and name "task-agent"', async () => {
		const { server } = await makeServerCtx();
		expect(server.type).toBe('sdk');
		expect(server.name).toBe('task-agent');
	});

	test('registers all 7 expected tools', async () => {
		const { server } = await makeServerCtx();
		const registered = Object.keys(server.instance._registeredTools).sort();
		expect(registered).toEqual([
			'advance_workflow',
			'check_step_status',
			'list_group_members',
			'relay_message',
			'report_result',
			'request_human_input',
			'spawn_step_agent',
		]);
	});

	test('spawn_step_agent has correct description', async () => {
		const { server } = await makeServerCtx();
		const entry = server.instance._registeredTools['spawn_step_agent'];
		expect(entry).toBeDefined();
		expect(entry.description).toContain("Start a sub-session for a workflow step's assigned agent");
	});

	test('check_step_status has correct description', async () => {
		const { server } = await makeServerCtx();
		const entry = server.instance._registeredTools['check_step_status'];
		expect(entry).toBeDefined();
		expect(entry.description).toContain('Poll the status of a running step agent sub-session');
	});

	test('advance_workflow has correct description', async () => {
		const { server } = await makeServerCtx();
		const entry = server.instance._registeredTools['advance_workflow'];
		expect(entry).toBeDefined();
		expect(entry.description).toContain('Advance the workflow to the next step');
	});

	test('report_result has correct description', async () => {
		const { server } = await makeServerCtx();
		const entry = server.instance._registeredTools['report_result'];
		expect(entry).toBeDefined();
		expect(entry.description).toContain('Mark the task as completed, failed, or cancelled');
	});

	test('request_human_input has correct description', async () => {
		const { server } = await makeServerCtx();
		const entry = server.instance._registeredTools['request_human_input'];
		expect(entry).toBeDefined();
		expect(entry.description).toContain(
			'Pause workflow execution and surface a question to the human user'
		);
	});

	test('each registered tool has an inputSchema', async () => {
		const { server } = await makeServerCtx();
		const toolNames = [
			'spawn_step_agent',
			'check_step_status',
			'advance_workflow',
			'report_result',
			'request_human_input',
		];
		for (const name of toolNames) {
			const entry = server.instance._registeredTools[name];
			expect(entry).toBeDefined();
			expect(entry.inputSchema).toBeDefined();
		}
	});

	// ---------------------------------------------------------------------------
	// Handler delegation — invoke via the MCP server's registered handler
	// ---------------------------------------------------------------------------

	test('check_step_status registered handler returns not_found for an unknown step', async () => {
		const { server } = await makeServerCtx();
		// Invoke through the server's registered handler to verify the wiring
		const handler = server.instance._registeredTools['check_step_status'].handler;
		const result = await handler({ step_id: 'step-that-does-not-exist' }, {});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.taskStatus).toBe('not_found');
	});

	test('report_result registered handler returns error for unknown task', async () => {
		// Build a server whose config references a non-existent taskId
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();
		const config = makeConfig(ctx, 'no-such-task', run.id, factory);
		const server = createTaskAgentMcpServer(config);

		const handler = server.instance._registeredTools['report_result'].handler;
		const result = await handler({ status: 'completed', summary: 'done' }, {});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('no-such-task');
	});

	test('request_human_input registered handler returns error for unknown task', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();
		const config = makeConfig(ctx, 'no-such-task', run.id, factory);
		const server = createTaskAgentMcpServer(config);

		const handler = server.instance._registeredTools['request_human_input'].handler;
		const result = await handler({ question: 'Are you sure?' }, {});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('no-such-task');
	});

	test('creating multiple servers from same config yields independent instances', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();
		const config = makeConfig(ctx, mainTask.id, run.id, factory);

		const server1 = createTaskAgentMcpServer(config);
		const server2 = createTaskAgentMcpServer(config);

		// Each call returns a distinct server instance
		expect(server1.instance).not.toBe(server2.instance);
		// Both register all 7 tools
		expect(Object.keys(server1.instance._registeredTools)).toHaveLength(7);
		expect(Object.keys(server2.instance._registeredTools)).toHaveLength(7);
	});
});

// ===========================================================================
// list_group_members tests
// ===========================================================================

describe('createTaskAgentToolHandlers — list_group_members', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns error when no group ID is available', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();
		// No groupId in options — getGroupId returns undefined
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		const result = await handlers.list_group_members({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('No session group found');
	});

	test('returns error when group does not exist in DB', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(
			makeConfig(ctx, mainTask.id, run.id, factory, { groupId: 'nonexistent-group-id' })
		);

		const result = await handlers.list_group_members({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('nonexistent-group-id');
	});

	test('returns members for a real group', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		// Create a group with two members
		const group = ctx.sessionGroupRepo.createGroup({
			spaceId: ctx.spaceId,
			name: `task:${mainTask.id}`,
			taskId: mainTask.id,
		});
		ctx.sessionGroupRepo.addMember(group.id, 'task-agent-session', {
			role: 'task-agent',
			status: 'active',
		});
		ctx.sessionGroupRepo.addMember(group.id, 'coder-session-123', {
			role: 'coder',
			agentId: ctx.agentId,
			status: 'active',
		});

		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(
			makeConfig(ctx, mainTask.id, run.id, factory, { groupId: group.id })
		);

		const result = await handlers.list_group_members({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.groupId).toBe(group.id);
		expect(parsed.members).toHaveLength(2);

		const taskAgentMember = parsed.members.find((m: { role: string }) => m.role === 'task-agent');
		expect(taskAgentMember).toBeDefined();
		expect(taskAgentMember.sessionId).toBe('task-agent-session');
		expect(taskAgentMember.status).toBe('active');
		expect(Array.isArray(taskAgentMember.permittedTargets)).toBe(true);

		const coderMember = parsed.members.find((m: { role: string }) => m.role === 'coder');
		expect(coderMember).toBeDefined();
		expect(coderMember.sessionId).toBe('coder-session-123');
		expect(coderMember.agentId).toBe(ctx.agentId);
	});

	test('channelTopologyDeclared is false when no channels in run config', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		const group = ctx.sessionGroupRepo.createGroup({
			spaceId: ctx.spaceId,
			name: `task:${mainTask.id}`,
			taskId: mainTask.id,
		});
		ctx.sessionGroupRepo.addMember(group.id, 'session-a', {
			role: 'coder',
			status: 'active',
		});

		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(
			makeConfig(ctx, mainTask.id, run.id, factory, { groupId: group.id })
		);

		const result = await handlers.list_group_members({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.channelTopologyDeclared).toBe(false);
		// permittedTargets should be empty when no channels declared
		expect(parsed.members[0].permittedTargets).toEqual([]);
	});

	test('returns permitted targets based on resolved channels in run config', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		// Store resolved channels in the run config
		ctx.workflowRunRepo.updateRun(run.id, {
			config: {
				_resolvedChannels: [
					{
						fromRole: 'coder',
						toRole: 'reviewer',
						fromAgentId: ctx.agentId,
						toAgentId: 'agent-reviewer-1',
						direction: 'one-way',
						isHubSpoke: false,
					},
				],
			},
		});

		const group = ctx.sessionGroupRepo.createGroup({
			spaceId: ctx.spaceId,
			name: `task:${mainTask.id}`,
			taskId: mainTask.id,
		});
		ctx.sessionGroupRepo.addMember(group.id, 'coder-session', {
			role: 'coder',
			agentId: ctx.agentId,
			status: 'active',
		});
		ctx.sessionGroupRepo.addMember(group.id, 'reviewer-session', {
			role: 'reviewer',
			agentId: 'agent-reviewer-1',
			status: 'active',
		});

		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(
			makeConfig(ctx, mainTask.id, run.id, factory, { groupId: group.id })
		);

		const result = await handlers.list_group_members({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.channelTopologyDeclared).toBe(true);

		const coderMember = parsed.members.find((m: { role: string }) => m.role === 'coder');
		expect(coderMember.permittedTargets).toEqual(['reviewer']);

		const reviewerMember = parsed.members.find((m: { role: string }) => m.role === 'reviewer');
		expect(reviewerMember.permittedTargets).toEqual([]); // reviewer cannot send to coder (one-way)
	});
});

// ===========================================================================
// relay_message tests
// ===========================================================================

describe('createTaskAgentToolHandlers — relay_message', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns error when no group ID is available', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		const result = await handlers.relay_message({
			target_session_id: 'any-session',
			message: 'hello',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('No session group found');
	});

	test('returns error when target session is not in group', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		const group = ctx.sessionGroupRepo.createGroup({
			spaceId: ctx.spaceId,
			name: `task:${mainTask.id}`,
			taskId: mainTask.id,
		});
		ctx.sessionGroupRepo.addMember(group.id, 'known-session', {
			role: 'coder',
			status: 'active',
		});

		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(
			makeConfig(ctx, mainTask.id, run.id, factory, { groupId: group.id })
		);

		const result = await handlers.relay_message({
			target_session_id: 'unknown-session-from-another-group',
			message: 'hello',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('not a member of group');
	});

	test('successfully relays a message to a group member', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		const group = ctx.sessionGroupRepo.createGroup({
			spaceId: ctx.spaceId,
			name: `task:${mainTask.id}`,
			taskId: mainTask.id,
		});
		ctx.sessionGroupRepo.addMember(group.id, 'coder-session-relay', {
			role: 'coder',
			status: 'active',
		});

		const injectedMessages: Array<{ sessionId: string; message: string }> = [];
		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(
			makeConfig(ctx, mainTask.id, run.id, factory, {
				groupId: group.id,
				messageInjector: async (sessionId, message) => {
					injectedMessages.push({ sessionId, message });
				},
			})
		);

		const result = await handlers.relay_message({
			target_session_id: 'coder-session-relay',
			message: 'Please fix the tests.',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.targetSessionId).toBe('coder-session-relay');
		expect(parsed.targetRole).toBe('coder');

		// Verify the injector was called with correct args
		expect(injectedMessages).toHaveLength(1);
		expect(injectedMessages[0].sessionId).toBe('coder-session-relay');
		expect(injectedMessages[0].message).toBe('Please fix the tests.');
	});

	test('returns error when message injection fails', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		const group = ctx.sessionGroupRepo.createGroup({
			spaceId: ctx.spaceId,
			name: `task:${mainTask.id}`,
			taskId: mainTask.id,
		});
		ctx.sessionGroupRepo.addMember(group.id, 'failing-session', {
			role: 'coder',
			status: 'active',
		});

		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(
			makeConfig(ctx, mainTask.id, run.id, factory, {
				groupId: group.id,
				messageInjector: async () => {
					throw new Error('Session is not available');
				},
			})
		);

		const result = await handlers.relay_message({
			target_session_id: 'failing-session',
			message: 'hello',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('Session is not available');
	});

	test('relay is not constrained by channel topology', async () => {
		// Even with one-way channels only coder→reviewer, Task Agent can relay reviewer→coder
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		// Channels: only coder → reviewer (one-way)
		ctx.workflowRunRepo.updateRun(run.id, {
			config: {
				_resolvedChannels: [
					{
						fromRole: 'coder',
						toRole: 'reviewer',
						fromAgentId: ctx.agentId,
						toAgentId: 'agent-reviewer',
						direction: 'one-way',
						isHubSpoke: false,
					},
				],
			},
		});

		const group = ctx.sessionGroupRepo.createGroup({
			spaceId: ctx.spaceId,
			name: `task:${mainTask.id}`,
			taskId: mainTask.id,
		});
		ctx.sessionGroupRepo.addMember(group.id, 'coder-session', {
			role: 'coder',
			status: 'active',
		});
		ctx.sessionGroupRepo.addMember(group.id, 'reviewer-session', {
			role: 'reviewer',
			status: 'active',
		});

		const injectedMessages: string[] = [];
		const factory = makeMockSessionFactory();
		// Task Agent relays from reviewer back to coder (not in declared topology)
		const handlers = createTaskAgentToolHandlers(
			makeConfig(ctx, mainTask.id, run.id, factory, {
				groupId: group.id,
				messageInjector: async (_sid, msg) => {
					injectedMessages.push(msg);
				},
			})
		);

		// This should succeed — Task Agent is unrestricted
		const result = await handlers.relay_message({
			target_session_id: 'coder-session',
			message: 'Feedback from reviewer: please update the API docs.',
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(injectedMessages[0]).toBe('Feedback from reviewer: please update the API docs.');
	});
});
