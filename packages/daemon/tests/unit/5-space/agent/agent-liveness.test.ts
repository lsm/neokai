/**
 * Unit tests for agent-liveness.ts — autoCompleteStuckAgents()
 *
 * Scenarios covered:
 *   1. Non-stuck agents (alive, elapsed < timeout) — no auto-completion
 *   2. Stuck agent (alive, elapsed > timeout) — auto-completed, event emitted
 *   3. Dead agent (not alive) — skipped (handled by dead-agent reset path)
 *   4. Task without taskAgentSessionId — skipped
 *   5. Task not in_progress — skipped (completed/pending/needs_attention)
 *   6. Multiple tasks, some stuck and some not — only stuck ones completed
 *   7. Custom timeoutMs parameter — respected
 *   8. Falls back to createdAt when startedAt is missing
 *   9. Auto-completion sets result field with descriptive message
 *   10. Returns list of AutoCompletedAgent entries matching stuck tasks
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { autoCompleteStuckAgents } from '../../../../src/lib/space/runtime/agent-liveness.ts';
import {
	AGENT_REPORT_DONE_TIMEOUT_MS,
	resolveNodeTimeout,
	CODER_NODE_TIMEOUT_MS,
	REVIEWER_NODE_TIMEOUT_MS,
	QA_NODE_TIMEOUT_MS,
	PLANNER_NODE_TIMEOUT_MS,
	DEFAULT_NODE_TIMEOUT_MS,
} from '../../../../src/lib/space/runtime/constants.ts';
import type { AutoCompletedAgent } from '../../../../src/lib/space/runtime/agent-liveness.ts';
import type { SpaceTask } from '@neokai/shared';
import type { SpaceNotificationEvent } from '../../../../src/lib/space/runtime/notification-sink.ts';
import type { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-agent-liveness',
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return { db, dir };
}

function seedSpaceRow(db: BunDatabase, spaceId: string): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
	).run(spaceId, `/tmp/workspace-${spaceId}`, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedTask(
	db: BunDatabase,
	id: string,
	spaceId: string,
	overrides: {
		status?: string;
		taskAgentSessionId?: string | null;
		startedAt?: number | null;
		workflowRunId?: string;
		workflowNodeId?: string; // kept for compat but ignored — removed from space_tasks in M71
	} = {}
): void {
	const now = Date.now();
	// M71: workflow_node_id removed from space_tasks; node tracking moved to node_executions
	db.prepare(
		`INSERT INTO space_tasks
       (id, space_id, task_number, title, description, status, priority, depends_on,
        task_agent_session_id, started_at, workflow_run_id,
        created_at, updated_at)
       VALUES (?, ?, (SELECT COALESCE(MAX(task_number), 0) + 1 FROM space_tasks WHERE space_id = ?), ?, ?, ?, 'normal', '[]', ?, ?, ?, ?, ?)`
	).run(
		id,
		spaceId,
		spaceId,
		`Task ${id}`,
		'',
		overrides.status ?? 'in_progress',
		overrides.taskAgentSessionId ?? null,
		overrides.startedAt !== undefined ? overrides.startedAt : now,
		overrides.workflowRunId ?? null,
		now,
		now
	);
}

/** Creates a mock TaskAgentManager that reports liveness based on a set of alive task IDs. */
function makeMockTAM(aliveTaskIds: Set<string>): TaskAgentManager {
	return {
		isTaskAgentAlive: (taskId: string) => aliveTaskIds.has(taskId),
	} as unknown as TaskAgentManager;
}

/** Collects all notification events for assertion. */
function makeNotifySpy(): {
	events: SpaceNotificationEvent[];
	notify: (event: SpaceNotificationEvent) => Promise<void>;
} {
	const events: SpaceNotificationEvent[] = [];
	return {
		events,
		notify: async (event) => {
			events.push(event);
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('autoCompleteStuckAgents', () => {
	let db: BunDatabase;
	let dir: string;
	let taskRepo: SpaceTaskRepository;
	const spaceId = 'space-test-liveness';

	beforeEach(() => {
		({ db, dir } = makeDb());
		taskRepo = new SpaceTaskRepository(db);
		seedSpaceRow(db, spaceId);
	});

	afterEach(() => {
		db.close();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore cleanup failures
		}
	});

	test('returns empty array when no tasks are provided', async () => {
		const tam = makeMockTAM(new Set());
		const spy = makeNotifySpy();

		const result = await autoCompleteStuckAgents([], spaceId, taskRepo, tam, spy.notify);

		expect(result).toEqual([]);
		expect(spy.events).toHaveLength(0);
	});

	test('skips tasks without taskAgentSessionId', async () => {
		seedTask(db, 'task-1', spaceId, {
			status: 'in_progress',
			taskAgentSessionId: null,
			startedAt: Date.now() - AGENT_REPORT_DONE_TIMEOUT_MS - 1000,
		});

		const task = taskRepo.getTask('task-1')!;
		const tam = makeMockTAM(new Set(['task-1']));
		const spy = makeNotifySpy();

		const result = await autoCompleteStuckAgents([task], spaceId, taskRepo, tam, spy.notify);

		expect(result).toHaveLength(0);
		expect(spy.events).toHaveLength(0);
		expect(taskRepo.getTask('task-1')!.status).toBe('in_progress');
	});

	test('skips tasks not in in_progress status', async () => {
		// M71: 'pending'→'open', 'completed'→'done'
		for (const status of ['open', 'done', 'blocked', 'cancelled'] as const) {
			const taskId = `task-${status}`;
			seedTask(db, taskId, spaceId, {
				status,
				taskAgentSessionId: 'session-123',
				startedAt: Date.now() - AGENT_REPORT_DONE_TIMEOUT_MS - 1000,
			});
		}

		const tasks = ['open', 'done', 'blocked', 'cancelled'].map(
			(s) => taskRepo.getTask(`task-${s}`)!
		);
		const tam = makeMockTAM(new Set(tasks.map((t) => t.id)));
		const spy = makeNotifySpy();

		const result = await autoCompleteStuckAgents(tasks, spaceId, taskRepo, tam, spy.notify);

		expect(result).toHaveLength(0);
		expect(spy.events).toHaveLength(0);
	});

	test('skips dead agents (not alive)', async () => {
		seedTask(db, 'task-dead', spaceId, {
			status: 'in_progress',
			taskAgentSessionId: 'session-dead',
			startedAt: Date.now() - AGENT_REPORT_DONE_TIMEOUT_MS - 1000,
		});

		const task = taskRepo.getTask('task-dead')!;
		// TAM reports task as NOT alive
		const tam = makeMockTAM(new Set());
		const spy = makeNotifySpy();

		const result = await autoCompleteStuckAgents([task], spaceId, taskRepo, tam, spy.notify);

		expect(result).toHaveLength(0);
		expect(spy.events).toHaveLength(0);
		expect(taskRepo.getTask('task-dead')!.status).toBe('in_progress');
	});

	test('skips alive agent that has NOT exceeded the timeout', async () => {
		// Started 1 second ago — well under the 10-minute timeout
		seedTask(db, 'task-fresh', spaceId, {
			status: 'in_progress',
			taskAgentSessionId: 'session-fresh',
			startedAt: Date.now() - 1000,
		});

		const task = taskRepo.getTask('task-fresh')!;
		const tam = makeMockTAM(new Set(['task-fresh']));
		const spy = makeNotifySpy();

		const result = await autoCompleteStuckAgents([task], spaceId, taskRepo, tam, spy.notify);

		expect(result).toHaveLength(0);
		expect(spy.events).toHaveLength(0);
		expect(taskRepo.getTask('task-fresh')!.status).toBe('in_progress');
	});

	test('does NOT auto-complete when elapsed is at or below the timeout boundary', async () => {
		// The guard uses `elapsedMs <= timeoutMs`, so tasks within the window are excluded.
		// We set startedAt = now - elapsedMs and timeoutMs = elapsedMs + 1000 (1-second buffer)
		// so that even if a few ms pass during test execution, elapsed stays safely below
		// the timeout threshold.
		const elapsedMs = 4000; // 4 seconds ago
		const customTimeoutMs = elapsedMs + 1000; // timeout is 5 seconds (1 s above elapsed)
		seedTask(db, 'task-boundary', spaceId, {
			status: 'in_progress',
			taskAgentSessionId: 'session-boundary',
			startedAt: Date.now() - elapsedMs,
		});

		const task = taskRepo.getTask('task-boundary')!;
		const tam = makeMockTAM(new Set(['task-boundary']));
		const spy = makeNotifySpy();

		// Patch startedAt so elapsedMs ≈ 4 s, timeout = 5 s → clearly within window
		const patchedTask: SpaceTask = { ...task, startedAt: Date.now() - elapsedMs };

		const result = await autoCompleteStuckAgents(
			[patchedTask],
			spaceId,
			taskRepo,
			tam,
			spy.notify,
			customTimeoutMs
		);

		// elapsed < timeoutMs → no auto-completion
		expect(result).toHaveLength(0);
		expect(spy.events).toHaveLength(0);
		expect(taskRepo.getTask('task-boundary')!.status).toBe('in_progress');
	});

	test('auto-completes a stuck agent (alive + timed out)', async () => {
		const stuckStartedAt = Date.now() - AGENT_REPORT_DONE_TIMEOUT_MS - 5000;
		seedTask(db, 'task-stuck', spaceId, {
			status: 'in_progress',
			taskAgentSessionId: 'session-stuck',
			startedAt: stuckStartedAt,
		});

		const task = taskRepo.getTask('task-stuck')!;
		const tam = makeMockTAM(new Set(['task-stuck']));
		const spy = makeNotifySpy();

		const result = await autoCompleteStuckAgents([task], spaceId, taskRepo, tam, spy.notify);

		// Returns the auto-completed entry
		expect(result).toHaveLength(1);
		expect(result[0].taskId).toBe('task-stuck');
		expect(result[0].elapsedMs).toBeGreaterThan(AGENT_REPORT_DONE_TIMEOUT_MS);

		// Task is now completed
		const updated = taskRepo.getTask('task-stuck')!;
		expect(updated.status).toBe('done');
		expect(updated.completedAt).toBeDefined();
		expect(updated.result).toContain('Auto-completed');
		expect(updated.result).toContain('report_result');

		// Event was emitted
		expect(spy.events).toHaveLength(1);
		expect(spy.events[0].kind).toBe('agent_auto_completed');
		const event = spy.events[0] as {
			kind: string;
			spaceId: string;
			taskId: string;
			elapsedMs: number;
			timestamp: string;
		};
		expect(event.spaceId).toBe(spaceId);
		expect(event.taskId).toBe('task-stuck');
		expect(event.elapsedMs).toBeGreaterThan(AGENT_REPORT_DONE_TIMEOUT_MS);
		expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	test('auto-complete result message includes timeout in minutes', async () => {
		const customTimeoutMs = 5 * 60 * 1000; // 5 minutes
		seedTask(db, 'task-msg', spaceId, {
			status: 'in_progress',
			taskAgentSessionId: 'session-msg',
			startedAt: Date.now() - customTimeoutMs - 1000,
		});

		const task = taskRepo.getTask('task-msg')!;
		const tam = makeMockTAM(new Set(['task-msg']));
		const spy = makeNotifySpy();

		await autoCompleteStuckAgents([task], spaceId, taskRepo, tam, spy.notify, customTimeoutMs);

		const updated = taskRepo.getTask('task-msg')!;
		expect(updated.result).toBe(
			'Auto-completed: agent did not call report_result within 5 minutes'
		);
	});

	test('respects custom timeoutMs parameter', async () => {
		const shortTimeoutMs = 1000; // 1 second
		seedTask(db, 'task-custom', spaceId, {
			status: 'in_progress',
			taskAgentSessionId: 'session-custom',
			startedAt: Date.now() - 2000, // 2 seconds ago — exceeds 1s timeout
		});

		const task = taskRepo.getTask('task-custom')!;
		const tam = makeMockTAM(new Set(['task-custom']));
		const spy = makeNotifySpy();

		const result = await autoCompleteStuckAgents(
			[task],
			spaceId,
			taskRepo,
			tam,
			spy.notify,
			shortTimeoutMs
		);

		expect(result).toHaveLength(1);
		expect(result[0].taskId).toBe('task-custom');
	});

	test('falls back to createdAt when startedAt is missing', async () => {
		const longAgoCreatedAt = Date.now() - AGENT_REPORT_DONE_TIMEOUT_MS - 5000;
		// Insert with NULL started_at
		seedTask(db, 'task-nostartdate', spaceId, {
			status: 'in_progress',
			taskAgentSessionId: 'session-x',
			startedAt: null,
		});
		// Manually override created_at to simulate a long-running task
		db.prepare(`UPDATE space_tasks SET created_at = ? WHERE id = ?`).run(
			longAgoCreatedAt,
			'task-nostartdate'
		);

		const task = taskRepo.getTask('task-nostartdate')!;
		// Manually patch the in-memory task since repository reads the DB value
		const patchedTask: SpaceTask = { ...task, startedAt: undefined, createdAt: longAgoCreatedAt };

		const tam = makeMockTAM(new Set(['task-nostartdate']));
		const spy = makeNotifySpy();

		const result = await autoCompleteStuckAgents([patchedTask], spaceId, taskRepo, tam, spy.notify);

		expect(result).toHaveLength(1);
		expect(taskRepo.getTask('task-nostartdate')!.status).toBe('done');
	});

	test('handles multiple tasks — only completes the stuck ones', async () => {
		const stuckStartedAt = Date.now() - AGENT_REPORT_DONE_TIMEOUT_MS - 1000;
		const freshStartedAt = Date.now() - 5000;

		seedTask(db, 'task-stuck-a', spaceId, {
			status: 'in_progress',
			taskAgentSessionId: 'session-a',
			startedAt: stuckStartedAt,
		});
		seedTask(db, 'task-fresh-b', spaceId, {
			status: 'in_progress',
			taskAgentSessionId: 'session-b',
			startedAt: freshStartedAt,
		});
		seedTask(db, 'task-dead-c', spaceId, {
			status: 'in_progress',
			taskAgentSessionId: 'session-c',
			startedAt: stuckStartedAt,
		});
		seedTask(db, 'task-no-session-d', spaceId, {
			status: 'in_progress',
			taskAgentSessionId: null,
			startedAt: stuckStartedAt,
		});

		const tasks = ['task-stuck-a', 'task-fresh-b', 'task-dead-c', 'task-no-session-d'].map(
			(id) => taskRepo.getTask(id)!
		);

		// Only a and b are alive; c is dead
		const tam = makeMockTAM(new Set(['task-stuck-a', 'task-fresh-b']));
		const spy = makeNotifySpy();

		const result = await autoCompleteStuckAgents(tasks, spaceId, taskRepo, tam, spy.notify);

		// Only stuck-a should be auto-completed
		expect(result).toHaveLength(1);
		expect(result[0].taskId).toBe('task-stuck-a');

		expect(taskRepo.getTask('task-stuck-a')!.status).toBe('done');
		expect(taskRepo.getTask('task-fresh-b')!.status).toBe('in_progress');
		expect(taskRepo.getTask('task-dead-c')!.status).toBe('in_progress');
		expect(taskRepo.getTask('task-no-session-d')!.status).toBe('in_progress');

		// One notification for the one auto-completed task
		expect(spy.events).toHaveLength(1);
	});

	test('auto-completes multiple stuck agents in a single call', async () => {
		const stuckStartedAt = Date.now() - AGENT_REPORT_DONE_TIMEOUT_MS - 1000;

		for (const id of ['task-s1', 'task-s2', 'task-s3']) {
			seedTask(db, id, spaceId, {
				status: 'in_progress',
				taskAgentSessionId: `session-${id}`,
				startedAt: stuckStartedAt,
			});
		}

		const tasks = ['task-s1', 'task-s2', 'task-s3'].map((id) => taskRepo.getTask(id)!);
		const tam = makeMockTAM(new Set(['task-s1', 'task-s2', 'task-s3']));
		const spy = makeNotifySpy();

		const result = await autoCompleteStuckAgents(tasks, spaceId, taskRepo, tam, spy.notify);

		expect(result).toHaveLength(3);
		expect(spy.events).toHaveLength(3);
		for (const id of ['task-s1', 'task-s2', 'task-s3']) {
			expect(taskRepo.getTask(id)!.status).toBe('done');
		}
	});

	test('AGENT_REPORT_DONE_TIMEOUT_MS is 10 minutes', () => {
		expect(AGENT_REPORT_DONE_TIMEOUT_MS).toBe(10 * 60 * 1000);
	});

	test('per-task timeout via getTimeoutMs overrides default timeoutMs', async () => {
		const shortCustomTimeout = 500; // 0.5 s
		const longCustomTimeout = 60 * 60 * 1000; // 1 hour (task should NOT be auto-completed)

		// task-short: started 1 second ago — exceeds short custom timeout
		seedTask(db, 'task-short', spaceId, {
			status: 'in_progress',
			taskAgentSessionId: 'session-short',
			startedAt: Date.now() - 1000,
		});
		// task-long: started 1 second ago — within 1-hour custom timeout
		seedTask(db, 'task-long', spaceId, {
			status: 'in_progress',
			taskAgentSessionId: 'session-long',
			startedAt: Date.now() - 1000,
		});

		const tasks = ['task-short', 'task-long'].map((id) => taskRepo.getTask(id)!);
		const tam = makeMockTAM(new Set(['task-short', 'task-long']));
		const spy = makeNotifySpy();

		// Resolver: short task gets 500ms timeout, long task gets 1h timeout
		const getTimeoutMs = (task: SpaceTask): number =>
			task.id === 'task-short' ? shortCustomTimeout : longCustomTimeout;

		const result = await autoCompleteStuckAgents(
			tasks,
			spaceId,
			taskRepo,
			tam,
			spy.notify,
			AGENT_REPORT_DONE_TIMEOUT_MS, // default (ignored when getTimeoutMs is provided)
			getTimeoutMs
		);

		// Only task-short should be auto-completed
		expect(result).toHaveLength(1);
		expect(result[0].taskId).toBe('task-short');
		expect(taskRepo.getTask('task-short')!.status).toBe('done');
		expect(taskRepo.getTask('task-long')!.status).toBe('in_progress');
		expect(spy.events).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// resolveNodeTimeout tests
// ---------------------------------------------------------------------------

describe('resolveNodeTimeout', () => {
	test('coder role returns CODER_NODE_TIMEOUT_MS (30 minutes)', () => {
		expect(resolveNodeTimeout('coder')).toBe(CODER_NODE_TIMEOUT_MS);
		expect(resolveNodeTimeout('Coder')).toBe(CODER_NODE_TIMEOUT_MS);
		expect(resolveNodeTimeout('CODER')).toBe(CODER_NODE_TIMEOUT_MS);
	});

	test('general role returns CODER_NODE_TIMEOUT_MS (same as coder)', () => {
		expect(resolveNodeTimeout('general')).toBe(CODER_NODE_TIMEOUT_MS);
		expect(resolveNodeTimeout('General')).toBe(CODER_NODE_TIMEOUT_MS);
	});

	test('reviewer role returns REVIEWER_NODE_TIMEOUT_MS (15 minutes)', () => {
		expect(resolveNodeTimeout('reviewer')).toBe(REVIEWER_NODE_TIMEOUT_MS);
		expect(resolveNodeTimeout('Reviewer')).toBe(REVIEWER_NODE_TIMEOUT_MS);
	});

	test('qa role returns QA_NODE_TIMEOUT_MS (15 minutes)', () => {
		expect(resolveNodeTimeout('qa')).toBe(QA_NODE_TIMEOUT_MS);
		expect(resolveNodeTimeout('QA')).toBe(QA_NODE_TIMEOUT_MS);
	});

	test('planner role returns PLANNER_NODE_TIMEOUT_MS (20 minutes)', () => {
		expect(resolveNodeTimeout('planner')).toBe(PLANNER_NODE_TIMEOUT_MS);
		expect(resolveNodeTimeout('Planner')).toBe(PLANNER_NODE_TIMEOUT_MS);
	});

	test('unknown role returns DEFAULT_NODE_TIMEOUT_MS (30 minutes)', () => {
		expect(resolveNodeTimeout('designer')).toBe(DEFAULT_NODE_TIMEOUT_MS);
		expect(resolveNodeTimeout('')).toBe(DEFAULT_NODE_TIMEOUT_MS);
		expect(resolveNodeTimeout('custom-agent')).toBe(DEFAULT_NODE_TIMEOUT_MS);
	});

	test('timeout constants have correct minute values', () => {
		expect(CODER_NODE_TIMEOUT_MS).toBe(30 * 60 * 1000);
		expect(REVIEWER_NODE_TIMEOUT_MS).toBe(15 * 60 * 1000);
		expect(QA_NODE_TIMEOUT_MS).toBe(15 * 60 * 1000);
		expect(PLANNER_NODE_TIMEOUT_MS).toBe(20 * 60 * 1000);
		expect(DEFAULT_NODE_TIMEOUT_MS).toBe(30 * 60 * 1000);
	});
});
