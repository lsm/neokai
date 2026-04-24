/**
 * Unit tests for the `mark_complete` Task Agent tool (PR 2/5).
 *
 * Contract:
 *   - Happy path: task in `approved` → transitions `approved → done`, clears
 *     post-approval tracking fields, emits `space.task.updated`.
 *   - Wrong status: returns a structured error suggesting `approve_task`.
 *   - `approve_task` on already-approved: returns a guardrail error.
 */

import { mock } from 'bun:test';

// Mirror the SDK mock used elsewhere so tests can reflect on tool metadata.
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
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { createTaskAgentToolHandlers } from '../../../../src/lib/space/tools/task-agent-tools.ts';
import type { Space } from '@neokai/shared';

function makeDb(): BunDatabase {
	const db = new BunDatabase(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return db;
}

function seedSpaceRow(db: BunDatabase, spaceId: string): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, autonomy_level, created_at, updated_at)
     VALUES (?, '/tmp/ws', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?, ?)`
	).run(spaceId, `Space ${spaceId}`, spaceId, 5, Date.now(), Date.now());
}

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, 'Coder', '', null, '[]', '', ?, ?)`
	).run(agentId, spaceId, Date.now(), Date.now());
}

function makeSpace(spaceId: string): Space {
	return {
		id: spaceId,
		workspacePath: '/tmp/ws',
		name: `Space ${spaceId}`,
		description: '',
		backgroundContext: '',
		instructions: '',
		sessionIds: [],
		status: 'active',
		autonomyLevel: 5,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

interface Ctx {
	db: BunDatabase;
	spaceId: string;
	space: Space;
	taskRepo: SpaceTaskRepository;
	artifactRepo: WorkflowRunArtifactRepository;
	nodeExecutionRepo: NodeExecutionRepository;
	workflowRunRepo: SpaceWorkflowRunRepository;
	workflowManager: SpaceWorkflowManager;
	taskManager: SpaceTaskManager;
}

function makeCtx(): Ctx {
	const db = makeDb();
	const spaceId = 'space-mc-test';
	seedSpaceRow(db, spaceId);
	seedAgentRow(db, 'agent-1', spaceId);

	const agentRepo = new SpaceAgentRepository(db);
	void new SpaceAgentManager(agentRepo);
	const workflowRepo = new SpaceWorkflowRepository(db);
	const workflowManager = new SpaceWorkflowManager(workflowRepo);
	const workflowRunRepo = new SpaceWorkflowRunRepository(db);
	const taskRepo = new SpaceTaskRepository(db);
	const artifactRepo = new WorkflowRunArtifactRepository(db);
	const nodeExecutionRepo = new NodeExecutionRepository(db);
	void new SpaceManager(db);
	const taskManager = new SpaceTaskManager(db, spaceId);

	return {
		db,
		spaceId,
		space: makeSpace(spaceId),
		taskRepo,
		artifactRepo,
		nodeExecutionRepo,
		workflowRunRepo,
		workflowManager,
		taskManager,
	};
}

describe('task-agent mark_complete', () => {
	let ctx: Ctx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
	});

	test('transitions approved → done and clears post-approval fields', async () => {
		// Arrange: create a task in `approved` with post-approval tracking stamped.
		const task = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'in_progress',
		});
		// Move through in_progress → approved (direct valid transition).
		await ctx.taskManager.setTaskStatus(task.id, 'approved', { approvalSource: 'agent' });
		ctx.taskRepo.updateTask(task.id, {
			postApprovalSessionId: 'session-xyz',
			postApprovalStartedAt: Date.now(),
			postApprovalBlockedReason: null,
		});

		const handlers = createTaskAgentToolHandlers({
			taskId: task.id,
			space: ctx.space,
			workflowRunId: 'no-run',
			taskRepo: ctx.taskRepo,
			artifactRepo: ctx.artifactRepo,
			nodeExecutionRepo: ctx.nodeExecutionRepo,
			taskManager: ctx.taskManager,
			messageInjector: async () => {},
		});

		// Act.
		const result = await handlers.mark_complete({});
		const parsed = JSON.parse(result.content[0].text);

		// Assert handler response.
		expect(parsed.success).toBe(true);
		expect(parsed.taskId).toBe(task.id);
		expect(parsed.message).toContain('done');

		// Assert task state.
		const final = ctx.taskRepo.getTask(task.id);
		expect(final?.status).toBe('done');
		expect(final?.postApprovalSessionId).toBeNull();
		expect(final?.postApprovalStartedAt).toBeNull();
		expect(final?.postApprovalBlockedReason).toBeNull();
	});

	test('rejects when task is not approved — suggests approve_task', async () => {
		const task = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'in_progress',
		});
		const handlers = createTaskAgentToolHandlers({
			taskId: task.id,
			space: ctx.space,
			workflowRunId: 'no-run',
			taskRepo: ctx.taskRepo,
			artifactRepo: ctx.artifactRepo,
			nodeExecutionRepo: ctx.nodeExecutionRepo,
			taskManager: ctx.taskManager,
			messageInjector: async () => {},
		});

		const result = await handlers.mark_complete({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('approved');
		expect(parsed.error).toContain('approve_task');

		// Task state must be unchanged.
		const final = ctx.taskRepo.getTask(task.id);
		expect(final?.status).toBe('in_progress');
	});

	test('rejects when task not found', async () => {
		const handlers = createTaskAgentToolHandlers({
			taskId: 'no-such-task',
			space: ctx.space,
			workflowRunId: 'no-run',
			taskRepo: ctx.taskRepo,
			artifactRepo: ctx.artifactRepo,
			nodeExecutionRepo: ctx.nodeExecutionRepo,
			taskManager: ctx.taskManager,
			messageInjector: async () => {},
		});
		const result = await handlers.mark_complete({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('no-such-task');
	});
});

describe('task-agent approve_task guardrail (already-approved)', () => {
	let ctx: Ctx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
	});

	test('rejects approve_task when task is already approved', async () => {
		const task = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'in_progress',
		});
		await ctx.taskManager.setTaskStatus(task.id, 'approved', { approvalSource: 'agent' });

		const handlers = createTaskAgentToolHandlers({
			taskId: task.id,
			space: ctx.space,
			workflowRunId: 'no-run',
			taskRepo: ctx.taskRepo,
			artifactRepo: ctx.artifactRepo,
			nodeExecutionRepo: ctx.nodeExecutionRepo,
			taskManager: ctx.taskManager,
			messageInjector: async () => {},
		});
		const result = await handlers.approve_task({});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('mark_complete');
		expect(parsed.error).toContain("'approved'");
	});
});
