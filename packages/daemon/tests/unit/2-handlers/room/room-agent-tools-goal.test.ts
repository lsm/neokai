import { mock } from 'bun:test';

// Re-declare the SDK mock so it survives Bun's module isolation.
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
	query: mock(async () => ({ interrupt: () => {} })),
	interrupt: mock(async () => {}),
	supportedModels: mock(async () => {
		throw new Error('SDK unavailable');
	}),
	createSdkMcpServer: mock((_opts: { name: string; tools: unknown[] }) => {
		const registeredTools: Record<string, unknown> = {};
		for (const t of _opts.tools ?? []) {
			const name = (t as { name: string }).name;
			if (name) registeredTools[name] = t;
		}
		return {
			type: 'sdk' as const,
			name: _opts.name,
			version: '1.0.0',
			tools: _opts.tools ?? [],
			instance: {
				connect() {},
				disconnect() {},
				_registeredTools: registeredTools,
			},
		};
	}),
	tool: mock((_name: string, _desc: string, _schema: unknown, _handler: unknown) => ({
		name: _name,
	})),
}));

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { GoalManager } from '../../../../src/lib/room/managers/goal-manager';
import { noOpReactiveDb } from '../../../helpers/reactive-database';
import { TaskManager } from '../../../../src/lib/room/managers/task-manager';
import { SessionGroupRepository } from '../../../../src/lib/room/state/session-group-repository';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import {
	createRoomAgentToolHandlers,
	createRoomAgentMcpServer,
	createLeaderContextMcpServer,
} from '../../../../src/lib/room/tools/room-agent-tools';

const SCHEMA_SQL = (roomId: string) => `
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
		replan_count INTEGER NOT NULL DEFAULT 0,
		short_id TEXT
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
		short_id TEXT,
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
	CREATE TABLE session_group_messages (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
		session_id TEXT,
		role TEXT NOT NULL DEFAULT 'system',
		message_type TEXT NOT NULL DEFAULT 'status',
		content TEXT NOT NULL DEFAULT '',
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
	CREATE TABLE mission_executions (
		id TEXT PRIMARY KEY,
		goal_id TEXT NOT NULL,
		execution_number INTEGER NOT NULL,
		started_at INTEGER,
		completed_at INTEGER,
		status TEXT NOT NULL DEFAULT 'running',
		result_summary TEXT,
		task_ids TEXT NOT NULL DEFAULT '[]',
		planning_attempts INTEGER NOT NULL DEFAULT 0,
		FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
		UNIQUE(goal_id, execution_number)
	);
	INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('${roomId}', 'Test', ${Date.now()}, ${Date.now()});
`;

describe('Room Agent Tools - reset_goal and planning_attempts', () => {
	let db: Database;
	let goalManager: GoalManager;
	let taskManager: TaskManager;
	let groupRepo: SessionGroupRepository;
	let handlers: ReturnType<typeof createRoomAgentToolHandlers>;
	const roomId = 'room-1';

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec(SCHEMA_SQL(roomId));
		goalManager = new GoalManager(db as never, roomId, noOpReactiveDb);
		taskManager = new TaskManager(db as never, roomId, noOpReactiveDb);
		groupRepo = new SessionGroupRepository(db, createReactiveDatabase(db as never));
		handlers = createRoomAgentToolHandlers({ roomId, goalManager, taskManager, groupRepo });
	});

	afterEach(() => {
		db.close();
	});

	function parseResult(result: { content: Array<{ type: string; text: string }> }) {
		return JSON.parse(result.content[0].text) as Record<string, unknown>;
	}

	/** Insert an active (not completed) session group for a task, simulating an in-progress agent session. */
	function insertActiveGroup(taskId: string) {
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
			[groupId, 'task', taskId, 'active_work', 0, metadata, Date.now()]
		);
		db.run(
			'INSERT INTO session_group_members (group_id, session_id, role, joined_at) VALUES (?, ?, ?, ?)',
			[groupId, 'worker-session-1', 'worker', Date.now()]
		);
		return groupId;
	}

	// -------------------------------------------------------------------------
	// reset_goal tests
	// -------------------------------------------------------------------------

	describe('reset_goal', () => {
		it('should return error for non-existent goal', async () => {
			const result = parseResult(await handlers.reset_goal({ goal_id: 'nonexistent-id' }));
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/not found/i);
		});

		it('should reset goal with linked tasks in non-terminal statuses', async () => {
			// Create goal and link tasks with different statuses
			const goalResult = parseResult(await handlers.create_goal({ title: 'Test Goal' }));
			const goalId = goalResult.goalId as string;

			// Create tasks with non-terminal and terminal statuses
			const t1 = parseResult(
				await handlers.create_task({ title: 'Task 1', description: 'desc', goal_id: goalId })
			);
			const t2 = parseResult(
				await handlers.create_task({ title: 'Task 2', description: 'desc', goal_id: goalId })
			);
			const t3 = parseResult(
				await handlers.create_task({ title: 'Task 3', description: 'desc', goal_id: goalId })
			);

			// Mark t2 as completed (terminal), t3 as cancelled (terminal), t1 remains pending
			// Use 'manual' mode to bypass strict status transition validation in tests
			await taskManager.setTaskStatus(t2.taskId as string, 'completed', { mode: 'manual' });
			await taskManager.setTaskStatus(t3.taskId as string, 'cancelled', { mode: 'manual' });

			// Set planning_attempts to non-zero
			db.run('UPDATE goals SET planning_attempts = 3 WHERE id = ?', [goalId]);

			// Reset the goal
			const result = parseResult(await handlers.reset_goal({ goal_id: goalId }));
			expect(result.success).toBe(true);
			expect(result.goal).toBeDefined();

			const goal = result.goal as Record<string, unknown>;
			expect(goal.linkedTaskIds).toEqual([]);
			expect(goal.planning_attempts).toBe(0);
			expect(goal.consecutiveFailures).toBe(0);
			expect(goal.replanCount).toBe(0);
			expect(goal.status).toBe('active');

			// Pending task (t1) should have been cancelled
			const cancelledTask = await taskManager.getTask(t1.taskId as string);
			expect(cancelledTask?.status).toBe('cancelled');
		});

		it('should cancel pending/in-progress tasks before resetting', async () => {
			const goalResult = parseResult(await handlers.create_goal({ title: 'Goal With Tasks' }));
			const goalId = goalResult.goalId as string;

			// Create tasks in various non-terminal statuses
			const t1 = parseResult(
				await handlers.create_task({ title: 'Pending Task', description: 'desc', goal_id: goalId })
			);

			// Verify task is pending
			const taskBefore = await taskManager.getTask(t1.taskId as string);
			expect(taskBefore?.status).toBe('pending');

			const result = parseResult(await handlers.reset_goal({ goal_id: goalId }));
			expect(result.success).toBe(true);

			// Task should be cancelled
			const taskAfter = await taskManager.getTask(t1.taskId as string);
			expect(taskAfter?.status).toBe('cancelled');
		});

		it('should skip cancellation for terminal-status tasks', async () => {
			const goalResult = parseResult(await handlers.create_goal({ title: 'Goal' }));
			const goalId = goalResult.goalId as string;

			const t1 = parseResult(
				await handlers.create_task({ title: 'Done Task', description: 'desc', goal_id: goalId })
			);
			await taskManager.setTaskStatus(t1.taskId as string, 'completed', { mode: 'manual' });

			// Reset goal — completed task should remain completed (not be double-cancelled)
			const result = parseResult(await handlers.reset_goal({ goal_id: goalId }));
			expect(result.success).toBe(true);

			const task = await taskManager.getTask(t1.taskId as string);
			expect(task?.status).toBe('completed');
		});

		it('should call runtime.cancelTask and runtime.onGoalCreated when runtime is available', async () => {
			const goalResult = parseResult(await handlers.create_goal({ title: 'Runtime Goal' }));
			const goalId = goalResult.goalId as string;

			const t1 = parseResult(
				await handlers.create_task({ title: 'Task', description: 'desc', goal_id: goalId })
			);

			// Set up mock runtime
			const cancelledIds: string[] = [];
			const onGoalCreatedIds: string[] = [];
			const mockRuntime = {
				cancelTask: async (taskId: string) => {
					cancelledIds.push(taskId);
					await taskManager.setTaskStatus(taskId, 'cancelled');
					return { success: true, cancelledTaskIds: [taskId] };
				},
				onGoalCreated: (gId: string) => {
					onGoalCreatedIds.push(gId);
				},
			};
			const runtimeService = {
				getRuntime: (_roomId: string) => mockRuntime as never,
			};

			const handlersWithRuntime = createRoomAgentToolHandlers({
				roomId,
				goalManager,
				taskManager,
				groupRepo,
				runtimeService,
			});

			const result = parseResult(await handlersWithRuntime.reset_goal({ goal_id: goalId }));
			expect(result.success).toBe(true);

			// runtime.cancelTask should have been called for the pending task
			expect(cancelledIds).toContain(t1.taskId);

			// runtime.onGoalCreated should have been called after reset
			expect(onGoalCreatedIds).toContain(goalId);
		});

		it('should fall back to taskManager.cancelTaskCascade and emit hub events when runtime is unavailable', async () => {
			const goalResult = parseResult(await handlers.create_goal({ title: 'Fallback Goal' }));
			const goalId = goalResult.goalId as string;

			const t1 = parseResult(
				await handlers.create_task({ title: 'Task', description: 'desc', goal_id: goalId })
			);

			// Track hub events
			const emittedEvents: Array<{ event: string; payload: unknown }> = [];
			const mockDaemonHub = {
				emit: async (event: string, payload: unknown) => {
					emittedEvents.push({ event, payload });
				},
			};

			const handlersWithHub = createRoomAgentToolHandlers({
				roomId,
				goalManager,
				taskManager,
				groupRepo,
				daemonHub: mockDaemonHub as never,
				// no runtimeService → fallback path
			});

			const result = parseResult(await handlersWithHub.reset_goal({ goal_id: goalId }));
			expect(result.success).toBe(true);

			// Task should be cancelled via cascade
			const task = await taskManager.getTask(t1.taskId as string);
			expect(task?.status).toBe('cancelled');

			// Hub should have received room.task.update event
			expect(emittedEvents.some((e) => e.event === 'room.task.update')).toBe(true);
		});

		it('should return error when in_progress task has active session group and no runtime', async () => {
			const goalResult = parseResult(await handlers.create_goal({ title: 'Blocked Goal' }));
			const goalId = goalResult.goalId as string;

			const t1 = parseResult(
				await handlers.create_task({ title: 'Active Task', description: 'desc', goal_id: goalId })
			);
			const taskId = t1.taskId as string;

			// Move task to in_progress (pending → in_progress is a valid transition)
			await taskManager.setTaskStatus(taskId, 'in_progress');

			// Insert an active (not completed) session group — simulates a running agent session
			insertActiveGroup(taskId);

			// Without runtimeService, reset_goal should refuse to cancel an in_progress task
			// with an active session group (same guard as cancel_task)
			const result = parseResult(await handlers.reset_goal({ goal_id: goalId }));
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/active session group/i);

			// Goal and task should be unchanged
			const task = await taskManager.getTask(taskId);
			expect(task?.status).toBe('in_progress');
		});

		it('should cancel in_progress task without active session group in fallback path', async () => {
			const goalResult = parseResult(await handlers.create_goal({ title: 'No-Session Goal' }));
			const goalId = goalResult.goalId as string;

			const t1 = parseResult(
				await handlers.create_task({ title: 'Task', description: 'desc', goal_id: goalId })
			);
			const taskId = t1.taskId as string;

			// Move to in_progress but do NOT create a session group
			await taskManager.setTaskStatus(taskId, 'in_progress');

			// Without runtime but also without an active session group — should succeed
			const result = parseResult(await handlers.reset_goal({ goal_id: goalId }));
			expect(result.success).toBe(true);

			const task = await taskManager.getTask(taskId);
			expect(task?.status).toBe('cancelled');
		});
	});

	// -------------------------------------------------------------------------
	// update_goal with planning_attempts
	// -------------------------------------------------------------------------

	describe('update_goal with planning_attempts', () => {
		it('should persist planning_attempts when provided', async () => {
			const goalResult = parseResult(await handlers.create_goal({ title: 'Goal' }));
			const goalId = goalResult.goalId as string;

			// Set planning_attempts to a non-zero value
			db.run('UPDATE goals SET planning_attempts = 4 WHERE id = ?', [goalId]);

			// Reset via update_goal
			const updateResult = parseResult(
				await handlers.update_goal({ goal_id: goalId, planning_attempts: 0 })
			);
			expect(updateResult.success).toBe(true);
			const goal = updateResult.goal as Record<string, unknown>;
			expect(goal.planning_attempts).toBe(0);
		});

		it('should accept non-zero planning_attempts value', async () => {
			const goalResult = parseResult(await handlers.create_goal({ title: 'Goal 2' }));
			const goalId = goalResult.goalId as string;

			const updateResult = parseResult(
				await handlers.update_goal({ goal_id: goalId, planning_attempts: 2 })
			);
			expect(updateResult.success).toBe(true);
			const goal = updateResult.goal as Record<string, unknown>;
			expect(goal.planning_attempts).toBe(2);
		});

		it('should fail when no update fields are provided (planning_attempts absent)', async () => {
			const goalResult = parseResult(await handlers.create_goal({ title: 'Goal 3' }));
			const goalId = goalResult.goalId as string;

			const result = parseResult(await handlers.update_goal({ goal_id: goalId }));
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/no update fields/i);
		});

		it('should succeed with only planning_attempts as the update field', async () => {
			const goalResult = parseResult(await handlers.create_goal({ title: 'Goal 4' }));
			const goalId = goalResult.goalId as string;

			// Only planning_attempts — no other fields
			const result = parseResult(
				await handlers.update_goal({ goal_id: goalId, planning_attempts: 1 })
			);
			expect(result.success).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// Negative test: reset_goal is NOT registered in createLeaderContextMcpServer
	// -------------------------------------------------------------------------

	describe('MCP server tool registration', () => {
		it('reset_goal is registered in createRoomAgentMcpServer', () => {
			const server = createRoomAgentMcpServer({ roomId, goalManager, taskManager, groupRepo });
			const toolNames = (server.tools as Array<{ name: string }>).map((t) => t.name);
			expect(toolNames).toContain('reset_goal');
		});

		it('reset_goal is NOT registered in createLeaderContextMcpServer', () => {
			const server = createLeaderContextMcpServer({ roomId, goalManager, taskManager, groupRepo });
			const toolNames = (server.tools as Array<{ name: string }>).map((t) => t.name);
			expect(toolNames).not.toContain('reset_goal');
		});

		it('createLeaderContextMcpServer tool list does not contain reset_goal via instance registry', () => {
			const server = createLeaderContextMcpServer({ roomId, goalManager, taskManager, groupRepo });
			const registeredTools = (
				server.instance as unknown as { _registeredTools: Record<string, unknown> }
			)._registeredTools;
			expect(Object.keys(registeredTools)).not.toContain('reset_goal');
		});
	});

	// -------------------------------------------------------------------------
	// update_goal: title/description change invalidates in-progress planning
	// -------------------------------------------------------------------------

	describe('update_goal: invalidate in-progress planning on title/description change', () => {
		/** Helper: create a planning task and link it to a goal via DB (task_type = 'planning'). */
		async function createPlanningTask(goalId: string, status: string = 'pending') {
			// Insert a planning task directly (task_type 'planning' is blocked via handler,
			// but can be created directly in the DB for test purposes)
			const taskId = `planning-task-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			db.run(
				`INSERT INTO tasks (id, room_id, title, description, status, priority, task_type, assigned_agent, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					taskId,
					roomId,
					'Planning Task',
					'auto-generated planning',
					status,
					'normal',
					'planning',
					'planner',
					Date.now(),
					Date.now(),
				]
			);
			// Link to goal
			await goalManager.linkTaskToGoal(goalId, taskId);
			return taskId;
		}

		it('should cancel in-progress planning task and reset planning_attempts when title changes', async () => {
			const goalResult = parseResult(await handlers.create_goal({ title: 'Original Title' }));
			const goalId = goalResult.goalId as string;

			// Set planning_attempts to a non-zero value
			db.run('UPDATE goals SET planning_attempts = 3 WHERE id = ?', [goalId]);

			// Create a pending planning task
			const planTaskId = await createPlanningTask(goalId, 'pending');

			// Update the title
			const result = parseResult(
				await handlers.update_goal({ goal_id: goalId, title: 'Updated Title' })
			);
			expect(result.success).toBe(true);

			// Planning task should be cancelled
			const planTask = await taskManager.getTask(planTaskId);
			expect(planTask?.status).toBe('cancelled');

			// planning_attempts should be reset to 0
			const goal = result.goal as Record<string, unknown>;
			expect(goal.planning_attempts).toBe(0);
		});

		it('should cancel in-progress planning task and reset planning_attempts when description changes', async () => {
			const goalResult = parseResult(await handlers.create_goal({ title: 'Goal' }));
			const goalId = goalResult.goalId as string;

			db.run('UPDATE goals SET planning_attempts = 2 WHERE id = ?', [goalId]);

			const planTaskId = await createPlanningTask(goalId, 'in_progress');

			const result = parseResult(
				await handlers.update_goal({ goal_id: goalId, description: 'New description' })
			);
			expect(result.success).toBe(true);

			const planTask = await taskManager.getTask(planTaskId);
			expect(planTask?.status).toBe('cancelled');

			const goal = result.goal as Record<string, unknown>;
			expect(goal.planning_attempts).toBe(0);
		});

		it('should NOT cancel planning tasks when only priority is updated', async () => {
			const goalResult = parseResult(await handlers.create_goal({ title: 'Goal' }));
			const goalId = goalResult.goalId as string;

			db.run('UPDATE goals SET planning_attempts = 2 WHERE id = ?', [goalId]);

			const planTaskId = await createPlanningTask(goalId, 'pending');

			const result = parseResult(await handlers.update_goal({ goal_id: goalId, priority: 'high' }));
			expect(result.success).toBe(true);

			// Planning task should still be pending (not cancelled)
			const planTask = await taskManager.getTask(planTaskId);
			expect(planTask?.status).toBe('pending');

			// planning_attempts should remain unchanged
			const rawGoal = db.query('SELECT planning_attempts FROM goals WHERE id = ?').get(goalId) as {
				planning_attempts: number;
			};
			expect(rawGoal.planning_attempts).toBe(2);
		});

		it('should do nothing when no planning tasks are in progress', async () => {
			const goalResult = parseResult(await handlers.create_goal({ title: 'Goal' }));
			const goalId = goalResult.goalId as string;

			db.run('UPDATE goals SET planning_attempts = 1 WHERE id = ?', [goalId]);

			// No planning tasks linked — just update title
			const result = parseResult(
				await handlers.update_goal({ goal_id: goalId, title: 'New Title' })
			);
			expect(result.success).toBe(true);

			// planning_attempts should still be reset to 0
			const goal = result.goal as Record<string, unknown>;
			expect(goal.planning_attempts).toBe(0);
		});

		it('should transition needs_human goal to active when title/description changes', async () => {
			const goalResult = parseResult(await handlers.create_goal({ title: 'Stuck Goal' }));
			const goalId = goalResult.goalId as string;

			// Move goal to needs_human status (simulates planner hitting max attempts)
			await goalManager.updateGoalStatus(goalId, 'needs_human');

			const result = parseResult(
				await handlers.update_goal({ goal_id: goalId, description: 'Clarified description' })
			);
			expect(result.success).toBe(true);

			const goal = result.goal as Record<string, unknown>;
			expect(goal.status).toBe('active');
			expect(goal.planning_attempts).toBe(0);
		});

		it('should leave an active goal as active when title/description changes', async () => {
			const goalResult = parseResult(await handlers.create_goal({ title: 'Active Goal' }));
			const goalId = goalResult.goalId as string;

			// Goal is active by default
			const result = parseResult(
				await handlers.update_goal({ goal_id: goalId, title: 'New Title' })
			);
			expect(result.success).toBe(true);

			const goal = result.goal as Record<string, unknown>;
			expect(goal.status).toBe('active');
		});

		it('should call runtime.cancelTask and runtime.onGoalCreated when runtime is available', async () => {
			const goalResult = parseResult(await handlers.create_goal({ title: 'Runtime Goal' }));
			const goalId = goalResult.goalId as string;

			const planTaskId = await createPlanningTask(goalId, 'pending');

			const cancelledIds: string[] = [];
			const onGoalCreatedIds: string[] = [];
			const mockRuntime = {
				cancelTask: async (taskId: string) => {
					cancelledIds.push(taskId);
					await taskManager.setTaskStatus(taskId, 'cancelled');
					return { success: true, cancelledTaskIds: [taskId] };
				},
				onGoalCreated: (gId: string) => {
					onGoalCreatedIds.push(gId);
				},
			};
			const runtimeService = { getRuntime: (_roomId: string) => mockRuntime as never };

			const handlersWithRuntime = createRoomAgentToolHandlers({
				roomId,
				goalManager,
				taskManager,
				groupRepo,
				runtimeService,
			});

			const result = parseResult(
				await handlersWithRuntime.update_goal({ goal_id: goalId, title: 'Updated' })
			);
			expect(result.success).toBe(true);

			// runtime.cancelTask should have been called for the planning task
			expect(cancelledIds).toContain(planTaskId);

			// runtime.onGoalCreated should have been triggered
			expect(onGoalCreatedIds).toContain(goalId);
		});

		it('should NOT cancel terminal-status planning tasks', async () => {
			const goalResult = parseResult(await handlers.create_goal({ title: 'Goal' }));
			const goalId = goalResult.goalId as string;

			// Create a completed planning task (terminal — should not be cancelled again)
			const planTaskId = await createPlanningTask(goalId, 'completed');

			const result = parseResult(
				await handlers.update_goal({ goal_id: goalId, title: 'New Title' })
			);
			expect(result.success).toBe(true);

			const planTask = await taskManager.getTask(planTaskId);
			expect(planTask?.status).toBe('completed');
		});

		it('should respect explicit planning_attempts when provided alongside title change', async () => {
			const goalResult = parseResult(await handlers.create_goal({ title: 'Goal' }));
			const goalId = goalResult.goalId as string;

			db.run('UPDATE goals SET planning_attempts = 3 WHERE id = ?', [goalId]);

			// Caller explicitly sets planning_attempts = 5 alongside a title change
			const result = parseResult(
				await handlers.update_goal({ goal_id: goalId, title: 'New Title', planning_attempts: 5 })
			);
			expect(result.success).toBe(true);

			// The explicit value (5) should win — the auto-reset to 0 is skipped
			const goal = result.goal as Record<string, unknown>;
			expect(goal.planning_attempts).toBe(5);
		});

		it('should respect explicit status:needs_human when title/description also changes', async () => {
			const goalResult = parseResult(await handlers.create_goal({ title: 'Goal' }));
			const goalId = goalResult.goalId as string;

			// Caller explicitly sets status to needs_human AND changes the title in the same call.
			// The explicit status instruction takes precedence — invalidation should NOT override it.
			const result = parseResult(
				await handlers.update_goal({
					goal_id: goalId,
					title: 'Updated Title',
					status: 'needs_human',
				})
			);
			expect(result.success).toBe(true);

			// Explicit status wins — should remain needs_human
			const goal = result.goal as Record<string, unknown>;
			expect(goal.status).toBe('needs_human');
			// planning_attempts still reset since no explicit planning_attempts was provided
			expect(goal.planning_attempts).toBe(0);
		});

		it('should return error when in_progress planning task has active session group and no runtime', async () => {
			const goalResult = parseResult(await handlers.create_goal({ title: 'Goal' }));
			const goalId = goalResult.goalId as string;

			const planTaskId = await createPlanningTask(goalId, 'in_progress');

			// Insert an active session group for the planning task (simulates running planner)
			insertActiveGroup(planTaskId);

			// Without runtime, should refuse to cancel a planning task with an active session group
			const result = parseResult(
				await handlers.update_goal({ goal_id: goalId, title: 'New Title' })
			);
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/active session group/i);

			// Planning task should be unchanged
			const planTask = await taskManager.getTask(planTaskId);
			expect(planTask?.status).toBe('in_progress');

			// Goal title must NOT have been mutated — the update was rejected before any DB write
			const goalAfter = await goalManager.getGoal(goalId);
			expect(goalAfter?.title).toBe('Goal');
		});
	});
});
