/**
 * Unit tests for createGlobalSpacesToolHandlers()
 *
 * Section 1 — Autonomy level handling (mock-based):
 *   create_space: passes autonomy_level through to SpaceManager
 *   update_space: passes autonomy_level through to SpaceManager
 *
 * Section 2 — Coordination tools (real DB integration):
 *   create_standalone_task — create task outside a workflow with space_id resolution
 *   get_task_detail        — fetch full task detail; validate space ownership
 *   retry_task             — reset failed/cancelled task to pending
 *   cancel_task            — cancel task (with optional workflow run cancellation)
 *   reassign_task          — change agent assignment for a task
 *
 * Also covers the resolveSpaceId / activeSpaceId fallback mechanism for each tool.
 */

import { describe, it, test, expect, mock, beforeEach, afterEach } from 'bun:test';
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
import { SpaceManager } from '../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../src/lib/space/runtime/space-runtime.ts';
import {
	createGlobalSpacesToolHandlers,
	type GlobalSpacesToolsConfig,
	type GlobalSpacesState,
} from '../../../src/lib/space/tools/global-spaces-tools.ts';
import type { Space, SpaceAutonomyLevel, SpaceWorkflow } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Section 1: Mock-based fixtures for autonomy level tests
// ---------------------------------------------------------------------------

const NOW = Date.now();

function makeSpace(overrides: Partial<Space> = {}): Space {
	return {
		id: 'space-1',
		workspacePath: '/tmp/test-ws',
		name: 'Test Space',
		description: '',
		backgroundContext: '',
		instructions: '',
		sessionIds: [],
		status: 'active',
		autonomyLevel: 'supervised',
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

function makeSpaceManager(space: Space) {
	return {
		createSpace: mock(async () => space),
		getSpace: mock(async () => space),
		listSpaces: mock(async () => [space]),
		updateSpace: mock(async () => space),
		archiveSpace: mock(async () => ({ ...space, status: 'archived' as const })),
		deleteSpace: mock(async () => true),
		addSession: mock(async () => space),
		removeSession: mock(async () => space),
	};
}

function makeMockConfig(spaceManager: ReturnType<typeof makeSpaceManager>): GlobalSpacesToolsConfig {
	return {
		spaceManager: spaceManager as unknown as SpaceManager,
		spaceAgentManager: {
			listBySpaceId: mock(() => []),
		} as unknown as SpaceAgentManager,
		runtime: {} as unknown as SpaceRuntime,
		workflowManager: {
			listWorkflows: mock(() => []),
		} as unknown as SpaceWorkflowManager,
		taskRepo: {} as unknown as SpaceTaskRepository,
		workflowRunRepo: {} as unknown as SpaceWorkflowRunRepository,
		// db not exercised by autonomy-level tests; cast to satisfy type
		db: null as unknown as BunDatabase,
	};
}

function makeMockState(): GlobalSpacesState {
	return { activeSpaceId: 'space-1' };
}

function parseResult(result: { content: Array<{ type: 'text'; text: string }> }) {
	return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Section 1a: create_space autonomy_level
// ---------------------------------------------------------------------------

describe('global-spaces-tools: create_space autonomy_level', () => {
	let spaceManager: ReturnType<typeof makeSpaceManager>;
	let handlers: ReturnType<typeof createGlobalSpacesToolHandlers>;

	beforeEach(() => {
		spaceManager = makeSpaceManager(makeSpace({ autonomyLevel: 'supervised' }));
		handlers = createGlobalSpacesToolHandlers(makeMockConfig(spaceManager), makeMockState());
	});

	it('passes autonomy_level=supervised to SpaceManager.createSpace', async () => {
		const result = parseResult(
			await handlers.create_space({
				name: 'My Space',
				workspace_path: '/tmp/ws',
				autonomy_level: 'supervised',
			})
		);

		expect(result.success).toBe(true);
		expect(spaceManager.createSpace).toHaveBeenCalledTimes(1);
		const [params] = (spaceManager.createSpace as ReturnType<typeof mock>).mock.calls[0];
		expect(params.autonomyLevel).toBe('supervised');
	});

	it('passes autonomy_level=semi_autonomous to SpaceManager.createSpace', async () => {
		const semiSpace = makeSpace({ autonomyLevel: 'semi_autonomous' });
		(spaceManager.createSpace as ReturnType<typeof mock>).mockResolvedValue(semiSpace);

		const result = parseResult(
			await handlers.create_space({
				name: 'Semi Space',
				workspace_path: '/tmp/ws',
				autonomy_level: 'semi_autonomous',
			})
		);

		expect(result.success).toBe(true);
		const [params] = (spaceManager.createSpace as ReturnType<typeof mock>).mock.calls[0];
		expect(params.autonomyLevel).toBe('semi_autonomous');
	});

	it('does not set autonomyLevel when autonomy_level is omitted', async () => {
		await handlers.create_space({ name: 'My Space', workspace_path: '/tmp/ws' });

		const [params] = (spaceManager.createSpace as ReturnType<typeof mock>).mock.calls[0];
		expect(params.autonomyLevel).toBeUndefined();
	});

	it('returns success with the space returned by SpaceManager', async () => {
		const space = makeSpace({ name: 'My Space', autonomyLevel: 'semi_autonomous' });
		(spaceManager.createSpace as ReturnType<typeof mock>).mockResolvedValue(space);

		const result = parseResult(
			await handlers.create_space({
				name: 'My Space',
				workspace_path: '/tmp/ws',
				autonomy_level: 'semi_autonomous',
			})
		);

		expect(result.success).toBe(true);
		expect(result.space.autonomyLevel).toBe('semi_autonomous');
	});

	it('returns success:false on SpaceManager error', async () => {
		(spaceManager.createSpace as ReturnType<typeof mock>).mockRejectedValue(
			new Error('Workspace path does not exist: /tmp/ws')
		);

		const result = parseResult(
			await handlers.create_space({ name: 'Bad', workspace_path: '/tmp/ws' })
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('Workspace path does not exist');
	});
});

// ---------------------------------------------------------------------------
// Section 1b: update_space autonomy_level
// ---------------------------------------------------------------------------

describe('global-spaces-tools: update_space autonomy_level', () => {
	let spaceManager: ReturnType<typeof makeSpaceManager>;
	let handlers: ReturnType<typeof createGlobalSpacesToolHandlers>;

	beforeEach(() => {
		spaceManager = makeSpaceManager(makeSpace());
		handlers = createGlobalSpacesToolHandlers(makeMockConfig(spaceManager), makeMockState());
	});

	it('passes autonomy_level=semi_autonomous to SpaceManager.updateSpace', async () => {
		const updatedSpace = makeSpace({ autonomyLevel: 'semi_autonomous' });
		(spaceManager.updateSpace as ReturnType<typeof mock>).mockResolvedValue(updatedSpace);

		const result = parseResult(
			await handlers.update_space({
				space_id: 'space-1',
				autonomy_level: 'semi_autonomous',
			})
		);

		expect(result.success).toBe(true);
		const [id, params] = (spaceManager.updateSpace as ReturnType<typeof mock>).mock.calls[0];
		expect(id).toBe('space-1');
		expect(params.autonomyLevel).toBe('semi_autonomous');
	});

	it('passes autonomy_level=supervised to SpaceManager.updateSpace', async () => {
		await handlers.update_space({ space_id: 'space-1', autonomy_level: 'supervised' });

		const [, params] = (spaceManager.updateSpace as ReturnType<typeof mock>).mock.calls[0];
		expect(params.autonomyLevel).toBe('supervised');
	});

	it('does not set autonomyLevel in params when autonomy_level is omitted', async () => {
		await handlers.update_space({ space_id: 'space-1', name: 'New Name' });

		const [, params] = (spaceManager.updateSpace as ReturnType<typeof mock>).mock.calls[0];
		expect(params.autonomyLevel).toBeUndefined();
		expect(params.name).toBe('New Name');
	});

	it('passes all fields including autonomy_level together', async () => {
		await handlers.update_space({
			space_id: 'space-1',
			name: 'Updated',
			description: 'New desc',
			autonomy_level: 'semi_autonomous',
		});

		const [id, params] = (spaceManager.updateSpace as ReturnType<typeof mock>).mock.calls[0];
		expect(id).toBe('space-1');
		expect(params.name).toBe('Updated');
		expect(params.description).toBe('New desc');
		expect(params.autonomyLevel).toBe('semi_autonomous');
	});

	it('returns success with space from SpaceManager including updated autonomyLevel', async () => {
		const updatedSpace = makeSpace({ autonomyLevel: 'semi_autonomous' as SpaceAutonomyLevel });
		(spaceManager.updateSpace as ReturnType<typeof mock>).mockResolvedValue(updatedSpace);

		const result = parseResult(
			await handlers.update_space({
				space_id: 'space-1',
				autonomy_level: 'semi_autonomous',
			})
		);

		expect(result.success).toBe(true);
		expect(result.space.autonomyLevel).toBe('semi_autonomous');
	});

	it('returns success:false on SpaceManager error', async () => {
		(spaceManager.updateSpace as ReturnType<typeof mock>).mockRejectedValue(
			new Error('Space not found: bad-id')
		);

		const result = parseResult(
			await handlers.update_space({ space_id: 'bad-id', autonomy_level: 'supervised' })
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('Space not found');
	});
});

// ---------------------------------------------------------------------------
// Section 2: Real-DB helpers for coordination tool tests
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-global-spaces-tools',
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

function buildSingleStepWorkflow(
	spaceId: string,
	workflowManager: SpaceWorkflowManager,
	agentId: string,
	name: string
): SpaceWorkflow {
	const stepId = `step-${Math.random().toString(36).slice(2)}`;
	return workflowManager.createWorkflow({
		spaceId,
		name,
		steps: [{ id: stepId, name: 'Work', agentId }],
		transitions: [],
		startStepId: stepId,
		rules: [],
		tags: [],
	});
}

interface TestCtx {
	db: BunDatabase;
	dir: string;
	spaceId: string;
	otherSpaceId: string;
	agentId: string;
	workflowManager: SpaceWorkflowManager;
	workflowRunRepo: SpaceWorkflowRunRepository;
	taskRepo: SpaceTaskRepository;
	runtime: SpaceRuntime;
	spaceManager: SpaceManager;
	spaceAgentManager: SpaceAgentManager;
}

function makeCtx(): TestCtx {
	const { db, dir } = makeDb();
	const spaceId = 'space-global-tools-test';
	const otherSpaceId = 'space-other-test';
	const workspacePath = '/tmp/test-workspace';

	seedSpaceRow(db, spaceId, workspacePath);
	seedSpaceRow(db, otherSpaceId, '/tmp/other-workspace');

	const agentId = 'agent-coder-1';
	seedAgentRow(db, agentId, spaceId, 'Coder', 'coder');

	const agentRepo = new SpaceAgentRepository(db);
	const spaceAgentManager = new SpaceAgentManager(agentRepo);

	const workflowRepo = new SpaceWorkflowRepository(db);
	const workflowManager = new SpaceWorkflowManager(workflowRepo);

	const workflowRunRepo = new SpaceWorkflowRunRepository(db);
	const taskRepo = new SpaceTaskRepository(db);
	const spaceManager = new SpaceManager(db);

	const runtime = new SpaceRuntime({
		db,
		spaceManager,
		spaceAgentManager,
		spaceWorkflowManager: workflowManager,
		workflowRunRepo,
		taskRepo,
	});

	return {
		db,
		dir,
		spaceId,
		otherSpaceId,
		agentId,
		workflowManager,
		workflowRunRepo,
		taskRepo,
		runtime,
		spaceManager,
		spaceAgentManager,
	};
}

function makeHandlers(ctx: TestCtx, state: GlobalSpacesState) {
	return createGlobalSpacesToolHandlers(
		{
			spaceManager: ctx.spaceManager,
			spaceAgentManager: ctx.spaceAgentManager,
			runtime: ctx.runtime,
			workflowManager: ctx.workflowManager,
			taskRepo: ctx.taskRepo,
			workflowRunRepo: ctx.workflowRunRepo,
			db: ctx.db,
		},
		state
	);
}

// ---------------------------------------------------------------------------
// create_standalone_task
// ---------------------------------------------------------------------------

describe('createGlobalSpacesToolHandlers — create_standalone_task', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('creates task with explicit space_id', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const result = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'My task',
			description: 'Do something',
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.title).toBe('My task');
		expect(parsed.task.description).toBe('Do something');
		expect(parsed.task.spaceId).toBe(ctx.spaceId);
		expect(parsed.task.status).toBe('pending');
		expect(parsed.space_id).toBe(ctx.spaceId);
	});

	test('creates task using active space context when no space_id provided', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: ctx.spaceId });

		const result = await handlers.create_standalone_task({
			title: 'Active space task',
			description: 'Via active context',
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.spaceId).toBe(ctx.spaceId);
	});

	test('returns error when no space context is available', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const result = await handlers.create_standalone_task({
			title: 'Orphan task',
			description: 'No space',
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('No space specified');
	});

	test('creates task with all optional fields', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const result = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'Full task',
			description: 'Full description',
			priority: 'high',
			task_type: 'coding',
			assigned_agent: 'general',
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.priority).toBe('high');
		expect(parsed.task.taskType).toBe('coding');
		expect(parsed.task.assignedAgent).toBe('general');
	});

	test('returns error when dependency task does not exist', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const result = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'Dependent task',
			description: 'Depends on ghost',
			depends_on: ['non-existent-task-id'],
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toBeDefined();
	});

	test('creates task with depends_on pointing to an existing task', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const r1 = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'First task',
			description: 'Do first',
		});
		const firstTaskId = JSON.parse(r1.content[0].text).task.id;

		const result = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'Second task',
			description: 'Do second',
			depends_on: [firstTaskId],
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.task.dependsOn).toContain(firstTaskId);
	});
});

// ---------------------------------------------------------------------------
// get_task_detail
// ---------------------------------------------------------------------------

describe('createGlobalSpacesToolHandlers — get_task_detail', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns full task detail when task exists', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const createResult = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'Detail task',
			description: 'For detail test',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		const result = await handlers.get_task_detail({ task_id: taskId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.task.id).toBe(taskId);
		expect(parsed.task.title).toBe('Detail task');
	});

	test('returns error when task does not exist', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const result = await handlers.get_task_detail({ task_id: 'no-such-task' });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('no-such-task');
	});

	test('validates task belongs to explicit space_id', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const createResult = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'Space A task',
			description: 'Belongs to space A',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		const result = await handlers.get_task_detail({
			task_id: taskId,
			space_id: ctx.otherSpaceId,
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain(ctx.otherSpaceId);
	});

	test('validates task belongs to active space context', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: ctx.otherSpaceId });

		const createResult = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'Wrong space task',
			description: 'Should fail validation',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		const result = await handlers.get_task_detail({ task_id: taskId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain(ctx.otherSpaceId);
	});

	test('returns task without space validation when no space context available', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const createResult = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'No context task',
			description: 'Should succeed without context',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		const result = await handlers.get_task_detail({ task_id: taskId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.task.id).toBe(taskId);
	});
});

// ---------------------------------------------------------------------------
// retry_task
// ---------------------------------------------------------------------------

describe('createGlobalSpacesToolHandlers — retry_task', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	async function createAndFailTask(handlers: ReturnType<typeof makeHandlers>): Promise<string> {
		const createResult = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'Fail task',
			description: 'Will fail',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;
		ctx.taskRepo.updateTask(taskId, { status: 'in_progress' });
		ctx.taskRepo.updateTask(taskId, { status: 'needs_attention', error: 'Something went wrong' });
		return taskId;
	}

	test('resets a needs_attention task to pending', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });
		const taskId = await createAndFailTask(handlers);

		const result = await handlers.retry_task({ task_id: taskId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.task.status).toBe('pending');
		// null DB values become undefined in SpaceTask and are omitted in JSON
		expect(parsed.task.error).toBeUndefined();
	});

	test('retries with updated description', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });
		const taskId = await createAndFailTask(handlers);

		const result = await handlers.retry_task({
			task_id: taskId,
			description: 'Updated description on retry',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.task.status).toBe('pending');
		expect(parsed.task.description).toBe('Updated description on retry');
	});

	test('returns error when task does not exist', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const result = await handlers.retry_task({ task_id: 'ghost-task' });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('ghost-task');
	});

	test('returns error when task is in completed status', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const createResult = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'Completed task',
			description: 'Already done',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;
		ctx.taskRepo.updateTask(taskId, { status: 'in_progress' });
		ctx.taskRepo.updateTask(taskId, { status: 'completed' });

		const result = await handlers.retry_task({ task_id: taskId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('completed');
	});

	test('returns error when task belongs to different space', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });
		const taskId = await createAndFailTask(handlers);

		const result = await handlers.retry_task({
			task_id: taskId,
			space_id: ctx.otherSpaceId,
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain(ctx.otherSpaceId);
	});

	test('uses active space context for ownership validation', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: ctx.spaceId });
		const taskId = await createAndFailTask(handlers);

		const result = await handlers.retry_task({ task_id: taskId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.task.status).toBe('pending');
	});
});

// ---------------------------------------------------------------------------
// cancel_task
// ---------------------------------------------------------------------------

describe('createGlobalSpacesToolHandlers — cancel_task', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('cancels a pending task', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const createResult = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'Cancel me',
			description: 'Will be cancelled',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		const result = await handlers.cancel_task({ task_id: taskId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.task.status).toBe('cancelled');
		expect(parsed.cancelledWorkflowRunId).toBeNull();
	});

	test('returns error when task does not exist', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const result = await handlers.cancel_task({ task_id: 'ghost-id' });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('ghost-id');
	});

	test('returns error when cancelling a completed task (invalid transition)', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const createResult = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'Completed task',
			description: 'Already done',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;
		ctx.taskRepo.updateTask(taskId, { status: 'in_progress' });
		ctx.taskRepo.updateTask(taskId, { status: 'completed' });

		const result = await handlers.cancel_task({ task_id: taskId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBeDefined();
	});

	test('cancels associated workflow run when cancel_workflow_run is true', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: ctx.spaceId });
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Test WF');

		const startResult = await handlers.start_workflow_run({
			space_id: ctx.spaceId,
			workflow_id: wf.id,
			title: 'run to cancel',
		});
		const { run, tasks } = JSON.parse(startResult.content[0].text);
		const taskId = tasks[0].id;

		ctx.taskRepo.updateTask(taskId, { status: 'in_progress' });

		const result = await handlers.cancel_task({
			task_id: taskId,
			cancel_workflow_run: true,
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.task.status).toBe('cancelled');
		expect(parsed.cancelledWorkflowRunId).toBe(run.id);

		const updatedRun = ctx.workflowRunRepo.getRun(run.id);
		expect(updatedRun?.status).toBe('cancelled');
	});

	test('does not cancel workflow run when cancel_workflow_run is false', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: ctx.spaceId });
		const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Keep WF');

		const startResult = await handlers.start_workflow_run({
			space_id: ctx.spaceId,
			workflow_id: wf.id,
			title: 'run to keep',
		});
		const { run, tasks } = JSON.parse(startResult.content[0].text);
		const taskId = tasks[0].id;
		ctx.taskRepo.updateTask(taskId, { status: 'in_progress' });

		const result = await handlers.cancel_task({
			task_id: taskId,
			cancel_workflow_run: false,
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.cancelledWorkflowRunId).toBeNull();

		const updatedRun = ctx.workflowRunRepo.getRun(run.id);
		expect(updatedRun?.status).toBe('in_progress');
	});

	test('cancel_workflow_run: true on standalone task (no workflowRunId) is a no-op', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const createResult = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'Standalone task',
			description: 'No workflow run',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		const result = await handlers.cancel_task({
			task_id: taskId,
			cancel_workflow_run: true,
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.task.status).toBe('cancelled');
		expect(parsed.cancelledWorkflowRunId).toBeNull();
	});

	test('returns error when task belongs to different space', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const createResult = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'Task in space A',
			description: 'Cancel from wrong space',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		const result = await handlers.cancel_task({
			task_id: taskId,
			space_id: ctx.otherSpaceId,
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain(ctx.otherSpaceId);
	});

	test('returns error when cancelling a completed task (invalid transition)', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const createResult = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'Completed task',
			description: 'Already done',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;
		ctx.taskRepo.updateTask(taskId, { status: 'in_progress' });
		ctx.taskRepo.updateTask(taskId, { status: 'completed' });

		const result = await handlers.cancel_task({ task_id: taskId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBeDefined();
	});

	test('cancel_workflow_run: true on standalone task (no workflowRunId) is a no-op', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const createResult = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'Standalone task',
			description: 'No workflow run',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		const result = await handlers.cancel_task({
			task_id: taskId,
			cancel_workflow_run: true,
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.task.status).toBe('cancelled');
		// No workflow run to cancel — should be null
		expect(parsed.cancelledWorkflowRunId).toBeNull();
	});

	test('cascades cancellation to dependent pending tasks', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const r1 = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'Parent task',
			description: 'Parent',
		});
		const parentId = JSON.parse(r1.content[0].text).task.id;

		const r2 = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'Child task',
			description: 'Child',
			depends_on: [parentId],
		});
		const childId = JSON.parse(r2.content[0].text).task.id;

		await handlers.cancel_task({ task_id: parentId });

		const childTask = ctx.taskRepo.getTask(childId);
		expect(childTask?.status).toBe('cancelled');
	});
});

// ---------------------------------------------------------------------------
// reassign_task
// ---------------------------------------------------------------------------

describe('createGlobalSpacesToolHandlers — reassign_task', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('reassigns a pending task to a custom agent', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const createResult = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'Reassign me',
			description: 'Will be reassigned',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		const result = await handlers.reassign_task({
			task_id: taskId,
			custom_agent_id: 'custom-agent-x',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.task.customAgentId).toBe('custom-agent-x');
	});

	test('clears custom agent by setting custom_agent_id to null', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const createResult = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'Clear agent task',
			description: 'Will clear custom agent',
			custom_agent_id: 'custom-agent-to-clear',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		const result = await handlers.reassign_task({
			task_id: taskId,
			custom_agent_id: null,
			assigned_agent: 'general',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		// null DB value becomes undefined in SpaceTask and is omitted in JSON
		expect(parsed.task.customAgentId).toBeUndefined();
		expect(parsed.task.assignedAgent).toBe('general');
	});

	test('returns error when task does not exist', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const result = await handlers.reassign_task({
			task_id: 'ghost-task',
			custom_agent_id: 'some-agent',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('ghost-task');
	});

	test('returns error when trying to reassign an in_progress task', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const createResult = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'In progress task',
			description: 'Cannot reassign',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;
		ctx.taskRepo.updateTask(taskId, { status: 'in_progress' });

		const result = await handlers.reassign_task({
			task_id: taskId,
			custom_agent_id: 'new-agent',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('in_progress');
	});

	test('returns error when task belongs to different space', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const createResult = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'Space A task',
			description: 'Reassign from wrong space',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		const result = await handlers.reassign_task({
			task_id: taskId,
			space_id: ctx.otherSpaceId,
			custom_agent_id: 'new-agent',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain(ctx.otherSpaceId);
	});

	test('reassigns a needs_attention task', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: null });

		const createResult = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'Failed task',
			description: 'Needs reassignment',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;
		ctx.taskRepo.updateTask(taskId, { status: 'in_progress' });
		ctx.taskRepo.updateTask(taskId, { status: 'needs_attention', error: 'failed' });

		const result = await handlers.reassign_task({
			task_id: taskId,
			custom_agent_id: 'backup-agent',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.task.customAgentId).toBe('backup-agent');
	});

	test('uses active space context for ownership validation', async () => {
		const handlers = makeHandlers(ctx, { activeSpaceId: ctx.spaceId });

		const createResult = await handlers.create_standalone_task({
			space_id: ctx.spaceId,
			title: 'Active context task',
			description: 'Reassign via active context',
		});
		const taskId = JSON.parse(createResult.content[0].text).task.id;

		const result = await handlers.reassign_task({
			task_id: taskId,
			custom_agent_id: 'agent-via-context',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.task.customAgentId).toBe('agent-via-context');
	});
});
