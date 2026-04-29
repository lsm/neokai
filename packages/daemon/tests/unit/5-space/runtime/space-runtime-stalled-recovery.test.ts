/**
 * SpaceRuntime — Stalled Workflow Run Recovery Tests (Task #120)
 *
 * Tests `recoverStalledRuns()` — the daemon-restart safety net that scans
 * `status='in_progress'` workflow runs and forces a sane terminal state for
 * runs that no agent will ever drive forward.
 *
 * Behaviour under test:
 *
 *   1. Run with all node executions `idle`/`cancelled` AND no completion
 *      signal → run + canonical task transitioned to `blocked` with
 *      block_reason `execution_failed` and a restart-aware result message;
 *      `task_blocked` and `workflow_run_blocked` notifications fire.
 *
 *   2. Run with all node executions terminal AND a completion signal
 *      (canonical task `reportedStatus='done'`, or task already `done`) →
 *      left untouched (still `in_progress`); the existing tick path will
 *      pick it up via CompletionDetector and finalize.
 *
 *   3. Run with at least one `pending`/`in_progress`/`blocked` execution →
 *      left untouched (the tick loop owns the next move).
 *
 *   4. Recovery is idempotent — calling `recoverStalledRuns()` twice (or
 *      via both `executeTick()` and the public method) only acts once.
 *
 *   5. Recovery is run as part of the first `executeTick()` (so daemon
 *      bootstrapping doesn't have to wire it up separately).
 *
 *   6. Orphan in_progress executions (dead session) are NOT touched by
 *      recovery — the existing crash-retry path in `processRunTick` owns
 *      them, including crash counting.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { ToolContinuationRecoveryRepository } from '../../../../src/storage/repositories/tool-continuation-recovery-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceWorkflow, SpaceRuntimeNotification, NodeExecutionStatus } from '@neokai/shared';

// ---------------------------------------------------------------------------
// DB / seed helpers (mirror the rehydration test fixtures)
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
	const db = new BunDatabase(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return db;
}

function seedSpaceRow(db: BunDatabase, spaceId: string, workspacePath = '/tmp/ws'): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
	).run(spaceId, workspacePath, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
	).run(agentId, spaceId, `Agent ${agentId}`, Date.now(), Date.now());
}

function buildLinearWorkflow(
	spaceId: string,
	workflowManager: SpaceWorkflowManager,
	nodes: Array<{ id: string; name: string; agentId: string }>
): SpaceWorkflow {
	const transitions = nodes.slice(0, -1).map((step, i) => ({
		from: step.id,
		to: nodes[i + 1].id,
		condition: { type: 'always' as const },
		order: 0,
	}));
	return workflowManager.createWorkflow({
		spaceId,
		name: `Workflow-${Date.now()}-${Math.random()}`,
		description: 'Test',
		nodes,
		transitions,
		startNodeId: nodes[0].id,
		rules: [],
		tags: [],
		completionAutonomyLevel: 3,
	});
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SpaceRuntime — recoverStalledRuns()', () => {
	let db: BunDatabase;

	let workflowRunRepo: SpaceWorkflowRunRepository;
	let taskRepo: SpaceTaskRepository;
	let agentManager: SpaceAgentManager;
	let workflowManager: SpaceWorkflowManager;
	let spaceManager: SpaceManager;
	let nodeExecutionRepo: NodeExecutionRepository;
	let notifications: SpaceRuntimeNotification[];

	const SPACE_ID = 'space-recovery-1';
	const AGENT = 'agent-recovery-1';
	const STEP_A = 'step-a';
	const STEP_B = 'step-b';

	function makeRuntime(overrides?: Partial<SpaceRuntimeConfig>): SpaceRuntime {
		const rt = new SpaceRuntime({
			db,
			spaceManager,
			spaceAgentManager: agentManager,
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			...overrides,
		});
		rt.setNotificationSink({
			notify: async (event: SpaceRuntimeNotification) => {
				notifications.push(event);
			},
		});
		return rt;
	}

	function findExec(runId: string, nodeId: string) {
		return nodeExecutionRepo.listByNode(runId, nodeId)[0];
	}

	function seedExec(
		runId: string,
		nodeId: string,
		agentName: string,
		status: NodeExecutionStatus,
		opts: { agentSessionId?: string | null; result?: string | null } = {}
	) {
		const existing = findExec(runId, nodeId);
		if (existing) {
			nodeExecutionRepo.update(existing.id, {
				status,
				agentSessionId: opts.agentSessionId ?? null,
				result: opts.result ?? null,
			});
			return existing;
		}
		const created = nodeExecutionRepo.createOrIgnore({
			workflowRunId: runId,
			workflowNodeId: nodeId,
			agentName,
			agentId: AGENT,
			status: 'pending',
		});
		nodeExecutionRepo.update(created.id, {
			status,
			agentSessionId: opts.agentSessionId ?? null,
			result: opts.result ?? null,
		});
		return created;
	}

	beforeEach(() => {
		db = makeDb();
		seedSpaceRow(db, SPACE_ID);
		seedAgentRow(db, AGENT, SPACE_ID);

		workflowRunRepo = new SpaceWorkflowRunRepository(db);
		taskRepo = new SpaceTaskRepository(db);
		const agentRepo = new SpaceAgentRepository(db);
		agentManager = new SpaceAgentManager(agentRepo);
		const workflowRepo = new SpaceWorkflowRepository(db);
		workflowManager = new SpaceWorkflowManager(workflowRepo);
		spaceManager = new SpaceManager(db);
		nodeExecutionRepo = new NodeExecutionRepository(db);
		notifications = [];
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			/* ignore */
		}
	});

	// -------------------------------------------------------------------------
	// 1. Stalled with no completion signal → blocked
	// -------------------------------------------------------------------------

	describe('orphaned tool_result waiting_rebind recovery', () => {
		test('queued continuation resets waiting_rebind execution to pending for one deterministic retry', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Step A', agentId: AGENT },
			]);
			db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);
			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Orphan Recovery Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');
			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Orphan Recovery Run',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: STEP_A,
				status: 'in_progress',
			});
			const execution = seedExec(run.id, STEP_A, 'Step A', 'waiting_rebind', {
				agentSessionId: 'dead-session',
				result: 'waiting for orphaned tool_result recovery',
			});
			const recoveryRepo = new ToolContinuationRecoveryRepository(db);
			recoveryRepo.ensureSchema();
			recoveryRepo.recordToolUse({
				toolUseId: 'tool-rebind-1',
				sessionId: 'dead-session',
				ttlMs: 60_000,
				owner: { executionId: execution.id, workflowRunId: run.id },
			});
			recoveryRepo.queueContinuation({
				toolUseId: 'tool-rebind-1',
				sessionId: 'dead-session',
				requestBody: { messages: [{ role: 'user', content: [] }] },
				reason: 'late continuation arrived after session timeout',
				ttlMs: 60_000,
			});

			const rt = makeRuntime({
				taskAgentManager: {
					rehydrate: async () => {},
					isSessionAlive: () => false,
					getAgentSessionById: () => null,
					isExecutionSpawning: () => false,
				} as any,
			});
			await rt.executeTick();

			const updated = nodeExecutionRepo.getById(execution.id)!;
			const inbox = recoveryRepo.listPendingInboxForExecution(execution.id);
			expect(updated.status).toBe('pending');
			expect(updated.agentSessionId).toBeNull();
			expect(updated.data?.orphanedToolContinuation).toMatchObject({
				state: 'rebound',
				retryCount: 1,
				queuedContinuations: 1,
			});
			expect(inbox).toHaveLength(0);
			expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');
			expect(notifications.some((event) => event.kind === 'task_retry')).toBe(true);
		});

		test('empty inbox with no active tool_use fails waiting_rebind execution forward to blocked', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Step A', agentId: AGENT },
			]);
			db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);
			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Expired Orphan Recovery Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');
			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Expired Orphan Recovery Run',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: STEP_A,
				status: 'in_progress',
			});
			const execution = seedExec(run.id, STEP_A, 'Step A', 'waiting_rebind', {
				agentSessionId: 'dead-session',
				result: 'waiting for orphaned tool_result recovery',
			});
			const recoveryRepo = new ToolContinuationRecoveryRepository(db);
			recoveryRepo.ensureSchema();

			const rt = makeRuntime({
				taskAgentManager: {
					rehydrate: async () => {},
					isSessionAlive: () => false,
					getAgentSessionById: () => null,
					isExecutionSpawning: () => false,
				} as any,
			});
			await rt.executeTick();

			const reason = 'orphaned tool_result recovery expired before a continuation arrived';
			const updated = nodeExecutionRepo.getById(execution.id)!;
			const updatedRun = workflowRunRepo.getRun(run.id)!;
			const updatedTask = taskRepo.getTask(task.id)!;
			const runBlockedEvents = notifications.filter(
				(event) => event.kind === 'workflow_run_blocked'
			);
			expect(updated.status).toBe('blocked');
			expect(updated.result).toBe(reason);
			expect(updated.data?.orphanedToolContinuation).toMatchObject({
				state: 'failed',
				retryCount: 0,
				reason,
			});
			expect(updatedRun.status).toBe('blocked');
			expect(updatedTask.status).toBe('blocked');
			expect(updatedTask.blockReason).toBe('execution_failed');
			expect(updatedTask.result).toBe(reason);
			expect(recoveryRepo.listPendingInboxForExecution(execution.id)).toHaveLength(0);
			expect(runBlockedEvents).toHaveLength(1);
			expect(runBlockedEvents[0]).toMatchObject({
				kind: 'workflow_run_blocked',
				spaceId: SPACE_ID,
				runId: run.id,
				reason,
			});
		});

		test('live waiting_rebind session is not failed forward after tool_use is consumed', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Step A', agentId: AGENT },
			]);
			db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);
			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Live Rebind Session Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');
			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Live Rebind Session Run',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: STEP_A,
				status: 'in_progress',
			});
			const execution = seedExec(run.id, STEP_A, 'Step A', 'waiting_rebind', {
				agentSessionId: 'live-session',
				result: 'waiting for orphaned tool_result recovery',
			});
			const recoveryRepo = new ToolContinuationRecoveryRepository(db);
			recoveryRepo.ensureSchema();
			recoveryRepo.recordToolUse({
				toolUseId: 'tool-live-consumed',
				sessionId: 'live-session',
				ttlMs: 60_000,
				owner: { executionId: execution.id, workflowRunId: run.id },
			});
			recoveryRepo.markConsumed('tool-live-consumed');

			const rt = makeRuntime({
				taskAgentManager: {
					rehydrate: async () => {},
					isSessionAlive: (sessionId: string) => sessionId === 'live-session',
					getAgentSessionById: () => null,
					isExecutionSpawning: () => false,
				} as any,
			});
			await rt.executeTick();

			expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('waiting_rebind');
			expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
			expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');
			expect(notifications.some((event) => event.kind === 'workflow_run_blocked')).toBe(false);
		});

		test('blocking one waiting_rebind execution stops later same-tick rebounds', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Step A', agentId: AGENT },
				{ id: STEP_B, name: 'Step B', agentId: AGENT },
			]);
			db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);
			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Multiple Waiting Rebind Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');
			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Multiple Waiting Rebind Run',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: STEP_A,
				status: 'in_progress',
			});
			const expiredExecution = seedExec(run.id, STEP_A, 'Step A', 'waiting_rebind', {
				agentSessionId: 'dead-session-a',
				result: 'waiting for orphaned tool_result recovery',
			});
			const reboundCandidate = seedExec(run.id, STEP_B, 'Step B', 'waiting_rebind', {
				agentSessionId: 'dead-session-b',
				result: 'waiting for orphaned tool_result recovery',
			});
			const recoveryRepo = new ToolContinuationRecoveryRepository(db);
			recoveryRepo.ensureSchema();
			recoveryRepo.recordToolUse({
				toolUseId: 'tool-rebind-after-block',
				sessionId: 'dead-session-b',
				ttlMs: 60_000,
				owner: { executionId: reboundCandidate.id, workflowRunId: run.id },
			});
			recoveryRepo.queueContinuation({
				toolUseId: 'tool-rebind-after-block',
				sessionId: 'dead-session-b',
				requestBody: { messages: [{ role: 'user', content: [] }] },
				reason: 'late continuation for sibling execution',
				ttlMs: 60_000,
			});

			const rt = makeRuntime({
				taskAgentManager: {
					rehydrate: async () => {},
					isSessionAlive: () => false,
					getAgentSessionById: () => null,
					isExecutionSpawning: () => false,
				} as any,
			});
			await rt.executeTick();

			expect(nodeExecutionRepo.getById(expiredExecution.id)?.status).toBe('blocked');
			expect(nodeExecutionRepo.getById(reboundCandidate.id)?.status).toBe('waiting_rebind');
			expect(recoveryRepo.listPendingInboxForExecution(reboundCandidate.id)).toHaveLength(1);
			expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
			expect(taskRepo.getTask(task.id)?.status).toBe('blocked');
			expect(notifications.filter((event) => event.kind === 'task_retry')).toHaveLength(0);
			expect(notifications.filter((event) => event.kind === 'workflow_run_blocked')).toHaveLength(
				1
			);
		});
	});

	describe('runs with all node executions terminal and no completion signal', () => {
		test('single-node run with idle execution → run blocked, task blocked, notifications emitted', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Step A', agentId: AGENT },
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Stalled Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Stalled Run',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: STEP_A,
				status: 'in_progress',
			});

			seedExec(run.id, STEP_A, 'Step A', 'idle');

			const rt = makeRuntime();
			await rt.recoverStalledRuns();

			// Run should be blocked
			const updatedRun = workflowRunRepo.getRun(run.id)!;
			expect(updatedRun.status).toBe('blocked');

			// Canonical task should be blocked with execution_failed reason
			const updatedTask = taskRepo.getTask(task.id)!;
			expect(updatedTask.status).toBe('blocked');
			expect(updatedTask.blockReason).toBe('execution_failed');
			expect(updatedTask.result).toContain('stalled across daemon restart');

			// Notifications fired
			const taskBlockedEvents = notifications.filter((n) => n.kind === 'task_blocked');
			const runBlockedEvents = notifications.filter((n) => n.kind === 'workflow_run_blocked');
			expect(taskBlockedEvents.length).toBe(1);
			expect(runBlockedEvents.length).toBe(1);
			expect(taskBlockedEvents[0]).toMatchObject({
				kind: 'task_blocked',
				spaceId: SPACE_ID,
				taskId: task.id,
			});
			expect(runBlockedEvents[0]).toMatchObject({
				kind: 'workflow_run_blocked',
				spaceId: SPACE_ID,
				runId: run.id,
			});
		});

		test('multi-node run with all idle/cancelled executions → blocked', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Step A', agentId: AGENT },
				{ id: STEP_B, name: 'Step B', agentId: AGENT },
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Multi-Stalled',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Multi-Stalled',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: STEP_A,
				status: 'in_progress',
			});

			seedExec(run.id, STEP_A, 'Step A', 'idle');
			seedExec(run.id, STEP_B, 'Step B', 'cancelled');

			const rt = makeRuntime();
			await rt.recoverStalledRuns();

			expect(workflowRunRepo.getRun(run.id)!.status).toBe('blocked');
		});

		test('run with no canonical task still transitions run → blocked (defensive)', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Step A', agentId: AGENT },
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Orphan Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// No task created — degenerate but possible state
			seedExec(run.id, STEP_A, 'Step A', 'idle');

			const rt = makeRuntime();
			await rt.recoverStalledRuns();

			expect(workflowRunRepo.getRun(run.id)!.status).toBe('blocked');
			// workflow_run_blocked still fires; no task_blocked because no canonical task
			expect(notifications.filter((n) => n.kind === 'workflow_run_blocked').length).toBe(1);
			expect(notifications.filter((n) => n.kind === 'task_blocked').length).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// 2. Completion signal recorded → leave for tick to finalize
	// -------------------------------------------------------------------------

	describe('runs with completion signal are left to the tick loop', () => {
		test('all idle executions + canonical task with reportedStatus="done" → not blocked', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Step A', agentId: AGENT },
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Completion Pending',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Completion Pending',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: STEP_A,
				status: 'in_progress',
			});
			taskRepo.updateTask(task.id, { reportedStatus: 'done' });

			seedExec(run.id, STEP_A, 'Step A', 'idle');

			const rt = makeRuntime();
			await rt.recoverStalledRuns();

			// Run still in_progress — tick loop will finalize
			expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
			// No blocked notifications
			expect(notifications.filter((n) => n.kind === 'workflow_run_blocked').length).toBe(0);
			expect(notifications.filter((n) => n.kind === 'task_blocked').length).toBe(0);
		});

		test('canonical task already done → not blocked', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Step A', agentId: AGENT },
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Done Task Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Done Task Run',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: STEP_A,
				status: 'done',
			});

			seedExec(run.id, STEP_A, 'Step A', 'idle');

			const rt = makeRuntime();
			await rt.recoverStalledRuns();

			expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
		});

		// -----------------------------------------------------------------------
		// Regression — task #127
		//
		// A task in `review` is paused waiting for human approval (the end-node
		// agent finished, all sibling executions correctly went `idle`). It is
		// NOT a stalled run. A daemon restart must leave the task and its run
		// untouched. Same applies to `approved` (post-approval executor may be
		// in flight, leaving prior node executions idle).
		// -----------------------------------------------------------------------

		test('canonical task in `review` → run + task untouched, no blocked notifications (task #127)', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Step A', agentId: AGENT },
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Review-Pending Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Review-Pending Run',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: STEP_A,
				status: 'review',
			});

			// All node executions correctly idle while we wait for the human.
			seedExec(run.id, STEP_A, 'Step A', 'idle');

			const rt = makeRuntime();
			await rt.recoverStalledRuns();

			// Run + task must be unchanged — `review` is "at rest", not stalled.
			expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
			const after = taskRepo.getTask(task.id)!;
			expect(after.status).toBe('review');
			expect(after.blockReason).toBeNull();
			// And no spurious blocked notifications.
			expect(notifications.filter((n) => n.kind === 'workflow_run_blocked').length).toBe(0);
			expect(notifications.filter((n) => n.kind === 'task_blocked').length).toBe(0);
		});

		test('canonical task in `review` with pendingCheckpointType=task_completion → not blocked', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Step A', agentId: AGENT },
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Submit-For-Approval Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Submit-For-Approval Run',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: STEP_A,
				status: 'review',
			});
			// Mirror the real-world `submit_for_approval` checkpoint shape.
			taskRepo.updateTask(task.id, { pendingCheckpointType: 'task_completion' });

			seedExec(run.id, STEP_A, 'Step A', 'idle');

			const rt = makeRuntime();
			await rt.recoverStalledRuns();

			expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
			const after = taskRepo.getTask(task.id)!;
			expect(after.status).toBe('review');
			expect(after.pendingCheckpointType).toBe('task_completion');
			expect(notifications.filter((n) => n.kind === 'task_blocked').length).toBe(0);
		});

		test('canonical task in `approved` → run + task untouched (post-approval may be in flight)', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Step A', agentId: AGENT },
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Approved Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Approved Run',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: STEP_A,
				status: 'approved',
			});

			seedExec(run.id, STEP_A, 'Step A', 'idle');

			const rt = makeRuntime();
			await rt.recoverStalledRuns();

			expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
			expect(taskRepo.getTask(task.id)!.status).toBe('approved');
			expect(notifications.filter((n) => n.kind === 'workflow_run_blocked').length).toBe(0);
			expect(notifications.filter((n) => n.kind === 'task_blocked').length).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// 3. Driveable executions left untouched
	// -------------------------------------------------------------------------

	describe('runs with driveable executions are skipped', () => {
		test('pending execution → run untouched (tick will spawn)', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Step A', agentId: AGENT },
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Pending Exec',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			seedExec(run.id, STEP_A, 'Step A', 'pending');

			const rt = makeRuntime();
			await rt.recoverStalledRuns();

			expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
			expect(findExec(run.id, STEP_A)!.status).toBe('pending');
			expect(notifications.length).toBe(0);
		});

		test('blocked execution → run untouched (existing blocked-recovery path owns it)', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Step A', agentId: AGENT },
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Blocked Exec',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			seedExec(run.id, STEP_A, 'Step A', 'blocked', {
				result: 'agent crashed',
			});

			const rt = makeRuntime();
			await rt.recoverStalledRuns();

			// Recovery should NOT block the run — the tick path's
			// attemptBlockedRunRecovery will retry/escalate on its own schedule
			expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
			expect(notifications.filter((n) => n.kind === 'workflow_run_blocked').length).toBe(0);
		});

		test('orphan in_progress execution with dead session → recovery does NOT touch it', async () => {
			// Recovery deliberately leaves orphan in_progress executions for the
			// tick path's crash-retry logic (which counts crashes per execution).
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Step A', agentId: AGENT },
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Orphan In-Progress',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			const exec = seedExec(run.id, STEP_A, 'Step A', 'in_progress', {
				agentSessionId: 'session:dead',
			});

			const tam = {
				isExecutionSpawning: () => false,
				isSessionAlive: () => false, // dead session
				spawnWorkflowNodeAgentForExecution: async () => 'session:new',
				cancelBySessionId: () => {},
				interruptBySessionId: async () => {},
				rehydrate: async () => {},
			};

			const rt = makeRuntime({ taskAgentManager: tam as never });
			await rt.recoverStalledRuns();

			// Execution untouched by recovery — still in_progress, session preserved
			const after = nodeExecutionRepo.getById(exec.id)!;
			expect(after.status).toBe('in_progress');
			expect(after.agentSessionId).toBe('session:dead');
			// Run untouched — no premature blocked transition
			expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
			expect(notifications.length).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// 4. Idempotency
	// -------------------------------------------------------------------------

	describe('idempotency', () => {
		test('calling recoverStalledRuns twice acts only once', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Step A', agentId: AGENT },
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Idempotent',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Idempotent',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: STEP_A,
				status: 'in_progress',
			});

			seedExec(run.id, STEP_A, 'Step A', 'idle');

			const rt = makeRuntime();
			await rt.recoverStalledRuns();
			await rt.recoverStalledRuns();

			// Notifications emitted exactly once
			expect(notifications.filter((n) => n.kind === 'task_blocked').length).toBe(1);
			expect(notifications.filter((n) => n.kind === 'workflow_run_blocked').length).toBe(1);
		});

		test('executeTick after recoverStalledRuns does not re-emit blocked notifications', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Step A', agentId: AGENT },
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Tick Idempotent',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Tick Idempotent',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: STEP_A,
				status: 'in_progress',
			});

			seedExec(run.id, STEP_A, 'Step A', 'idle');

			const rt = makeRuntime();
			await rt.recoverStalledRuns();
			const beforeTick = notifications.length;

			await rt.executeTick();

			// executeTick's first-tick recovery path should be a no-op
			// (recoveryDone flag set). The tick may emit other events for the
			// already-blocked run, but it must not re-fire the recovery
			// blocked notifications.
			const taskBlockedAfter = notifications.filter((n) => n.kind === 'task_blocked').length;
			const runBlockedAfter = notifications.filter((n) => n.kind === 'workflow_run_blocked').length;

			expect(taskBlockedAfter).toBe(1);
			expect(runBlockedAfter).toBe(1);
			expect(notifications.length).toBeGreaterThanOrEqual(beforeTick);
		});
	});

	// -------------------------------------------------------------------------
	// 5. executeTick triggers recovery on first call
	// -------------------------------------------------------------------------

	describe('first executeTick triggers recovery', () => {
		test('stalled run is blocked on first tick even without explicit recoverStalledRuns call', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Step A', agentId: AGENT },
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Tick Recovery',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Tick Recovery',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: STEP_A,
				status: 'in_progress',
			});

			seedExec(run.id, STEP_A, 'Step A', 'idle');

			const rt = makeRuntime();
			// No explicit recoverStalledRuns — only executeTick
			await rt.executeTick();

			expect(workflowRunRepo.getRun(run.id)!.status).toBe('blocked');
		});
	});

	// -------------------------------------------------------------------------
	// 6. Multiple stalled runs across spaces
	// -------------------------------------------------------------------------

	describe('multiple stalled runs', () => {
		test('multiple stalled runs in the same space all get blocked', async () => {
			const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-multi-1', name: 'Step 1', agentId: AGENT },
			]);
			const wf2 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-multi-2', name: 'Step 2', agentId: AGENT },
			]);

			const run1 = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: wf1.id,
				title: 'Stalled 1',
			});
			workflowRunRepo.transitionStatus(run1.id, 'in_progress');
			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Stalled 1',
				description: '',
				workflowRunId: run1.id,
				workflowNodeId: 'step-multi-1',
				status: 'in_progress',
			});
			seedExec(run1.id, 'step-multi-1', 'Step 1', 'idle');

			const run2 = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: wf2.id,
				title: 'Stalled 2',
			});
			workflowRunRepo.transitionStatus(run2.id, 'in_progress');
			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Stalled 2',
				description: '',
				workflowRunId: run2.id,
				workflowNodeId: 'step-multi-2',
				status: 'in_progress',
			});
			seedExec(run2.id, 'step-multi-2', 'Step 2', 'idle');

			const rt = makeRuntime();
			await rt.recoverStalledRuns();

			expect(workflowRunRepo.getRun(run1.id)!.status).toBe('blocked');
			expect(workflowRunRepo.getRun(run2.id)!.status).toBe('blocked');
			expect(notifications.filter((n) => n.kind === 'workflow_run_blocked').length).toBe(2);
		});
	});
});
