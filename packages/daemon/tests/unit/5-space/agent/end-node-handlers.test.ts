/**
 * Unit tests for createEndNodeHandlers() — the Design v2 two-tool contract
 * for end-node agents.
 *
 * Covers:
 *   - approve_task        — autonomy-gated self-close
 *   - submit_for_approval — always-available human sign-off request
 *
 * Note: report_result was removed. Audit records are now written via
 * save_artifact({ type: 'result', append: true }) on the node-agent tool surface.
 *
 * These handlers were extracted from task-agent-manager.ts so they can be
 * unit-tested directly with a real SQLite DB and no live agent sessions.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { createEndNodeHandlers } from '../../../../src/lib/space/tools/end-node-handlers.ts';
import type { EndNodeHandlerDeps } from '../../../../src/lib/space/tools/end-node-handlers.ts';
import type { Space, SpaceWorkflow } from '@neokai/shared';
import type { DaemonHub } from '../../../../src/lib/daemon-hub.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
	// Use in-memory SQLite — faster than file-based DB and avoids filesystem
	// I/O contention that caused beforeEach hook timeouts in CI.
	const db = new BunDatabase(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return db;
}

function seedSpaceRow(db: BunDatabase, spaceId: string, autonomyLevel = 1): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, autonomy_level, created_at, updated_at)
     VALUES (?, '/tmp', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?, ?)`
	).run(spaceId, `Space ${spaceId}`, spaceId, autonomyLevel, Date.now(), Date.now());
}

function makeSpace(spaceId: string, autonomyLevel?: number): Space {
	return {
		id: spaceId,
		workspacePath: '/tmp',
		name: `Space ${spaceId}`,
		description: '',
		backgroundContext: '',
		instructions: '',
		sessionIds: [],
		status: 'active',
		autonomyLevel,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function makeWorkflow(completionAutonomyLevel: number, endNodeId = 'end-node'): SpaceWorkflow {
	return {
		id: 'wf-test',
		spaceId: 'space-test',
		name: 'Test WF',
		description: '',
		nodes: [{ id: endNodeId, name: 'end', agents: [] }],
		channels: [],
		gates: [],
		startNodeId: endNodeId,
		endNodeId,
		completionAutonomyLevel,
		tags: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	} as unknown as SpaceWorkflow;
}

interface MockHubCtx {
	hub: Pick<DaemonHub, 'emit'>;
	emitted: Array<{ name: string; payload: Record<string, unknown> }>;
}

function makeMockHub(): MockHubCtx {
	const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];
	const hub = {
		emit: mock((name: string, payload: Record<string, unknown>) => {
			emitted.push({ name, payload });
			return Promise.resolve();
		}),
	} as unknown as Pick<DaemonHub, 'emit'>;
	return { hub, emitted };
}

interface TestCtx {
	db: BunDatabase;
	spaceId: string;
	taskRepo: SpaceTaskRepository;
	taskManager: SpaceTaskManager;
}

function makeCtx(autonomyLevel = 1): TestCtx {
	const db = makeDb();
	const spaceId = 'space-end-node-test';
	seedSpaceRow(db, spaceId, autonomyLevel);
	return {
		db,
		spaceId,
		taskRepo: new SpaceTaskRepository(db),
		// Real SpaceTaskManager so the centralised transition validator runs
		// inside `submitTaskForReview` — exercises the same code path that the
		// production wiring takes from `task-agent-manager.ts`.
		taskManager: new SpaceTaskManager(db, spaceId),
	};
}

/** Build deps with sensible defaults + overrides. */
function makeDeps(
	ctx: TestCtx,
	taskId: string,
	overrides: Partial<EndNodeHandlerDeps> = {}
): EndNodeHandlerDeps {
	return {
		taskId,
		spaceId: ctx.spaceId,
		workflow: makeWorkflow(3),
		workflowNodeId: 'end-node',
		agentName: 'test-agent',
		taskRepo: ctx.taskRepo,
		taskManager: ctx.taskManager,
		spaceManager: {
			getSpace: async () => makeSpace(ctx.spaceId, 3),
		},
		...overrides,
	};
}

// ===========================================================================
// approve_task — autonomy-gated self-close
// ===========================================================================

describe('createEndNodeHandlers — approve_task', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
	});

	test('returns error when space.autonomyLevel < workflow.completionAutonomyLevel', async () => {
		const task = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'in_progress',
		});
		const { onApproveTask } = createEndNodeHandlers(
			makeDeps(ctx, task.id, {
				workflow: makeWorkflow(3),
				spaceManager: { getSpace: async () => makeSpace(ctx.spaceId, 1) },
			})
		);

		const out = await onApproveTask({});
		const parsed = JSON.parse(out.content[0].text);

		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('approve_task not permitted');
		expect(parsed.error).toContain('space autonomy level 1');
		expect(parsed.error).toContain('completionAutonomyLevel 3');

		// task unchanged
		const t = ctx.taskRepo.getTask(task.id);
		expect(t?.reportedStatus).toBeFalsy();
	});

	test('defaults to level 1 when space has no autonomy set', async () => {
		const task = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'in_progress',
		});
		const { onApproveTask } = createEndNodeHandlers(
			makeDeps(ctx, task.id, {
				workflow: makeWorkflow(3),
				spaceManager: { getSpace: async () => makeSpace(ctx.spaceId, undefined) },
			})
		);

		const out = await onApproveTask({});
		const parsed = JSON.parse(out.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('space autonomy level 1');
	});

	test('defaults to required level 5 when workflow is null (blocks approval)', async () => {
		const task = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'in_progress',
		});
		const { onApproveTask } = createEndNodeHandlers(
			makeDeps(ctx, task.id, {
				workflow: null,
				spaceManager: { getSpace: async () => makeSpace(ctx.spaceId, 4) },
			})
		);

		const out = await onApproveTask({});
		const parsed = JSON.parse(out.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('completionAutonomyLevel 5');
	});

	test('sets reportedStatus=done when autonomy is sufficient', async () => {
		const task = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'in_progress',
		});
		const { onApproveTask } = createEndNodeHandlers(
			makeDeps(ctx, task.id, {
				workflow: makeWorkflow(3),
				spaceManager: { getSpace: async () => makeSpace(ctx.spaceId, 3) },
			})
		);

		const out = await onApproveTask({});
		const parsed = JSON.parse(out.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.taskId).toBe(task.id);
		expect(parsed.message).toContain('completion-action pipeline');

		const t = ctx.taskRepo.getTask(task.id);
		expect(t?.reportedStatus).toBe('done');
	});

	test('clears pending-completion fields that were set by a prior submit_for_approval', async () => {
		const task = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'review',
		});
		// Prime the pending-completion fields as if submit_for_approval ran first.
		ctx.taskRepo.updateTask(task.id, {
			pendingCheckpointType: 'task_completion',
			pendingCompletionSubmittedByNodeId: 'end-node',
			pendingCompletionSubmittedAt: Date.now() - 1000,
			pendingCompletionReason: 'prior reason',
		});

		const { onApproveTask } = createEndNodeHandlers(
			makeDeps(ctx, task.id, {
				workflow: makeWorkflow(2),
				spaceManager: { getSpace: async () => makeSpace(ctx.spaceId, 3) },
			})
		);

		const out = await onApproveTask({});
		expect(JSON.parse(out.content[0].text).success).toBe(true);

		const t = ctx.taskRepo.getTask(task.id);
		expect(t?.reportedStatus).toBe('done');
		expect(t?.pendingCheckpointType).toBeNull();
		expect(t?.pendingCompletionSubmittedByNodeId).toBeNull();
		expect(t?.pendingCompletionSubmittedAt).toBeNull();
		expect(t?.pendingCompletionReason).toBeNull();
	});

	test('emits space.task.updated with the updated task on success', async () => {
		const task = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'in_progress',
		});
		const { hub, emitted } = makeMockHub();
		const { onApproveTask } = createEndNodeHandlers(
			makeDeps(ctx, task.id, {
				workflow: makeWorkflow(3),
				spaceManager: { getSpace: async () => makeSpace(ctx.spaceId, 3) },
				daemonHub: hub,
			})
		);

		await onApproveTask({});

		const updateEvents = emitted.filter((e) => e.name === 'space.task.updated');
		expect(updateEvents).toHaveLength(1);
		expect(updateEvents[0].payload.taskId).toBe(task.id);
		expect(updateEvents[0].payload.spaceId).toBe(ctx.spaceId);
		const emittedTask = updateEvents[0].payload.task as { id: string; reportedStatus: string };
		expect(emittedTask.id).toBe(task.id);
		expect(emittedTask.reportedStatus).toBe('done');
	});

	test('does NOT emit space.task.updated when permission check fails', async () => {
		const task = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'in_progress',
		});
		const { hub, emitted } = makeMockHub();
		const { onApproveTask } = createEndNodeHandlers(
			makeDeps(ctx, task.id, {
				workflow: makeWorkflow(5),
				spaceManager: { getSpace: async () => makeSpace(ctx.spaceId, 1) },
				daemonHub: hub,
			})
		);

		await onApproveTask({});
		expect(emitted).toHaveLength(0);
	});

	test('returns error when task does not exist (even at sufficient autonomy)', async () => {
		const { onApproveTask } = createEndNodeHandlers(
			makeDeps(ctx, 'ghost-task', {
				workflow: makeWorkflow(3),
				spaceManager: { getSpace: async () => makeSpace(ctx.spaceId, 5) },
			})
		);
		const out = await onApproveTask({});
		const parsed = JSON.parse(out.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('ghost-task');
	});
});

// ===========================================================================
// submit_for_approval — always available
// ===========================================================================

describe('createEndNodeHandlers — submit_for_approval', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
	});

	test('sets status=review and populates pending-completion fields', async () => {
		const task = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'in_progress',
		});
		const { onSubmitForApproval } = createEndNodeHandlers(
			makeDeps(ctx, task.id, { workflowNodeId: 'end-node-xyz' })
		);

		const before = Date.now();
		const out = await onSubmitForApproval({ reason: 'needs review' });
		const after = Date.now();

		const parsed = JSON.parse(out.content[0].text);
		expect(parsed.success).toBe(true);
		expect(parsed.message).toContain('submitted for human review');
		expect(parsed.message).toContain('needs review');

		const t = ctx.taskRepo.getTask(task.id);
		expect(t?.status).toBe('review');
		expect(t?.pendingCheckpointType).toBe('task_completion');
		expect(t?.pendingCompletionSubmittedByNodeId).toBe('end-node-xyz');
		expect(t?.pendingCompletionReason).toBe('needs review');
		expect(t?.pendingCompletionSubmittedAt).toBeGreaterThanOrEqual(before);
		expect(t?.pendingCompletionSubmittedAt).toBeLessThanOrEqual(after);
	});

	test('handles missing reason (optional field)', async () => {
		const task = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'in_progress',
		});
		const { onSubmitForApproval } = createEndNodeHandlers(makeDeps(ctx, task.id));

		const out = await onSubmitForApproval({});
		const parsed = JSON.parse(out.content[0].text);

		expect(parsed.success).toBe(true);
		// Message omits the "(reason: ...)" suffix when reason is missing.
		expect(parsed.message).not.toContain('(reason:');

		const t = ctx.taskRepo.getTask(task.id);
		expect(t?.status).toBe('review');
		expect(t?.pendingCompletionReason).toBeNull();
	});

	test('succeeds regardless of space autonomy level', async () => {
		// submit_for_approval must work even at level 1 (the most restrictive).
		const task = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'in_progress',
		});
		const { onSubmitForApproval } = createEndNodeHandlers(
			makeDeps(ctx, task.id, {
				workflow: makeWorkflow(5),
				spaceManager: { getSpace: async () => makeSpace(ctx.spaceId, 1) },
			})
		);

		const out = await onSubmitForApproval({ reason: 'low-autonomy submit' });
		const parsed = JSON.parse(out.content[0].text);
		expect(parsed.success).toBe(true);

		const t = ctx.taskRepo.getTask(task.id);
		expect(t?.status).toBe('review');
	});

	test('emits space.task.updated with the updated task', async () => {
		const task = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'in_progress',
		});
		const { hub, emitted } = makeMockHub();
		const { onSubmitForApproval } = createEndNodeHandlers(
			makeDeps(ctx, task.id, { daemonHub: hub })
		);

		await onSubmitForApproval({ reason: 'escalate' });

		const updateEvents = emitted.filter((e) => e.name === 'space.task.updated');
		expect(updateEvents).toHaveLength(1);
		expect(updateEvents[0].payload.taskId).toBe(task.id);
		const emittedTask = updateEvents[0].payload.task as {
			id: string;
			status: string;
			pendingCheckpointType: string;
		};
		expect(emittedTask.id).toBe(task.id);
		expect(emittedTask.status).toBe('review');
		expect(emittedTask.pendingCheckpointType).toBe('task_completion');
	});

	test('returns error when task does not exist', async () => {
		const { onSubmitForApproval } = createEndNodeHandlers(makeDeps(ctx, 'ghost'));
		const out = await onSubmitForApproval({ reason: 'x' });
		const parsed = JSON.parse(out.content[0].text);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('ghost');
	});
});

// ===========================================================================
// daemonHub is optional
// ===========================================================================

describe('createEndNodeHandlers — daemonHub is optional', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
	});

	test('approve_task succeeds without a daemonHub', async () => {
		const task = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'in_progress',
		});
		const { onApproveTask } = createEndNodeHandlers(
			makeDeps(ctx, task.id, {
				workflow: makeWorkflow(1),
				spaceManager: { getSpace: async () => makeSpace(ctx.spaceId, 5) },
				daemonHub: undefined,
			})
		);

		const out = await onApproveTask({});
		expect(JSON.parse(out.content[0].text).success).toBe(true);
		expect(ctx.taskRepo.getTask(task.id)?.reportedStatus).toBe('done');
	});

	test('submit_for_approval succeeds without a daemonHub', async () => {
		const task = ctx.taskRepo.createTask({
			spaceId: ctx.spaceId,
			title: 'T',
			description: '',
			status: 'in_progress',
		});
		const { onSubmitForApproval } = createEndNodeHandlers(
			makeDeps(ctx, task.id, { daemonHub: undefined })
		);

		const out = await onSubmitForApproval({});
		expect(JSON.parse(out.content[0].text).success).toBe(true);
		expect(ctx.taskRepo.getTask(task.id)?.status).toBe('review');
	});
});
