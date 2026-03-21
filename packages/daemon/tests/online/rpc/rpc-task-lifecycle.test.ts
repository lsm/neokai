/**
 * Task Lifecycle RPC Integration Tests
 *
 * Tests the full task lifecycle via RPC handlers against a real daemon
 * with mocked SDK (dev proxy). No actual agent runs required — status
 * transitions and archival are exercised entirely via RPC calls.
 *
 * Covered scenarios:
 * - pending → in_progress → completed → reactivate (in_progress)
 * - pending → in_progress → cancelled → reactivate (in_progress)
 * - pending → in_progress → needs_attention → reactivate and archive
 * - timestamps: startedAt set on in_progress, completedAt set on completed/cancelled/needs_attention
 * - result/error/progress cleared when reactivating from completed/cancelled/needs_attention
 * - complete a task, then archive it via task.setStatus (archived)
 * - complete a task, then archive it via task.archive RPC
 * - archived tasks reject all further status transitions
 * - task.list excludes archived by default; includes them with includeArchived: true
 * - task.sendHumanMessage on archived task returns terminal error (pre-runtime guard)
 * - task.sendHumanMessage on completed/cancelled/needs_attention task with no prior group: rolls
 *   back to original status (reviveTaskForMessage returns false when no session group exists)
 *
 * Note on auto-reactivation success path: the happy path for task.sendHumanMessage on a
 * completed/cancelled task (where reviveTaskForMessage returns true) requires live agent
 * sessions from a prior run. That path is covered by the unit tests in
 * packages/daemon/tests/unit/rpc-handlers/task-handlers.test.ts (lines 385-482) and by the
 * room integration tests (room-advanced-scenarios.test.ts). The tests here cover the
 * integration-layer error / rollback behavior that is only verifiable against a real daemon.
 *
 * Note on worktree preservation: worktree creation and cleanup require an actual agent run
 * (the daemon spawns a git worktree when starting an agent group). These tests exercise
 * task status transitions without running agents so no worktrees are involved.
 * Worktree lifecycle is covered by packages/daemon/tests/unit/room/task-group-manager.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';
import type { NeoTask } from '@neokai/shared';

describe('Task Lifecycle RPC Integration', () => {
	let daemon: DaemonServerContext;

	beforeAll(async () => {
		daemon = await createDaemonServer();
	}, 20_000);

	afterAll(async () => {
		await daemon?.waitForExit();
	}, 15_000);

	// ─── Helpers ──────────────────────────────────────────────────────────────

	async function createRoom(label: string): Promise<string> {
		const result = (await daemon.messageHub.request('room.create', {
			name: `${label}-${Date.now()}`,
		})) as { room: { id: string } };
		return result.room.id;
	}

	async function createTask(roomId: string, title: string): Promise<NeoTask> {
		const result = (await daemon.messageHub.request('task.create', {
			roomId,
			title,
			description: 'Integration test task',
		})) as { task: NeoTask };
		return result.task;
	}

	async function getTask(roomId: string, taskId: string): Promise<NeoTask> {
		const result = (await daemon.messageHub.request('task.get', {
			roomId,
			taskId,
		})) as { task: NeoTask };
		return result.task;
	}

	async function setStatus(roomId: string, taskId: string, status: string): Promise<NeoTask> {
		const result = (await daemon.messageHub.request('task.setStatus', {
			roomId,
			taskId,
			status,
		})) as { task: NeoTask };
		return result.task;
	}

	async function listTasks(roomId: string, includeArchived?: boolean): Promise<NeoTask[]> {
		const result = (await daemon.messageHub.request('task.list', {
			roomId,
			...(includeArchived !== undefined ? { includeArchived } : {}),
		})) as { tasks: NeoTask[] };
		return result.tasks;
	}

	// ─── Status transition: complete → reactivate ─────────────────────────────

	describe('complete → reactivate lifecycle', () => {
		test('task transitions pending → in_progress → completed → in_progress (reactivation)', async () => {
			const roomId = await createRoom('complete-reactivate');
			const task = await createTask(roomId, 'Reactivation from completed');

			// task.create sets initial status to pending
			expect(task.status).toBe('pending');

			// pending → in_progress
			const inProgress = await setStatus(roomId, task.id, 'in_progress');
			expect(inProgress.status).toBe('in_progress');

			// in_progress → completed
			const completed = await setStatus(roomId, task.id, 'completed');
			expect(completed.status).toBe('completed');
			expect(completed.archivedAt).toBeUndefined();

			// completed → in_progress (reactivation)
			const reactivated = await setStatus(roomId, task.id, 'in_progress');
			expect(reactivated.status).toBe('in_progress');
		});

		test('startedAt is set on in_progress; completedAt is set on completed', async () => {
			const before = Date.now();
			const roomId = await createRoom('complete-timestamps');
			const task = await createTask(roomId, 'Timestamps on complete');

			const inProgress = await setStatus(roomId, task.id, 'in_progress');
			expect(inProgress.startedAt).toBeGreaterThanOrEqual(before);

			const completed = await setStatus(roomId, task.id, 'completed');
			expect(completed.completedAt).toBeGreaterThanOrEqual(before);
		});

		test('result and progress are cleared when reactivating from completed', async () => {
			const roomId = await createRoom('complete-reactivate-clears');
			const task = await createTask(roomId, 'Cleared fields on reactivation');

			await setStatus(roomId, task.id, 'in_progress');

			// Set completed with a result
			const completedResult = (await daemon.messageHub.request('task.setStatus', {
				roomId,
				taskId: task.id,
				status: 'completed',
				result: 'Task done successfully',
			})) as { task: NeoTask };
			expect(completedResult.task.status).toBe('completed');
			const completedAt = completedResult.task.completedAt;
			expect(completedAt).toBeGreaterThan(0);

			// Reactivation clears result and progress but retains completedAt (repository
			// only sets started_at on in_progress; it never erases completed_at).
			const reactivated = await setStatus(roomId, task.id, 'in_progress');
			expect(reactivated.result).toBeUndefined();
			expect(reactivated.progress).toBeUndefined();
			expect(reactivated.archivedAt).toBeUndefined();
			expect(reactivated.completedAt).toBe(completedAt);
		});

		test('reactivated task has no archivedAt after coming back from completed', async () => {
			const roomId = await createRoom('reactivate-no-archive');
			const task = await createTask(roomId, 'No archivedAt after reactivation');

			await setStatus(roomId, task.id, 'in_progress');
			await setStatus(roomId, task.id, 'completed');
			const reactivated = await setStatus(roomId, task.id, 'in_progress');

			expect(reactivated.archivedAt).toBeUndefined();
		});
	});

	// ─── Status transition: cancel → reactivate ───────────────────────────────

	describe('cancel → reactivate lifecycle', () => {
		test('task transitions pending → in_progress → cancelled → in_progress (reactivation)', async () => {
			const roomId = await createRoom('cancel-reactivate');
			const task = await createTask(roomId, 'Reactivation from cancelled');

			// Advance through the lifecycle (task starts in pending)
			await setStatus(roomId, task.id, 'in_progress');

			const cancelled = await setStatus(roomId, task.id, 'cancelled');
			expect(cancelled.status).toBe('cancelled');
			// completedAt is set on cancellation (reuses the completed_at column)
			expect(cancelled.completedAt).toBeGreaterThan(0);

			// cancelled → in_progress (reactivation)
			const reactivated = await setStatus(roomId, task.id, 'in_progress');
			expect(reactivated.status).toBe('in_progress');
		});

		test('error and progress are cleared when reactivating from cancelled', async () => {
			const roomId = await createRoom('cancel-reactivate-clears');
			const task = await createTask(roomId, 'Cleared fields on cancel reactivation');

			await setStatus(roomId, task.id, 'in_progress');
			await setStatus(roomId, task.id, 'cancelled');

			const reactivated = await setStatus(roomId, task.id, 'in_progress');
			expect(reactivated.error).toBeUndefined();
			expect(reactivated.progress).toBeUndefined();
		});

		test('reactivated-from-cancelled task retains title and description', async () => {
			const roomId = await createRoom('cancel-preserve');
			const task = await createTask(roomId, 'Cancelled task preserved');

			await setStatus(roomId, task.id, 'in_progress');
			await setStatus(roomId, task.id, 'cancelled');
			await setStatus(roomId, task.id, 'in_progress');

			// Re-fetch to confirm persisted fields
			const fetched = await getTask(roomId, task.id);
			expect(fetched.status).toBe('in_progress');
			expect(fetched.title).toBe('Cancelled task preserved');
		});
	});

	// ─── needs_attention lifecycle ────────────────────────────────────────────

	describe('needs_attention lifecycle', () => {
		test('task can transition in_progress → needs_attention', async () => {
			const roomId = await createRoom('needs-attention-transition');
			const task = await createTask(roomId, 'Needs attention transition');

			await setStatus(roomId, task.id, 'in_progress');
			const needsAttention = await setStatus(roomId, task.id, 'needs_attention');
			expect(needsAttention.status).toBe('needs_attention');
			// completedAt is set for needs_attention too (terminal-ish state)
			expect(needsAttention.completedAt).toBeGreaterThan(0);
		});

		test('needs_attention → in_progress reactivation clears error and progress', async () => {
			const roomId = await createRoom('needs-attention-reactivate');
			const task = await createTask(roomId, 'Needs attention reactivation');

			await setStatus(roomId, task.id, 'in_progress');

			// Set needs_attention with an error message
			const failed = (await daemon.messageHub.request('task.setStatus', {
				roomId,
				taskId: task.id,
				status: 'needs_attention',
				error: 'Something went wrong',
			})) as { task: NeoTask };
			expect(failed.task.status).toBe('needs_attention');

			// Reactivation: needs_attention → in_progress should clear error
			const reactivated = await setStatus(roomId, task.id, 'in_progress');
			expect(reactivated.status).toBe('in_progress');
			expect(reactivated.error).toBeUndefined();
			expect(reactivated.progress).toBeUndefined();
		});

		test('needs_attention task can be archived via task.setStatus', async () => {
			const roomId = await createRoom('needs-attention-archive-setStatus');
			const task = await createTask(roomId, 'Archive needs_attention via setStatus');

			await setStatus(roomId, task.id, 'in_progress');
			await setStatus(roomId, task.id, 'needs_attention');

			const archived = await setStatus(roomId, task.id, 'archived');
			expect(archived.status).toBe('archived');
			expect(archived.archivedAt).toBeGreaterThan(0);
		});

		test('needs_attention task can be archived via task.archive RPC', async () => {
			const roomId = await createRoom('needs-attention-archive-rpc');
			const task = await createTask(roomId, 'Archive needs_attention via task.archive');

			await setStatus(roomId, task.id, 'in_progress');
			await setStatus(roomId, task.id, 'needs_attention');

			const result = (await daemon.messageHub.request('task.archive', {
				roomId,
				taskId: task.id,
			})) as { task: NeoTask };

			expect(result.task.status).toBe('archived');
			expect(result.task.archivedAt).toBeGreaterThan(0);
		});

		test('archived via needs_attention path is excluded from task.list by default', async () => {
			const roomId = await createRoom('needs-attention-list-filter');
			const task = await createTask(roomId, 'Needs attention archived list filter');

			await setStatus(roomId, task.id, 'in_progress');
			await setStatus(roomId, task.id, 'needs_attention');
			await setStatus(roomId, task.id, 'archived');

			const defaultList = await listTasks(roomId);
			expect(defaultList.map((t) => t.id)).not.toContain(task.id);

			const withArchived = await listTasks(roomId, true);
			const found = withArchived.find((t) => t.id === task.id);
			expect(found?.status).toBe('archived');
		});
	});

	// ─── Archive via task.setStatus ───────────────────────────────────────────

	describe('archive via task.setStatus → archived', () => {
		test('completed task can be archived via setStatus, archivedAt is set', async () => {
			const roomId = await createRoom('archive-via-setStatus');
			const task = await createTask(roomId, 'Archive via setStatus');

			await setStatus(roomId, task.id, 'in_progress');
			await setStatus(roomId, task.id, 'completed');

			const archived = await setStatus(roomId, task.id, 'archived');
			expect(archived.status).toBe('archived');
			expect(archived.archivedAt).toBeGreaterThan(0);
		});

		test('cancelled task can be archived via setStatus', async () => {
			const roomId = await createRoom('cancel-then-archive-setStatus');
			const task = await createTask(roomId, 'Cancel then archive setStatus');

			await setStatus(roomId, task.id, 'in_progress');
			await setStatus(roomId, task.id, 'cancelled');

			const archived = await setStatus(roomId, task.id, 'archived');
			expect(archived.status).toBe('archived');
			expect(archived.archivedAt).toBeGreaterThan(0);
		});
	});

	// ─── Archive via task.archive RPC ─────────────────────────────────────────

	describe('archive via task.archive RPC', () => {
		test('completed task can be archived via task.archive, status is archived', async () => {
			const roomId = await createRoom('archive-rpc');
			const task = await createTask(roomId, 'Archive via task.archive');

			await setStatus(roomId, task.id, 'in_progress');
			await setStatus(roomId, task.id, 'completed');

			const result = (await daemon.messageHub.request('task.archive', {
				roomId,
				taskId: task.id,
			})) as { task: NeoTask };

			expect(result.task.status).toBe('archived');
			expect(result.task.archivedAt).toBeGreaterThan(0);
		});

		test('cancelled task can be archived via task.archive', async () => {
			const roomId = await createRoom('archive-rpc-cancelled');
			const task = await createTask(roomId, 'Archive cancelled via task.archive');

			await setStatus(roomId, task.id, 'in_progress');
			await setStatus(roomId, task.id, 'cancelled');

			const result = (await daemon.messageHub.request('task.archive', {
				roomId,
				taskId: task.id,
			})) as { task: NeoTask };

			expect(result.task.status).toBe('archived');
			expect(result.task.archivedAt).toBeGreaterThan(0);
		});

		test('task.archive rejects in_progress task', async () => {
			const roomId = await createRoom('archive-active-reject');
			const task = await createTask(roomId, 'Cannot archive in_progress');

			await setStatus(roomId, task.id, 'in_progress');

			await expect(
				daemon.messageHub.request('task.archive', {
					roomId,
					taskId: task.id,
				})
			).rejects.toThrow(/Cannot archive task in 'in_progress' state/);
		});

		test('task.archive rejects pending task', async () => {
			const roomId = await createRoom('archive-pending-reject');
			const task = await createTask(roomId, 'Cannot archive pending');

			// task.create defaults to pending — archive directly without changing status
			await expect(
				daemon.messageHub.request('task.archive', {
					roomId,
					taskId: task.id,
				})
			).rejects.toThrow(/Cannot archive task in 'pending' state/);
		});
	});

	// ─── Archived is a true terminal state ────────────────────────────────────

	describe('archived → any transition is rejected', () => {
		test('archived task cannot be moved to in_progress', async () => {
			const roomId = await createRoom('archived-terminal-inprogress');
			const task = await createTask(roomId, 'Archived terminal in_progress');

			await setStatus(roomId, task.id, 'in_progress');
			await setStatus(roomId, task.id, 'completed');
			await setStatus(roomId, task.id, 'archived');

			await expect(
				daemon.messageHub.request('task.setStatus', {
					roomId,
					taskId: task.id,
					status: 'in_progress',
				})
			).rejects.toThrow(/Invalid status transition from 'archived'/);
		});

		test('archived task cannot be moved to pending', async () => {
			const roomId = await createRoom('archived-terminal-pending');
			const task = await createTask(roomId, 'Archived terminal pending');

			await setStatus(roomId, task.id, 'in_progress');
			await setStatus(roomId, task.id, 'completed');
			await setStatus(roomId, task.id, 'archived');

			await expect(
				daemon.messageHub.request('task.setStatus', {
					roomId,
					taskId: task.id,
					status: 'pending',
				})
			).rejects.toThrow(/Invalid status transition from 'archived'/);
		});

		test('archived task cannot be moved to cancelled', async () => {
			const roomId = await createRoom('archived-terminal-cancelled');
			const task = await createTask(roomId, 'Archived terminal cancelled');

			await setStatus(roomId, task.id, 'in_progress');
			await setStatus(roomId, task.id, 'cancelled');
			await setStatus(roomId, task.id, 'archived');

			await expect(
				daemon.messageHub.request('task.setStatus', {
					roomId,
					taskId: task.id,
					status: 'cancelled',
				})
			).rejects.toThrow(/Invalid status transition from 'archived'/);
		});

		test('archived task cannot be archived again', async () => {
			const roomId = await createRoom('archived-terminal-re-archive');
			const task = await createTask(roomId, 'Cannot re-archive');

			await setStatus(roomId, task.id, 'in_progress');
			await setStatus(roomId, task.id, 'completed');
			await setStatus(roomId, task.id, 'archived');

			await expect(
				daemon.messageHub.request('task.setStatus', {
					roomId,
					taskId: task.id,
					status: 'archived',
				})
			).rejects.toThrow(/Invalid status transition from 'archived'/);
		});
	});

	// ─── task.list filtering ──────────────────────────────────────────────────

	describe('task.list filtering with includeArchived', () => {
		test('archived tasks are excluded from task.list by default', async () => {
			const roomId = await createRoom('list-excludes-archived');

			const active = await createTask(roomId, 'Active task');
			const toArchive = await createTask(roomId, 'Task to archive');

			// Archive one of the tasks (starts in pending → in_progress → completed → archived)
			await setStatus(roomId, toArchive.id, 'in_progress');
			await setStatus(roomId, toArchive.id, 'completed');
			await setStatus(roomId, toArchive.id, 'archived');

			// Default list should exclude archived
			const defaultList = await listTasks(roomId);
			const ids = defaultList.map((t) => t.id);
			expect(ids).toContain(active.id);
			expect(ids).not.toContain(toArchive.id);
		});

		test('archived tasks appear when includeArchived: true', async () => {
			const roomId = await createRoom('list-includes-archived');

			const active = await createTask(roomId, 'Active task');
			const toArchive = await createTask(roomId, 'Task to archive');

			await setStatus(roomId, toArchive.id, 'in_progress');
			await setStatus(roomId, toArchive.id, 'completed');
			await setStatus(roomId, toArchive.id, 'archived');

			// With includeArchived: true, both tasks should appear
			const fullList = await listTasks(roomId, true);
			const ids = fullList.map((t) => t.id);
			expect(ids).toContain(active.id);
			expect(ids).toContain(toArchive.id);

			// Verify the archived task shows the correct status and archivedAt timestamp
			const archivedInList = fullList.find((t) => t.id === toArchive.id)!;
			expect(archivedInList.status).toBe('archived');
			expect(archivedInList.archivedAt).toBeGreaterThan(0);
		});

		test('explicitly passing includeArchived: false matches default behaviour', async () => {
			const roomId = await createRoom('list-explicit-false');

			const toArchive = await createTask(roomId, 'Task to archive');
			await setStatus(roomId, toArchive.id, 'in_progress');
			await setStatus(roomId, toArchive.id, 'completed');
			await setStatus(roomId, toArchive.id, 'archived');

			const explicit = await listTasks(roomId, false);
			expect(explicit.map((t) => t.id)).not.toContain(toArchive.id);
		});

		test('multiple archived tasks are all excluded by default', async () => {
			const roomId = await createRoom('list-multi-archived');

			const tasks = await Promise.all([
				createTask(roomId, 'Archive 1'),
				createTask(roomId, 'Archive 2'),
				createTask(roomId, 'Archive 3'),
			]);

			for (const t of tasks) {
				await setStatus(roomId, t.id, 'in_progress');
				await setStatus(roomId, t.id, 'completed');
				await setStatus(roomId, t.id, 'archived');
			}

			const defaultList = await listTasks(roomId);
			expect(defaultList.length).toBe(0);

			const fullList = await listTasks(roomId, true);
			expect(fullList.length).toBe(3);
			for (const t of fullList) {
				expect(t.status).toBe('archived');
			}
		});
	});

	// ─── task.sendHumanMessage guards ─────────────────────────────────────────

	describe('task.sendHumanMessage — lifecycle guards', () => {
		test('archived task rejects sendHumanMessage with terminal-state error', async () => {
			const roomId = await createRoom('messaging-archived');
			const task = await createTask(roomId, 'Archived messaging blocked');

			await setStatus(roomId, task.id, 'in_progress');
			await setStatus(roomId, task.id, 'completed');
			await setStatus(roomId, task.id, 'archived');

			await expect(
				daemon.messageHub.request('task.sendHumanMessage', {
					roomId,
					taskId: task.id,
					message: 'hello?',
				})
			).rejects.toThrow(/is archived and cannot receive messages/);
		});

		test('archived task error fires before runtime lookup (no group needed)', async () => {
			// The archived guard in task-handlers.ts fires before the runtime lookup,
			// so the error is consistent regardless of whether a session group exists.
			const roomId = await createRoom('messaging-archived-no-group');
			const task = await createTask(roomId, 'Archived no-group messaging blocked');

			await setStatus(roomId, task.id, 'in_progress');
			await setStatus(roomId, task.id, 'completed');
			await setStatus(roomId, task.id, 'archived');

			await expect(
				daemon.messageHub.request('task.sendHumanMessage', {
					roomId,
					taskId: task.id,
					message: 'this should fail',
				})
			).rejects.toThrow(/is archived and cannot receive messages/);

			// Verify task remains archived (no unintended side effects)
			const fetched = await getTask(roomId, task.id);
			expect(fetched.status).toBe('archived');
		});

		test('needs_attention task with no prior agent group rolls back on sendHumanMessage', async () => {
			// needs_attention tasks use 'review' as the intermediate status during revive.
			// Without a session group, reviveTaskForMessage returns false, triggering rollback.
			const roomId = await createRoom('messaging-needs-attention-no-group');
			const task = await createTask(roomId, 'Needs attention no-group rollback');

			await setStatus(roomId, task.id, 'in_progress');
			await setStatus(roomId, task.id, 'needs_attention');

			await expect(
				daemon.messageHub.request('task.sendHumanMessage', {
					roomId,
					taskId: task.id,
					message: 'please try again',
				})
			).rejects.toThrow(/Failed to revive task/);

			// Confirm rollback: task should be back to needs_attention
			const fetched = await getTask(roomId, task.id);
			expect(fetched.status).toBe('needs_attention');
		});

		test('completed task with no prior agent group rolls back to completed on sendHumanMessage', async () => {
			// When a task is manually set to completed (no actual agent run),
			// there is no session group. reviveTaskForMessage returns false and the
			// handler rolls back the task status to completed.
			const roomId = await createRoom('messaging-completed-no-group');
			const task = await createTask(roomId, 'Completed no-group rollback');

			await setStatus(roomId, task.id, 'in_progress');
			await setStatus(roomId, task.id, 'completed');

			await expect(
				daemon.messageHub.request('task.sendHumanMessage', {
					roomId,
					taskId: task.id,
					message: 'can you continue?',
				})
			).rejects.toThrow(/Failed to revive task/);

			// Confirm rollback: task should be back to completed
			const fetched = await getTask(roomId, task.id);
			expect(fetched.status).toBe('completed');
		});

		test('cancelled task with no prior agent group rolls back to cancelled on sendHumanMessage', async () => {
			const roomId = await createRoom('messaging-cancelled-no-group');
			const task = await createTask(roomId, 'Cancelled no-group rollback');

			await setStatus(roomId, task.id, 'in_progress');
			await setStatus(roomId, task.id, 'cancelled');

			await expect(
				daemon.messageHub.request('task.sendHumanMessage', {
					roomId,
					taskId: task.id,
					message: 'please restart',
				})
			).rejects.toThrow(/Failed to revive task/);

			// Confirm rollback: task should be back to cancelled
			const fetched = await getTask(roomId, task.id);
			expect(fetched.status).toBe('cancelled');
		});
	});
});
