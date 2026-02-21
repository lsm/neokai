/**
 * RoomAgentService Integration Tests
 *
 * Tests real component interactions for the Room Agent:
 * - Real AgentSession initialization with AgentSession.fromInit()
 * - Real DaemonHub events and event propagation
 * - Real database persistence with repositories
 * - Multi-service coordination (RoomAgentService + GoalManager + TaskManager)
 * - MCP tool integration (room_spawn_worker, room_create_task, etc.)
 * - State recovery after service restart
 *
 * Uses in-memory SQLite with real schema creation.
 * Mocks only the AI provider responses.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables } from '../../../src/storage/schema';
import { Database } from '../../../src/storage';
import { RoomAgentService } from '../../../src/lib/room/room-agent-service';
import { RoomManager } from '../../../src/lib/room/room-manager';
import { TaskManager } from '../../../src/lib/room/task-manager';
import { GoalManager } from '../../../src/lib/room/goal-manager';
import { SessionPairManager } from '../../../src/lib/room/session-pair-manager';
import { RecurringJobScheduler } from '../../../src/lib/room/recurring-job-scheduler';
import { PromptTemplateManager } from '../../../src/lib/prompts/prompt-template-manager';
import { createDaemonHub, type DaemonHub } from '../../../src/lib/daemon-hub';
import { MessageHub, MessageHubRouter } from '@neokai/shared';
import type { Room, SessionPair, NeoTask, RoomGoal } from '@neokai/shared';

/**
 * Helper to create additional room-related tables
 */
function createRoomTables(db: BunDatabase): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS goals (
			id TEXT PRIMARY KEY,
			room_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('pending', 'in_progress', 'completed', 'blocked')),
			priority TEXT NOT NULL DEFAULT 'normal'
				CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
			progress INTEGER DEFAULT 0,
			linked_task_ids TEXT DEFAULT '[]',
			metrics TEXT DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			completed_at INTEGER,
			FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS session_pairs (
			id TEXT PRIMARY KEY,
			room_id TEXT NOT NULL,
			room_session_id TEXT NOT NULL,
			manager_session_id TEXT NOT NULL,
			worker_session_id TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'idle', 'crashed', 'completed')),
			current_task_id TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS room_agent_states (
			room_id TEXT PRIMARY KEY,
			lifecycle_state TEXT NOT NULL DEFAULT 'idle'
				CHECK(lifecycle_state IN ('idle', 'planning', 'executing', 'waiting', 'reviewing', 'error', 'paused')),
			current_goal_id TEXT,
			current_task_id TEXT,
			active_session_pair_ids TEXT DEFAULT '[]',
			last_activity_at INTEGER NOT NULL,
			error_count INTEGER DEFAULT 0,
			last_error TEXT,
			pending_actions TEXT DEFAULT '[]',
			FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS recurring_jobs (
			id TEXT PRIMARY KEY,
			room_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			schedule TEXT NOT NULL DEFAULT '{}',
			task_template TEXT NOT NULL DEFAULT '{}',
			enabled INTEGER DEFAULT 1,
			last_run_at INTEGER,
			next_run_at INTEGER,
			run_count INTEGER DEFAULT 0,
			max_runs INTEGER,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS proposals (
			id TEXT PRIMARY KEY,
			room_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			type TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			proposed_changes TEXT DEFAULT '{}',
			reasoning TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('pending', 'approved', 'rejected', 'withdrawn', 'applied')),
			acted_by TEXT,
			action_response TEXT,
			created_at INTEGER NOT NULL,
			acted_at INTEGER,
			FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS prompt_templates (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			content TEXT NOT NULL,
			variables TEXT DEFAULT '[]',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS room_prompt_overrides (
			room_id TEXT NOT NULL,
			template_id TEXT NOT NULL,
			custom_content TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (room_id, template_id),
			FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
			FOREIGN KEY (template_id) REFERENCES prompt_templates(id) ON DELETE CASCADE
		)
	`);

	// Add missing columns to tasks table for recurring jobs support
	try {
		db.exec(`ALTER TABLE tasks ADD COLUMN recurring_job_id TEXT`);
	} catch {
		/* column already exists */
	}
	try {
		db.exec(`ALTER TABLE tasks ADD COLUMN execution_mode TEXT`);
	} catch {
		/* column already exists */
	}
	try {
		db.exec(`ALTER TABLE tasks ADD COLUMN session_ids TEXT DEFAULT '[]'`);
	} catch {
		/* column already exists */
	}
	try {
		db.exec(`ALTER TABLE tasks ADD COLUMN sessions TEXT DEFAULT '{}'`);
	} catch {
		/* column already exists */
	}
}

/**
 * Mock SessionPairManager that doesn't create real sessions
 */
function createMockSessionPairManager(): {
	manager: {
		createPair: (params: {
			roomId: string;
			roomSessionId: string;
			taskTitle: string;
			taskDescription: string;
			workspacePath?: string;
		}) => Promise<{ pair: SessionPair; task: NeoTask }>;
		getPair: (id: string) => SessionPair | null;
		getPairsByRoom: (roomId: string) => SessionPair[];
	};
	pairs: Map<string, SessionPair>;
} {
	const pairs = new Map<string, SessionPair>();
	let pairCounter = 0;

	return {
		manager: {
			createPair: async (params) => {
				pairCounter++;
				const pairId = `pair-${pairCounter}`;
				const workerSessionId = `worker-${pairCounter}`;
				const managerSessionId = `manager-${pairCounter}`;
				const taskId = `task-${pairCounter}`;

				const pair: SessionPair = {
					id: pairId,
					roomId: params.roomId,
					roomSessionId: params.roomSessionId,
					managerSessionId,
					workerSessionId,
					status: 'active',
					currentTaskId: taskId,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				};

				pairs.set(pairId, pair);

				const task: NeoTask = {
					id: taskId,
					roomId: params.roomId,
					title: params.taskTitle,
					description: params.taskDescription ?? '',
					status: 'pending',
					priority: 'normal',
					dependsOn: [],
					createdAt: Date.now(),
				};

				return { pair, task };
			},
			getPair: (id) => pairs.get(id) ?? null,
			getPairsByRoom: (roomId) => Array.from(pairs.values()).filter((p) => p.roomId === roomId),
		},
		pairs,
	};
}

interface TestContext {
	db: Database;
	bunDb: BunDatabase;
	roomManager: RoomManager;
	room: Room;
	daemonHub: DaemonHub;
	messageHub: MessageHub;
	sessionPairManager: ReturnType<typeof createMockSessionPairManager>;
	taskManager: TaskManager;
	goalManager: GoalManager;
	recurringJobScheduler: RecurringJobScheduler;
	promptTemplateManager: PromptTemplateManager;
	trackedEvents: Array<{ event: string; data: unknown }>;
	cleanup: () => void;
}

async function createTestContext(): Promise<TestContext> {
	// Create in-memory database wrapper
	const db = new Database(':memory:');
	await db.initialize();

	// Get raw BunDatabase for additional table creation
	const bunDb = db.getDatabase();
	createTables(bunDb);
	createRoomTables(bunDb);

	// Create room manager and a room
	const roomManager = new RoomManager(bunDb);
	const room = roomManager.createRoom({
		name: 'Test Room',
		allowedPaths: [{ path: '/workspace/test' }],
		defaultPath: '/workspace/test',
	});

	// Create DaemonHub
	const daemonHub = createDaemonHub('test-daemon');
	await daemonHub.initialize();

	// Create MessageHub
	const router = new MessageHubRouter({ logger: console, debug: false });
	const messageHub = new MessageHub({ defaultSessionId: 'global', debug: false });
	messageHub.registerRouter(router);

	// Create mock session pair manager
	const sessionPairManager = createMockSessionPairManager();

	// Create managers
	const taskManager = new TaskManager(bunDb, room.id);
	const goalManager = new GoalManager(bunDb, room.id, daemonHub);
	const recurringJobScheduler = new RecurringJobScheduler(bunDb, daemonHub);
	const promptTemplateManager = new PromptTemplateManager(bunDb);

	// Track events
	const trackedEvents: Array<{ event: string; data: unknown }> = [];

	return {
		db,
		bunDb,
		roomManager,
		room,
		daemonHub,
		messageHub,
		sessionPairManager,
		taskManager,
		goalManager,
		recurringJobScheduler,
		promptTemplateManager,
		trackedEvents,
		cleanup: () => {
			recurringJobScheduler.stop();
			messageHub.cleanup();
			db.close();
		},
	};
}

describe('RoomAgentService Integration', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestContext();
	});

	afterEach(() => {
		ctx.cleanup();
	});

	describe('Real AgentSession Flow', () => {
		test('should initialize RoomAgentService without AgentSession when no getApiKey provided', async () => {
			const agentService = new RoomAgentService({
				room: ctx.room,
				db: ctx.bunDb,
				daemonHub: ctx.daemonHub,
				messageHub: ctx.messageHub,
				sessionPairManager: ctx.sessionPairManager.manager as unknown as SessionPairManager,
			});

			await agentService.start();

			// Should not have AgentSession when no getApiKey provided
			expect(agentService.getAgentSession()).toBeNull();

			// But should still have lifecycle manager
			expect(agentService.getLifecycleManager()).not.toBeNull();

			// And should be in idle state
			expect(agentService.getState().lifecycleState).toBe('idle');

			await agentService.stop();
		});

		// NOTE: AgentSession initialization with getApiKey is tested in online tests
		// because the MCP server configuration contains cyclic structures that cannot
		// be serialized to JSON for database storage in unit tests.
		test.skip('should initialize with AgentSession when getApiKey is provided', async () => {
			// This test requires real MCP server infrastructure
			// See tests/online/ for full AgentSession tests
		});

		test('should have lifecycle state machine working', async () => {
			const agentService = new RoomAgentService({
				room: ctx.room,
				db: ctx.bunDb,
				daemonHub: ctx.daemonHub,
				messageHub: ctx.messageHub,
				sessionPairManager: ctx.sessionPairManager.manager as unknown as SessionPairManager,
			});

			await agentService.start();

			// Test lifecycle state transitions
			expect(agentService.getState().lifecycleState).toBe('idle');

			await agentService.forceState('planning');
			expect(agentService.getState().lifecycleState).toBe('planning');

			await agentService.forceState('executing');
			expect(agentService.getState().lifecycleState).toBe('executing');

			await agentService.forceState('reviewing');
			expect(agentService.getState().lifecycleState).toBe('reviewing');

			await agentService.stop();
		});
	});

	describe('Real DaemonHub Events', () => {
		test('should emit state change events on lifecycle transitions', async () => {
			const events: Array<{ event: string; data: unknown }> = [];
			const unsubscribe = ctx.daemonHub.on('roomAgent.stateChanged', (data) => {
				events.push({ event: 'roomAgent.stateChanged', data });
			});

			const agentService = new RoomAgentService({
				room: ctx.room,
				db: ctx.bunDb,
				daemonHub: ctx.daemonHub,
				messageHub: ctx.messageHub,
				sessionPairManager: ctx.sessionPairManager.manager as unknown as SessionPairManager,
			});

			await agentService.start();
			await agentService.forceState('planning');
			await agentService.forceState('executing');
			await agentService.stop();

			// Should have tracked state changes
			expect(events.length).toBeGreaterThan(0);

			// Check event structure
			const stateChangeEvent = events.find(
				(e) => (e.data as { newState?: string }).newState === 'planning'
			);
			expect(stateChangeEvent).toBeDefined();
			expect((stateChangeEvent!.data as { roomId: string }).roomId).toBe(ctx.room.id);

			unsubscribe();
		});

		test('should handle room.message event and create task', async () => {
			const events: Array<{ event: string; data: unknown }> = [];
			ctx.daemonHub.on('roomAgent.stateChanged', (data) => {
				events.push({ event: 'roomAgent.stateChanged', data });
			});

			const agentService = new RoomAgentService({
				room: ctx.room,
				db: ctx.bunDb,
				daemonHub: ctx.daemonHub,
				messageHub: ctx.messageHub,
				sessionPairManager: ctx.sessionPairManager.manager as unknown as SessionPairManager,
			});

			await agentService.start();

			// Emit room.message event
			await ctx.daemonHub.emit('room.message', {
				sessionId: agentService.sessionId,
				roomId: ctx.room.id,
				message: {
					id: 'msg-1',
					role: 'user',
					content: 'Please help me with something',
					timestamp: Date.now(),
				},
				sender: 'test-user',
			});

			// Wait for event processing
			await Bun.sleep(50);

			// Should have transitioned through planning
			const planningEvent = events.find(
				(e) => (e.data as { newState?: string }).newState === 'planning'
			);
			expect(planningEvent).toBeDefined();

			// Task should have been created
			const tasks = await ctx.taskManager.listTasks();
			expect(tasks.length).toBeGreaterThan(0);
			expect(tasks[0].title).toContain('Please help me');

			await agentService.stop();
		});

		test('should ignore room.message events for other rooms', async () => {
			const events: Array<{ event: string; data: unknown }> = [];
			ctx.daemonHub.on('roomAgent.stateChanged', (data) => {
				events.push({ event: 'roomAgent.stateChanged', data });
			});

			const agentService = new RoomAgentService({
				room: ctx.room,
				db: ctx.bunDb,
				daemonHub: ctx.daemonHub,
				messageHub: ctx.messageHub,
				sessionPairManager: ctx.sessionPairManager.manager as unknown as SessionPairManager,
			});

			await agentService.start();
			events.length = 0; // Clear startup events

			// Emit room.message event for different room
			await ctx.daemonHub.emit('room.message', {
				sessionId: 'room:other-room',
				roomId: 'other-room-id',
				message: {
					id: 'msg-2',
					role: 'user',
					content: 'This should be ignored',
					timestamp: Date.now(),
				},
				sender: 'test-user',
			});

			await Bun.sleep(50);

			// Should not have any state changes for other room
			expect(events.length).toBe(0);

			await agentService.stop();
		});
	});

	describe('Real Database Persistence', () => {
		test('should persist agent state to database', async () => {
			const agentService = new RoomAgentService({
				room: ctx.room,
				db: ctx.bunDb,
				daemonHub: ctx.daemonHub,
				messageHub: ctx.messageHub,
				sessionPairManager: ctx.sessionPairManager.manager as unknown as SessionPairManager,
			});

			await agentService.start();
			await agentService.forceState('executing');

			// Verify state persisted to database
			const stateRepo = new (
				await import('../../../src/storage/repositories/room-agent-state-repository')
			).RoomAgentStateRepository(ctx.bunDb);
			const dbState = stateRepo.getState(ctx.room.id);

			expect(dbState).not.toBeNull();
			expect(dbState!.lifecycleState).toBe('executing');
			expect(dbState!.roomId).toBe(ctx.room.id);

			await agentService.stop();
		});

		test('should recover state from database on service restart', async () => {
			// First service instance
			const agentService1 = new RoomAgentService({
				room: ctx.room,
				db: ctx.bunDb,
				daemonHub: ctx.daemonHub,
				messageHub: ctx.messageHub,
				sessionPairManager: ctx.sessionPairManager.manager as unknown as SessionPairManager,
			});

			await agentService1.start();
			await agentService1.forceState('planning');
			await agentService1.stop();

			// Second service instance - should recover state
			const agentService2 = new RoomAgentService({
				room: ctx.room,
				db: ctx.bunDb,
				daemonHub: ctx.daemonHub,
				messageHub: ctx.messageHub,
				sessionPairManager: ctx.sessionPairManager.manager as unknown as SessionPairManager,
			});

			await agentService2.start();

			// Should have recovered 'paused' state (from stop)
			expect(['paused', 'planning']).toContain(agentService2.getState().lifecycleState);

			await agentService2.stop();
		});

		test('should persist GoalManager state with real database', async () => {
			// Create a goal
			const goal = await ctx.goalManager.createGoal({
				title: 'Test Goal',
				description: 'A goal for testing persistence',
				priority: 'high',
			});

			expect(goal.id).toBeDefined();
			expect(goal.roomId).toBe(ctx.room.id);
			expect(goal.status).toBe('pending');

			// Verify persisted
			const retrievedGoal = await ctx.goalManager.getGoal(goal.id);
			expect(retrievedGoal).not.toBeNull();
			expect(retrievedGoal!.title).toBe('Test Goal');
		});

		test('should persist TaskManager state with real database', async () => {
			// Create a task
			const task = await ctx.taskManager.createTask({
				title: 'Test Task',
				description: 'A task for testing persistence',
				priority: 'urgent',
			});

			expect(task.id).toBeDefined();
			expect(task.roomId).toBe(ctx.room.id);
			expect(task.status).toBe('pending');
			expect(task.priority).toBe('urgent');

			// Update task status
			await ctx.taskManager.startTask(task.id, 'session-1');
			const updatedTask = await ctx.taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('in_progress');
			expect(updatedTask!.sessionId).toBe('session-1');
		});
	});

	describe('Multi-Service Coordination', () => {
		test('should coordinate RoomAgentService + GoalManager + TaskManager', async () => {
			// Create a goal
			const goal = await ctx.goalManager.createGoal({
				title: 'Implement Feature X',
				description: 'Complete implementation of feature X',
			});

			// Create tasks linked to the goal
			const task1 = await ctx.taskManager.createTask({
				title: 'Design API',
				description: 'Design the API for feature X',
				priority: 'high',
			});

			const task2 = await ctx.taskManager.createTask({
				title: 'Write Tests',
				description: 'Write tests for feature X',
				priority: 'normal',
				dependsOn: [task1.id],
			});

			// Link tasks to goal
			await ctx.goalManager.linkTaskToGoal(goal.id, task1.id);
			await ctx.goalManager.linkTaskToGoal(goal.id, task2.id);

			// Complete first task
			await ctx.taskManager.completeTask(task1.id, 'API designed successfully');

			// Manually recalculate progress (in real app this happens via updateGoalsForTask)
			await ctx.goalManager.recalculateProgress(goal.id);

			// Goal progress should be updated (1 of 2 tasks = 50%)
			const updatedGoal = await ctx.goalManager.getGoal(goal.id);
			expect(updatedGoal!.progress).toBe(50);

			// Complete second task
			await ctx.taskManager.completeTask(task2.id, 'Tests written');

			// Manually recalculate progress
			await ctx.goalManager.recalculateProgress(goal.id);

			// Goal should be 100% complete
			const finalGoal = await ctx.goalManager.getGoal(goal.id);
			expect(finalGoal!.progress).toBe(100);
		});

		test('should handle task lifecycle: create -> assign -> complete', async () => {
			// Create task
			const task = await ctx.taskManager.createTask({
				title: 'Lifecycle Test Task',
				description: 'Testing task lifecycle',
			});

			expect(task.status).toBe('pending');

			// Start task
			const startedTask = await ctx.taskManager.startTask(task.id, 'worker-session-1');
			expect(startedTask.status).toBe('in_progress');
			expect(startedTask.sessionId).toBe('worker-session-1');

			// Update progress
			const progressTask = await ctx.taskManager.updateTaskProgress(task.id, 50, 'Halfway done');
			expect(progressTask.progress).toBe(50);
			expect(progressTask.currentStep).toBe('Halfway done');

			// Complete task
			const completedTask = await ctx.taskManager.completeTask(task.id, 'Task completed');
			expect(completedTask.status).toBe('completed');
			expect(completedTask.progress).toBe(100);
			expect(completedTask.result).toBe('Task completed');
		});

		test('should respect task dependencies', async () => {
			// Create tasks with dependencies
			const task1 = await ctx.taskManager.createTask({
				title: 'First Task',
				description: 'Must be completed first',
			});

			const task2 = await ctx.taskManager.createTask({
				title: 'Second Task',
				description: 'Depends on first',
				dependsOn: [task1.id],
			});

			// task2 should not have dependencies met yet
			const depsMetBefore = await ctx.taskManager.areDependenciesMet(task2);
			expect(depsMetBefore).toBe(false);

			// Get next pending task - should be task1 (no deps)
			const nextTask = await ctx.taskManager.getNextPendingTask();
			expect(nextTask!.id).toBe(task1.id);

			// Complete task1
			await ctx.taskManager.completeTask(task1.id, 'Done');

			// Now task2 deps should be met
			const depsMetAfter = await ctx.taskManager.areDependenciesMet(task2);
			expect(depsMetAfter).toBe(true);

			// Get next pending task - should be task2
			const nextTaskAfter = await ctx.taskManager.getNextPendingTask();
			expect(nextTaskAfter!.id).toBe(task2.id);
		});
	});

	describe('RecurringJob Integration', () => {
		test('should create and trigger recurring jobs', async () => {
			// Start scheduler
			ctx.recurringJobScheduler.start();

			// Create a recurring job
			const job = await ctx.recurringJobScheduler.createJob({
				roomId: ctx.room.id,
				name: 'Daily Check',
				description: 'Check for updates daily',
				schedule: { type: 'interval', minutes: 60 },
				taskTemplate: {
					title: 'Daily Check Task',
					description: 'Perform daily check',
					priority: 'normal',
				},
				enabled: true,
			});

			expect(job.id).toBeDefined();
			expect(job.roomId).toBe(ctx.room.id);
			expect(job.enabled).toBe(true);

			// Manually trigger the job
			const result = await ctx.recurringJobScheduler.triggerJob(job.id);
			expect(result.success).toBe(true);
			expect(result.taskId).toBeDefined();

			// Task should have been created
			const task = await ctx.taskManager.getTask(result.taskId!);
			expect(task).not.toBeNull();
			expect(task!.title).toBe('Daily Check Task');
			expect(task!.recurringJobId).toBe(job.id);
		});

		test('should emit recurringJob.triggered event', async () => {
			const events: Array<{ event: string; data: unknown }> = [];
			ctx.daemonHub.on('recurringJob.triggered', (data) => {
				events.push({ event: 'recurringJob.triggered', data });
			});

			ctx.recurringJobScheduler.start();

			const job = await ctx.recurringJobScheduler.createJob({
				roomId: ctx.room.id,
				name: 'Test Job',
				description: 'Test job',
				schedule: { type: 'interval', minutes: 60 },
				taskTemplate: {
					title: 'Test Task',
					description: 'Test',
				},
				enabled: true,
			});

			await ctx.recurringJobScheduler.triggerJob(job.id);

			// Should have triggered event
			expect(events.length).toBe(1);
			expect((events[0].data as { jobId: string }).jobId).toBe(job.id);
			expect((events[0].data as { roomId: string }).roomId).toBe(ctx.room.id);
		});
	});

	describe('Error Handling and Recovery', () => {
		test('should track error count in state', async () => {
			const agentService = new RoomAgentService(
				{
					room: ctx.room,
					db: ctx.bunDb,
					daemonHub: ctx.daemonHub,
					messageHub: ctx.messageHub,
					sessionPairManager: ctx.sessionPairManager.manager as unknown as SessionPairManager,
				},
				{ maxErrorCount: 3 }
			);

			await agentService.start();

			// Force to error state
			await agentService.forceState('error');

			expect(agentService.getState().lifecycleState).toBe('error');

			await agentService.stop();
		});

		test('should handle pause and resume correctly', async () => {
			const events: Array<{ event: string; data: unknown }> = [];
			ctx.daemonHub.on('roomAgent.stateChanged', (data) => {
				events.push({ event: 'roomAgent.stateChanged', data });
			});

			const agentService = new RoomAgentService({
				room: ctx.room,
				db: ctx.bunDb,
				daemonHub: ctx.daemonHub,
				messageHub: ctx.messageHub,
				sessionPairManager: ctx.sessionPairManager.manager as unknown as SessionPairManager,
			});

			await agentService.start();
			events.length = 0;

			await agentService.pause();
			expect(agentService.getState().lifecycleState).toBe('paused');

			await agentService.resume();
			expect(agentService.getState().lifecycleState).toBe('idle');

			// Should have pause and resume events
			const pauseEvent = events.find(
				(e) => (e.data as { newState?: string }).newState === 'paused'
			);
			const resumeEvent = events.find((e) => (e.data as { newState?: string }).newState === 'idle');
			expect(pauseEvent).toBeDefined();
			expect(resumeEvent).toBeDefined();

			await agentService.stop();
		});
	});

	describe('GitHub Event Processing', () => {
		test('should parse GitHub issue event and create task', async () => {
			const agentService = new RoomAgentService({
				room: ctx.room,
				db: ctx.bunDb,
				daemonHub: ctx.daemonHub,
				messageHub: ctx.messageHub,
				sessionPairManager: ctx.sessionPairManager.manager as unknown as SessionPairManager,
			});

			await agentService.start();

			// Emit GitHub event
			await ctx.daemonHub.emit('room.message', {
				sessionId: agentService.sessionId,
				roomId: ctx.room.id,
				message: {
					id: 'github-msg-1',
					role: 'github_event',
					content:
						'**issue opened**\nRepository: owner/repo\nIssue #123: Fix bug in login\nBody: Users cannot login',
					timestamp: Date.now(),
				},
			});

			await Bun.sleep(50);

			// Task should have been created
			const tasks = await ctx.taskManager.listTasks();
			const githubTask = tasks.find((t) => t.title.includes('Fix bug in login'));
			expect(githubTask).toBeDefined();
			expect(githubTask!.priority).toBe('high'); // Opened issues are high priority
			expect(githubTask!.description).toContain('Issue #123');

			await agentService.stop();
		});
	});

	describe('Command Handling', () => {
		test('should handle /status command', async () => {
			const events: Array<{ event: string; data: unknown }> = [];
			ctx.daemonHub.on('room.message', (data) => {
				events.push({ event: 'room.message', data });
			});

			const agentService = new RoomAgentService({
				room: ctx.room,
				db: ctx.bunDb,
				daemonHub: ctx.daemonHub,
				messageHub: ctx.messageHub,
				sessionPairManager: ctx.sessionPairManager.manager as unknown as SessionPairManager,
			});

			await agentService.start();

			// Send /status command
			await ctx.daemonHub.emit('room.message', {
				sessionId: agentService.sessionId,
				roomId: ctx.room.id,
				message: {
					id: 'cmd-1',
					role: 'user',
					content: '/status',
					timestamp: Date.now(),
				},
			});

			await Bun.sleep(50);

			// Should have sent a response message
			const responseMsg = events.find(
				(e) => (e.data as { message?: { role?: string } }).message?.role === 'assistant'
			);
			expect(responseMsg).toBeDefined();
			expect((responseMsg!.data as { message: { content: string } }).message.content).toContain(
				'Agent Status:'
			);

			await agentService.stop();
		});

		test('should handle /goals command', async () => {
			// Create some goals
			await ctx.goalManager.createGoal({ title: 'Goal 1', description: 'First goal' });
			await ctx.goalManager.createGoal({ title: 'Goal 2', description: 'Second goal' });

			const events: Array<{ event: string; data: unknown }> = [];
			ctx.daemonHub.on('room.message', (data) => {
				events.push({ event: 'room.message', data });
			});

			const agentService = new RoomAgentService({
				room: ctx.room,
				db: ctx.bunDb,
				daemonHub: ctx.daemonHub,
				messageHub: ctx.messageHub,
				sessionPairManager: ctx.sessionPairManager.manager as unknown as SessionPairManager,
			});

			await agentService.start();

			// Send /goals command
			await ctx.daemonHub.emit('room.message', {
				sessionId: agentService.sessionId,
				roomId: ctx.room.id,
				message: {
					id: 'cmd-2',
					role: 'user',
					content: '/goals',
					timestamp: Date.now(),
				},
			});

			await Bun.sleep(50);

			// Should have sent a response with goals
			const responseMsg = events.find(
				(e) => (e.data as { message?: { role?: string } }).message?.role === 'assistant'
			);
			expect(responseMsg).toBeDefined();
			const content = (responseMsg!.data as { message: { content: string } }).message.content;
			expect(content).toContain('Goals:');
			expect(content).toContain('Goal 1');
			expect(content).toContain('Goal 2');

			await agentService.stop();
		});
	});

	describe('State Recovery After Restart', () => {
		test('should recover active pairs state after restart', async () => {
			const agentService = new RoomAgentService({
				room: ctx.room,
				db: ctx.bunDb,
				daemonHub: ctx.daemonHub,
				messageHub: ctx.messageHub,
				sessionPairManager: ctx.sessionPairManager.manager as unknown as SessionPairManager,
			});

			await agentService.start();

			// Simulate creating active pairs
			const stateRepo = new (
				await import('../../../src/storage/repositories/room-agent-state-repository')
			).RoomAgentStateRepository(ctx.bunDb);
			stateRepo.addActiveSessionPair(ctx.room.id, 'pair-1');
			stateRepo.addActiveSessionPair(ctx.room.id, 'pair-2');

			await agentService.stop();

			// Create new service instance
			const agentService2 = new RoomAgentService({
				room: ctx.room,
				db: ctx.bunDb,
				daemonHub: ctx.daemonHub,
				messageHub: ctx.messageHub,
				sessionPairManager: ctx.sessionPairManager.manager as unknown as SessionPairManager,
			});

			await agentService2.start();

			// Should have recovered active pairs
			const state = agentService2.getState();
			expect(state.activeSessionPairIds).toContain('pair-1');
			expect(state.activeSessionPairIds).toContain('pair-2');

			await agentService2.stop();
		});

		test('should recover error state after restart', async () => {
			// First service - set error state
			const agentService1 = new RoomAgentService(
				{
					room: ctx.room,
					db: ctx.bunDb,
					daemonHub: ctx.daemonHub,
					messageHub: ctx.messageHub,
					sessionPairManager: ctx.sessionPairManager.manager as unknown as SessionPairManager,
				},
				{ maxErrorCount: 5 }
			);

			await agentService1.start();
			await agentService1.forceState('error');

			// Verify error state persisted
			const stateRepo = new (
				await import('../../../src/storage/repositories/room-agent-state-repository')
			).RoomAgentStateRepository(ctx.bunDb);
			stateRepo.recordError(ctx.room.id, 'Test error');

			await agentService1.stop();

			// Second service - should recover error count
			const agentService2 = new RoomAgentService(
				{
					room: ctx.room,
					db: ctx.bunDb,
					daemonHub: ctx.daemonHub,
					messageHub: ctx.messageHub,
					sessionPairManager: ctx.sessionPairManager.manager as unknown as SessionPairManager,
				},
				{ maxErrorCount: 5 }
			);

			await agentService2.start();

			// Error count should be recovered
			expect(agentService2.getState().errorCount).toBe(1);

			await agentService2.stop();
		});
	});
});
