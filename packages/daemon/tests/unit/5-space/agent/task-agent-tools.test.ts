/**
 * Unit tests for createTaskAgentToolHandlers()
 *
 * Covers Task Agent tools:
 *   save_artifact       — append-only artifact persistence; does NOT close task
 *   approve_task        — autonomy-gated self-close
 *   submit_for_approval — always-available human sign-off
 *   request_human_input — pauses execution, marks task needs_attention
 *   list_group_members  — lists group members with session IDs and channel info
 *   send_message        — sends message to peer node agents via channel topology
 *
 * Tests use a real SQLite database (via runMigrations).
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
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import {
	createTaskAgentToolHandlers,
	createTaskAgentMcpServer,
	type TaskAgentToolsConfig,
} from '../../../../src/lib/space/tools/task-agent-tools.ts';
import type { Space, SpaceWorkflow, SpaceTask } from '@neokai/shared';
import type { DaemonHub } from '../../../../src/lib/daemon-hub.ts';

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
		completionAutonomyLevel: 3,
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
		completionAutonomyLevel: 3,
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
		completionAutonomyLevel: 3,
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
		completionAutonomyLevel: 3,
	});
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
	artifactRepo: WorkflowRunArtifactRepository;
	nodeExecutionRepo: NodeExecutionRepository;
	taskManager: SpaceTaskManager;
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
	const artifactRepo = new WorkflowRunArtifactRepository(db);
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
		artifactRepo,
		nodeExecutionRepo,
		taskManager,
		runtime,
	};
}

function makeConfig(
	ctx: TestCtx,
	taskId: string,
	workflowRunId: string,
	options?: {
		messageInjector?: (sessionId: string, message: string) => Promise<void>;
	}
): TaskAgentToolsConfig {
	return {
		taskId,
		space: ctx.space,
		workflowRunId,
		taskRepo: ctx.taskRepo,
		artifactRepo: ctx.artifactRepo,
		nodeExecutionRepo: ctx.nodeExecutionRepo,
		taskManager: ctx.taskManager,
		messageInjector: options?.messageInjector ?? (async () => {}),
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
// save_artifact tests
// ===========================================================================

describe('createTaskAgentToolHandlers — save_artifact', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('saves artifact with summary and does NOT mutate task state', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Main task',
			description: '',
			status: 'in_progress',
		});
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run } = await startRun(ctx, wf);

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id));
		const result = await handlers.save_artifact({
			type: 'result',
			key: '',
			append: false,
			summary: 'All steps completed successfully.',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.artifact.type).toBe('result');
		expect(parsed.artifact.nodeId).toBe('task-agent');
		expect(parsed.artifact.runId).toBe(run.id);

		// Task state unchanged
		const updated = ctx.taskRepo.getTask(mainTask.id);
		expect(updated?.status).toBe('in_progress');

		// Artifact row written
		const artifacts = ctx.artifactRepo.listByRun(run.id, { artifactType: 'result' });
		expect(artifacts).toHaveLength(1);
		expect(artifacts[0].data.summary).toBe('All steps completed successfully.');
	});

	test('append mode creates multiple records', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'Ongoing',
			description: '',
			status: 'in_progress',
		});
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run } = await startRun(ctx, wf);

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id));

		const r1 = await handlers.save_artifact({
			type: 'audit',
			key: '',
			append: true,
			summary: 'First',
		});
		const r2 = await handlers.save_artifact({
			type: 'audit',
			key: '',
			append: true,
			summary: 'Second',
		});

		expect(JSON.parse(r1.content[0].text).success).toBe(true);
		expect(JSON.parse(r2.content[0].text).success).toBe(true);

		const artifacts = ctx.artifactRepo.listByRun(run.id, { artifactType: 'audit' });
		expect(artifacts).toHaveLength(2);
	});

	test('returns error when artifactRepo is absent', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'in_progress',
		});
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run } = await startRun(ctx, wf);

		// Config without artifactRepo
		const config = { ...makeConfig(ctx, mainTask.id, run.id), artifactRepo: undefined };
		const handlers = createTaskAgentToolHandlers(config);
		const result = await handlers.save_artifact({ type: 'result', summary: 'done' });
		expect(JSON.parse(result.content[0].text).success).toBe(false);
	});

	test('returns error when neither summary nor data provided', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'in_progress',
		});
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run } = await startRun(ctx, wf);

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id));
		const result = await handlers.save_artifact({ type: 'result' });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('summary');
	});
});

// ===========================================================================
// approve_task tests
// ===========================================================================

describe('createTaskAgentToolHandlers — approve_task', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		// Seed space with autonomy level 5 so approve_task works by default
		const { db, dir } = makeDb();
		const spaceId = 'space-tat-test';
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
       allowed_models, session_ids, slug, status, autonomy_level, created_at, updated_at)
       VALUES (?, '/tmp/test-workspace', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?, ?)`
		).run(spaceId, `Space ${spaceId}`, spaceId, 5, Date.now(), Date.now());

		const agentId = 'agent-coder-1';
		db.prepare(
			`INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
       VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
		).run(agentId, spaceId, 'Coder', Date.now(), Date.now());

		const agentRepo = new SpaceAgentRepository(db);
		const agentManager = new SpaceAgentManager(agentRepo);
		const workflowRepo = new SpaceWorkflowRepository(db);
		const workflowManager = new SpaceWorkflowManager(workflowRepo);
		const workflowRunRepo = new SpaceWorkflowRunRepository(db);
		const taskRepo = new SpaceTaskRepository(db);
		const artifactRepo = new WorkflowRunArtifactRepository(db);
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
		const space = makeSpace(spaceId, '/tmp/test-workspace');
		// Override space autonomy level to 5
		(space as { autonomyLevel?: number }).autonomyLevel = 5;

		ctx = {
			db,
			dir,
			spaceId,
			agentId,
			space,
			workflowManager,
			workflowRunRepo,
			taskRepo,
			artifactRepo,
			nodeExecutionRepo,
			taskManager,
			runtime,
		};
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('sets reportedStatus=done when space autonomy sufficient (no workflow run repo)', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'in_progress',
		});
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run } = await startRun(ctx, wf);

		// Config with space autonomy=5, no workflowRunRepo (defaults to level 5 required — passes since 5 >= 5)
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id));
		const result = await handlers.approve_task({});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.taskId).toBe(mainTask.id);

		const t = ctx.taskRepo.getTask(mainTask.id);
		expect(t?.reportedStatus).toBe('done');
	});

	test('returns error when autonomy level too low', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'in_progress',
		});
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run } = await startRun(ctx, wf);

		// Override space autonomy to 1 (too low for any workflow)
		(ctx.space as { autonomyLevel?: number }).autonomyLevel = 1;
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id));
		const result = await handlers.approve_task({});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('approve_task not permitted');
	});

	test('returns error when task not found', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run } = await startRun(ctx, wf);

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, 'no-such-task', run.id));
		const result = await handlers.approve_task({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('no-such-task');
	});
});

// ===========================================================================
// submit_for_approval tests
// ===========================================================================

describe('createTaskAgentToolHandlers — submit_for_approval', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('sets status=review and pending-completion fields', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'in_progress',
		});
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run } = await startRun(ctx, wf);

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id));
		const before = Date.now();
		const result = await handlers.submit_for_approval({ reason: 'risky change' });
		const after = Date.now();
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.message).toContain('submitted for human review');
		expect(parsed.message).toContain('risky change');

		const t = ctx.taskRepo.getTask(mainTask.id);
		expect(t?.status).toBe('review');
		expect(t?.pendingCheckpointType).toBe('task_completion');
		expect(t?.pendingCompletionReason).toBe('risky change');
		expect(t?.pendingCompletionSubmittedAt).toBeGreaterThanOrEqual(before);
		expect(t?.pendingCompletionSubmittedAt).toBeLessThanOrEqual(after);
		// Task Agent has no workflowNodeId — stored as null
		expect(t?.pendingCompletionSubmittedByNodeId).toBeNull();
	});

	test('handles missing reason (optional field)', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'in_progress',
		});
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run } = await startRun(ctx, wf);

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id));
		const result = await handlers.submit_for_approval({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.message).not.toContain('(reason:');

		const t = ctx.taskRepo.getTask(mainTask.id);
		expect(t?.status).toBe('review');
		expect(t?.pendingCompletionReason).toBeNull();
	});

	test('returns error when task not found', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run } = await startRun(ctx, wf);
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, 'ghost', run.id));
		const result = await handlers.submit_for_approval({ reason: 'x' });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('ghost');
	});

	test('succeeds regardless of space autonomy level', async () => {
		const mainTask = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'in_progress',
		});
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run } = await startRun(ctx, wf);

		// autonomy level 1 (minimum) should still allow submit_for_approval
		(ctx.space as { autonomyLevel?: number }).autonomyLevel = 1;
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id));
		const result = await handlers.submit_for_approval({ reason: 'low-autonomy escalate' });
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(ctx.taskRepo.getTask(mainTask.id)?.status).toBe('review');
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

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, 'run-id'));

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

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, 'run-id'));

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

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, 'run-id'));

		const result = await handlers.request_human_input({
			question: 'Which approach should we take?',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.message).toContain('Wait');
		expect(parsed.message).toContain('human responds');
	});

	test('returns error when task not found', async () => {
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, 'task-missing', 'run-id'));

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

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, 'run-id'));

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
		const config = makeConfig(ctx, mainTask.id, run.id);
		const server = createTaskAgentMcpServer(config);
		return { wf, run, mainTask, config, server };
	}

	// ---------------------------------------------------------------------------
	// Tool registration
	// ---------------------------------------------------------------------------

	test('returns an object with type "sdk" and name "task-agent"', async () => {
		const { server } = await makeServerCtx();
		expect(server.type).toBe('sdk');
		expect(server.name).toBe('task-agent');
	});

	test('registers the 8 externally exposed task-agent tools (with artifactRepo)', async () => {
		const { server } = await makeServerCtx();
		const registered = Object.keys(server.instance._registeredTools).sort();
		expect(registered).toEqual([
			'approve_gate',
			'approve_task',
			'list_artifacts',
			'list_group_members',
			'request_human_input',
			'save_artifact',
			'send_message',
			'submit_for_approval',
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

	test('save_artifact has correct description', async () => {
		const { server } = await makeServerCtx();
		const entry = server.instance._registeredTools['save_artifact'];
		expect(entry).toBeDefined();
		expect(entry.description).toContain('artifact');
	});

	test('approve_task has correct description', async () => {
		const { server } = await makeServerCtx();
		const entry = server.instance._registeredTools['approve_task'];
		expect(entry).toBeDefined();
		expect(entry.description).toContain('autonomy');
	});

	test('submit_for_approval has correct description', async () => {
		const { server } = await makeServerCtx();
		const entry = server.instance._registeredTools['submit_for_approval'];
		expect(entry).toBeDefined();
		expect(entry.description).toContain('human review');
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
			'save_artifact',
			'request_human_input',
			'approve_task',
			'submit_for_approval',
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

	test('save_artifact registered handler writes an artifact', async () => {
		// Build a server whose config references a real taskId and run
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);
		const config = makeConfig(ctx, mainTask.id, run.id);
		const server = createTaskAgentMcpServer(config);

		const handler = server.instance._registeredTools['save_artifact'].handler;
		const result = await handler({ type: 'result', summary: 'done' }, {});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.artifact.type).toBe('result');
	});

	test('request_human_input registered handler returns error for unknown task', async () => {
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run } = await startRun(ctx, wf);
		const config = makeConfig(ctx, 'no-such-task', run.id);
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
		const config = makeConfig(ctx, mainTask.id, run.id);

		const server1 = createTaskAgentMcpServer(config);
		const server2 = createTaskAgentMcpServer(config);

		// Each call returns a distinct server instance
		expect(server1.instance).not.toBe(server2.instance);
		// Both register the same 8 externally exposed tools (with artifactRepo)
		expect(Object.keys(server1.instance._registeredTools)).toHaveLength(8);
		expect(Object.keys(server2.instance._registeredTools)).toHaveLength(8);
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
		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id));

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

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id));

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

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id));

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

		const handlers = createTaskAgentToolHandlers(makeConfig(ctx, mainTask.id, run.id));

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
// send_message queue-until-active + Space Agent escalation
// ===========================================================================

describe('createTaskAgentToolHandlers — send_message queue-until-active', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('queues message when target is declared but inactive', async () => {
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		// Declare "reviewer" in the run with no active session (pending, no session id).
		ctx.nodeExecutionRepo.create({
			workflowRunId: run.id,
			workflowNodeId: 'declared-node',
			agentName: 'reviewer',
			status: 'pending',
		});

		const { PendingAgentMessageRepository } = await import(
			'../../../../src/storage/repositories/pending-agent-message-repository.ts'
		);
		const pendingRepo = new PendingAgentMessageRepository(ctx.db);

		const { hub, emittedEvents } = makeMockDaemonHub();
		const queuedRecords: Array<{ id: string; targetAgentName: string }> = [];

		const config: TaskAgentToolsConfig = {
			...makeConfig(ctx, mainTask.id, run.id),
			pendingMessageRepo: pendingRepo,
			daemonHub: hub,
			onMessageQueued: (rec) =>
				queuedRecords.push({ id: rec.id, targetAgentName: rec.targetAgentName }),
		};
		const handlers = createTaskAgentToolHandlers(config);

		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'ping',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.queued).toHaveLength(1);
		expect(parsed.queued[0].agentName).toBe('reviewer');
		expect(parsed.queued[0].targetKind).toBe('node_agent');
		expect(parsed.queued[0].deduped).toBe(false);

		// Queued record is persisted.
		const pending = pendingRepo.listPendingForTarget(run.id, 'reviewer');
		expect(pending).toHaveLength(1);
		expect(pending[0].message).toBe('ping');

		// Observability: onMessageQueued hook fires + DaemonHub event is emitted.
		expect(queuedRecords).toHaveLength(1);
		expect(queuedRecords[0].targetAgentName).toBe('reviewer');
		const queuedEvent = emittedEvents.find((e) => e.name === 'space.pendingMessage.queued');
		expect(queuedEvent).toBeDefined();
		expect(queuedEvent!.payload.targetAgentName).toBe('reviewer');
		expect(queuedEvent!.payload.targetKind).toBe('node_agent');
	});

	test('returns notFoundAgentNames when target is not declared in run', async () => {
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		const { PendingAgentMessageRepository } = await import(
			'../../../../src/storage/repositories/pending-agent-message-repository.ts'
		);
		const pendingRepo = new PendingAgentMessageRepository(ctx.db);

		const config: TaskAgentToolsConfig = {
			...makeConfig(ctx, mainTask.id, run.id),
			pendingMessageRepo: pendingRepo,
		};
		const handlers = createTaskAgentToolHandlers(config);

		const result = await handlers.send_message({
			target: 'ghost-agent',
			message: 'hello',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.notFoundAgentNames).toEqual(['ghost-agent']);
		// Nothing queued because agent isn't declared in the run.
		expect(pendingRepo.listAllPending()).toHaveLength(0);
	});

	test('delivers to active target while queuing inactive target (partial)', async () => {
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		// Coder has a live session (simulated via mock taskAgentManager backed by nodeExecutionRepo).
		// Reviewer is declared in NodeExecution but has no live session yet.
		ctx.nodeExecutionRepo.create({
			workflowRunId: run.id,
			workflowNodeId: 'active-node',
			agentName: 'coder',
			agentSessionId: 'session-coder',
			status: 'in_progress',
		});
		ctx.nodeExecutionRepo.create({
			workflowRunId: run.id,
			workflowNodeId: 'declared-node',
			agentName: 'reviewer',
			status: 'pending',
		});

		const { PendingAgentMessageRepository } = await import(
			'../../../../src/storage/repositories/pending-agent-message-repository.ts'
		);
		const pendingRepo = new PendingAgentMessageRepository(ctx.db);

		// Mock taskAgentManager: coder has a live session, reviewer does not.
		const mockTaskAgentManager = {
			getAgentNamesForTask: async (_taskId: string) => ['coder'],
			getSubSessionByAgentName: async (_taskId: string, agentName: string) => {
				if (agentName === 'coder') return { session: { id: 'session-coder' } };
				return null;
			},
			tryResumeNodeAgentSession: async () => {},
		} as unknown as TaskAgentToolsConfig['taskAgentManager'];

		const delivered: Array<{ sessionId: string; message: string }> = [];
		const config: TaskAgentToolsConfig = {
			...makeConfig(ctx, mainTask.id, run.id, {
				messageInjector: async (sessionId, message) => {
					delivered.push({ sessionId, message });
				},
			}),
			pendingMessageRepo: pendingRepo,
			taskAgentManager: mockTaskAgentManager,
		};
		const handlers = createTaskAgentToolHandlers(config);

		const result = await handlers.send_message({
			target: ['coder', 'reviewer'],
			message: 'hi all',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.delivered).toHaveLength(1);
		expect(parsed.delivered[0].agentName).toBe('coder');
		expect(parsed.queued).toHaveLength(1);
		expect(parsed.queued[0].agentName).toBe('reviewer');

		// The coder got the message right away.
		expect(delivered).toHaveLength(1);
		expect(delivered[0].message).toBe('[Message from task-agent]: hi all');

		// The reviewer message is queued.
		const pending = pendingRepo.listPendingForTarget(run.id, 'reviewer');
		expect(pending).toHaveLength(1);
	});

	test('idempotency_key dedupes repeated queue attempts', async () => {
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		ctx.nodeExecutionRepo.create({
			workflowRunId: run.id,
			workflowNodeId: 'declared-node',
			agentName: 'reviewer',
			status: 'pending',
		});

		const { PendingAgentMessageRepository } = await import(
			'../../../../src/storage/repositories/pending-agent-message-repository.ts'
		);
		const pendingRepo = new PendingAgentMessageRepository(ctx.db);

		const config: TaskAgentToolsConfig = {
			...makeConfig(ctx, mainTask.id, run.id),
			pendingMessageRepo: pendingRepo,
		};
		const handlers = createTaskAgentToolHandlers(config);

		const r1 = await handlers.send_message({
			target: 'reviewer',
			message: 'v1',
			idempotency_key: 'dedupe-key-1',
		});
		const p1 = JSON.parse(r1.content[0].text);
		expect(p1.queued[0].deduped).toBe(false);

		const r2 = await handlers.send_message({
			target: 'reviewer',
			message: 'v2-replay',
			idempotency_key: 'dedupe-key-1',
		});
		const p2 = JSON.parse(r2.content[0].text);
		expect(p2.queued[0].deduped).toBe(true);
		// ID returned is the original record, not a new one.
		expect(p2.queued[0].messageId).toBe(p1.queued[0].messageId);

		const pending = pendingRepo.listPendingForTarget(run.id, 'reviewer');
		expect(pending).toHaveLength(1);
		expect(pending[0].message).toBe('v1');
	});

	test('escalates to Space Agent via spaceAgentInjector', async () => {
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		const injectorCalls: Array<{ spaceId: string; message: string }> = [];
		const config: TaskAgentToolsConfig = {
			...makeConfig(ctx, mainTask.id, run.id),
			spaceAgentInjector: async (spaceId, message) => {
				injectorCalls.push({ spaceId, message });
			},
		};
		const handlers = createTaskAgentToolHandlers(config);

		const result = await handlers.send_message({
			target: 'space-agent',
			message: 'need your help with scope',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.delivered).toHaveLength(1);
		expect(parsed.delivered[0].agentName).toBe('space-agent');
		expect(parsed.delivered[0].sessionId).toBe(`space:chat:${ctx.spaceId}`);

		expect(injectorCalls).toHaveLength(1);
		expect(injectorCalls[0].spaceId).toBe(ctx.spaceId);
		expect(injectorCalls[0].message).toBe('[Message from task-agent]: need your help with scope');
	});

	test('queues for Space Agent when injector fails + pendingMessageRepo is configured', async () => {
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		const { PendingAgentMessageRepository } = await import(
			'../../../../src/storage/repositories/pending-agent-message-repository.ts'
		);
		const pendingRepo = new PendingAgentMessageRepository(ctx.db);

		const config: TaskAgentToolsConfig = {
			...makeConfig(ctx, mainTask.id, run.id),
			pendingMessageRepo: pendingRepo,
			spaceAgentInjector: async () => {
				throw new Error('Space Agent session not ready');
			},
		};
		const handlers = createTaskAgentToolHandlers(config);

		const result = await handlers.send_message({
			target: 'space-agent',
			message: 'queue me',
		});
		const parsed = JSON.parse(result.content[0].text);

		// delivery failed, but queued succeeded → overall success=true
		expect(parsed.success).toBe(true);
		expect(parsed.queued).toHaveLength(1);
		expect(parsed.queued[0].targetKind).toBe('space_agent');

		const pending = pendingRepo.listPendingForTarget(run.id, 'space-agent');
		expect(pending).toHaveLength(1);
		expect(pending[0].message).toBe('queue me');
		expect(pending[0].targetKind).toBe('space_agent');
	});

	test('queues for Space Agent when no injector is configured but pendingMessageRepo is', async () => {
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		const { PendingAgentMessageRepository } = await import(
			'../../../../src/storage/repositories/pending-agent-message-repository.ts'
		);
		const pendingRepo = new PendingAgentMessageRepository(ctx.db);

		const config: TaskAgentToolsConfig = {
			...makeConfig(ctx, mainTask.id, run.id),
			pendingMessageRepo: pendingRepo,
			// no spaceAgentInjector
		};
		const handlers = createTaskAgentToolHandlers(config);

		const result = await handlers.send_message({
			target: 'space-agent',
			message: 'defer me',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.queued).toHaveLength(1);
		expect(parsed.queued[0].targetKind).toBe('space_agent');

		const pending = pendingRepo.listPendingForTarget(run.id, 'space-agent');
		expect(pending).toHaveLength(1);
	});

	test('fails hard when space-agent target has no injector and no queue repo', async () => {
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		const config: TaskAgentToolsConfig = {
			...makeConfig(ctx, mainTask.id, run.id),
			// neither pendingMessageRepo nor spaceAgentInjector
		};
		const handlers = createTaskAgentToolHandlers(config);

		const result = await handlers.send_message({
			target: 'space-agent',
			message: 'orphan',
		});
		const parsed = JSON.parse(result.content[0].text);

		// No infra at all → escalation is a failed target. Because it's the only target,
		// the handler reports partial-no-delivery.
		expect(parsed.failed).toBeDefined();
		expect(parsed.failed[0].agentName).toBe('space-agent');
	});

	test('send_message tool on MCP server surface accepts idempotency_key', async () => {
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		ctx.nodeExecutionRepo.create({
			workflowRunId: run.id,
			workflowNodeId: 'declared-node',
			agentName: 'reviewer',
			status: 'pending',
		});

		const { PendingAgentMessageRepository } = await import(
			'../../../../src/storage/repositories/pending-agent-message-repository.ts'
		);
		const pendingRepo = new PendingAgentMessageRepository(ctx.db);

		const config: TaskAgentToolsConfig = {
			...makeConfig(ctx, mainTask.id, run.id),
			pendingMessageRepo: pendingRepo,
		};
		const server = createTaskAgentMcpServer(config);
		const entry = server.instance._registeredTools['send_message'];

		const out = await entry.handler(
			{ target: 'reviewer', message: 'via mcp', idempotency_key: 'k-mcp' },
			{}
		);
		const parsed = JSON.parse(out.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.queued[0].deduped).toBe(false);

		// Replay with same key → deduped
		const out2 = await entry.handler(
			{ target: 'reviewer', message: 'via mcp replay', idempotency_key: 'k-mcp' },
			{}
		);
		const parsed2 = JSON.parse(out2.content[0].text);
		expect(parsed2.queued[0].deduped).toBe(true);
	});
});

// ===========================================================================
// send_message auto-resume (Task #70)
// ===========================================================================

describe('createTaskAgentToolHandlers — send_message auto-resume on queue', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('calls tryResumeNodeAgentSession after queuing a non-deduped message', async () => {
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		// Declare "reviewer" as pending (no session yet)
		ctx.nodeExecutionRepo.create({
			workflowRunId: run.id,
			workflowNodeId: 'declared-node',
			agentName: 'reviewer',
			status: 'pending',
		});

		const { PendingAgentMessageRepository } = await import(
			'../../../../src/storage/repositories/pending-agent-message-repository.ts'
		);
		const pendingRepo = new PendingAgentMessageRepository(ctx.db);

		const resumeAttempts: Array<{ workflowRunId: string; agentName: string }> = [];

		// Mock taskAgentManager with tryResumeNodeAgentSession spy
		const mockTaskAgentManager = {
			getAgentNamesForTask: async (_taskId: string) => [],
			getSubSessionByAgentName: async (_taskId: string, _agentName: string) => null,
			tryResumeNodeAgentSession: async (workflowRunId: string, agentName: string) => {
				resumeAttempts.push({ workflowRunId, agentName });
			},
		} as unknown as TaskAgentToolsConfig['taskAgentManager'];

		const config: TaskAgentToolsConfig = {
			...makeConfig(ctx, mainTask.id, run.id),
			pendingMessageRepo: pendingRepo,
			taskAgentManager: mockTaskAgentManager,
		};
		const handlers = createTaskAgentToolHandlers(config);

		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'ping',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.queued).toHaveLength(1);

		// Auto-resume must have been attempted
		expect(resumeAttempts).toHaveLength(1);
		expect(resumeAttempts[0].agentName).toBe('reviewer');
		expect(resumeAttempts[0].workflowRunId).toBe(run.id);
	});

	test('does NOT call tryResumeNodeAgentSession for deduped (already-queued) messages', async () => {
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		ctx.nodeExecutionRepo.create({
			workflowRunId: run.id,
			workflowNodeId: 'declared-node',
			agentName: 'reviewer',
			status: 'pending',
		});

		const { PendingAgentMessageRepository } = await import(
			'../../../../src/storage/repositories/pending-agent-message-repository.ts'
		);
		const pendingRepo = new PendingAgentMessageRepository(ctx.db);

		const resumeAttempts: string[] = [];

		const mockTaskAgentManager = {
			getAgentNamesForTask: async (_taskId: string) => [],
			getSubSessionByAgentName: async (_taskId: string, _agentName: string) => null,
			tryResumeNodeAgentSession: async (_workflowRunId: string, agentName: string) => {
				resumeAttempts.push(agentName);
			},
		} as unknown as TaskAgentToolsConfig['taskAgentManager'];

		const config: TaskAgentToolsConfig = {
			...makeConfig(ctx, mainTask.id, run.id),
			pendingMessageRepo: pendingRepo,
			taskAgentManager: mockTaskAgentManager,
		};
		const handlers = createTaskAgentToolHandlers(config);

		// First call — new enqueue → auto-resume triggered
		await handlers.send_message({
			target: 'reviewer',
			message: 'ping',
			idempotency_key: 'auto-resume-dedup-1',
		});
		expect(resumeAttempts).toHaveLength(1);

		// Second call with same key — deduped → auto-resume NOT triggered again
		resumeAttempts.length = 0;
		await handlers.send_message({
			target: 'reviewer',
			message: 'ping (retry)',
			idempotency_key: 'auto-resume-dedup-1',
		});
		expect(resumeAttempts).toHaveLength(0);
	});

	test('does NOT call tryResumeNodeAgentSession when taskAgentManager is absent', async () => {
		// Regression guard: the code path must not throw when taskAgentManager is unset
		const wf = buildTwoStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId);
		const { run, mainTask } = await startRun(ctx, wf);

		ctx.nodeExecutionRepo.create({
			workflowRunId: run.id,
			workflowNodeId: 'declared-node',
			agentName: 'reviewer',
			status: 'pending',
		});

		const { PendingAgentMessageRepository } = await import(
			'../../../../src/storage/repositories/pending-agent-message-repository.ts'
		);
		const pendingRepo = new PendingAgentMessageRepository(ctx.db);

		// No taskAgentManager — should not throw
		const config: TaskAgentToolsConfig = {
			...makeConfig(ctx, mainTask.id, run.id),
			pendingMessageRepo: pendingRepo,
			// taskAgentManager deliberately absent
		};
		const handlers = createTaskAgentToolHandlers(config);

		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'ping',
		});
		const parsed = JSON.parse(result.content[0].text);

		// Still queues successfully; just no auto-resume
		expect(parsed.success).toBe(true);
		expect(parsed.queued).toHaveLength(1);
	});
});
