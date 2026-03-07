import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { GoalManager } from '../../../src/lib/room/managers/goal-manager';
import { TaskManager } from '../../../src/lib/room/managers/task-manager';
import { SessionGroupRepository } from '../../../src/lib/room/state/session-group-repository';
import { createRoomAgentToolHandlers } from '../../../src/lib/room/tools/room-agent-tools';

describe('Room Agent Tools', () => {
	let db: Database;
	let goalManager: GoalManager;
	let taskManager: TaskManager;
	let groupRepo: SessionGroupRepository;
	let handlers: ReturnType<typeof createRoomAgentToolHandlers>;
	const roomId = 'room-1';

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec(`
			CREATE TABLE rooms (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE goals (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'active',
				priority TEXT NOT NULL DEFAULT 'normal',
				progress INTEGER DEFAULT 0,
				linked_task_ids TEXT DEFAULT '[]',
				metrics TEXT DEFAULT '{}',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				completed_at INTEGER
			);
			CREATE TABLE tasks (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				priority TEXT NOT NULL DEFAULT 'normal',
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				depends_on TEXT DEFAULT '[]',
				task_type TEXT DEFAULT 'coding',
				created_by_task_id TEXT,
				assigned_agent TEXT DEFAULT 'coder',
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER
			);
			CREATE TABLE session_groups (
				id TEXT PRIMARY KEY,
				group_type TEXT NOT NULL DEFAULT 'task',
				ref_id TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'awaiting_worker',
				version INTEGER NOT NULL DEFAULT 0,
				metadata TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL,
				completed_at INTEGER
			);
			CREATE TABLE session_group_members (
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				session_id TEXT NOT NULL,
				role TEXT NOT NULL,
				joined_at INTEGER NOT NULL,
				PRIMARY KEY (group_id, session_id)
			);
			CREATE TABLE task_group_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				kind TEXT NOT NULL,
				payload_json TEXT,
				created_at INTEGER NOT NULL
			);
			INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('${roomId}', 'Test', ${Date.now()}, ${Date.now()});
		`);

		goalManager = new GoalManager(db as never, roomId);
		taskManager = new TaskManager(db as never, roomId);
		groupRepo = new SessionGroupRepository(db as never);
		handlers = createRoomAgentToolHandlers({ roomId, goalManager, taskManager, groupRepo });
	});

	afterEach(() => {
		db.close();
	});

	function parseResult(result: { content: Array<{ type: string; text: string }> }) {
		return JSON.parse(result.content[0].text) as Record<string, unknown>;
	}

	function insertGroup(taskId: string, state: string = 'awaiting_human') {
		const groupId = `group-${taskId}`;
		const metadata = JSON.stringify({
			feedbackIteration: 0,
			leaderContractViolations: 0,
			leaderCalledTool: false,
			lastProcessedLeaderTurnId: null,
			lastForwardedMessageId: null,
			activeWorkStartedAt: null,
			activeWorkElapsed: 0,
			hibernatedAt: null,
			tokensUsed: 0,
			workerRole: 'coder',
			submittedForReview: false,
			approved: false,
		});
		db.run(
			'INSERT INTO session_groups (id, group_type, ref_id, state, version, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
			[groupId, 'task', taskId, state, 0, metadata, Date.now()]
		);
		db.run(
			'INSERT INTO session_group_members (group_id, session_id, role, joined_at) VALUES (?, ?, ?, ?)',
			[groupId, 'worker-session-1', 'worker', Date.now()]
		);
		db.run(
			'INSERT INTO session_group_members (group_id, session_id, role, joined_at) VALUES (?, ?, ?, ?)',
			[groupId, 'leader-session-1', 'leader', Date.now()]
		);
		return groupId;
	}

	describe('create_goal', () => {
		it('should create a goal', async () => {
			const result = parseResult(
				await handlers.create_goal({
					title: 'Add health check',
					description: 'Need an endpoint at /health',
				})
			);
			expect(result.success).toBe(true);
			expect(result.goalId).toBeDefined();
		});
	});

	describe('list_goals', () => {
		it('should list goals', async () => {
			await handlers.create_goal({ title: 'Goal 1' });
			await handlers.create_goal({ title: 'Goal 2' });
			const result = parseResult(await handlers.list_goals());
			expect(result.success).toBe(true);
			expect((result.goals as unknown[]).length).toBe(2);
		});
	});

	describe('update_goal', () => {
		it('should update goal status', async () => {
			const created = parseResult(await handlers.create_goal({ title: 'Goal' }));
			const goalId = created.goalId as string;
			const result = parseResult(
				await handlers.update_goal({ goal_id: goalId, status: 'completed' })
			);
			expect(result.success).toBe(true);
		});

		it('should return error for non-existent goal', async () => {
			const result = parseResult(
				await handlers.update_goal({ goal_id: 'no-such-goal', status: 'completed' })
			);
			expect(result.success).toBe(false);
		});
	});

	describe('create_task', () => {
		it('should create a task', async () => {
			const result = parseResult(
				await handlers.create_task({
					title: 'Implement endpoint',
					description: 'Add GET /health returning 200',
				})
			);
			expect(result.success).toBe(true);
			expect(result.taskId).toBeDefined();
		});

		it('should link task to goal when goal_id provided', async () => {
			const goal = parseResult(await handlers.create_goal({ title: 'Health' }));
			const goalId = goal.goalId as string;

			await handlers.create_task({
				title: 'Impl',
				description: 'Do it',
				goal_id: goalId,
			});

			const goals = parseResult(await handlers.list_goals());
			const updatedGoal = (goals.goals as Array<{ id: string; linkedTaskIds: string[] }>).find(
				(g) => g.id === goalId
			);
			expect(updatedGoal!.linkedTaskIds.length).toBe(1);
		});
	});

	describe('list_tasks', () => {
		it('should list all tasks', async () => {
			await handlers.create_task({ title: 'T1', description: 'd1' });
			await handlers.create_task({ title: 'T2', description: 'd2' });
			const result = parseResult(await handlers.list_tasks({}));
			expect((result.tasks as unknown[]).length).toBe(2);
		});

		it('should filter by goal_id', async () => {
			const goal = parseResult(await handlers.create_goal({ title: 'G1' }));
			const goalId = goal.goalId as string;
			await handlers.create_task({
				title: 'Linked',
				description: 'd',
				goal_id: goalId,
			});
			await handlers.create_task({ title: 'Unlinked', description: 'd' });

			const result = parseResult(await handlers.list_tasks({ goal_id: goalId }));
			expect((result.tasks as unknown[]).length).toBe(1);
		});
	});

	describe('update_task', () => {
		it('should return error for non-existent task', async () => {
			const result = parseResult(
				await handlers.update_task({ task_id: 'no-such-task', priority: 'high' })
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain('Task not found');
		});

		it('should update task priority', async () => {
			const created = parseResult(
				await handlers.create_task({ title: 'My task', description: 'd' })
			);
			const taskId = created.taskId as string;

			const result = parseResult(await handlers.update_task({ task_id: taskId, priority: 'high' }));
			expect(result.success).toBe(true);
			const task = result.task as { id: string; priority: string };
			expect(task.priority).toBe('high');
		});

		it('should update task title', async () => {
			const created = parseResult(
				await handlers.create_task({ title: 'Original title', description: 'desc' })
			);
			const taskId = created.taskId as string;

			const result = parseResult(
				await handlers.update_task({ task_id: taskId, title: 'Updated title' })
			);
			expect(result.success).toBe(true);
			const task = result.task as { id: string; title: string };
			expect(task.title).toBe('Updated title');
		});

		it('should update task description', async () => {
			const created = parseResult(
				await handlers.create_task({ title: 'T', description: 'Original description' })
			);
			const taskId = created.taskId as string;

			const result = parseResult(
				await handlers.update_task({ task_id: taskId, description: 'Updated description' })
			);
			expect(result.success).toBe(true);
			const task = result.task as { id: string; description: string };
			expect(task.description).toBe('Updated description');
		});

		it('should update title, description, and priority together', async () => {
			const created = parseResult(
				await handlers.create_task({ title: 'Old', description: 'Old desc' })
			);
			const taskId = created.taskId as string;

			const result = parseResult(
				await handlers.update_task({
					task_id: taskId,
					title: 'New title',
					description: 'New description',
					priority: 'urgent',
				})
			);
			expect(result.success).toBe(true);
			const task = result.task as { title: string; description: string; priority: string };
			expect(task.title).toBe('New title');
			expect(task.description).toBe('New description');
			expect(task.priority).toBe('urgent');
		});

		it('should preserve existing fields when updating only one field', async () => {
			const created = parseResult(
				await handlers.create_task({
					title: 'Keep title',
					description: 'Keep desc',
					priority: 'low',
				})
			);
			const taskId = created.taskId as string;

			// Update only priority
			const result = parseResult(
				await handlers.update_task({ task_id: taskId, priority: 'urgent' })
			);
			expect(result.success).toBe(true);
			const task = result.task as { title: string; description: string; priority: string };
			expect(task.title).toBe('Keep title');
			expect(task.description).toBe('Keep desc');
			expect(task.priority).toBe('urgent');
		});

		it('should work for tasks with any status', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;
			// Move task to in_progress status
			await taskManager.startTask(taskId);

			const result = parseResult(
				await handlers.update_task({ task_id: taskId, title: 'Updated while in_progress' })
			);
			expect(result.success).toBe(true);
			const task = result.task as { title: string; status: string };
			expect(task.title).toBe('Updated while in_progress');
			expect(task.status).toBe('in_progress');
		});

		it('should return updated task in response', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'desc' }));
			const taskId = created.taskId as string;

			const result = parseResult(
				await handlers.update_task({ task_id: taskId, title: 'New title' })
			);
			expect(result.success).toBe(true);
			const task = result.task as { id: string; title: string };
			expect(task.id).toBe(taskId);
			expect(task.title).toBe('New title');
		});

		it('should succeed and return task unchanged when no fields are provided (no-op)', async () => {
			const created = parseResult(
				await handlers.create_task({ title: 'Original', description: 'desc' })
			);
			const taskId = created.taskId as string;

			const result = parseResult(await handlers.update_task({ task_id: taskId }));
			expect(result.success).toBe(true);
			const task = result.task as { id: string; title: string };
			expect(task.id).toBe(taskId);
			expect(task.title).toBe('Original');
		});
	});

	describe('cancel_task', () => {
		it('should cancel a task', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const result = parseResult(await handlers.cancel_task({ task_id: created.taskId as string }));
			expect(result.success).toBe(true);

			// cancelled status is distinct from failed
			const cancelledTasks = parseResult(await handlers.list_tasks({ status: 'cancelled' }));
			expect((cancelledTasks.tasks as unknown[]).length).toBe(1);

			const failedTasks = parseResult(await handlers.list_tasks({ status: 'failed' }));
			expect((failedTasks.tasks as unknown[]).length).toBe(0);
		});

		it('should return error when task not found', async () => {
			const result = parseResult(await handlers.cancel_task({ task_id: 'no-such-task' }));
			expect(result.success).toBe(false);
			expect(result.error).toContain('Task not found');
		});
	});

	describe('get_room_status', () => {
		it('should return room overview', async () => {
			await handlers.create_goal({ title: 'G1' });
			await handlers.create_task({ title: 'T1', description: 'd' });
			const result = parseResult(await handlers.get_room_status());
			expect(result.success).toBe(true);

			const status = result.status as {
				goals: { total: number };
				tasks: { total: number; cancelled: number };
				activeGroups: number;
				tasksNeedingReview: unknown[];
			};
			expect(status.goals.total).toBe(1);
			expect(status.tasks.total).toBe(1);
			expect(status.tasks.cancelled).toBe(0);
			expect(status.activeGroups).toBe(0);
			expect(status.tasksNeedingReview).toEqual([]);
		});

		it('should count cancelled tasks separately from failed', async () => {
			const t1 = parseResult(await handlers.create_task({ title: 'To cancel', description: 'd' }));
			await handlers.cancel_task({ task_id: t1.taskId as string });

			const result = parseResult(await handlers.get_room_status());
			const status = result.status as {
				tasks: { total: number; failed: number; cancelled: number };
			};
			expect(status.tasks.total).toBe(1);
			expect(status.tasks.failed).toBe(0);
			expect(status.tasks.cancelled).toBe(1);
		});

		it('should include tasks in review status in tasksNeedingReview', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T1', description: 'd' }));
			const taskId = created.taskId as string;
			// Set task to review status
			await taskManager.reviewTask(taskId);

			const result = parseResult(await handlers.get_room_status());
			const status = result.status as {
				tasksNeedingReview: Array<{ taskId: string; title: string }>;
			};
			expect(status.tasksNeedingReview.length).toBe(1);
			expect(status.tasksNeedingReview[0].taskId).toBe(taskId);
			expect(status.tasksNeedingReview[0].title).toBe('T1');
		});

		it('should include tasks with awaiting_human group state in tasksNeedingReview', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T2', description: 'd' }));
			const taskId = created.taskId as string;
			// Create a group in awaiting_human state (without task being in review status)
			insertGroup(taskId, 'awaiting_human');

			const result = parseResult(await handlers.get_room_status());
			const status = result.status as {
				tasksNeedingReview: Array<{ taskId: string; title: string }>;
			};
			expect(status.tasksNeedingReview.length).toBe(1);
			expect(status.tasksNeedingReview[0].taskId).toBe(taskId);
		});

		it('should not duplicate tasks in tasksNeedingReview when both review status and awaiting_human group', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T3', description: 'd' }));
			const taskId = created.taskId as string;
			await taskManager.reviewTask(taskId);
			insertGroup(taskId, 'awaiting_human');

			const result = parseResult(await handlers.get_room_status());
			const status = result.status as {
				tasksNeedingReview: Array<{ taskId: string }>;
			};
			// Should appear only once despite matching both criteria
			expect(status.tasksNeedingReview.length).toBe(1);
			expect(status.tasksNeedingReview[0].taskId).toBe(taskId);
		});
	});

	describe('approve_task', () => {
		it('should return error when task not found', async () => {
			const result = parseResult(await handlers.approve_task({ task_id: 'no-such-task' }));
			expect(result.success).toBe(false);
			expect(result.error).toContain('Task not found');
		});

		it('should return error when runtimeService not configured', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const result = parseResult(
				await handlers.approve_task({ task_id: created.taskId as string })
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain('Runtime service not available');
		});

		it('should return error when runtime not found for room', async () => {
			const mockRuntimeService = { getRuntime: () => null };
			const h = createRoomAgentToolHandlers({
				roomId,
				goalManager,
				taskManager,
				groupRepo,
				runtimeService: mockRuntimeService,
			});
			const created = parseResult(await h.create_task({ title: 'T', description: 'd' }));
			const result = parseResult(await h.approve_task({ task_id: created.taskId as string }));
			expect(result.success).toBe(false);
			expect(result.error).toContain('Room runtime not found');
		});

		it('should call resumeWorkerFromHuman with approved:true on success', async () => {
			let capturedArgs: unknown[] = [];
			const mockRuntime = {
				resumeWorkerFromHuman: async (...args: unknown[]) => {
					capturedArgs = args;
					return true;
				},
				injectMessageToLeader: async () => true,
			};
			const h = createRoomAgentToolHandlers({
				roomId,
				goalManager,
				taskManager,
				groupRepo,
				runtimeService: { getRuntime: () => mockRuntime as never },
			});
			const created = parseResult(await h.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;
			const result = parseResult(await h.approve_task({ task_id: taskId }));

			expect(result.success).toBe(true);
			expect(capturedArgs[0]).toBe(taskId);
			expect(capturedArgs[2]).toEqual({ approved: true });
		});

		it('should return error when runtime resumeWorkerFromHuman returns false', async () => {
			const mockRuntime = {
				resumeWorkerFromHuman: async () => false,
				injectMessageToLeader: async () => true,
			};
			const h = createRoomAgentToolHandlers({
				roomId,
				goalManager,
				taskManager,
				groupRepo,
				runtimeService: { getRuntime: () => mockRuntime as never },
			});
			const created = parseResult(await h.create_task({ title: 'T', description: 'd' }));
			const result = parseResult(await h.approve_task({ task_id: created.taskId as string }));
			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to approve task');
		});
	});

	describe('reject_task', () => {
		it('should return error when task not found', async () => {
			const result = parseResult(
				await handlers.reject_task({ task_id: 'no-such-task', feedback: 'Not good' })
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain('Task not found');
		});

		it('should return error when runtimeService not configured', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const result = parseResult(
				await handlers.reject_task({ task_id: created.taskId as string, feedback: 'Needs work' })
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain('Runtime service not available');
		});

		it('should call resumeWorkerFromHuman with approved:false and feedback', async () => {
			let capturedArgs: unknown[] = [];
			const mockRuntime = {
				resumeWorkerFromHuman: async (...args: unknown[]) => {
					capturedArgs = args;
					return true;
				},
				injectMessageToLeader: async () => true,
			};
			const h = createRoomAgentToolHandlers({
				roomId,
				goalManager,
				taskManager,
				groupRepo,
				runtimeService: { getRuntime: () => mockRuntime as never },
			});
			const created = parseResult(await h.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;
			const result = parseResult(
				await h.reject_task({ task_id: taskId, feedback: 'Please fix the tests' })
			);

			expect(result.success).toBe(true);
			expect(capturedArgs[0]).toBe(taskId);
			expect(capturedArgs[1]).toBe('Please fix the tests');
			expect(capturedArgs[2]).toEqual({ approved: false });
		});
	});

	describe('send_message_to_task', () => {
		it('should return error when task not found', async () => {
			const result = parseResult(
				await handlers.send_message_to_task({ task_id: 'no-such-task', message: 'hello' })
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain('Task not found');
		});

		it('should return error when runtimeService not configured', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const result = parseResult(
				await handlers.send_message_to_task({
					task_id: created.taskId as string,
					message: 'hello',
				})
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain('Runtime service not available');
		});

		it('should route message to worker when group is in awaiting_human state', async () => {
			let capturedArgs: unknown[] = [];
			const mockRuntime = {
				resumeWorkerFromHuman: async (...args: unknown[]) => {
					capturedArgs = args;
					return true;
				},
				injectMessageToLeader: async () => true,
			};
			const h = createRoomAgentToolHandlers({
				roomId,
				goalManager,
				taskManager,
				groupRepo,
				runtimeService: { getRuntime: () => mockRuntime as never },
			});
			const created = parseResult(await h.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;
			insertGroup(taskId, 'awaiting_human');

			const result = parseResult(
				await h.send_message_to_task({ task_id: taskId, message: 'Looks good, proceed' })
			);
			expect(result.success).toBe(true);
			// routeHumanMessageToGroup calls resumeWorkerFromHuman for awaiting_human state
			expect(capturedArgs[0]).toBe(taskId);
			expect(capturedArgs[1]).toBe('Looks good, proceed');
		});

		it('should route message to leader when group is in awaiting_leader state', async () => {
			let capturedArgs: unknown[] = [];
			const mockRuntime = {
				resumeWorkerFromHuman: async () => true,
				injectMessageToLeader: async (...args: unknown[]) => {
					capturedArgs = args;
					return true;
				},
			};
			const h = createRoomAgentToolHandlers({
				roomId,
				goalManager,
				taskManager,
				groupRepo,
				runtimeService: { getRuntime: () => mockRuntime as never },
			});
			const created = parseResult(await h.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;
			insertGroup(taskId, 'awaiting_leader');

			const result = parseResult(
				await h.send_message_to_task({ task_id: taskId, message: 'Check the edge cases' })
			);
			expect(result.success).toBe(true);
			expect(capturedArgs[0]).toBe(taskId);
		});

		it('should return error when no active group for task', async () => {
			const mockRuntime = {
				resumeWorkerFromHuman: async () => true,
				injectMessageToLeader: async () => true,
			};
			const h = createRoomAgentToolHandlers({
				roomId,
				goalManager,
				taskManager,
				groupRepo,
				runtimeService: { getRuntime: () => mockRuntime as never },
			});
			const created = parseResult(await h.create_task({ title: 'T', description: 'd' }));
			const result = parseResult(
				await h.send_message_to_task({ task_id: created.taskId as string, message: 'hello' })
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain('No active session group');
		});
	});

	describe('get_task_detail', () => {
		it('should return error when task not found', async () => {
			const result = parseResult(await handlers.get_task_detail({ task_id: 'no-such-task' }));
			expect(result.success).toBe(false);
			expect(result.error).toContain('Task not found');
		});

		it('should return task details without group when no group exists', async () => {
			const created = parseResult(
				await handlers.create_task({ title: 'My task', description: 'Do something' })
			);
			const taskId = created.taskId as string;

			const result = parseResult(await handlers.get_task_detail({ task_id: taskId }));
			expect(result.success).toBe(true);
			const task = result.task as { id: string; title: string };
			expect(task.id).toBe(taskId);
			expect(task.title).toBe('My task');
			expect(result.group).toBeNull();
		});

		it('should return full task and group details when group exists', async () => {
			const created = parseResult(
				await handlers.create_task({ title: 'Task with group', description: 'd' })
			);
			const taskId = created.taskId as string;
			insertGroup(taskId, 'awaiting_human');

			const result = parseResult(await handlers.get_task_detail({ task_id: taskId }));
			expect(result.success).toBe(true);
			const task = result.task as { id: string; title: string };
			expect(task.id).toBe(taskId);

			const group = result.group as {
				id: string;
				state: string;
				workerSessionId: string;
				leaderSessionId: string;
				feedbackIteration: number;
				awaitingHumanReview: boolean;
			};
			expect(group).not.toBeNull();
			expect(group.id).toBe(`group-${taskId}`);
			expect(group.state).toBe('awaiting_human');
			expect(group.workerSessionId).toBe('worker-session-1');
			expect(group.leaderSessionId).toBe('leader-session-1');
			expect(group.feedbackIteration).toBe(0);
			expect(group.awaitingHumanReview).toBe(true);
		});

		it('should report awaitingHumanReview as false for non-awaiting_human states', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;
			insertGroup(taskId, 'awaiting_leader');

			const result = parseResult(await handlers.get_task_detail({ task_id: taskId }));
			const group = result.group as { state: string; awaitingHumanReview: boolean };
			expect(group.state).toBe('awaiting_leader');
			expect(group.awaitingHumanReview).toBe(false);
		});
	});
});
