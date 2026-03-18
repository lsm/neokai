import { Database } from 'bun:sqlite';
import { RoomRuntime } from '../../../src/lib/room/runtime/room-runtime';
import { SessionGroupRepository } from '../../../src/lib/room/state/session-group-repository';
import { SessionObserver } from '../../../src/lib/room/state/session-observer';
import { GoalManager } from '../../../src/lib/room/managers/goal-manager';
import { TaskManager } from '../../../src/lib/room/managers/task-manager';
import type { Room } from '@neokai/shared';
import type { SessionFactory } from '../../../src/lib/room/runtime/task-group-manager';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { HookOptions } from '../../../src/lib/room/runtime/lifecycle-hooks';

export function createMockDaemonHub() {
	const handlers = new Map<string, Map<string | undefined, Array<(data: unknown) => void>>>();
	const emittedEvents: Array<{ event: string; data: unknown }> = [];
	return {
		emittedEvents,
		on(
			event: string,
			handler: (data: unknown) => void,
			options?: { sessionId?: string }
		): () => void {
			if (!handlers.has(event)) {
				handlers.set(event, new Map());
			}
			const eventHandlers = handlers.get(event)!;
			const key = options?.sessionId;
			if (!eventHandlers.has(key)) {
				eventHandlers.set(key, []);
			}
			eventHandlers.get(key)!.push(handler);
			return () => {
				const list = eventHandlers.get(key);
				if (list) {
					const idx = list.indexOf(handler);
					if (idx !== -1) list.splice(idx, 1);
				}
			};
		},
		async emit(event: string, data: unknown): Promise<void> {
			emittedEvents.push({ event, data });
		},
	};
}

export function createMockSessionFactory() {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	/** Per-session processing state, configurable in tests for stuck worker scenarios */
	const processingStates = new Map<
		string,
		'idle' | 'queued' | 'processing' | 'interrupted' | 'waiting_for_input'
	>();
	return {
		calls,
		processingStates,
		async createAndStartSession(init: unknown, role: string) {
			calls.push({ method: 'createAndStartSession', args: [init, role] });
		},
		async injectMessage(
			sessionId: string,
			message: string,
			opts?: { deliveryMode?: 'current_turn' | 'next_turn' }
		) {
			calls.push({ method: 'injectMessage', args: [sessionId, message, opts] });
		},
		hasSession(_sessionId: string) {
			return true;
		},
		getProcessingState(
			sessionId: string
		): 'idle' | 'queued' | 'processing' | 'interrupted' | 'waiting_for_input' | undefined {
			return processingStates.get(sessionId);
		},
		async answerQuestion(_sessionId: string, _answer: string) {
			return false;
		},
		async createWorktree(_basePath: string, sessionId: string, _branchName?: string) {
			// Return a synthetic worktree path so isolation enforcement passes in tests
			return `/tmp/worktrees/${sessionId}`;
		},
		async removeWorktree(_workspacePath: string) {
			return true;
		},
		async restoreSession(sessionId: string) {
			calls.push({ method: 'restoreSession', args: [sessionId] });
			return true;
		},
		async interruptSession(sessionId: string) {
			calls.push({ method: 'interruptSession', args: [sessionId] });
		},
		async stopSession(sessionId: string) {
			calls.push({ method: 'stopSession', args: [sessionId] });
		},
		async startSession(sessionId: string) {
			calls.push({ method: 'startSession', args: [sessionId] });
			return true;
		},
	} satisfies SessionFactory & {
		calls: Array<{ method: string; args: unknown[] }>;
		processingStates: Map<
			string,
			'idle' | 'queued' | 'processing' | 'interrupted' | 'waiting_for_input'
		>;
	};
}

export function makeRoom(overrides?: Partial<Room>): Room {
	return {
		id: 'room-1',
		name: 'Test Room',
		allowedPaths: [{ path: '/workspace', label: 'ws' }],
		defaultPath: '/workspace',
		sessionIds: [],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

const DB_SCHEMA = `
	CREATE TABLE rooms (
		id TEXT PRIMARY KEY, name TEXT NOT NULL,
		created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
	);
	CREATE TABLE goals (
		id TEXT PRIMARY KEY, room_id TEXT NOT NULL, title TEXT NOT NULL,
		description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
		priority TEXT NOT NULL DEFAULT 'normal', progress INTEGER DEFAULT 0,
		linked_task_ids TEXT DEFAULT '[]', metrics TEXT DEFAULT '{}',
		created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER,
		planning_attempts INTEGER DEFAULT 0, goal_review_attempts INTEGER DEFAULT 0,
		mission_type TEXT NOT NULL DEFAULT 'one_shot'
			CHECK(mission_type IN ('one_shot', 'measurable', 'recurring')),
		autonomy_level TEXT NOT NULL DEFAULT 'supervised'
			CHECK(autonomy_level IN ('supervised', 'semi_autonomous')),
		schedule TEXT,
		schedule_paused INTEGER NOT NULL DEFAULT 0,
		next_run_at INTEGER,
		structured_metrics TEXT,
		max_consecutive_failures INTEGER NOT NULL DEFAULT 3,
		max_planning_attempts INTEGER NOT NULL DEFAULT 0,
		consecutive_failures INTEGER NOT NULL DEFAULT 0,
		replan_count INTEGER NOT NULL DEFAULT 0
	);
	CREATE TABLE tasks (
		id TEXT PRIMARY KEY, room_id TEXT NOT NULL, title TEXT NOT NULL,
		description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
		priority TEXT NOT NULL DEFAULT 'normal', progress INTEGER,
		current_step TEXT, result TEXT, error TEXT,
		depends_on TEXT DEFAULT '[]',
		task_type TEXT DEFAULT 'coding',
		created_by_task_id TEXT,
		assigned_agent TEXT DEFAULT 'coder',
		created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER,
		archived_at INTEGER,
		active_session TEXT,
		pr_url TEXT,
		pr_number INTEGER,
		pr_created_at INTEGER,
		updated_at INTEGER
	);
	CREATE TABLE session_groups (
		id TEXT PRIMARY KEY, group_type TEXT NOT NULL DEFAULT 'task',
		ref_id TEXT NOT NULL,
		state TEXT NOT NULL DEFAULT 'awaiting_worker',
		version INTEGER NOT NULL DEFAULT 0,
		metadata TEXT NOT NULL DEFAULT '{}',
		created_at INTEGER NOT NULL, completed_at INTEGER
	);
	CREATE TABLE session_group_members (
		group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
		session_id TEXT NOT NULL, role TEXT NOT NULL, joined_at INTEGER NOT NULL,
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
`;

export interface RuntimeTestContext {
	db: Database;
	runtime: RoomRuntime;
	taskManager: TaskManager;
	goalManager: GoalManager;
	groupRepo: SessionGroupRepository;
	sessionFactory: ReturnType<typeof createMockSessionFactory>;
	observer: SessionObserver;
	hub: ReturnType<typeof createMockDaemonHub>;
}

export interface RuntimeTestContextOptions {
	hookOptions?: HookOptions;
	room?: Partial<Room>;
	maxConcurrentGroups?: number;
	maxFeedbackIterations?: number;
	/** Worker message provider for testing (bypass markers, envelope content, terminal errors) */
	getWorkerMessages?: (
		sessionId: string,
		afterMessageId: string | null
	) => Array<{ id: string; text: string; toolCallNames: string[] }>;
}

export function createRuntimeTestContext(opts?: RuntimeTestContextOptions): RuntimeTestContext {
	const db = new Database(':memory:');
	const now = Date.now();
	db.exec(DB_SCHEMA);
	db.exec(
		`INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('room-1', 'Test', ${now}, ${now})`
	);

	const mockHub = createMockDaemonHub();
	const groupRepo = new SessionGroupRepository(db as never);
	const observer = new SessionObserver(mockHub as unknown as DaemonHub);
	const taskManager = new TaskManager(db as never, 'room-1');
	const goalManager = new GoalManager(db as never, 'room-1');
	const sessionFactory = createMockSessionFactory();
	const room = makeRoom(opts?.room);

	const runtime = new RoomRuntime({
		room,
		groupRepo,
		sessionObserver: observer,
		taskManager,
		goalManager,
		sessionFactory,
		workspacePath: '/workspace',
		maxConcurrentGroups: opts?.maxConcurrentGroups ?? 1,
		maxFeedbackIterations: opts?.maxFeedbackIterations,
		tickInterval: 60_000,
		hookOptions:
			opts?.hookOptions ??
			({
				runCommand: async (_args: string[], _cwd: string) => ({ stdout: '', exitCode: 1 }),
			} as const),
		getWorkerMessages: opts?.getWorkerMessages,
		// Fetch from managers (reads from DB) instead of caching objects
		getRoom: (roomId) => (roomId === 'room-1' ? room : null),
		getTask: (taskId) => taskManager.getTask(taskId),
		getGoal: (goalId) => goalManager.getGoal(goalId),
		daemonHub: mockHub as unknown as DaemonHub,
	});

	return {
		db,
		runtime,
		taskManager,
		goalManager,
		groupRepo,
		sessionFactory,
		observer,
		hub: mockHub,
	};
}

export async function createGoalAndTask(
	ctx: RuntimeTestContext,
	opts?: { assignedAgent?: 'coder' | 'general' }
) {
	const goal = await ctx.goalManager.createGoal({
		title: 'Health check',
		description: 'Add health endpoint',
	});
	const task = await ctx.taskManager.createTask({
		title: 'Add GET /health',
		description: 'Returns 200 OK',
		// Default to 'general' for most unit tests.
		assignedAgent: opts?.assignedAgent ?? 'general',
	});
	await ctx.goalManager.linkTaskToGoal(goal.id, task.id);
	return { goal, task };
}

/**
 * Helper: spawn a group via tick, route worker to leader, return the group.
 * Leaves the group in `awaiting_leader` state ready for a leader tool call.
 */
export async function spawnAndRouteToLeader(
	ctx: RuntimeTestContext,
	opts?: { assignedAgent?: 'coder' | 'general' }
) {
	const { goal, task } = await createGoalAndTask(ctx, opts);
	ctx.runtime.start();
	await ctx.runtime.tick();

	const groups = ctx.groupRepo.getActiveGroups('room-1');
	const group = groups[0];

	await ctx.runtime.onWorkerTerminalState(group.id, {
		sessionId: group.workerSessionId,
		kind: 'idle',
	});

	return { goal, task, group };
}
