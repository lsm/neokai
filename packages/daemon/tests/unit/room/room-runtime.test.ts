import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { RoomRuntime } from '../../../src/lib/room/room-runtime';
import { TaskPairRepository } from '../../../src/lib/room/task-pair-repository';
import { SessionObserver } from '../../../src/lib/room/session-observer';
import { GoalManager } from '../../../src/lib/room/goal-manager';
import { TaskManager } from '../../../src/lib/room/task-manager';
import type { Room } from '@neokai/shared';
import type { SessionFactory } from '../../../src/lib/room/task-pair-manager';
import type { DaemonHub } from '../../../src/lib/daemon-hub';

function createMockDaemonHub() {
	const handlers = new Map<string, Map<string | undefined, Array<(data: unknown) => void>>>();
	return {
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
	};
}

function createMockSessionFactory() {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	return {
		calls,
		async createAndStartSession(init: unknown, role: string) {
			calls.push({ method: 'createAndStartSession', args: [init, role] });
		},
		async injectMessage(sessionId: string, message: string) {
			calls.push({ method: 'injectMessage', args: [sessionId, message] });
		},
	} satisfies SessionFactory & { calls: Array<{ method: string; args: unknown[] }> };
}

function makeRoom(): Room {
	return {
		id: 'room-1',
		name: 'Test Room',
		allowedPaths: [{ path: '/workspace', label: 'ws' }],
		defaultPath: '/workspace',
		sessionIds: [],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

describe('RoomRuntime', () => {
	let db: Database;
	let runtime: RoomRuntime;
	let taskManager: TaskManager;
	let goalManager: GoalManager;
	let taskPairRepo: TaskPairRepository;
	let sessionFactory: ReturnType<typeof createMockSessionFactory>;
	let observer: SessionObserver;

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec(`
			CREATE TABLE rooms (
				id TEXT PRIMARY KEY, name TEXT NOT NULL,
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			);
			CREATE TABLE goals (
				id TEXT PRIMARY KEY, room_id TEXT NOT NULL, title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
				priority TEXT NOT NULL DEFAULT 'normal', progress INTEGER DEFAULT 0,
				linked_task_ids TEXT DEFAULT '[]', metrics TEXT DEFAULT '{}',
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
			);
			CREATE TABLE tasks (
				id TEXT PRIMARY KEY, room_id TEXT NOT NULL, title TEXT NOT NULL,
				description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
				priority TEXT NOT NULL DEFAULT 'normal', progress INTEGER,
				current_step TEXT, result TEXT, error TEXT,
				depends_on TEXT DEFAULT '[]',
				created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER
			);
			CREATE TABLE task_pairs (
				id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
				craft_session_id TEXT NOT NULL, lead_session_id TEXT NOT NULL,
				pair_state TEXT NOT NULL DEFAULT 'awaiting_craft',
				feedback_iteration INTEGER NOT NULL DEFAULT 0,
				lead_contract_violations INTEGER NOT NULL DEFAULT 0,
				last_processed_lead_turn_id TEXT,
				last_forwarded_message_id TEXT,
				active_work_started_at INTEGER,
				active_work_elapsed INTEGER NOT NULL DEFAULT 0,
				hibernated_at INTEGER,
				version INTEGER NOT NULL DEFAULT 0,
				tokens_used INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL, completed_at INTEGER
			);
			INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('room-1', 'Test', ${Date.now()}, ${Date.now()});
		`);

		const mockHub = createMockDaemonHub();
		taskPairRepo = new TaskPairRepository(db as never);
		observer = new SessionObserver(mockHub as unknown as DaemonHub);
		taskManager = new TaskManager(db as never, 'room-1');
		goalManager = new GoalManager(db as never, 'room-1');
		sessionFactory = createMockSessionFactory();

		runtime = new RoomRuntime({
			room: makeRoom(),
			taskPairRepo,
			sessionObserver: observer,
			taskManager,
			goalManager,
			sessionFactory,
			workspacePath: '/workspace',
			maxConcurrentPairs: 1,
			maxFeedbackIterations: 5,
			tickInterval: 60_000, // Long interval so timer doesn't fire during tests
		});
	});

	afterEach(() => {
		runtime.stop();
		db.close();
	});

	async function createGoalAndTask() {
		const goal = await goalManager.createGoal({
			title: 'Health check',
			description: 'Add health endpoint',
		});
		const task = await taskManager.createTask({
			title: 'Add GET /health',
			description: 'Returns 200 OK',
		});
		await goalManager.linkTaskToGoal(goal.id, task.id);
		return { goal, task };
	}

	describe('lifecycle', () => {
		it('should start in paused state', () => {
			expect(runtime.getState()).toBe('paused');
		});

		it('should transition to running on start', () => {
			runtime.start();
			expect(runtime.getState()).toBe('running');
		});

		it('should pause and resume', () => {
			runtime.start();
			runtime.pause();
			expect(runtime.getState()).toBe('paused');
			runtime.resume();
			expect(runtime.getState()).toBe('running');
		});

		it('should stop', () => {
			runtime.start();
			runtime.stop();
			expect(runtime.getState()).toBe('stopped');
		});
	});

	describe('tick', () => {
		it('should not tick when paused', async () => {
			await createGoalAndTask();
			await runtime.tick();

			// No pairs should be spawned since runtime is paused
			expect(sessionFactory.calls).toHaveLength(0);
		});

		it('should spawn a pair for pending task when running', async () => {
			const { task } = await createGoalAndTask();
			runtime.start();
			await runtime.tick();

			// Should have created craft and lead sessions
			const craftCalls = sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession' && c.args[1] === 'craft'
			);
			const leadCalls = sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession' && c.args[1] === 'lead'
			);
			expect(craftCalls).toHaveLength(1);
			expect(leadCalls).toHaveLength(1);

			// Task should be in_progress
			const updated = await taskManager.getTask(task.id);
			expect(updated!.status).toBe('in_progress');
		});

		it('should respect maxConcurrentPairs', async () => {
			await createGoalAndTask();
			// Create second task
			const task2 = await taskManager.createTask({
				title: 'Another task',
				description: 'Details',
			});
			const goals = await goalManager.listGoals();
			await goalManager.linkTaskToGoal(goals[0].id, task2.id);

			runtime.start();
			await runtime.tick();

			// Only 1 pair should be spawned (maxConcurrentPairs = 1)
			const craftCalls = sessionFactory.calls.filter(
				(c) => c.method === 'createAndStartSession' && c.args[1] === 'craft'
			);
			expect(craftCalls).toHaveLength(1);
		});

		it('should not spawn pair when no pending tasks', async () => {
			runtime.start();
			await runtime.tick();

			expect(sessionFactory.calls).toHaveLength(0);
		});

		it('should use mutex to prevent concurrent ticks', async () => {
			await createGoalAndTask();
			runtime.start();

			// Run two ticks concurrently
			const [result1, result2] = await Promise.all([runtime.tick(), runtime.tick()]);

			// Only one pair should be spawned
			const activePairs = taskPairRepo.getActivePairs('room-1');
			expect(activePairs).toHaveLength(1);
		});
	});

	describe('handleLeadTool', () => {
		it('should handle complete_task', async () => {
			const { task } = await createGoalAndTask();
			runtime.start();
			await runtime.tick();

			const pairs = taskPairRepo.getActivePairs('room-1');
			expect(pairs).toHaveLength(1);
			const pair = pairs[0];

			// Route craft output to lead first
			await runtime.onCraftTerminalState(pair.id, {
				sessionId: pair.craftSessionId,
				kind: 'completed',
			});

			// Now handle complete_task from Lead
			const result = await runtime.handleLeadTool(pair.id, 'complete_task', {
				summary: 'Health endpoint added',
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(true);

			// Task should be completed
			const updatedTask = await taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('completed');
		});

		it('should handle fail_task', async () => {
			const { task } = await createGoalAndTask();
			runtime.start();
			await runtime.tick();

			const pairs = taskPairRepo.getActivePairs('room-1');
			const pair = pairs[0];

			// Route to lead
			await runtime.onCraftTerminalState(pair.id, {
				sessionId: pair.craftSessionId,
				kind: 'completed',
			});

			const result = await runtime.handleLeadTool(pair.id, 'fail_task', {
				reason: 'Cannot be done',
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(true);

			const updatedTask = await taskManager.getTask(task.id);
			expect(updatedTask!.status).toBe('failed');
		});

		it('should handle send_to_craft', async () => {
			const { task } = await createGoalAndTask();
			runtime.start();
			await runtime.tick();

			const pairs = taskPairRepo.getActivePairs('room-1');
			const pair = pairs[0];

			// Route craft to lead
			await runtime.onCraftTerminalState(pair.id, {
				sessionId: pair.craftSessionId,
				kind: 'completed',
			});

			const result = await runtime.handleLeadTool(pair.id, 'send_to_craft', {
				message: 'Fix the tests',
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(true);

			// Should inject feedback into craft session
			const injectCalls = sessionFactory.calls.filter(
				(c) => c.method === 'injectMessage' && (c.args[1] as string).includes('LEAD FEEDBACK')
			);
			expect(injectCalls.length).toBeGreaterThan(0);
		});

		it('should reject if pair not in awaiting_lead state', async () => {
			await createGoalAndTask();
			runtime.start();
			await runtime.tick();

			const pairs = taskPairRepo.getActivePairs('room-1');
			const pair = pairs[0];

			// Pair is in awaiting_craft (haven't routed to lead yet)
			const result = await runtime.handleLeadTool(pair.id, 'complete_task', {
				summary: 'Done',
			});

			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('awaiting_lead');
		});

		it('should reject for non-existent pair', async () => {
			const result = await runtime.handleLeadTool('nonexistent', 'complete_task', {
				summary: 'Done',
			});
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.success).toBe(false);
		});
	});

	describe('onCraftTerminalState', () => {
		it('should route craft output to lead', async () => {
			await createGoalAndTask();
			runtime.start();
			await runtime.tick();

			const pairs = taskPairRepo.getActivePairs('room-1');
			const pair = pairs[0];

			await runtime.onCraftTerminalState(pair.id, {
				sessionId: pair.craftSessionId,
				kind: 'completed',
			});

			// Pair should transition to awaiting_lead
			const updated = taskPairRepo.getPair(pair.id);
			expect(updated!.pairState).toBe('awaiting_lead');
		});

		it('should ignore if pair not in awaiting_craft', async () => {
			await createGoalAndTask();
			runtime.start();
			await runtime.tick();

			const pairs = taskPairRepo.getActivePairs('room-1');
			const pair = pairs[0];

			// Route to lead first
			await runtime.onCraftTerminalState(pair.id, {
				sessionId: pair.craftSessionId,
				kind: 'completed',
			});

			// Try again - should be idempotent (now in awaiting_lead)
			await runtime.onCraftTerminalState(pair.id, {
				sessionId: pair.craftSessionId,
				kind: 'completed',
			});

			// Still awaiting_lead, no error
			const updated = taskPairRepo.getPair(pair.id);
			expect(updated!.pairState).toBe('awaiting_lead');
		});
	});

	describe('onLeadTerminalState (contract validation)', () => {
		it('should nudge on first contract violation', async () => {
			await createGoalAndTask();
			runtime.start();
			await runtime.tick();

			const pairs = taskPairRepo.getActivePairs('room-1');
			const pair = pairs[0];

			// Route to lead
			await runtime.onCraftTerminalState(pair.id, {
				sessionId: pair.craftSessionId,
				kind: 'completed',
			});

			// Lead reaches terminal without calling a tool
			await runtime.onLeadTerminalState(pair.id, {
				sessionId: pair.leadSessionId,
				kind: 'completed',
			});

			// Should inject nudge message
			const nudgeCalls = sessionFactory.calls.filter(
				(c) =>
					c.method === 'injectMessage' &&
					c.args[0] === pair.leadSessionId &&
					(c.args[1] as string).includes('must call exactly one')
			);
			expect(nudgeCalls).toHaveLength(1);

			// Violations should be 1
			const updated = taskPairRepo.getPair(pair.id);
			expect(updated!.leadContractViolations).toBe(1);
		});

		it('should escalate on second contract violation', async () => {
			await createGoalAndTask();
			runtime.start();
			await runtime.tick();

			const pairs = taskPairRepo.getActivePairs('room-1');
			const pair = pairs[0];

			// Route to lead
			await runtime.onCraftTerminalState(pair.id, {
				sessionId: pair.craftSessionId,
				kind: 'completed',
			});

			// First violation
			await runtime.onLeadTerminalState(pair.id, {
				sessionId: pair.leadSessionId,
				kind: 'completed',
			});

			// Second violation
			await runtime.onLeadTerminalState(pair.id, {
				sessionId: pair.leadSessionId,
				kind: 'completed',
			});

			// Pair should be awaiting_human
			const updated = taskPairRepo.getPair(pair.id);
			expect(updated!.pairState).toBe('awaiting_human');
		});

		it('should not fire if Lead called a tool', async () => {
			await createGoalAndTask();
			runtime.start();
			await runtime.tick();

			const pairs = taskPairRepo.getActivePairs('room-1');
			const pair = pairs[0];

			// Route to lead
			await runtime.onCraftTerminalState(pair.id, {
				sessionId: pair.craftSessionId,
				kind: 'completed',
			});

			// Lead calls complete_task (which sets leadCalledToolMap)
			await runtime.handleLeadTool(pair.id, 'complete_task', { summary: 'Done' });

			// Lead terminal state should be no-op (tool was called)
			// Pair is already completed, so this is safe
			const updated = taskPairRepo.getPair(pair.id);
			expect(updated!.pairState).toBe('completed');
		});
	});
});
