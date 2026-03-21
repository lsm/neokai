/**
 * SpaceRuntime Notification Tests
 *
 * Verifies that SpaceRuntime emits structured notifications via NotificationSink
 * for all four event types:
 *   - workflow_run_needs_attention  (gate blocked)
 *   - task_needs_attention          (task entered needs_attention)
 *   - workflow_run_completed        (run reached terminal step)
 *   - task_timeout                  (in_progress task exceeded threshold)
 *
 * Also verifies:
 *   - Deduplication: same task in needs_attention across two ticks → one notification
 *   - Normal advancement emits NO notifications
 *   - setNotificationSink() replaces the sink at runtime
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
import { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceRuntimeConfig } from '../../../src/lib/space/runtime/space-runtime.ts';
import type {
	NotificationSink,
	SpaceNotificationEvent,
} from '../../../src/lib/space/runtime/notification-sink.ts';
import type { SpaceWorkflow } from '@neokai/shared';

// ---------------------------------------------------------------------------
// MockNotificationSink
// ---------------------------------------------------------------------------

class MockNotificationSink implements NotificationSink {
	readonly events: SpaceNotificationEvent[] = [];

	notify(event: SpaceNotificationEvent): Promise<void> {
		this.events.push(event);
		return Promise.resolve();
	}

	get byKind(): Record<string, SpaceNotificationEvent[]> {
		const map: Record<string, SpaceNotificationEvent[]> = {};
		for (const e of this.events) {
			if (!map[e.kind]) map[e.kind] = [];
			map[e.kind].push(e);
		}
		return map;
	}

	clear(): void {
		this.events.length = 0;
	}
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-space-runtime-notif',
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

function setSpaceTaskTimeoutMs(db: BunDatabase, spaceId: string, timeoutMs: number): void {
	db.prepare(`UPDATE spaces SET config = ? WHERE id = ?`).run(
		JSON.stringify({ taskTimeoutMs: timeoutMs }),
		spaceId
	);
}

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string, role: string): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, role, description, model, tools, system_prompt,
     config, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', null, '[]', '', null, ?, ?)`
	).run(agentId, spaceId, `Agent ${agentId}`, role, Date.now(), Date.now());
}

function buildLinearWorkflow(
	spaceId: string,
	workflowManager: SpaceWorkflowManager,
	steps: Array<{ id: string; name: string; agentId: string }>,
	conditions: Array<{ type: 'always' | 'human' }> = []
): SpaceWorkflow {
	const transitions = steps.slice(0, -1).map((step, i) => ({
		from: step.id,
		to: steps[i + 1].id,
		condition: conditions[i] ?? { type: 'always' as const },
		order: 0,
	}));

	return workflowManager.createWorkflow({
		spaceId,
		name: `Workflow ${Date.now()}-${Math.random()}`,
		description: '',
		steps,
		transitions,
		startStepId: steps[0].id,
		rules: [],
		tags: [],
	});
}

// ---------------------------------------------------------------------------
// Test suite setup
// ---------------------------------------------------------------------------

describe('SpaceRuntime — notification events', () => {
	let db: BunDatabase;
	let dir: string;

	let workflowRunRepo: SpaceWorkflowRunRepository;
	let taskRepo: SpaceTaskRepository;
	let agentManager: SpaceAgentManager;
	let workflowManager: SpaceWorkflowManager;
	let spaceManager: SpaceManager;
	let sink: MockNotificationSink;
	let runtime: SpaceRuntime;

	const SPACE_ID = 'space-notif-1';
	const WORKSPACE = '/tmp/notif-ws';
	const AGENT_CODER = 'agent-coder-notif';
	const STEP_A = 'step-na';
	const STEP_B = 'step-nb';

	function makeRuntime(extraConfig?: Partial<SpaceRuntimeConfig>): SpaceRuntime {
		const config: SpaceRuntimeConfig = {
			db,
			spaceManager,
			spaceAgentManager: agentManager,
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			notificationSink: sink,
			...extraConfig,
		};
		return new SpaceRuntime(config);
	}

	beforeEach(() => {
		({ db, dir } = makeDb());

		seedSpaceRow(db, SPACE_ID, WORKSPACE);
		seedAgentRow(db, AGENT_CODER, SPACE_ID, 'coder');

		workflowRunRepo = new SpaceWorkflowRunRepository(db);
		taskRepo = new SpaceTaskRepository(db);

		const agentRepo = new SpaceAgentRepository(db);
		agentManager = new SpaceAgentManager(agentRepo);

		const workflowRepo = new SpaceWorkflowRepository(db);
		workflowManager = new SpaceWorkflowManager(workflowRepo);

		spaceManager = new SpaceManager(db);
		sink = new MockNotificationSink();
		runtime = makeRuntime();
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
	// workflow_run_needs_attention
	// -------------------------------------------------------------------------

	describe('workflow_run_needs_attention', () => {
		test('emits event when human gate blocks advancement', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'human' }]
			);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });

			await runtime.executeTick();

			expect(sink.events).toHaveLength(1);
			const evt = sink.events[0];
			expect(evt.kind).toBe('workflow_run_needs_attention');
			if (evt.kind === 'workflow_run_needs_attention') {
				expect(evt.spaceId).toBe(SPACE_ID);
				expect(evt.runId).toBe(run.id);
				expect(typeof evt.reason).toBe('string');
				expect(evt.reason.length).toBeGreaterThan(0);
				expect(typeof evt.timestamp).toBe('string');
			}
		});

		test('emits event with the WorkflowTransitionError message as reason', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'human' }]
			);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });

			await runtime.executeTick();

			const evt = sink.events[0];
			// WorkflowGateError message should contain human-gate context
			expect(evt.kind).toBe('workflow_run_needs_attention');
			if (evt.kind === 'workflow_run_needs_attention') {
				expect(evt.reason).toMatch(/human/i);
			}
		});

		test('does NOT re-emit on subsequent ticks (run already in needs_attention status)', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'human' }]
			);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });

			// First tick — gate fires
			await runtime.executeTick();
			expect(sink.events).toHaveLength(1);

			// Second tick — run is needs_attention, processRunTick returns early
			await runtime.executeTick();
			expect(sink.events).toHaveLength(1); // still just one
		});
	});

	// -------------------------------------------------------------------------
	// task_needs_attention
	// -------------------------------------------------------------------------

	describe('task_needs_attention', () => {
		test('emits event when a step task enters needs_attention', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
			]);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'needs_attention', error: 'Build failed' });

			await runtime.executeTick();

			expect(sink.events).toHaveLength(1);
			const evt = sink.events[0];
			expect(evt.kind).toBe('task_needs_attention');
			if (evt.kind === 'task_needs_attention') {
				expect(evt.spaceId).toBe(SPACE_ID);
				expect(evt.taskId).toBe(tasks[0].id);
				expect(evt.reason).toBe('Build failed');
				expect(typeof evt.timestamp).toBe('string');
			}
		});

		test('uses fallback reason when task.error is null', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
			]);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			// Set to needs_attention without error message
			taskRepo.updateTask(tasks[0].id, { status: 'needs_attention' });

			await runtime.executeTick();

			const evt = sink.events[0];
			expect(evt.kind).toBe('task_needs_attention');
			if (evt.kind === 'task_needs_attention') {
				expect(evt.reason).toBe('Task requires attention');
			}
		});

		test('does NOT advance when task is needs_attention (returns early)', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'always' }]
			);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'needs_attention' });

			await runtime.executeTick();

			// No step B task should be created
			const allTasks = taskRepo.listByWorkflowRun(run.id);
			expect(allTasks).toHaveLength(1);
		});
	});

	// -------------------------------------------------------------------------
	// Deduplication — task_needs_attention
	// -------------------------------------------------------------------------

	describe('deduplication', () => {
		test('same task in needs_attention across two ticks emits only ONE notification', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
			]);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'needs_attention' });

			// First tick — should emit
			await runtime.executeTick();
			expect(sink.events).toHaveLength(1);

			// Second tick — same task still in needs_attention — should NOT emit again
			await runtime.executeTick();
			expect(sink.events).toHaveLength(1);

			// Third tick — still deduped
			await runtime.executeTick();
			expect(sink.events).toHaveLength(1);
		});

		test('re-notifies after task leaves and re-enters needs_attention', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
			]);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'needs_attention' });

			// First tick — emits
			await runtime.executeTick();
			expect(sink.events).toHaveLength(1);

			// Task gets retried: back to in_progress
			taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
			await runtime.executeTick();
			// No new event for in_progress
			expect(sink.events).toHaveLength(1);

			// Task fails again
			taskRepo.updateTask(tasks[0].id, { status: 'needs_attention', error: 'Again' });
			await runtime.executeTick();
			// Should emit a second time since the dedup key was cleared
			expect(sink.events).toHaveLength(2);
			expect(sink.events[1].kind).toBe('task_needs_attention');
		});

		test('multiple tasks in needs_attention each emit their own notification', async () => {
			// Two-step workflow where both tasks (for different steps) end up needing attention
			// In practice, each step has one task; we test with a single-step workflow and
			// verify only one event per step.
			// For multiple tasks we'd need a parallel step model; instead verify per-task dedup
			// with two separate single-step workflows.
			const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-multi-a', name: 'Step A', agentId: AGENT_CODER },
			]);
			const wf2 = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-multi-b', name: 'Step B', agentId: AGENT_CODER },
			]);

			const { tasks: tasks1 } = await runtime.startWorkflowRun(SPACE_ID, wf1.id, 'Run 1');
			const { tasks: tasks2 } = await runtime.startWorkflowRun(SPACE_ID, wf2.id, 'Run 2');

			taskRepo.updateTask(tasks1[0].id, { status: 'needs_attention' });
			taskRepo.updateTask(tasks2[0].id, { status: 'needs_attention' });

			await runtime.executeTick();

			// Both should emit
			const naEvents = sink.events.filter((e) => e.kind === 'task_needs_attention');
			expect(naEvents).toHaveLength(2);
			const taskIds = naEvents.map((e) => (e.kind === 'task_needs_attention' ? e.taskId : ''));
			expect(taskIds).toContain(tasks1[0].id);
			expect(taskIds).toContain(tasks2[0].id);

			// Second tick — still deduped (no new events)
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_needs_attention')).toHaveLength(2);
		});
	});

	// -------------------------------------------------------------------------
	// workflow_run_completed
	// -------------------------------------------------------------------------

	describe('workflow_run_completed', () => {
		test('emits event when terminal step is completed', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Only Step', agentId: AGENT_CODER },
			]);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });

			await runtime.executeTick();

			expect(sink.events).toHaveLength(1);
			const evt = sink.events[0];
			expect(evt.kind).toBe('workflow_run_completed');
			if (evt.kind === 'workflow_run_completed') {
				expect(evt.spaceId).toBe(SPACE_ID);
				expect(evt.runId).toBe(run.id);
				expect(evt.status).toBe('completed');
				expect(typeof evt.timestamp).toBe('string');
			}
		});

		test('emits event after multi-step workflow completes', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'always' }]
			);

			const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

			// Complete step A → advance to step B
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });
			await runtime.executeTick();

			// No completed event yet (still running)
			expect(sink.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(0);

			// Complete step B → run completes
			const stepBTask = taskRepo.listByWorkflowRun(run.id).find((t) => t.workflowStepId === STEP_B);
			expect(stepBTask).toBeDefined();
			taskRepo.updateTask(stepBTask!.id, { status: 'completed' });
			await runtime.executeTick();

			const completedEvents = sink.events.filter((e) => e.kind === 'workflow_run_completed');
			expect(completedEvents).toHaveLength(1);
			if (completedEvents[0].kind === 'workflow_run_completed') {
				expect(completedEvents[0].runId).toBe(run.id);
				expect(completedEvents[0].status).toBe('completed');
			}
		});

		test('does NOT emit completed event for normal step advancement (mid-workflow)', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'always' }]
			);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });

			await runtime.executeTick();

			// Should have no events — just a normal advance
			expect(sink.events).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// task_timeout
	// -------------------------------------------------------------------------

	describe('task_timeout', () => {
		test('emits event when in_progress task exceeds taskTimeoutMs', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 1000); // 1 second timeout

			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
			]);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			// Set task to in_progress — this stamps started_at = Date.now()
			taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });

			// Back-date started_at to simulate timeout (2 seconds ago)
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
				Date.now() - 2000,
				tasks[0].id
			);

			await runtime.executeTick();

			expect(sink.events).toHaveLength(1);
			const evt = sink.events[0];
			expect(evt.kind).toBe('task_timeout');
			if (evt.kind === 'task_timeout') {
				expect(evt.spaceId).toBe(SPACE_ID);
				expect(evt.taskId).toBe(tasks[0].id);
				expect(evt.elapsedMs).toBeGreaterThan(1000);
				expect(typeof evt.timestamp).toBe('string');
			}
		});

		test('does NOT emit timeout when task has not exceeded the threshold', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 60_000); // 1 minute — won't fire in a unit test

			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
			]);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });

			await runtime.executeTick();

			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(0);
		});

		test('does NOT emit timeout when taskTimeoutMs is undefined (disabled)', async () => {
			// No config set on space → timeout disabled
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
			]);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
			// Back-date started_at as if a long time has passed
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
				Date.now() - 100_000,
				tasks[0].id
			);

			await runtime.executeTick();

			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(0);
		});

		test('deduplicates timeout notifications across ticks', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);

			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
			]);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
				Date.now() - 2000,
				tasks[0].id
			);

			// First tick — emits timeout
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);

			// Second tick — same task still in_progress and over threshold — deduped
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);
		});

		test('re-notifies timeout after task leaves in_progress and re-enters', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);

			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
			]);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
				Date.now() - 2000,
				tasks[0].id
			);

			// First tick — emits
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);

			// Task leaves in_progress (e.g. paused to needs_attention)
			taskRepo.updateTask(tasks[0].id, { status: 'needs_attention' });
			await runtime.executeTick();

			// Task re-enters in_progress, back-dated again
			taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
				Date.now() - 2000,
				tasks[0].id
			);
			await runtime.executeTick();

			// Should emit again since the dedup key was cleared when task left in_progress
			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(2);
		});
	});

	// -------------------------------------------------------------------------
	// No notifications for normal advancement
	// -------------------------------------------------------------------------

	describe('no notifications for mechanical advancement', () => {
		test('normal step completion and advancement emits no notifications', async () => {
			const workflow = buildLinearWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
					{ id: STEP_B, name: 'Code', agentId: AGENT_CODER },
				],
				[{ type: 'always' }]
			);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });

			await runtime.executeTick();

			expect(sink.events).toHaveLength(0);
		});

		test('task in pending state emits no notifications', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
			]);

			await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			// Task stays pending (no update)

			await runtime.executeTick();

			expect(sink.events).toHaveLength(0);
		});

		test('task in in_progress state (no timeout) emits no notifications', async () => {
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
			]);

			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });

			await runtime.executeTick();

			expect(sink.events).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// Standalone task notifications
	// -------------------------------------------------------------------------

	describe('standalone task notifications', () => {
		test('emits task_needs_attention for standalone task in needs_attention state', async () => {
			// Create a standalone task (no workflowRunId) directly via repo
			const created = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Standalone Task',
				description: 'No workflow',
				status: 'needs_attention',
			});
			// createTask doesn't support error field — set it via update
			const task = taskRepo.updateTask(created.id, { error: 'Disk full' })!;

			await runtime.executeTick();

			expect(sink.events).toHaveLength(1);
			const evt = sink.events[0];
			expect(evt.kind).toBe('task_needs_attention');
			if (evt.kind === 'task_needs_attention') {
				expect(evt.spaceId).toBe(SPACE_ID);
				expect(evt.taskId).toBe(task.id);
				expect(evt.reason).toBe('Disk full');
				expect(typeof evt.timestamp).toBe('string');
			}
		});

		test('uses fallback reason when standalone task.error is null', async () => {
			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Standalone Task',
				description: '',
				status: 'needs_attention',
			});

			await runtime.executeTick();

			const evt = sink.events[0];
			expect(evt.kind).toBe('task_needs_attention');
			if (evt.kind === 'task_needs_attention') {
				expect(evt.reason).toBe('Task requires attention');
			}
		});

		test('deduplicates standalone needs_attention across ticks', async () => {
			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Standalone',
				description: '',
				status: 'needs_attention',
			});

			// First tick — emits
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_needs_attention')).toHaveLength(1);

			// Second tick — still needs_attention — deduped
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_needs_attention')).toHaveLength(1);

			// Third tick — still deduped
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_needs_attention')).toHaveLength(1);
		});

		test('re-notifies standalone task after it leaves and re-enters needs_attention', async () => {
			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Standalone',
				description: '',
				status: 'needs_attention',
			});

			// First tick — emits
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_needs_attention')).toHaveLength(1);

			// Task gets retried: back to in_progress
			taskRepo.updateTask(task.id, { status: 'in_progress' });
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_needs_attention')).toHaveLength(1);

			// Task fails again
			taskRepo.updateTask(task.id, { status: 'needs_attention', error: 'Again' });
			await runtime.executeTick();
			// Should emit a second time since dedup key was cleared when task left needs_attention
			expect(sink.events.filter((e) => e.kind === 'task_needs_attention')).toHaveLength(2);
		});

		test('pending standalone tasks emit no notifications', async () => {
			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Standalone Pending',
				description: '',
				status: 'pending',
			});

			await runtime.executeTick();

			expect(sink.events).toHaveLength(0);
		});

		test('in_progress standalone tasks without timeout emit no notifications', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 60_000); // 1 minute — won't fire in unit test

			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Standalone In Progress',
				description: '',
				status: 'in_progress',
			});
			// Stamp started_at (normally done by repo on status transition, but we set in creation)
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(Date.now(), task.id);

			await runtime.executeTick();

			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(0);
		});

		test('emits task_timeout for standalone in_progress task that exceeds threshold', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 1000); // 1 second

			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Slow Standalone',
				description: '',
				status: 'in_progress',
			});
			// Back-date started_at to 2 seconds ago to simulate timeout
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
				Date.now() - 2000,
				task.id
			);

			await runtime.executeTick();

			expect(sink.events).toHaveLength(1);
			const evt = sink.events[0];
			expect(evt.kind).toBe('task_timeout');
			if (evt.kind === 'task_timeout') {
				expect(evt.spaceId).toBe(SPACE_ID);
				expect(evt.taskId).toBe(task.id);
				expect(evt.elapsedMs).toBeGreaterThan(1000);
				expect(typeof evt.timestamp).toBe('string');
			}
		});

		test('does NOT emit timeout for standalone task when taskTimeoutMs is undefined', async () => {
			// No config set — timeout disabled
			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Slow Standalone No Config',
				description: '',
				status: 'in_progress',
			});
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
				Date.now() - 100_000,
				task.id
			);

			await runtime.executeTick();

			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(0);
		});

		test('deduplicates standalone timeout notifications across ticks', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);

			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Timed Out Standalone',
				description: '',
				status: 'in_progress',
			});
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
				Date.now() - 2000,
				task.id
			);

			// First tick — emits
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);

			// Second tick — still in_progress and over threshold — deduped
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);
		});

		test('re-notifies standalone timeout after task leaves and re-enters in_progress', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);

			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Cycling Standalone',
				description: '',
				status: 'in_progress',
			});
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
				Date.now() - 2000,
				task.id
			);

			// First tick — emits timeout
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);

			// Task moves to needs_attention (leaves in_progress)
			taskRepo.updateTask(task.id, { status: 'needs_attention' });
			await runtime.executeTick();

			// Task re-enters in_progress and times out again
			taskRepo.updateTask(task.id, { status: 'in_progress' });
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
				Date.now() - 2000,
				task.id
			);
			await runtime.executeTick();

			// Should emit a second timeout since dedup key was cleared when task left in_progress
			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(2);
		});

		test('completed standalone task emits no notifications', async () => {
			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Done',
				description: '',
				status: 'completed',
			});

			await runtime.executeTick();

			expect(sink.events).toHaveLength(0);
		});

		test('cancelled standalone task emits no notifications', async () => {
			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Cancelled',
				description: '',
				status: 'cancelled',
			});

			await runtime.executeTick();

			expect(sink.events).toHaveLength(0);
		});

		test('archiving a standalone task clears its dedup key (no permanent leak)', async () => {
			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Soon Archived',
				description: '',
				status: 'needs_attention',
			});

			// First tick — emits notification, dedup key added
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_needs_attention')).toHaveLength(1);

			// Archive the task while it is still in needs_attention
			taskRepo.archiveTask(task.id);

			// Second tick — task is now archived; dedup key should be cleared
			await runtime.executeTick();
			// No new notification (archived tasks never re-enter needs_attention)
			expect(sink.events.filter((e) => e.kind === 'task_needs_attention')).toHaveLength(1);

			// Create a fresh runtime to simulate a restart — the previously leaked key
			// would have persisted in the old set. With the fix, the archived task was
			// cleaned up on the previous tick so no re-notification occurs here.
			// More importantly: verify the current runtime's set has been cleaned up by
			// creating a NEW task in needs_attention and confirming dedup still works.
			const task2 = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Another Task',
				description: '',
				status: 'needs_attention',
			});
			await runtime.executeTick();
			const naEvents = sink.events.filter(
				(e) => e.kind === 'task_needs_attention' && e.taskId === task2.id
			);
			expect(naEvents).toHaveLength(1);
		});

		test('workflow tasks are NOT processed by checkStandaloneTasks', async () => {
			// Create a workflow task (has workflowRunId) with needs_attention status
			// It should NOT generate a duplicate notification via the standalone path
			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: STEP_A, name: 'Step A', agentId: AGENT_CODER },
			]);
			const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'needs_attention', error: 'Workflow error' });

			await runtime.executeTick();

			// Should get exactly one notification (from processRunTick, not checkStandaloneTasks)
			const naEvents = sink.events.filter((e) => e.kind === 'task_needs_attention');
			expect(naEvents).toHaveLength(1);
			if (naEvents[0].kind === 'task_needs_attention') {
				expect(naEvents[0].taskId).toBe(tasks[0].id);
			}
		});
	});

	// -------------------------------------------------------------------------
	// Restart re-notification behavior (Task 2.3 restart contract)
	// -------------------------------------------------------------------------

	describe('restart re-notification (empty dedup set on restart)', () => {
		test('standalone needs_attention task is re-notified after simulated restart', async () => {
			const created = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Pre-existing Standalone',
				description: '',
				status: 'needs_attention',
			});
			// createTask doesn't support error field — set it via update
			const task = taskRepo.updateTask(created.id, { error: 'Pre-restart error' })!;

			// First runtime instance — first tick emits notification
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_needs_attention')).toHaveLength(1);

			// Simulate restart: create a fresh runtime with empty dedup set
			// (In production the daemon process restarts and all in-memory state is lost)
			const freshSink = new MockNotificationSink();
			const freshRuntime = makeRuntime({ notificationSink: freshSink });

			// First tick on fresh runtime — dedup set is empty → re-notifies once
			await freshRuntime.executeTick();
			const reNotified = freshSink.events.filter((e) => e.kind === 'task_needs_attention');
			expect(reNotified).toHaveLength(1);
			if (reNotified[0].kind === 'task_needs_attention') {
				expect(reNotified[0].taskId).toBe(task.id);
				expect(reNotified[0].reason).toBe('Pre-restart error');
			}

			// Second tick on fresh runtime — deduped, no new notification
			await freshRuntime.executeTick();
			expect(freshSink.events.filter((e) => e.kind === 'task_needs_attention')).toHaveLength(1);
		});

		test('standalone timed-out task is re-notified after simulated restart', async () => {
			setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);

			const task = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Pre-existing Timeout',
				description: '',
				status: 'in_progress',
			});
			db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
				Date.now() - 5000,
				task.id
			);

			// First runtime instance — first tick emits timeout
			await runtime.executeTick();
			expect(sink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);

			// Simulate restart: fresh runtime with empty dedup set
			const freshSink = new MockNotificationSink();
			const freshRuntime = makeRuntime({ notificationSink: freshSink });

			// First tick on fresh runtime — re-notifies once (dedup set was empty)
			await freshRuntime.executeTick();
			expect(freshSink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);

			// Second tick — deduped
			await freshRuntime.executeTick();
			expect(freshSink.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);
		});
	});

	// -------------------------------------------------------------------------
	// setNotificationSink() — post-construction wiring
	// -------------------------------------------------------------------------

	describe('setNotificationSink()', () => {
		test('replaces the sink at runtime before first tick', async () => {
			const newSink = new MockNotificationSink();
			// Create runtime WITHOUT a sink (uses NullNotificationSink)
			const rt = makeRuntime({ notificationSink: undefined });

			// Wire in the new sink before the first tick
			rt.setNotificationSink(newSink);

			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-wire', name: 'Only Step', agentId: AGENT_CODER },
			]);

			const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });

			await rt.executeTick();

			// Original sink should NOT have received events
			expect(sink.events).toHaveLength(0);
			// New sink SHOULD have received workflow_run_completed
			expect(newSink.events).toHaveLength(1);
			expect(newSink.events[0].kind).toBe('workflow_run_completed');
		});

		test('NullNotificationSink (default) silently drops all events', async () => {
			// Create runtime without any sink — no error should be thrown
			const rt = makeRuntime({ notificationSink: undefined });

			const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
				{ id: 'step-null', name: 'Only Step', agentId: AGENT_CODER },
			]);

			const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
			taskRepo.updateTask(tasks[0].id, { status: 'completed' });

			// Should not throw
			await expect(rt.executeTick()).resolves.toBeUndefined();
		});
	});
});
