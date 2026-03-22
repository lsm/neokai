import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { GoalManager } from '../../../src/lib/room/managers/goal-manager';
import { noOpReactiveDb } from '../../helpers/reactive-database';
import { TaskManager } from '../../../src/lib/room/managers/task-manager';
import { SessionGroupRepository } from '../../../src/lib/room/state/session-group-repository';
import {
	createRoomAgentToolHandlers,
	createRoomAgentMcpServer,
	createLeaderContextMcpServer,
} from '../../../src/lib/room/tools/room-agent-tools';

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
				completed_at INTEGER,
				planning_attempts INTEGER DEFAULT 0,
				goal_review_attempts INTEGER DEFAULT 0,
				mission_type TEXT NOT NULL DEFAULT 'one_shot'
					CHECK(mission_type IN ('one_shot', 'measurable', 'recurring')),
				autonomy_level TEXT NOT NULL DEFAULT 'supervised'
					CHECK(autonomy_level IN ('supervised', 'semi_autonomous')),
				schedule TEXT,
				schedule_paused INTEGER NOT NULL DEFAULT 0,
				next_run_at INTEGER,
				structured_metrics TEXT,
				max_consecutive_failures INTEGER NOT NULL DEFAULT 3,
				max_planning_attempts INTEGER NOT NULL DEFAULT 5,
				consecutive_failures INTEGER NOT NULL DEFAULT 0,
		replan_count INTEGER NOT NULL DEFAULT 0
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
				completed_at INTEGER,
				archived_at INTEGER,
				active_session TEXT,
				pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,
				updated_at INTEGER
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
			CREATE TABLE mission_metric_history (
				id TEXT PRIMARY KEY,
				goal_id TEXT NOT NULL,
				metric_name TEXT NOT NULL,
				value REAL NOT NULL,
				recorded_at INTEGER NOT NULL,
				FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_mission_metric_history_lookup
				ON mission_metric_history(goal_id, metric_name, recorded_at);
			INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('${roomId}', 'Test', ${Date.now()}, ${Date.now()});
		`);

		goalManager = new GoalManager(db as never, roomId, noOpReactiveDb);
		taskManager = new TaskManager(db as never, roomId, noOpReactiveDb);
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
			submittedForReview: state === 'awaiting_human',
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

		it('should create a task with depends_on', async () => {
			// Create prerequisite task first
			const prerequisite = parseResult(
				await handlers.create_task({
					title: 'Prerequisite task',
					description: 'This must complete first',
				})
			);
			const prerequisiteId = prerequisite.taskId as string;

			// Create dependent task
			const result = parseResult(
				await handlers.create_task({
					title: 'Dependent task',
					description: 'Depends on prerequisite',
					depends_on: [prerequisiteId],
				})
			);
			expect(result.success).toBe(true);
			const task = result.task as { id: string; dependsOn: string[] };
			expect(task.dependsOn).toEqual([prerequisiteId]);
		});

		it('should create a task with task_type', async () => {
			const result = parseResult(
				await handlers.create_task({
					title: 'Research task',
					description: 'Investigate options',
					task_type: 'research',
				})
			);
			expect(result.success).toBe(true);
			const task = result.task as { id: string; taskType: string };
			expect(task.taskType).toBe('research');
		});

		it('should create a task with assigned_agent', async () => {
			const result = parseResult(
				await handlers.create_task({
					title: 'General task',
					description: 'Any agent can do this',
					assigned_agent: 'general',
				})
			);
			expect(result.success).toBe(true);
			const task = result.task as { id: string; assignedAgent: string };
			expect(task.assignedAgent).toBe('general');
		});

		it('should create a task with all new fields', async () => {
			const prerequisite = parseResult(
				await handlers.create_task({
					title: 'First task',
					description: 'Start here',
				})
			);
			const prerequisiteId = prerequisite.taskId as string;

			const result = parseResult(
				await handlers.create_task({
					title: 'Full featured task',
					description: 'All options',
					depends_on: [prerequisiteId],
					task_type: 'coding',
					assigned_agent: 'coder',
				})
			);
			expect(result.success).toBe(true);
			const task = result.task as {
				id: string;
				dependsOn: string[];
				taskType: string;
				assignedAgent: string;
			};
			expect(task.dependsOn).toEqual([prerequisiteId]);
			expect(task.taskType).toBe('coding');
			expect(task.assignedAgent).toBe('coder');
		});

		it('should return error when depends_on references non-existent task', async () => {
			const result = parseResult(
				await handlers.create_task({
					title: 'Task with bad dependency',
					description: 'References non-existent task',
					depends_on: ['non-existent-task-id'],
				})
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain('Dependency task not found');
		});

		it('should reject task_type planning as it is reserved for internal use', async () => {
			const result = parseResult(
				await handlers.create_task({
					title: 'Planning task',
					description: 'This should be rejected',
					task_type: 'planning' as never, // cast to bypass TS check
				})
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain("'planning' is reserved for internal use");
		});

		it('should allow task_type coding, research, design, goal_review but not planning', async () => {
			for (const taskType of ['coding', 'research', 'design', 'goal_review'] as const) {
				const result = parseResult(
					await handlers.create_task({
						title: `${taskType} task`,
						description: 'Should succeed',
						task_type: taskType,
					})
				);
				expect(result.success).toBe(true);
			}
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

		it('should update task depends_on', async () => {
			// Create two prerequisite tasks
			const prereq1 = parseResult(
				await handlers.create_task({ title: 'Prereq 1', description: 'First' })
			);
			const prereq1Id = prereq1.taskId as string;
			const prereq2 = parseResult(
				await handlers.create_task({ title: 'Prereq 2', description: 'Second' })
			);
			const prereq2Id = prereq2.taskId as string;

			// Create dependent task
			const created = parseResult(
				await handlers.create_task({
					title: 'Dependent',
					description: 'Depends on others',
					depends_on: [prereq1Id],
				})
			);
			const taskId = created.taskId as string;

			// Update to depend on both tasks
			const result = parseResult(
				await handlers.update_task({ task_id: taskId, depends_on: [prereq1Id, prereq2Id] })
			);
			expect(result.success).toBe(true);
			const task = result.task as { dependsOn: string[] };
			expect(task.dependsOn).toEqual([prereq1Id, prereq2Id]);
		});

		it('should clear depends_on when set to empty array', async () => {
			// Create prerequisite task
			const prereq = parseResult(
				await handlers.create_task({ title: 'Prereq', description: 'First' })
			);
			const prereqId = prereq.taskId as string;

			// Create dependent task
			const created = parseResult(
				await handlers.create_task({
					title: 'Dependent',
					description: 'Depends on other',
					depends_on: [prereqId],
				})
			);
			const taskId = created.taskId as string;

			// Clear dependencies
			const result = parseResult(await handlers.update_task({ task_id: taskId, depends_on: [] }));
			expect(result.success).toBe(true);
			const task = result.task as { dependsOn: string[] };
			expect(task.dependsOn).toEqual([]);
		});

		it('should return error when updating depends_on with non-existent task', async () => {
			const created = parseResult(await handlers.create_task({ title: 'Task', description: 'd' }));
			const taskId = created.taskId as string;

			const result = parseResult(
				await handlers.update_task({ task_id: taskId, depends_on: ['non-existent-task-id'] })
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain('Dependency task not found');
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

			const failedTasks = parseResult(await handlers.list_tasks({ status: 'needs_attention' }));
			expect((failedTasks.tasks as unknown[]).length).toBe(0);
		});

		it('should use runtime cancellation when runtime service is available', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const calls: Array<string> = [];
			const mockRuntime = {
				cancelTask: async (taskId: string) => {
					calls.push(taskId);
					return { success: true, cancelledTaskIds: [taskId] };
				},
			};
			const runtimeHandlers = createRoomAgentToolHandlers({
				roomId,
				goalManager,
				taskManager,
				groupRepo,
				runtimeService: { getRuntime: () => mockRuntime as never },
			});

			const result = parseResult(
				await runtimeHandlers.cancel_task({ task_id: created.taskId as string })
			);
			expect(result.success).toBe(true);
			expect(calls).toEqual([created.taskId]);
		});

		it('should return error when task not found', async () => {
			const result = parseResult(await handlers.cancel_task({ task_id: 'no-such-task' }));
			expect(result.success).toBe(false);
			expect(result.error).toContain('Task not found');
		});
	});

	describe('stop_session', () => {
		it('should interrupt in_progress task (task stays active)', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;
			// Move task to in_progress
			await taskManager.setTaskStatus(taskId, 'in_progress');

			// Without runtime service, returns error (interrupt requires runtime)
			const result = parseResult(await handlers.stop_session({ task_id: taskId }));
			expect(result.success).toBe(false);
			expect(result.error).toContain('unavailable');

			// Task should still be in_progress (not failed)
			const task = await taskManager.getTask(taskId);
			expect(task!.status).toBe('in_progress');
		});

		it('should use runtime.interruptTaskSession when runtime service is available', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;
			await taskManager.setTaskStatus(taskId, 'in_progress');

			const calls: Array<string> = [];
			const mockRuntime = {
				interruptTaskSession: async (tid: string) => {
					calls.push(tid);
					return { success: true };
				},
			};
			const runtimeHandlers = createRoomAgentToolHandlers({
				roomId,
				goalManager,
				taskManager,
				groupRepo,
				runtimeService: { getRuntime: () => mockRuntime as never },
			});

			const result = parseResult(await runtimeHandlers.stop_session({ task_id: taskId }));
			expect(result.success).toBe(true);
			expect(result.message).toContain('interrupted');
			expect(calls).toEqual([taskId]);
		});

		it('should return error when task not found', async () => {
			const result = parseResult(await handlers.stop_session({ task_id: 'no-such-task' }));
			expect(result.success).toBe(false);
			expect(result.error).toContain('Task not found');
		});

		it('should return error for pending task', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			// Task is pending by default
			const result = parseResult(
				await handlers.stop_session({ task_id: created.taskId as string })
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain('Task cannot be interrupted');
		});

		it('should return error for completed task', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			await taskManager.setTaskStatus(created.taskId as string, 'in_progress');
			await taskManager.completeTask(created.taskId as string, 'done');

			const result = parseResult(
				await handlers.stop_session({ task_id: created.taskId as string })
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain('Task cannot be interrupted');
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

		it('should count cancelled tasks separately from needs_attention tasks', async () => {
			const t1 = parseResult(await handlers.create_task({ title: 'To cancel', description: 'd' }));
			await handlers.cancel_task({ task_id: t1.taskId as string });

			const result = parseResult(await handlers.get_room_status());
			const status = result.status as {
				tasks: { total: number; needsAttention: number; cancelled: number };
			};
			expect(status.tasks.total).toBe(1);
			expect(status.tasks.needsAttention).toBe(0);
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
				injectMessageToWorker: async (...args: unknown[]) => {
					capturedArgs = args;
					return true;
				},
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
			const taskId = created.taskId as string;
			insertGroup(taskId, 'awaiting_human');

			const result = parseResult(
				await h.send_message_to_task({ task_id: taskId, message: 'Looks good, proceed' })
			);
			expect(result.success).toBe(true);
			expect(capturedArgs[0]).toBe(taskId);
			expect(capturedArgs[1]).toBe('Looks good, proceed');
		});

		it('should route message to worker by default even when group is in awaiting_leader state', async () => {
			let capturedArgs: unknown[] = [];
			const mockRuntime = {
				resumeWorkerFromHuman: async () => true,
				injectMessageToLeader: async () => true,
				injectMessageToWorker: async (...args: unknown[]) => {
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

		it('should auto-revive failed task and call reviveTaskForMessage', async () => {
			let reviveCalledWith: unknown[] = [];
			const mockRuntime = {
				reviveTaskForMessage: async (...args: unknown[]) => {
					reviveCalledWith = args;
					return true;
				},
				injectMessageToWorker: async () => true,
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

			// Move to failed state
			await taskManager.startTask(taskId);
			await taskManager.failTask(taskId, 'test failure');

			const result = parseResult(
				await h.send_message_to_task({ task_id: taskId, message: 'please retry' })
			);
			expect(result.success).toBe(true);
			expect(result.message).toContain('revived');

			// Task should be in review status after revive
			const task = await taskManager.getTask(taskId);
			expect(task!.status).toBe('review');

			// reviveTaskForMessage should have been called with correct args
			expect(reviveCalledWith[0]).toBe(taskId);
			expect(reviveCalledWith[1]).toBe('please retry');
		});

		it('should auto-reactivate cancelled task and deliver message (preserving group history)', async () => {
			const mockRuntime = {
				reviveTaskForMessage: async () => true,
				injectMessageToWorker: async () => true,
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

			// Move to cancelled state with a group that has completedAt set
			await taskManager.startTask(taskId);
			const groupId = insertGroup(taskId, 'awaiting_human');
			const groupInserted = groupRepo.getGroup(groupId);
			groupRepo.completeGroup(groupId, groupInserted!.version);
			await taskManager.cancelTask(taskId);

			// Verify the group has a non-null completedAt before reactivation
			const groupBefore = groupRepo.getGroup(groupId);
			expect(groupBefore!.completedAt).not.toBeNull();

			const result = parseResult(
				await h.send_message_to_task({ task_id: taskId, message: 'resume please' })
			);
			// Cancelled task should be auto-reactivated and message delivered
			expect(result.success).toBe(true);
			expect(result.message).toContain('cancelled');
			expect(result.message).toContain('in_progress');

			// Task should now be in_progress
			const task = await taskManager.getTask(taskId);
			expect(task!.status).toBe('in_progress');

			// Group history is PRESERVED — no resetGroupForRestart, reviveTaskForMessage keeps context
			const groupAfter = groupRepo.getGroup(groupId);
			expect(groupAfter!.completedAt).not.toBeNull();
		});

		it('should roll back cancelled task when reviveTaskForMessage fails (group state preserved)', async () => {
			const mockRuntime = {
				reviveTaskForMessage: async () => false,
				injectMessageToWorker: async () => true,
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

			// Move to cancelled state with a group that has completedAt set
			await taskManager.startTask(taskId);
			const groupId = insertGroup(taskId, 'awaiting_human');
			const groupInserted = groupRepo.getGroup(groupId);
			groupRepo.completeGroup(groupId, groupInserted!.version);
			await taskManager.cancelTask(taskId);

			const result = parseResult(
				await h.send_message_to_task({ task_id: taskId, message: 'resume please' })
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain('cancelled');

			// Task status should be rolled back to cancelled
			const task = await taskManager.getTask(taskId);
			expect(task!.status).toBe('cancelled');

			// Group state should be untouched — no metadata was wiped during the failed attempt
			const groupAfter = groupRepo.getGroup(groupId);
			expect(groupAfter!.completedAt).not.toBeNull();
		});

		it('should roll back task to needs_attention when reviveTaskForMessage returns false', async () => {
			const mockRuntime = {
				reviveTaskForMessage: async () => false,
				injectMessageToWorker: async () => true,
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

			await taskManager.startTask(taskId);
			await taskManager.failTask(taskId, 'test failure');

			const result = parseResult(
				await h.send_message_to_task({ task_id: taskId, message: 'hello' })
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain('needs_attention');

			// Task status should be rolled back to failed (not left in review)
			const task = await taskManager.getTask(taskId);
			expect(task!.status).toBe('needs_attention');
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
				completedAt: number | null;
				workerSessionId: string;
				leaderSessionId: string;
				feedbackIteration: number;
				awaitingHumanReview: boolean;
			};
			expect(group).not.toBeNull();
			expect(group.id).toBe(`group-${taskId}`);
			expect(group.completedAt).toBeNull();
			expect(group.workerSessionId).toBe('worker-session-1');
			expect(group.leaderSessionId).toBe('leader-session-1');
			expect(group.feedbackIteration).toBe(0);
			expect(group.awaitingHumanReview).toBe(true);
		});

		it('should report awaitingHumanReview as false for non-awaiting_human groups', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;
			insertGroup(taskId, 'awaiting_worker');

			const result = parseResult(await handlers.get_task_detail({ task_id: taskId }));
			const group = result.group as { completedAt: number | null; awaitingHumanReview: boolean };
			expect(group.completedAt).toBeNull();
			expect(group.awaitingHumanReview).toBe(false);
		});
	});

	describe('set_task_status', () => {
		it('should return error when task not found', async () => {
			const result = parseResult(
				await handlers.set_task_status({ task_id: 'no-such-task', status: 'completed' })
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain('Task not found');
		});

		it('should return error for invalid status transition', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;

			// Try invalid transition: pending -> completed (not allowed)
			const result = parseResult(
				await handlers.set_task_status({ task_id: taskId, status: 'completed' })
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid status transition');
		});

		it('should allow valid transition: pending -> in_progress', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;

			const result = parseResult(
				await handlers.set_task_status({ task_id: taskId, status: 'in_progress' })
			);
			expect(result.success).toBe(true);
			expect(result.task.status).toBe('in_progress');
		});

		it('should allow restart from failed to pending', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;

			// Move to in_progress first
			await taskManager.startTask(taskId);
			// Then fail it
			await taskManager.failTask(taskId, 'Something went wrong');

			// Now restart it
			const result = parseResult(
				await handlers.set_task_status({ task_id: taskId, status: 'pending' })
			);
			expect(result.success).toBe(true);
			expect(result.task.status).toBe('pending');
			// Error should be cleared
			expect(result.task.error).toBeUndefined();
		});

		it('should allow restart from cancelled to in_progress', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;

			// Cancel the task
			await taskManager.cancelTask(taskId);

			// Now restart it
			const result = parseResult(
				await handlers.set_task_status({ task_id: taskId, status: 'in_progress' })
			);
			expect(result.success).toBe(true);
			expect(result.task.status).toBe('in_progress');
		});

		it('should reset old failed group when restarting task', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;

			// Move to in_progress first
			await taskManager.startTask(taskId);
			// Create a failed group
			const groupId = insertGroup(taskId, 'failed');
			// Then fail the task
			await taskManager.failTask(taskId, 'Something went wrong');

			// Verify the group exists in failed state
			const groupBefore = groupRepo.getGroup(groupId);
			expect(groupBefore).not.toBeNull();
			expect(groupBefore!.taskId).toBe(taskId);

			// Restart the task
			const result = parseResult(
				await handlers.set_task_status({ task_id: taskId, status: 'pending' })
			);
			expect(result.success).toBe(true);
			expect(result.task.status).toBe('pending');

			// The old failed group should be reset and active again
			const groupAfter = groupRepo.getGroup(groupId);
			expect(groupAfter).not.toBeNull();
			expect(groupAfter!.completedAt).toBeNull();
			expect(groupAfter!.submittedForReview).toBe(false);
			expect(groupAfter!.feedbackIteration).toBe(0);
		});

		it('should reset old cancelled group when restarting task', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;

			// Create a group (will be in failed state after task cancellation)
			const groupId = insertGroup(taskId, 'failed');
			// Cancel the task
			await taskManager.cancelTask(taskId);

			// Verify the group exists
			const groupBefore = groupRepo.getGroup(groupId);
			expect(groupBefore).not.toBeNull();
			expect(groupBefore!.taskId).toBe(taskId);

			// Restart the task
			const result = parseResult(
				await handlers.set_task_status({ task_id: taskId, status: 'in_progress' })
			);
			expect(result.success).toBe(true);
			expect(result.task.status).toBe('in_progress');

			// The old failed group should be reset and active again
			const groupAfter = groupRepo.getGroup(groupId);
			expect(groupAfter).not.toBeNull();
			expect(groupAfter!.completedAt).toBeNull();
			expect(groupAfter!.submittedForReview).toBe(false);
		});

		it('should reset old completed group when restarting task', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;

			// Move to in_progress, insert a group, and mark it completed via the repo
			// so that completedAt is non-null before reactivation
			await taskManager.startTask(taskId);
			const groupId = insertGroup(taskId, 'awaiting_human');
			const groupInserted = groupRepo.getGroup(groupId);
			expect(groupInserted).not.toBeNull();
			groupRepo.completeGroup(groupId, groupInserted!.version);
			await taskManager.completeTask(taskId, 'Done');

			// Verify the group has a non-null completedAt before reactivation
			const groupBefore = groupRepo.getGroup(groupId);
			expect(groupBefore).not.toBeNull();
			expect(groupBefore!.completedAt).not.toBeNull();

			// Reactivate the completed task
			const result = parseResult(
				await handlers.set_task_status({ task_id: taskId, status: 'in_progress' })
			);
			expect(result.success).toBe(true);
			expect(result.task.status).toBe('in_progress');

			// resetGroupForRestart should have cleared completedAt and reset metadata
			const groupAfter = groupRepo.getGroup(groupId);
			expect(groupAfter).not.toBeNull();
			expect(groupAfter!.completedAt).toBeNull();
			expect(groupAfter!.submittedForReview).toBe(false);
			expect(groupAfter!.feedbackIteration).toBe(0);
		});

		it('should succeed when group is already gone', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;

			// Move to in_progress first
			await taskManager.startTask(taskId);
			// Create a failed group
			const groupId = insertGroup(taskId, 'failed');
			// Then fail the task
			await taskManager.failTask(taskId, 'Something went wrong');

			// Delete the group directly to simulate concurrent deletion
			groupRepo.deleteGroup(groupId);

			// Restart the task - should succeed since there's no group to reset
			const result = parseResult(
				await handlers.set_task_status({ task_id: taskId, status: 'pending' })
			);
			expect(result.success).toBe(true);
			expect(result.task.status).toBe('pending');
		});

		it('should not reset group when transitioning to non-restart status', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;

			// Move to in_progress
			await taskManager.startTask(taskId);
			// Create an active group
			const groupId = insertGroup(taskId, 'awaiting_human');

			// Transition to review (not a restart)
			const result = parseResult(
				await handlers.set_task_status({ task_id: taskId, status: 'review' })
			);
			expect(result.success).toBe(true);

			// The group should still exist
			expect(groupRepo.getGroup(groupId)).not.toBeNull();
		});

		it('should allow transition: in_progress -> review', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;

			// Move to in_progress first
			await taskManager.startTask(taskId);

			const result = parseResult(
				await handlers.set_task_status({ task_id: taskId, status: 'review' })
			);
			expect(result.success).toBe(true);
			expect(result.task.status).toBe('review');
		});

		it('should update group state to awaiting_human when transitioning to review', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;

			// Move to in_progress first
			await taskManager.startTask(taskId);
			// Create an active group in awaiting_worker state
			const groupId = insertGroup(taskId, 'awaiting_worker');

			// Verify initial group flags
			const groupBefore = groupRepo.getGroup(groupId);
			expect(groupBefore).not.toBeNull();
			expect(groupBefore!.submittedForReview).toBe(false);

			// Transition to review
			const result = parseResult(
				await handlers.set_task_status({ task_id: taskId, status: 'review' })
			);
			expect(result.success).toBe(true);
			expect(result.task.status).toBe('review');

			// Group should be marked as awaiting human review in metadata
			const groupAfter = groupRepo.getGroup(groupId);
			expect(groupAfter).not.toBeNull();
			expect(groupAfter!.submittedForReview).toBe(true);
		});

		it('should revive group (clear completedAt) when transitioning failed -> review', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;

			// Move to in_progress, create a group, then fail the task and the group
			await taskManager.startTask(taskId);
			const groupId = insertGroup(taskId, 'awaiting_worker');
			await taskManager.failTask(taskId, 'Something went wrong');
			// Properly terminate the group (as failGroup would in production)
			const groupBeforeFail = groupRepo.getGroup(groupId)!;
			groupRepo.failGroup(groupId, groupBeforeFail.version);

			// Verify the group is terminated
			const groupTerminated = groupRepo.getGroup(groupId);
			expect(groupTerminated!.completedAt).not.toBeNull();

			// Revive to review via set_task_status
			const result = parseResult(
				await handlers.set_task_status({ task_id: taskId, status: 'review' })
			);
			expect(result.success).toBe(true);
			expect(result.task.status).toBe('review');

			// Group should be revived (completedAt cleared) and marked submittedForReview
			const groupAfter = groupRepo.getGroup(groupId);
			expect(groupAfter).not.toBeNull();
			expect(groupAfter!.completedAt).toBeNull();
			expect(groupAfter!.submittedForReview).toBe(true);
		});

		it('should clear error field when transitioning failed -> review', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;

			await taskManager.startTask(taskId);
			await taskManager.failTask(taskId, 'Something went wrong');

			// Revive to review — error field should be cleared (null→undefined via task repo)
			const result = parseResult(
				await handlers.set_task_status({ task_id: taskId, status: 'review' })
			);
			expect(result.success).toBe(true);
			expect(result.task.status).toBe('review');
			// The handler returns updatedTask which maps null→undefined for the error field
			expect(result.task.error).toBeFalsy();
		});

		it('should not revive group when already active (failed -> review, group has completedAt null)', async () => {
			// Edge case: group is not yet terminated (completedAt is null)
			// This can happen if set_task_status is called before the runtime terminates the group.
			// In this case, reviveGroup should be a no-op.
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;

			await taskManager.startTask(taskId);
			// Create a group but don't terminate it (completedAt stays null)
			const groupId = insertGroup(taskId, 'awaiting_worker');
			await taskManager.failTask(taskId, 'Something went wrong');

			// Group still has completedAt = null (insertGroup doesn't set it)
			const groupBefore = groupRepo.getGroup(groupId)!;
			expect(groupBefore.completedAt).toBeNull();

			// Revive to review should still work
			const result = parseResult(
				await handlers.set_task_status({ task_id: taskId, status: 'review' })
			);
			expect(result.success).toBe(true);
			expect(result.task.status).toBe('review');
			// Group should still be active
			expect(groupRepo.getGroup(groupId)!.completedAt).toBeNull();
		});

		it('should allow transition: in_progress -> completed with result', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;

			// Move to in_progress first
			await taskManager.startTask(taskId);

			const result = parseResult(
				await handlers.set_task_status({
					task_id: taskId,
					status: 'completed',
					result: 'Successfully implemented the feature',
				})
			);
			expect(result.success).toBe(true);
			expect(result.task.status).toBe('completed');
			expect(result.task.result).toBe('Successfully implemented the feature');
			expect(result.task.progress).toBe(100);
		});

		it('should allow transition: in_progress -> failed with error', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;

			// Move to in_progress first
			await taskManager.startTask(taskId);

			const result = parseResult(
				await handlers.set_task_status({
					task_id: taskId,
					status: 'needs_attention',
					error: 'Tests failed',
				})
			);
			expect(result.success).toBe(true);
			expect(result.task.status).toBe('needs_attention');
			expect(result.task.error).toBe('Tests failed');
		});

		it('should allow transition: review -> in_progress', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;

			// Move to in_progress and create active group
			await taskManager.startTask(taskId);
			const groupId = insertGroup(taskId, 'awaiting_worker');

			// Transition into review first (sets submittedForReview=true)
			await handlers.set_task_status({ task_id: taskId, status: 'review' });
			const result = parseResult(
				await handlers.set_task_status({ task_id: taskId, status: 'in_progress' })
			);
			expect(result.success).toBe(true);
			expect(result.task.status).toBe('in_progress');

			// Leaving review should clear awaiting-human semantics
			const groupAfter = groupRepo.getGroup(groupId);
			expect(groupAfter).not.toBeNull();
			expect(groupAfter!.submittedForReview).toBe(false);
			expect(groupAfter!.completedAt).toBeNull();
		});

		it('should deny transition: completed -> pending (terminal state)', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;

			// Move to in_progress and then to completed
			await taskManager.startTask(taskId);
			await taskManager.completeTask(taskId, 'Done');

			const result = parseResult(
				await handlers.set_task_status({ task_id: taskId, status: 'pending' })
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid status transition');
		});

		it('should return error when group cancellation fails due to version conflict', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;

			// Move to in_progress
			await taskManager.startTask(taskId);

			// Create an active group
			insertGroup(taskId, 'awaiting_human');

			// Create handler with mock runtime that returns null from cancel (simulating version conflict)
			const mockRuntime = {
				taskGroupManager: {
					cancel: async () => null, // Returns null to simulate version conflict
				},
			};
			const h = createRoomAgentToolHandlers({
				roomId,
				goalManager,
				taskManager,
				groupRepo,
				runtimeService: { getRuntime: () => mockRuntime as never },
			});

			// Try to complete the task - should fail because group cancellation failed
			const result = parseResult(await h.set_task_status({ task_id: taskId, status: 'completed' }));
			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to cancel active group');
			expect(result.error).toContain('group may have been modified concurrently');
		});

		it('should succeed when group cancellation succeeds', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;

			// Move to in_progress
			await taskManager.startTask(taskId);

			// Create an active group
			const groupId = insertGroup(taskId, 'awaiting_human');

			// Create handler with mock runtime that successfully cancels
			const mockRuntime = {
				taskGroupManager: {
					cancel: async (gId: string) => {
						expect(gId).toBe(groupId);
						return { id: gId, state: 'cancelled' };
					},
				},
			};
			const h = createRoomAgentToolHandlers({
				roomId,
				goalManager,
				taskManager,
				groupRepo,
				runtimeService: { getRuntime: () => mockRuntime as never },
			});

			// Complete the task - should succeed because group cancellation succeeded
			const result = parseResult(await h.set_task_status({ task_id: taskId, status: 'completed' }));
			expect(result.success).toBe(true);
			expect(result.task.status).toBe('completed');
		});

		it('should reject status change to terminal state without runtime when active group exists', async () => {
			const created = parseResult(await handlers.create_task({ title: 'T', description: 'd' }));
			const taskId = created.taskId as string;

			// Move to in_progress
			await taskManager.startTask(taskId);

			// Create an active group
			insertGroup(taskId, 'awaiting_human');

			// Handler without runtime service - should FAIL since active group exists
			// (would leave a zombie worker session if allowed)
			const result = parseResult(
				await handlers.set_task_status({ task_id: taskId, status: 'completed' })
			);
			expect(result.success).toBe(false);
			expect(result.error).toContain('runtime service');
		});
	});

	describe('record_metric', () => {
		it('should reject non-measurable goals', async () => {
			const created = parseResult(await handlers.create_goal({ title: 'One-Shot Goal' }));
			const result = parseResult(
				await handlers.record_metric({
					goal_id: created.goalId as string,
					metric_name: 'kpi',
					value: 42,
				})
			);
			expect(result.success).toBe(false);
			expect(result.error as string).toContain('not a measurable mission');
		});

		it('should reject non-existent goal', async () => {
			const result = parseResult(
				await handlers.record_metric({ goal_id: 'no-such-goal', metric_name: 'kpi', value: 42 })
			);
			expect(result.success).toBe(false);
			expect(result.error as string).toContain('not found');
		});

		it('should record metric for measurable goal', async () => {
			const goalResult = parseResult(await handlers.create_goal({ title: 'Measurable Goal' }));
			const goalId = goalResult.goalId as string;
			// Directly set missionType + structuredMetrics via manager
			await goalManager.updateGoalStatus(goalId, 'active');
			const dbGoal = await goalManager.getGoal(goalId);
			expect(dbGoal).toBeDefined();

			// Create goal directly with missionType via goalManager
			const mGoal = await goalManager.createGoal({
				title: 'Measurable Goal 2',
				missionType: 'measurable',
				structuredMetrics: [{ name: 'coverage', target: 80, current: 0 }],
			});

			const result = parseResult(
				await handlers.record_metric({ goal_id: mGoal.id, metric_name: 'coverage', value: 60 })
			);
			expect(result.success).toBe(true);
			expect((result.metric as { name: string }).name).toBe('coverage');
			expect((result.metric as { value: number }).value).toBe(60);
			// progress = 60/80 = 75%
			expect((result.metric as { goalProgress: number }).goalProgress).toBe(75);
		});

		it('should reject unknown metric name', async () => {
			const mGoal = await goalManager.createGoal({
				title: 'Measurable Goal',
				missionType: 'measurable',
				structuredMetrics: [{ name: 'coverage', target: 80, current: 0 }],
			});
			const result = parseResult(
				await handlers.record_metric({ goal_id: mGoal.id, metric_name: 'unknown_kpi', value: 50 })
			);
			expect(result.success).toBe(false);
			expect(result.error as string).toContain('not defined in structuredMetrics');
		});
	});

	describe('get_metrics', () => {
		it('should return empty structured metrics for goal without them', async () => {
			const created = parseResult(await handlers.create_goal({ title: 'Legacy Goal' }));
			const result = parseResult(await handlers.get_metrics({ goal_id: created.goalId as string }));
			expect(result.success).toBe(true);
			expect((result.structuredMetrics as unknown[]).length).toBe(0);
		});

		it('should return metric state for measurable goal', async () => {
			const mGoal = await goalManager.createGoal({
				title: 'Measurable Goal',
				missionType: 'measurable',
				structuredMetrics: [
					{ name: 'coverage', target: 80, current: 50 },
					{ name: 'latency', target: 200, current: 300, direction: 'decrease', baseline: 1000 },
				],
			});

			const result = parseResult(await handlers.get_metrics({ goal_id: mGoal.id }));
			expect(result.success).toBe(true);
			expect(result.missionType).toBe('measurable');
			expect((result.metrics as unknown[]).length).toBe(2);

			const coverage = (
				result.metrics as Array<{
					name: string;
					current: number;
					target: number;
					met: boolean;
					direction: string;
				}>
			).find((m) => m.name === 'coverage');
			expect(coverage!.current).toBe(50);
			expect(coverage!.target).toBe(80);
			expect(coverage!.met).toBe(false);
			expect(coverage!.direction).toBe('increase');
		});

		it('should report allTargetsMet=true when all met', async () => {
			const mGoal = await goalManager.createGoal({
				title: 'Measurable Goal',
				missionType: 'measurable',
				structuredMetrics: [{ name: 'coverage', target: 80, current: 90 }],
			});

			const result = parseResult(await handlers.get_metrics({ goal_id: mGoal.id }));
			expect(result.allTargetsMet).toBe(true);
		});

		it('should return error for non-existent goal', async () => {
			const result = parseResult(await handlers.get_metrics({ goal_id: 'no-such-goal' }));
			expect(result.success).toBe(false);
		});
	});

	describe('createLeaderContextMcpServer', () => {
		/**
		 * Helper: return the registered tool names from an SDK MCP server.
		 * The SDK stores registered tools in `instance._registeredTools` keyed by tool name.
		 */
		function getRegisteredToolNames(server: {
			instance: { _registeredTools: Record<string, unknown> };
		}): string[] {
			return Object.keys(server.instance._registeredTools).sort();
		}

		it('should expose the 7 leader tools (context + task management)', () => {
			const server = createLeaderContextMcpServer({ roomId, goalManager, taskManager, groupRepo });
			const names = getRegisteredToolNames(server as never);
			expect(names).toEqual([
				'cancel_task',
				'get_room_status',
				'get_task_detail',
				'list_goals',
				'list_tasks',
				'update_task',
				'update_task_status',
			]);
		});

		it('should NOT expose approve_task', () => {
			const server = createLeaderContextMcpServer({ roomId, goalManager, taskManager, groupRepo });
			const names = getRegisteredToolNames(server as never);
			expect(names).not.toContain('approve_task');
		});

		it('should NOT expose reject_task', () => {
			const server = createLeaderContextMcpServer({ roomId, goalManager, taskManager, groupRepo });
			const names = getRegisteredToolNames(server as never);
			expect(names).not.toContain('reject_task');
		});

		it('should NOT expose human-only or session management tools', () => {
			const server = createLeaderContextMcpServer({ roomId, goalManager, taskManager, groupRepo });
			const names = getRegisteredToolNames(server as never);
			const excluded = [
				'create_goal',
				'update_goal',
				'create_task',
				'stop_session',
				'send_message_to_task',
				'approve_task',
				'reject_task',
			];
			for (const w of excluded) {
				expect(names).not.toContain(w);
			}
		});

		describe('update_task tool', () => {
			it('should update task title and description', async () => {
				const task = await taskManager.createTask({
					title: 'Original title',
					description: 'Original description',
				});
				const leaderHandlers = createRoomAgentToolHandlers({
					roomId,
					goalManager,
					taskManager,
					groupRepo,
				});
				const result = parseResult(
					await leaderHandlers.update_task({
						task_id: task.id,
						title: 'Updated title',
						description: 'Updated description',
					})
				);
				expect(result.success).toBe(true);
				const updated = result.task as { title: string; description: string };
				expect(updated.title).toBe('Updated title');
				expect(updated.description).toBe('Updated description');
			});

			it('should update task priority', async () => {
				const task = await taskManager.createTask({ title: 'T', description: 'D' });
				const leaderHandlers = createRoomAgentToolHandlers({
					roomId,
					goalManager,
					taskManager,
					groupRepo,
				});
				const result = parseResult(
					await leaderHandlers.update_task({ task_id: task.id, priority: 'urgent' })
				);
				expect(result.success).toBe(true);
				const updated = result.task as { priority: string };
				expect(updated.priority).toBe('urgent');
			});

			it('should update task dependencies', async () => {
				const dep = await taskManager.createTask({ title: 'Dep', description: 'D' });
				const task = await taskManager.createTask({ title: 'Task', description: 'D' });
				const leaderHandlers = createRoomAgentToolHandlers({
					roomId,
					goalManager,
					taskManager,
					groupRepo,
				});
				const result = parseResult(
					await leaderHandlers.update_task({ task_id: task.id, depends_on: [dep.id] })
				);
				expect(result.success).toBe(true);
				const updated = result.task as { dependsOn: string[] };
				expect(updated.dependsOn).toContain(dep.id);
			});

			it('should reject self-dependency', async () => {
				const task = await taskManager.createTask({ title: 'T', description: 'D' });
				const leaderHandlers = createRoomAgentToolHandlers({
					roomId,
					goalManager,
					taskManager,
					groupRepo,
				});
				const result = parseResult(
					await leaderHandlers.update_task({ task_id: task.id, depends_on: [task.id] })
				);
				expect(result.success).toBe(false);
				expect(result.error).toContain('cannot depend on itself');
			});

			it('should fail gracefully when task not found', async () => {
				const leaderHandlers = createRoomAgentToolHandlers({
					roomId,
					goalManager,
					taskManager,
					groupRepo,
				});
				const result = parseResult(
					await leaderHandlers.update_task({ task_id: 'nonexistent', title: 'X' })
				);
				expect(result.success).toBe(false);
				expect(result.error).toBeDefined();
			});
		});

		describe('cancel_task tool', () => {
			it('should cancel a pending task and return cancelledTaskIds with clean message', async () => {
				const task = await taskManager.createTask({ title: 'T', description: 'D' });
				const leaderHandlers = createRoomAgentToolHandlers({
					roomId,
					goalManager,
					taskManager,
					groupRepo,
				});
				const result = parseResult(await leaderHandlers.cancel_task({ task_id: task.id }));
				expect(result.success).toBe(true);
				expect(result.cancelledTaskIds).toContain(task.id);
				// No "0 dependent" phrasing when there are no cascaded dependents
				expect(result.message).not.toContain('0 dependent');
				const updated = await taskManager.getTask(task.id);
				expect(updated?.status).toBe('cancelled');
			});

			it('should cascade cancellation and include all cancelled IDs in response', async () => {
				const parent = await taskManager.createTask({ title: 'Parent', description: 'D' });
				const child = await taskManager.createTask({
					title: 'Child',
					description: 'D',
					dependsOn: [parent.id],
				});
				const leaderHandlers = createRoomAgentToolHandlers({
					roomId,
					goalManager,
					taskManager,
					groupRepo,
				});
				const result = parseResult(await leaderHandlers.cancel_task({ task_id: parent.id }));
				expect(result.success).toBe(true);
				const cancelledIds = result.cancelledTaskIds as string[];
				expect(cancelledIds).toContain(parent.id);
				expect(cancelledIds).toContain(child.id);
				const updatedParent = await taskManager.getTask(parent.id);
				const updatedChild = await taskManager.getTask(child.id);
				expect(updatedParent?.status).toBe('cancelled');
				expect(updatedChild?.status).toBe('cancelled');
			});

			it('should reject cancellation of already-terminal tasks', async () => {
				const task = await taskManager.createTask({ title: 'T', description: 'D' });
				await taskManager.startTask(task.id);
				await taskManager.completeTask(task.id, 'done');
				const leaderHandlers = createRoomAgentToolHandlers({
					roomId,
					goalManager,
					taskManager,
					groupRepo,
				});
				const result = parseResult(await leaderHandlers.cancel_task({ task_id: task.id }));
				expect(result.success).toBe(false);
				expect(result.error).toContain('terminal state');
			});

			it('should reject cancellation of in_progress task with active group without runtimeService', async () => {
				const task = await taskManager.createTask({ title: 'T', description: 'D' });
				await taskManager.startTask(task.id);
				// Create an active group — triggers the guard
				insertGroup(task.id, 'awaiting_worker');
				const leaderHandlers = createRoomAgentToolHandlers({
					roomId,
					goalManager,
					taskManager,
					groupRepo,
					// no runtimeService — simulates leader context
				});
				const result = parseResult(await leaderHandlers.cancel_task({ task_id: task.id }));
				expect(result.success).toBe(false);
				expect(result.error).toContain('runtime service');
			});

			it('should reject cancellation of review task with active group without runtimeService', async () => {
				const task = await taskManager.createTask({ title: 'T', description: 'D' });
				await taskManager.startTask(task.id);
				await taskManager.reviewTask(task.id);
				// Create an active group — triggers the guard
				insertGroup(task.id, 'awaiting_human');
				const leaderHandlers = createRoomAgentToolHandlers({
					roomId,
					goalManager,
					taskManager,
					groupRepo,
					// no runtimeService — simulates leader context
				});
				const result = parseResult(await leaderHandlers.cancel_task({ task_id: task.id }));
				expect(result.success).toBe(false);
				expect(result.error).toContain('runtime service');
			});

			it('should fail gracefully when task not found', async () => {
				const leaderHandlers = createRoomAgentToolHandlers({
					roomId,
					goalManager,
					taskManager,
					groupRepo,
				});
				const result = parseResult(await leaderHandlers.cancel_task({ task_id: 'nonexistent' }));
				expect(result.success).toBe(false);
				expect(result.error).toBeDefined();
			});
		});

		describe('update_task_status tool (set_task_status handler)', () => {
			it('should transition task from needs_attention to pending', async () => {
				const task = await taskManager.createTask({ title: 'T', description: 'D' });
				await taskManager.startTask(task.id);
				await taskManager.failTask(task.id, 'failed');
				const leaderHandlers = createRoomAgentToolHandlers({
					roomId,
					goalManager,
					taskManager,
					groupRepo,
				});
				const result = parseResult(
					await leaderHandlers.set_task_status({ task_id: task.id, status: 'pending' })
				);
				expect(result.success).toBe(true);
				const updated = await taskManager.getTask(task.id);
				expect(updated?.status).toBe('pending');
			});

			it('should reject transitioning in_progress task with active group to terminal status without runtimeService', async () => {
				const task = await taskManager.createTask({ title: 'T', description: 'D' });
				await taskManager.startTask(task.id);
				// Create an active group — triggers the guard
				insertGroup(task.id, 'awaiting_worker');
				const leaderHandlers = createRoomAgentToolHandlers({
					roomId,
					goalManager,
					taskManager,
					groupRepo,
					// no runtimeService — simulates leader context
				});
				const result = parseResult(
					await leaderHandlers.set_task_status({ task_id: task.id, status: 'cancelled' })
				);
				expect(result.success).toBe(false);
				expect(result.error).toContain('runtime service');
			});

			it('should reject invalid status transitions', async () => {
				const task = await taskManager.createTask({ title: 'T', description: 'D' });
				const leaderHandlers = createRoomAgentToolHandlers({
					roomId,
					goalManager,
					taskManager,
					groupRepo,
				});
				// draft → completed is not a valid transition
				const result = parseResult(
					await leaderHandlers.set_task_status({ task_id: task.id, status: 'completed' })
				);
				expect(result.success).toBe(false);
				expect(result.error).toContain('Invalid status transition');
			});

			it('should fail gracefully when task not found', async () => {
				const leaderHandlers = createRoomAgentToolHandlers({
					roomId,
					goalManager,
					taskManager,
					groupRepo,
				});
				const result = parseResult(
					await leaderHandlers.set_task_status({ task_id: 'nonexistent', status: 'pending' })
				);
				expect(result.success).toBe(false);
				expect(result.error).toBeDefined();
			});
		});

		it('should use the distinct MCP server name "leader-context"', () => {
			const server = createLeaderContextMcpServer({ roomId, goalManager, taskManager, groupRepo });
			expect(server.name).toBe('leader-context');
		});

		it('full room-agent server name should remain "room-agent"', () => {
			const fullServer = createRoomAgentMcpServer({ roomId, goalManager, taskManager, groupRepo });
			expect(fullServer.name).toBe('room-agent');
		});

		it('full server exposes all 19 tools', () => {
			const fullServer = createRoomAgentMcpServer({ roomId, goalManager, taskManager, groupRepo });
			const names = getRegisteredToolNames(fullServer as never);
			expect(names).toHaveLength(19);
			expect(names).toContain('approve_task');
			expect(names).toContain('reject_task');
			expect(names).toContain('set_schedule');
			expect(names).toContain('pause_schedule');
			expect(names).toContain('resume_schedule');
			expect(names).toContain('record_metric');
			expect(names).toContain('get_metrics');
		});
	});
});
