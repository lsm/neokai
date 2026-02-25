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

	describe('autonomous flow integration', () => {
		it('should complete the full single-iteration cycle: spawn → craft done → lead completes', async () => {
			const { task } = await createGoalAndTask();
			runtime.start();

			// Step 1: tick spawns the pair
			await runtime.tick();
			const pairs = taskPairRepo.getActivePairs('room-1');
			expect(pairs).toHaveLength(1);
			const pair = pairs[0];

			// Step 2: Craft finishes — runtime routes output to Lead
			await runtime.onCraftTerminalState(pair.id, {
				sessionId: pair.craftSessionId,
				kind: 'completed',
			});
			expect(taskPairRepo.getPair(pair.id)!.pairState).toBe('awaiting_lead');

			// Step 3: Lead reviews and approves
			const result = await runtime.handleLeadTool(pair.id, 'complete_task', {
				summary: 'Endpoint added successfully',
			});
			expect(JSON.parse(result.content[0].text).success).toBe(true);

			// Pair and task are both done
			expect(taskPairRepo.getPair(pair.id)!.pairState).toBe('completed');
			expect((await taskManager.getTask(task.id))!.status).toBe('completed');

			// Tick should not spawn a new pair (no more pending tasks)
			sessionFactory.calls.length = 0;
			await runtime.tick();
			expect(sessionFactory.calls.filter((c) => c.method === 'createAndStartSession')).toHaveLength(
				0
			);
		});

		it('should complete the full two-iteration feedback cycle: craft → lead feedback → craft → lead completes', async () => {
			const { task } = await createGoalAndTask();
			runtime.start();

			// Spawn
			await runtime.tick();
			const pair = taskPairRepo.getActivePairs('room-1')[0];
			expect(pair.feedbackIteration).toBe(0);

			// Iteration 1: Craft done → Lead sends feedback
			await runtime.onCraftTerminalState(pair.id, {
				sessionId: pair.craftSessionId,
				kind: 'completed',
			});
			expect(taskPairRepo.getPair(pair.id)!.pairState).toBe('awaiting_lead');

			await runtime.handleLeadTool(pair.id, 'send_to_craft', {
				message: 'Add error handling to the endpoint',
			});

			// Pair is back to awaiting_craft with iteration bumped
			const afterFeedback = taskPairRepo.getPair(pair.id)!;
			expect(afterFeedback.pairState).toBe('awaiting_craft');
			expect(afterFeedback.feedbackIteration).toBe(1);

			// Feedback message was injected into Craft
			const feedbackInjects = sessionFactory.calls.filter(
				(c) =>
					c.method === 'injectMessage' &&
					c.args[0] === pair.craftSessionId &&
					(c.args[1] as string).includes('LEAD FEEDBACK')
			);
			expect(feedbackInjects).toHaveLength(1);

			// Iteration 2: Craft finishes again → Lead completes
			await runtime.onCraftTerminalState(pair.id, {
				sessionId: pair.craftSessionId,
				kind: 'completed',
			});
			expect(taskPairRepo.getPair(pair.id)!.pairState).toBe('awaiting_lead');

			const result = await runtime.handleLeadTool(pair.id, 'complete_task', {
				summary: 'Error handling added',
			});
			expect(JSON.parse(result.content[0].text).success).toBe(true);

			// Final state
			expect(taskPairRepo.getPair(pair.id)!.pairState).toBe('completed');
			const finalTask = await taskManager.getTask(task.id);
			expect(finalTask!.status).toBe('completed');
			expect(finalTask!.result).toBe('Error handling added');
		});

		it('should complete a three-iteration cycle and track feedback iterations accurately', async () => {
			await createGoalAndTask();
			runtime.start();
			await runtime.tick();
			const pair = taskPairRepo.getActivePairs('room-1')[0];

			// Iterations 1 and 2: Lead sends feedback each time
			for (let i = 0; i < 2; i++) {
				await runtime.onCraftTerminalState(pair.id, {
					sessionId: pair.craftSessionId,
					kind: 'completed',
				});
				await runtime.handleLeadTool(pair.id, 'send_to_craft', {
					message: `Feedback round ${i + 1}`,
				});
				expect(taskPairRepo.getPair(pair.id)!.feedbackIteration).toBe(i + 1);
			}

			// Iteration 3: Lead completes
			await runtime.onCraftTerminalState(pair.id, {
				sessionId: pair.craftSessionId,
				kind: 'completed',
			});
			await runtime.handleLeadTool(pair.id, 'complete_task', { summary: 'All done' });

			expect(taskPairRepo.getPair(pair.id)!.pairState).toBe('completed');
			expect(taskPairRepo.getPair(pair.id)!.feedbackIteration).toBe(2);
		});

		it('should reset lead contract violations on each new craft→lead round', async () => {
			await createGoalAndTask();
			runtime.start();
			await runtime.tick();
			const pair = taskPairRepo.getActivePairs('room-1')[0];

			// Craft done → Lead violates contract once
			await runtime.onCraftTerminalState(pair.id, {
				sessionId: pair.craftSessionId,
				kind: 'completed',
			});
			await runtime.onLeadTerminalState(pair.id, {
				sessionId: pair.leadSessionId,
				kind: 'completed',
			});
			expect(taskPairRepo.getPair(pair.id)!.leadContractViolations).toBe(1);

			// Lead sends feedback — pair goes back to awaiting_craft, violations stay until next round
			await runtime.handleLeadTool(pair.id, 'send_to_craft', { message: 'Redo this' });
			expect(taskPairRepo.getPair(pair.id)!.pairState).toBe('awaiting_craft');

			// Iteration 2: Craft done → routeCraftToLead resets violations to 0
			await runtime.onCraftTerminalState(pair.id, {
				sessionId: pair.craftSessionId,
				kind: 'completed',
			});
			expect(taskPairRepo.getPair(pair.id)!.leadContractViolations).toBe(0);
			expect(taskPairRepo.getPair(pair.id)!.pairState).toBe('awaiting_lead');

			// Lead finishes cleanly
			await runtime.handleLeadTool(pair.id, 'complete_task', { summary: 'Done' });
			expect(taskPairRepo.getPair(pair.id)!.pairState).toBe('completed');
		});

		it('should spawn the next pending task after first pair completes', async () => {
			// Create two tasks under the same goal
			const goal = await goalManager.createGoal({ title: 'Sprint 1', description: '' });
			const task1 = await taskManager.createTask({ title: 'Task 1', description: 'First' });
			const task2 = await taskManager.createTask({ title: 'Task 2', description: 'Second' });
			await goalManager.linkTaskToGoal(goal.id, task1.id);
			await goalManager.linkTaskToGoal(goal.id, task2.id);

			runtime.start();

			// Tick 1: picks up task1 (maxConcurrentPairs = 1)
			await runtime.tick();
			const pair1 = taskPairRepo.getActivePairs('room-1')[0];
			expect(pair1).toBeDefined();

			// Complete pair1 directly via pairManager (avoids scheduleTick microtask timing)
			await runtime.pairManager.completePair(pair1.id, 'Task 1 done');
			expect((await taskManager.getTask(task1.id))!.status).toBe('completed');
			expect(taskPairRepo.getActivePairs('room-1')).toHaveLength(0);

			// Tick 2: picks up task2 now that slot is free
			await runtime.tick();
			expect(taskPairRepo.getActivePairs('room-1')).toHaveLength(1);
			expect(taskPairRepo.getActivePairs('room-1')[0].id).not.toBe(pair1.id);
			expect((await taskManager.getTask(task2.id))!.status).toBe('in_progress');
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
