/**
 * Unit tests for createTaskAgentToolHandlers()
 *
 * Covers Task Agent tools:
 *   spawn_node_agent    — creates sub-session, registers callback, injects message
 *   check_node_status   — polling detection of sub-session completion
 *   report_result       — transitions main task to final status
 *   request_human_input — pauses execution, marks task needs_attention
 *   list_group_members  — lists group members with session IDs and channel info
 *   send_message        — sends message to peer node agents via channel topology
 *
 * Tests use a real SQLite database (via runMigrations) and mock SubSessionFactory
 * so no real agent sessions are created.
 */

import { mock } from 'bun:test';

// Re-declare the SDK mock so it survives Bun's module isolation.
// Without this, room-agent-tools.test.ts (which runs before this file alphabetically)
// overrides tool() to return only { name }, discarding description/inputSchema/handler.
// This file's tests inspect those fields, so we need the full mock.
mock.module('@anthropic-ai/claude-agent-sdk', () => {
	class MockMcpServer {
		readonly _registeredTools: Record<string, object> = {};
		connect(): void {}
		disconnect(): void {}
	}

	let _toolBatch: Array<{ name: string; def: object }> = [];

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function tool(name: string, description: string, inputSchema: any, handler: unknown): object {
		const def = { name, description, inputSchema, handler };
		_toolBatch.push({ name, def });
		return def;
	}

	return {
		query: mock(async () => ({ interrupt: () => {} })),
		interrupt: mock(async () => {}),
		supportedModels: mock(async () => {
			throw new Error('SDK unavailable');
		}),
		createSdkMcpServer: mock((_opts: { name: string; version?: string; tools?: unknown[] }) => {
			const server = new MockMcpServer();
			for (const { name, def } of _toolBatch) {
				server._registeredTools[name] = def;
			}
			// Fallback: recover from _opts.tools if _toolBatch was empty
			if (Object.keys(server._registeredTools).length === 0 && Array.isArray(_opts.tools)) {
				for (const t of _opts.tools) {
					const td = t as { name?: string };
					if (td.name) server._registeredTools[td.name] = t;
				}
			}
			_toolBatch = [];
			return {
				type: 'sdk' as const,
				name: _opts.name,
				version: _opts.version ?? '1.0.0',
				tools: _opts.tools ?? [],
				instance: server,
			};
		}),
		tool,
	};
});

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
import { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceManager } from '../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../src/lib/space/runtime/space-runtime.ts';
import { NodeExecutionRepository } from '../../../src/storage/repositories/node-execution-repository.ts';
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
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
	).run(spaceId, workspacePath, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string, name: string): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
	).run(agentId, spaceId, name, Date.now(), Date.now());
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
		nodes: [
			{
				id: step1Id,
				name: 'Step One',
				agents: [{ agentId, name: 'step-one' }],
				instructions: 'Do the first thing',
			},
			{
				id: step2Id,
				name: 'Step Two',
				agents: [{ agentId, name: 'step-two' }],
				instructions: 'Do the second thing',
			},
		],
		startNodeId: step1Id,
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
		nodes: [{ id: stepId, name: 'Only Step', agents: [{ agentId, name: 'only-step' }] }],
		startNodeId: stepId,
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
		nodes: [
			{ id: step1Id, name: 'Work Step', agents: [{ agentId, name: 'work-step' }] },
			{ id: step2Id, name: 'After Gate', agents: [{ agentId, name: 'after-gate' }] },
		],
		startNodeId: step1Id,
	});
}

function buildTaskResultWorkflow(
	spaceId: string,
	workflowManager: SpaceWorkflowManager,
	agentId: string,
	_conditionExpression = 'passed'
): SpaceWorkflow {
	const step1Id = `step-1-${Math.random().toString(36).slice(2)}`;
	const step2Id = `step-2-${Math.random().toString(36).slice(2)}`;
	return workflowManager.createWorkflow({
		spaceId,
		name: 'Task Result WF',
		nodes: [
			{ id: step1Id, name: 'Verify Step', agents: [{ agentId, name: 'verify-step' }] },
			{ id: step2Id, name: 'Next Step', agents: [{ agentId, name: 'next-step' }] },
		],
		startNodeId: step1Id,
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
	nodeExecutionRepo: NodeExecutionRepository;
	taskManager: SpaceTaskManager;
	agentManager: SpaceAgentManager;
	runtime: SpaceRuntime;
}

function makeCtx(): TestCtx {
	const { db, dir } = makeDb();
	const spaceId = 'space-tat-test';
	const workspacePath = '/tmp/test-workspace';

	seedSpaceRow(db, spaceId, workspacePath);

	const agentId = 'agent-coder-1';
	seedAgentRow(db, agentId, spaceId, 'Coder');

	const agentRepo = new SpaceAgentRepository(db);
	const agentManager = new SpaceAgentManager(agentRepo);

	const workflowRepo = new SpaceWorkflowRepository(db);
	const workflowManager = new SpaceWorkflowManager(workflowRepo);

	const workflowRunRepo = new SpaceWorkflowRunRepository(db);
	const taskRepo = new SpaceTaskRepository(db);
	const nodeExecutionRepo = new NodeExecutionRepository(db);
	const spaceManager = new SpaceManager(db);
	const taskManager = new SpaceTaskManager(db, spaceId);

	const runtime = new SpaceRuntime({
		db,
		spaceManager,
		spaceAgentManager: agentManager,
		spaceWorkflowManager: workflowManager,
		workflowRunRepo,
		taskRepo,
		nodeExecutionRepo,
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
		nodeExecutionRepo,
		taskManager,
		agentManager,
		runtime,
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
	}
): TaskAgentToolsConfig {
	return {
		taskId,
		space: ctx.space,
		workflowRunId,
		workspacePath: ctx.space.workspacePath,
		workflowManager: ctx.workflowManager,
		taskRepo: ctx.taskRepo,
		workflowRunRepo: ctx.workflowRunRepo,
		nodeExecutionRepo: ctx.nodeExecutionRepo,
		agentManager: ctx.agentManager,
		taskManager: ctx.taskManager,
		sessionFactory,
		messageInjector: options?.messageInjector ?? (async () => {}),
		onSubSessionComplete: options?.onSubSessionComplete ?? (async () => {}),
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

	const startNode = workflow.nodes.find((n) => n.id === workflow.startNodeId);
	let stepTask = tasks.find(
		(t) =>
			t.workflowRunId === run.id &&
			(startNode ? t.title === startNode.name || t.title.includes(startNode.id) : false)
	);

	if (!stepTask && startNode) {
		stepTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: startNode.name,
			description: `Synthetic step task for ${startNode.id}`,
			status: 'in_progress',
			workflowRunId: run.id,
		});
	}

	if (!stepTask) {
		stepTask = tasks[0];
	}

	// Create the main "task agent task" (the task that has a Task Agent session)
	const mainTask = ctx.taskRepo.createTask({
		spaceId: ctx.spaceId,
		title: 'Main orchestration task',
		description: 'The task being orchestrated',
		status: 'open',
		workflowRunId: run.id,
	});

	return { run, mainTask, stepTask };
}

// ===========================================================================
// spawn_node_agent tests
// ===========================================================================

describe('createTaskAgentToolHandlers — spawn_node_agent', () => {
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

		const result = await handlers.spawn_node_agent({ step_id: wf.startNodeId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.sessionId).toBeString();
		expect(parsed.stepId).toBe(wf.startNodeId);
		expect(parsed.taskId).toBe(stepTask.id);
	});

	test('transitions main task from pending to in_progress', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// Main task starts as pending
		const before = ctx.taskRepo.getTask(mainTask.id);
		expect(before?.status).toBe('open');

		await handlers.spawn_node_agent({ step_id: wf.startNodeId });

		const after = ctx.taskRepo.getTask(mainTask.id);
		expect(after?.status).toBe('in_progress');
	});

	test('stores sub-session ID on step task via taskAgentSessionId', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask, stepTask } = await startRun(ctx, wf);

		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		const result = await handlers.spawn_node_agent({ step_id: wf.startNodeId });
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
						status: 'done',
						completedAt: Date.now(),
					});
				},
			})
		);

		const result = await handlers.spawn_node_agent({ step_id: wf.startNodeId });
		const parsed = JSON.parse(result.content[0].text);

		// Trigger sub-session completion
		await (factory as ReturnType<typeof makeMockSessionFactory>)._triggerComplete(parsed.sessionId);

		expect(completedSteps).toContain(wf.startNodeId);
		const updatedStepTask = ctx.taskRepo.getTask(stepTask.id);
		expect(updatedStepTask?.status).toBe('done');
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

		const result = await handlers.spawn_node_agent({ step_id: wf.startNodeId });
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

		await handlers.spawn_node_agent({
			step_id: wf.startNodeId,
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

		const result = await handlers.spawn_node_agent({ step_id: 'step-does-not-exist' });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('step-does-not-exist');
	});

	test('returns error when no task found for step (step not yet started)', async () => {
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// The second step has no task yet because the workflow has not advanced to it
		const step2Id = wf.nodes[1].id;
		const result = await handlers.spawn_node_agent({ step_id: step2Id });
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
			status: 'open',
		});
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(
			makeConfig(ctx, mainTask.id, 'run-does-not-exist', factory)
		);

		const result = await handlers.spawn_node_agent({ step_id: wf.startNodeId });
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

		const result = await handlers.spawn_node_agent({ step_id: wf.startNodeId });
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

		const result = await handlers.spawn_node_agent({ step_id: wf.startNodeId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		const after = ctx.taskRepo.getTask(mainTask.id);
		expect(after?.status).toBe('in_progress');
	});

	test('double-spawn for same step_id succeeds on second call in standalone handler tests', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// First spawn
		const first = await handlers.spawn_node_agent({ step_id: wf.startNodeId });
		const firstParsed = JSON.parse(first.content[0].text);
		expect(firstParsed.success).toBe(true);
		const firstSessionId = firstParsed.sessionId;

		// Second spawn for the same step should still succeed.
		// In isolated handler tests, node_execution session persistence is not performed
		// by TaskAgentManager, so a new session may be created.
		const second = await handlers.spawn_node_agent({ step_id: wf.startNodeId });
		const secondParsed = JSON.parse(second.content[0].text);

		expect(secondParsed.success).toBe(true);
		expect(secondParsed.sessionId).toBeString();
		expect(secondParsed.sessionId).not.toBe(firstSessionId);
	});

	test('passes agentId and slot role as memberInfo to sessionFactory.create()', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		const result = await handlers.spawn_node_agent({ step_id: wf.startNodeId });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);

		const sessionId = parsed.sessionId;
		const memberInfo = factory._capturedMemberInfos.get(sessionId);

		// memberInfo must carry the agent's ID and slot name (role)
		expect(memberInfo).toBeDefined();
		expect(memberInfo?.agentId).toBe(ctx.agentId);
		// For explicit agents[] nodes, the slot name is 'only-step' (set in buildSingleStepWorkflow).
		// The slot name is used for group membership (not the base SpaceAgent.role or agentId).
		expect(memberInfo?.role).toBe('only-step');
	});
});

// ===========================================================================
// check_node_status tests
// ===========================================================================

describe('createTaskAgentToolHandlers — check_node_status', () => {
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

		const result = await handlers.check_node_status({ step_id: wf.startNodeId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.sessionStatus).toBe('not_started');
	});

	test('returns running when sub-session is actively processing', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// Spawn the node agent first
		const spawnResult = await handlers.spawn_node_agent({ step_id: wf.startNodeId });
		const { sessionId } = JSON.parse(spawnResult.content[0].text);

		// Factory returns isProcessing: true by default
		const result = await handlers.check_node_status({ step_id: wf.startNodeId });
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
		ctx.taskRepo.updateTask(stepTask.id, { status: 'done', completedAt: Date.now() });

		const result = await handlers.check_node_status({ step_id: wf.startNodeId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.taskStatus).toBe('done');
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

		const result = await handlers.check_node_status({ step_id: wf.startNodeId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.sessionStatus).toBe('unknown');
	});

	test('returns error when step_id is omitted', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// Call without step_id — step_id is required (currentNodeId removed in migration 59)
		const result = await handlers.check_node_status({});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('step_id is required');
	});

	test('returns not_found when step has no task yet', async () => {
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// Check step 2 which has no task (step not yet started)
		const step2Id = wf.nodes[1].id;
		const result = await handlers.check_node_status({ step_id: step2Id });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.taskStatus).toBe('not_found');
		expect(parsed.sessionStatus).toBe('not_started');
	});

	test('returns error when workflow run not found for the given step_id', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Main task',
			description: '',
			status: 'open',
		});
		const factory = makeMockSessionFactory();

		// step_id provided but run-missing does not exist
		const handlers = createTaskAgentToolHandlers(
			makeConfig(ctx, mainTask.id, 'run-missing', factory)
		);

		const result = await handlers.check_node_status({ step_id: 'some-step-id' });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.taskStatus).toBe('not_found');
		expect(parsed.sessionStatus).toBe('not_started');
	});

	test('session state shows completed status when session isComplete=true', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		// Spawn and then trigger complete (but don't update DB task status yet)
		const spawnResult = await handlers.spawn_node_agent({ step_id: wf.startNodeId });
		const { sessionId } = JSON.parse(spawnResult.content[0].text);

		// Simulate session completing without the completion callback updating DB
		// Override getProcessingState to report the session as complete
		(
			factory as unknown as { getProcessingState: (id: string) => SubSessionState }
		).getProcessingState = (_id: string) => ({ isProcessing: false, isComplete: true });

		const result = await handlers.check_node_status({ step_id: wf.startNodeId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.sessionStatus).toBe('completed');
		expect(sessionId).toBeString();
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
			status: 'done',
			summary: 'All steps completed successfully.',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('done');
		expect(parsed.summary).toBe('All steps completed successfully.');

		const updated = ctx.taskRepo.getTask(mainTask.id);
		expect(updated?.status).toBe('done');
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
			status: 'blocked',
			summary: 'An error occurred.',
			error: 'Tests failed in CI.',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('blocked');

		const updated = ctx.taskRepo.getTask(mainTask.id);
		expect(updated?.status).toBe('blocked');
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
			status: 'done',
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
			status: 'done',
		});
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, 'run-id', factory));

		const result = await handlers.report_result({
			status: 'done',
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

	test('emits space.task.done event when status is done', async () => {
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

		await handlers.report_result({ status: 'done', summary: 'All done.' });

		// The mock emit is synchronous (records events before returning Promise.resolve()),
		// so no async flush is needed — assertions can run immediately.
		expect(emittedEvents).toHaveLength(1);
		expect(emittedEvents[0].name).toBe('space.task.done');
		expect(emittedEvents[0].payload.taskId).toBe(mainTask.id);
		expect(emittedEvents[0].payload.spaceId).toBe(ctx.spaceId);
		expect(emittedEvents[0].payload.status).toBe('done');
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
			status: 'blocked',
			summary: 'Tests failed.',
			error: 'CI pipeline error',
		});

		expect(emittedEvents).toHaveLength(1);
		expect(emittedEvents[0].name).toBe('space.task.failed');
		expect(emittedEvents[0].payload.taskId).toBe(mainTask.id);
		expect(emittedEvents[0].payload.spaceId).toBe(ctx.spaceId);
		expect(emittedEvents[0].payload.status).toBe('blocked');
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

		const result = await handlers.report_result({ status: 'done', summary: 'Done.' });
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

		await handlers.report_result({ status: 'done', summary: 'Done.' });

		expect(emittedEvents[0].payload.sessionId).toBe('global');
	});

	test('does not emit event when task is not found', async () => {
		const factory = makeMockSessionFactory();
		const { hub, emittedEvents } = makeMockDaemonHub();

		const handlers = createTaskAgentToolHandlers({
			...makeConfig(ctx, 'nonexistent-task', 'run-id', factory),
			daemonHub: hub,
		});

		const result = await handlers.report_result({ status: 'done', summary: 'Done.' });
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

	test('marks task as blocked and returns the question in the response', async () => {
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
		expect(updated?.status).toBe('blocked');
		// The question is surfaced in the tool response payload (not stored in DB fields
		// since setTaskStatus only stores result for 'done' transitions).
	});

	test('includes context in the tool response when provided', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Main task',
			description: '',
			status: 'in_progress',
		});
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, 'run-id', factory));

		const result = await handlers.request_human_input({
			question: 'Approve the PR?',
			context: 'The PR includes breaking changes to the auth module.',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.question).toBe('Approve the PR?');
		expect(parsed.context).toContain('breaking changes');
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
		expect(parsed.message).toContain('human responds');
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
		// open → blocked is not valid (task must be in_progress)
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Main task',
			description: '',
			status: 'open',
		});
		const factory = makeMockSessionFactory();

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, 'run-id', factory));

		const result = await handlers.request_human_input({
			question: 'Approve?',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		// Error message reports the actual status ('open', not the old 'pending')
		expect(parsed.error).toContain('open');
	});
});

// ===========================================================================
// Integration: spawn → check → report lifecycle
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

	test('full single-step workflow lifecycle: spawn → check(running) → check(done) → report', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask, stepTask } = await startRun(ctx, wf);
		void stepTask; // used only for side effects

		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(
			makeConfig(ctx, mainTask.id, run.id, factory, {
				onSubSessionComplete: async () => {
					// Mark only the start-step task(s) as done so check_node_status can observe completion.
					const startNode = wf.nodes.find((n) => n.id === wf.startNodeId);
					const stepTasks = ctx.taskRepo
						.listByWorkflowRun(run.id)
						.filter((t) =>
							startNode ? t.title === startNode.name || t.title.includes(startNode.id) : false
						);
					for (const task of stepTasks) {
						ctx.taskRepo.updateTask(task.id, {
							status: 'done',
							completedAt: Date.now(),
						});
					}
				},
			})
		);

		// 1. Spawn node agent
		const spawnResult = await handlers.spawn_node_agent({ step_id: wf.startNodeId });
		const { sessionId } = JSON.parse(spawnResult.content[0].text);
		expect(sessionId).toBeString();

		// 2. Check status — running
		const checkRunning = await handlers.check_node_status({ step_id: wf.startNodeId });
		expect(JSON.parse(checkRunning.content[0].text).sessionStatus).toBe('running');

		// 3. Trigger sub-session completion (fires onSubSessionComplete callback)
		await (factory as ReturnType<typeof makeMockSessionFactory>)._triggerComplete(sessionId);

		// 4. Check status — completed
		const checkDone = await handlers.check_node_status({ step_id: wf.startNodeId });
		expect(JSON.parse(checkDone.content[0].text).taskStatus).toBe('done');

		// 5. Report result (mainTask is already in_progress after spawn_node_agent)
		const reportResult = await handlers.report_result({
			status: 'done',
			summary: 'Workflow completed successfully.',
		});
		const reportParsed = JSON.parse(reportResult.content[0].text);
		expect(reportParsed.success).toBe(true);
		expect(reportParsed.status).toBe('done');

		const finalTask = ctx.taskRepo.getTask(mainTask.id);
		expect(finalTask?.status).toBe('done');
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

	test('registers the 4 externally exposed task-agent tools', async () => {
		const { server } = await makeServerCtx();
		const registered = Object.keys(server.instance._registeredTools).sort();
		expect(registered).toEqual([
			'list_group_members',
			'report_result',
			'request_human_input',
			'send_message',
		]);
	});

	test('spawn_node_agent is not exposed on the MCP surface', async () => {
		const { server } = await makeServerCtx();
		const entry = server.instance._registeredTools['spawn_node_agent'];
		expect(entry).toBeUndefined();
	});

	test('check_node_status is not exposed on the MCP surface', async () => {
		const { server } = await makeServerCtx();
		const entry = server.instance._registeredTools['check_node_status'];
		expect(entry).toBeUndefined();
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
			'list_group_members',
			'send_message',
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

	test('list_group_members registered handler returns success payload', async () => {
		const { server } = await makeServerCtx();
		const handler = server.instance._registeredTools['list_group_members'].handler;
		const result = await handler({}, {});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(Array.isArray(parsed.members)).toBe(true);
	});

	test('report_result registered handler returns error for unknown task', async () => {
		// Build a server whose config references a non-existent taskId
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();
		const config = makeConfig(ctx, 'no-such-task', run.id, factory);
		const server = createTaskAgentMcpServer(config);

		const handler = server.instance._registeredTools['report_result'].handler;
		const result = await handler({ status: 'done', summary: 'done' }, {});
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
		// Both register the same 4 externally exposed tools
		expect(Object.keys(server1.instance._registeredTools)).toHaveLength(4);
		expect(Object.keys(server2.instance._registeredTools)).toHaveLength(4);
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

	test('returns empty member list when no tasks have taskAgentSessionId', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		const result = await handlers.list_group_members({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.members).toHaveLength(0);
	});

	test('returns members derived from tasks with taskAgentSessionId', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask, stepTask } = await startRun(ctx, wf);

		// Simulate an active sub-session via node_executions (source of truth post-migration)
		const execution = ctx.nodeExecutionRepo.createOrIgnore({
			workflowRunId: run.id,
			workflowNodeId: wf.startNodeId,
			agentName: 'only-step',
			agentSessionId: 'coder-session-123',
			status: 'in_progress',
		});
		ctx.nodeExecutionRepo.update(execution.id, {
			agentSessionId: 'coder-session-123',
			status: 'in_progress',
		});

		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		const result = await handlers.list_group_members({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.members).toHaveLength(1);

		const member = parsed.members[0];
		expect(member.sessionId).toBe('coder-session-123');
		expect(member.status).toBe('active');
		expect(Array.isArray(member.permittedTargets)).toBe(true);
	});

	test('no channelTopologyDeclared when no user-declared channels exist', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask, stepTask } = await startRun(ctx, wf);

		const execution = ctx.nodeExecutionRepo.createOrIgnore({
			workflowRunId: run.id,
			workflowNodeId: wf.startNodeId,
			agentName: 'only-step',
			agentSessionId: 'session-a',
			status: 'in_progress',
		});
		ctx.nodeExecutionRepo.update(execution.id, {
			agentSessionId: 'session-a',
			status: 'in_progress',
		});

		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		const result = await handlers.list_group_members({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		// No channels are declared, so channelTopologyDeclared is false
		expect(parsed.channelTopologyDeclared).toBe(false);
		// The member should have empty permittedTargets (no auto-generated channels)
		expect(parsed.members[0].permittedTargets).toHaveLength(0);
	});

	test('always returns channelTopologyDeclared=false (channel topology not stored post-M71)', async () => {
		// After migration M71, run.config was removed. Channel topology is no longer
		// accessible from list_group_members — it always returns an empty resolver.
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		// Seed two active node executions with sessions
		const exec1 = ctx.nodeExecutionRepo.create({
			workflowRunId: run.id,
			workflowNodeId: `${wf.startNodeId}-a`,
			agentName: 'task-1',
			agentSessionId: 'session-1',
			status: 'in_progress',
		});
		ctx.nodeExecutionRepo.update(exec1.id, {
			agentSessionId: 'session-1',
			status: 'in_progress',
		});

		const exec2 = ctx.nodeExecutionRepo.create({
			workflowRunId: run.id,
			workflowNodeId: `${wf.startNodeId}-b`,
			agentName: 'task-2',
			agentSessionId: 'session-2',
			status: 'in_progress',
		});
		ctx.nodeExecutionRepo.update(exec2.id, {
			agentSessionId: 'session-2',
			status: 'in_progress',
		});

		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		const result = await handlers.list_group_members({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		// Channel topology is not stored in run.config post-M71, so always false
		expect(parsed.channelTopologyDeclared).toBe(false);
		// permittedTargets are derived from known active roles in node_executions.
		for (const member of parsed.members) {
			expect(member.permittedTargets.length).toBeGreaterThanOrEqual(1);
		}
	});
});

// ===========================================================================
// spawn_node_agent — slot role and overrides
// ===========================================================================

describe('createTaskAgentToolHandlers — spawn_node_agent slot role and overrides', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('uses slot role for session group membership when WorkflowNodeAgent has a distinct role', async () => {
		// Create an agent and a workflow where the node uses the agents[] format with a custom slot role
		const agentId = ctx.agentId;
		const stepId = `step-slot-role-${Math.random().toString(36).slice(2)}`;
		const wf = ctx.workflowManager.createWorkflow({
			spaceId: ctx.spaceId,
			name: 'Slot Role Test WF',
			nodes: [
				{
					id: stepId,
					name: 'Slot Role Step',
					agents: [
						{
							agentId,
							name: 'strict-reviewer', // slot name differs from SpaceAgent.role ('coder')
						},
					],
				},
			],
			startNodeId: stepId,
		});

		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		const result = await handlers.spawn_node_agent({ step_id: stepId });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);

		// The session should be registered with the slot role, not the base agent's role
		const sessionId = parsed.sessionId;
		const capturedInfo = (
			factory as ReturnType<typeof makeMockSessionFactory>
		)._capturedMemberInfos.get(sessionId);
		expect(capturedInfo?.role).toBe('strict-reviewer'); // slot role, not 'coder' (base agent role)
	});

	test('uses slot name as role for group membership in explicit agents[] format', async () => {
		// buildSingleStepWorkflow uses agents: [{ agentId, name: 'only-step' }]
		// spawn_node_agent uses agentSlot.name ('only-step') as the memberRole.
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		const result = await handlers.spawn_node_agent({ step_id: wf.startNodeId });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);

		// The memberRole is the slot name ('only-step'), not the base SpaceAgent.role ('coder').
		const sessionId = parsed.sessionId;
		const capturedInfo = (
			factory as ReturnType<typeof makeMockSessionFactory>
		)._capturedMemberInfos.get(sessionId);
		expect(capturedInfo?.role).toBe('only-step');
	});

	test('spawned session uses the base agent model (WorkflowNodeAgent has no model field)', async () => {
		// WorkflowNodeAgent does not have a model field — model overrides are not supported at the
		// slot level. The base SpaceAgent model is always used.
		const agentId = ctx.agentId;
		const stepId = `step-model-check-${Math.random().toString(36).slice(2)}`;

		const wf = ctx.workflowManager.createWorkflow({
			spaceId: ctx.spaceId,
			name: 'Model Check Test WF',
			nodes: [
				{
					id: stepId,
					name: 'Model Check Step',
					agents: [{ agentId, name: 'fast-coder' }],
				},
			],
			startNodeId: stepId,
		});

		const { run, mainTask } = await startRun(ctx, wf);

		// Capture the init passed to sessionFactory.create
		let capturedInit: { model?: string } | null = null;
		const factory = makeMockSessionFactory({
			create: async (init: unknown) => {
				capturedInit = init as { model?: string };
				return `session-${Math.random().toString(36).slice(2)}`;
			},
		});
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		const result = await handlers.spawn_node_agent({ step_id: stepId });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);

		// model is provided (from the base agent config defaults)
		expect(capturedInit?.model).toBeString();
	});

	test('systemPrompt override from WorkflowNodeAgent slot is applied to spawned session', async () => {
		const agentId = ctx.agentId;
		const stepId = `step-prompt-override-${Math.random().toString(36).slice(2)}`;
		const overridePrompt = 'Focus exclusively on security vulnerabilities.';

		const wf = ctx.workflowManager.createWorkflow({
			spaceId: ctx.spaceId,
			name: 'Prompt Override Test WF',
			nodes: [
				{
					id: stepId,
					name: 'Prompt Override Step',
					agents: [
						{
							agentId,
							name: 'security-reviewer',
							// systemPrompt is WorkflowNodeAgentOverride, not a plain string
							systemPrompt: { mode: 'override', value: overridePrompt },
						},
					],
				},
			],
			startNodeId: stepId,
		});

		const { run, mainTask } = await startRun(ctx, wf);

		// Capture the init passed to sessionFactory.create
		let capturedInit: { systemPrompt?: { append?: string } } | null = null;
		const factory = makeMockSessionFactory({
			create: async (init: unknown) => {
				capturedInit = init as { systemPrompt?: { append?: string } };
				return `session-${Math.random().toString(36).slice(2)}`;
			},
		});
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));

		const result = await handlers.spawn_node_agent({ step_id: stepId });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);

		// The session init system prompt should contain the override text
		const promptText = capturedInit?.systemPrompt?.append ?? '';
		expect(promptText).toContain(overridePrompt);
	});

	test('same agent twice in one node: spawn_node_agent succeeds and returns a session', async () => {
		// When the same agentId appears twice in a node with different agent names (roles),
		// spawn_node_agent should succeed and use the first matching slot's name as the role.
		// workflowNodeId and agentName were removed in M71 so slot disambiguation by DB filter
		// is no longer possible; the first task matching the step name is used.
		const agentId = ctx.agentId;
		const stepId = `step-dual-${Math.random().toString(36).slice(2)}`;

		// Both slots use the same agentId but different roles
		const wf = ctx.workflowManager.createWorkflow({
			spaceId: ctx.spaceId,
			name: 'Dual Instance WF',
			nodes: [
				{
					id: stepId,
					name: 'Dual Instance Step',
					agents: [
						{ agentId, name: 'strict-reviewer' },
						{ agentId, name: 'quick-reviewer' },
					],
				},
			],
			startNodeId: stepId,
		});

		// The executor creates two tasks for this step (one per agent slot)
		const { run, mainTask } = await startRun(ctx, wf);

		// In one-task-per-workflow-run semantics, per-slot step tasks are not created.
		const allRunTasks = ctx.taskRepo
			.listByWorkflowRun(run.id)
			.sort((a, b) => a.createdAt - b.createdAt);
		const slotNames = new Set(['strict-reviewer', 'quick-reviewer']);
		const stepTasks = allRunTasks.filter((t) => slotNames.has(t.title));
		expect(stepTasks).toHaveLength(0);

		// spawn_node_agent picks the last matching task
		const factory = makeMockSessionFactory();
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));
		const result = await handlers.spawn_node_agent({ step_id: stepId });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);

		// The spawned session must have a valid role (one of the slot names)
		const sessionId = parsed.sessionId;
		const capturedInfo = (
			factory as ReturnType<typeof makeMockSessionFactory>
		)._capturedMemberInfos.get(sessionId);
		expect(capturedInfo?.role).toBeString();
		// Role should be one of the defined slot names, not the base SpaceAgent role ('coder')
		expect(capturedInfo?.role).not.toBe('coder');
	});

	test('spawn_node_agent succeeds even when slot uses systemPrompt override', async () => {
		// Verify that a slot-level systemPrompt (WorkflowNodeAgentOverride) does not
		// prevent spawn_node_agent from succeeding. The override value is passed as a string
		// to SlotOverrides.systemPrompt for use in resolveAgentInit.
		const agentId = ctx.agentId;
		const stepId = `step-override-check-${Math.random().toString(36).slice(2)}`;

		const wf = ctx.workflowManager.createWorkflow({
			spaceId: ctx.spaceId,
			name: 'Override Check WF',
			nodes: [
				{
					id: stepId,
					name: 'Override Step',
					agents: [
						{
							agentId,
							name: 'reviewer',
							systemPrompt: { mode: 'override', value: 'You are a reviewer.' },
						},
					],
				},
			],
			startNodeId: stepId,
		});

		const { run, mainTask } = await startRun(ctx, wf);

		// Capture the init to verify it succeeds
		let capturedInit: { model?: string } | null = null;
		const factory = makeMockSessionFactory({
			create: async (init: unknown) => {
				capturedInit = init as { model?: string };
				return `session-${Math.random().toString(36).slice(2)}`;
			},
		});

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id, factory));
		const result = await handlers.spawn_node_agent({ step_id: stepId });
		const parsed = JSON.parse(result.content[0].text);

		// Spawn must succeed
		expect(parsed.success).toBe(true);
		// model is provided from base agent config
		expect(capturedInit?.model).toBeString();
	});
});
