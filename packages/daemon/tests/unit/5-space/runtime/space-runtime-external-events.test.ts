import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { SpaceWorkflow } from '@neokai/shared';
import { ExternalEventService } from '../../../../src/lib/external-events/external-event-service';
import { ExternalEventStore } from '../../../../src/lib/external-events/external-event-store';
import type { ExternalEvent } from '../../../../src/lib/external-events/types';
import { createInternalCommandBus } from '../../../../src/lib/internal-command-bus';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

const SPACE_ID = 'space-runtime-events';
const AGENT_ID = 'agent-runtime-events';

function makeDb(): Database {
	const db = new Database(':memory:');
	createSpaceTables(db);
	const now = Date.now();
	db.prepare(
		`INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(SPACE_ID, SPACE_ID, '/tmp/runtime-events', 'Runtime Events', now, now);
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, description, tools, system_prompt, created_at, updated_at)
		 VALUES (?, ?, ?, '', '[]', '', ?, ?)`
	).run(AGENT_ID, SPACE_ID, 'Coder', now, now);
	return db;
}

function makeEvent(overrides: Partial<ExternalEvent> = {}): ExternalEvent {
	return {
		id: `evt-${Math.random().toString(36).slice(2)}`,
		spaceId: SPACE_ID,
		source: 'github',
		topic: 'github/lsm/neokai/pull_request.review_submitted',
		occurredAt: 1_700_000_000_000,
		ingestedAt: 1_700_000_001_000,
		dedupeKey: `dedupe-${Math.random().toString(36).slice(2)}`,
		summary: 'PR review submitted',
		payload: { action: 'review_submitted', prNumber: 42 },
		...overrides,
	};
}

class MockTaskAgentManager {
	alive = new Set<string>();
	spawned: string[] = [];

	isSessionAlive(sessionId: string): boolean {
		return this.alive.has(sessionId);
	}

	async rehydrate(): Promise<void> {}

	isExecutionSpawning(_executionId: string): boolean {
		return false;
	}

	async tryResumeNodeAgentSession(): Promise<void> {}

	async flushPendingMessagesForTarget(): Promise<void> {}

	async spawnWorkflowNodeAgentForExecution(
		_task: unknown,
		_space: unknown,
		_workflow: unknown,
		_run: unknown,
		execution: { id: string },
		_options?: unknown
	): Promise<string> {
		const sessionId = `session-${execution.id}`;
		this.spawned.push(sessionId);
		this.alive.add(sessionId);
		return sessionId;
	}
}

describe('SpaceRuntime external event subscriptions', () => {
	let db: Database;
	let workflowRunRepo: SpaceWorkflowRunRepository;
	let taskRepo: SpaceTaskRepository;
	let nodeExecutionRepo: NodeExecutionRepository;
	let workflowManager: SpaceWorkflowManager;
	let runtime: SpaceRuntime;
	let eventStore: ExternalEventStore;
	let eventService: ExternalEventService;
	let injected: Array<{ sessionId: string; message: string; deliveryMode?: string }>;
	let tam: MockTaskAgentManager;
	let bus: ReturnType<typeof createDaemonInternalEventBus>;

	function createWorkflow(
		topic = 'github/*/*/pull_request.review_*',
		extraTopics: string[] = [],
		nodeId = 'code'
	): SpaceWorkflow {
		return workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: `Workflow ${Math.random()}`,
			description: '',
			nodes: [
				{
					id: nodeId,
					name: 'Code',
					agents: [
						{
							agentId: AGENT_ID,
							name: 'coder',
							eventInterests: [topic, ...extraTopics].map((interestTopic) => ({
								topic: interestTopic,
							})),
						},
					],
				},
			],
			transitions: [],
			startNodeId: nodeId,
			rules: [],
			tags: [],
		});
	}

	beforeEach(() => {
		db = makeDb();
		workflowRunRepo = new SpaceWorkflowRunRepository(db);
		taskRepo = new SpaceTaskRepository(db);
		nodeExecutionRepo = new NodeExecutionRepository(db);
		workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
		bus = createDaemonInternalEventBus();
		const commandBus = createInternalCommandBus();
		eventStore = new ExternalEventStore(db);
		eventService = new ExternalEventService(eventStore, bus);
		injected = [];
		commandBus.register('agent.message.inject', async (command) => {
			injected.push({
				sessionId: command.sessionId,
				message: command.message,
				deliveryMode: command.deliveryMode,
			});
			return { ok: true };
		});
		tam = new MockTaskAgentManager();
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
	});

	test('delivers matching events to a live node-agent session and marks delivery complete', async () => {
		const workflow = createWorkflow();
		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-live',
			startedAt: Date.now(),
		});
		tam.alive.add('session-live');

		const event = makeEvent();
		await eventService.publish(event);

		expect(injected).toHaveLength(1);
		expect(injected[0]!.sessionId).toBe('session-live');
		expect(injected[0]!.deliveryMode).toBe('immediate');
		expect(JSON.parse(injected[0]!.message).eventId).toBe(event.id);
		expect(eventStore.getById(event.id)?.state).toBe('delivered');
		const deliveries = eventStore.listDeliveries(event.id);
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]!.state).toBe('delivered');
		expect(deliveries[0]!.taskId).toBe(tasks[0]!.id);
	});

	test('queues matching events for pending nodes and flushes after session creation', async () => {
		const workflow = createWorkflow();
		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const event = makeEvent();

		await eventService.publish(event);

		expect(injected).toHaveLength(0);
		expect(eventStore.getById(event.id)?.state).toBe('published');
		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('pending');

		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: tasks[0]!.id,
			nodeId: 'code',
			agentName: 'coder',
			sessionId: 'session-flush',
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(injected).toHaveLength(1);
		expect(injected[0]!.sessionId).toBe('session-flush');
		expect(eventStore.getById(event.id)?.state).toBe('delivered');
	});

	test('marks unmatched events ignored', async () => {
		const workflow = createWorkflow('github/*/*/pull_request.review_*');
		await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		await runtime.executeTick();

		const event = makeEvent({ topic: 'github/lsm/neokai/pull_request.comment_created' });
		await eventService.publish(event);

		expect(injected).toHaveLength(0);
		expect(eventStore.getById(event.id)?.state).toBe('ignored');
	});

	test('fails queued deliveries when an execution is unregistered', async () => {
		const workflow = createWorkflow();
		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const event = makeEvent();
		await eventService.publish(event);

		runtime.unregisterExecution(run.id, tasks[0]!.id, 'code', 'coder');

		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('failed');
		expect(delivery.failureReason).toBe('node_execution_cancelled');
		expect(eventStore.getById(event.id)?.state).toBe('failed');
	});

	test('skips invalid event interest topics during registration', async () => {
		const workflow = createWorkflow('github/lsm/neokai/pull_request');
		await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		await runtime.executeTick();

		const event = makeEvent();
		await eventService.publish(event);

		expect(injected).toHaveLength(0);
		expect(eventStore.getById(event.id)?.state).toBe('ignored');
		expect(eventStore.listDeliveries(event.id)).toHaveLength(0);
	});

	test('drops stale queued deliveries when run interests are rebuilt', async () => {
		const workflow = createWorkflow();
		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const event = makeEvent();
		await eventService.publish(event);

		runtime.registerRunInterests(run.id, tasks[0]!.id, [], { clearQueuedDeliveries: true });
		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: tasks[0]!.id,
			nodeId: 'code',
			agentName: 'coder',
			sessionId: 'session-stale',
		});

		expect(injected).toHaveLength(0);
		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('failed');
		expect(delivery.failureReason).toBe('run_interests_rebuilt');
	});

	test('does not ignore unmatched events before runtime rehydrate completes', async () => {
		const event = makeEvent();
		await eventService.publish(event);

		expect(eventStore.getById(event.id)?.state).toBe('published');
		expect(eventStore.listDeliveries(event.id)).toHaveLength(0);
	});

	test('re-subscribes external event listener after runtime restart', async () => {
		const workflow = createWorkflow();
		const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-restart',
			startedAt: Date.now(),
		});
		tam.alive.add('session-restart');

		await runtime.stop();
		runtime.start();
		await runtime.executeTick();

		const event = makeEvent();
		await eventService.publish(event);

		expect(injected).toHaveLength(1);
		expect(injected[0]!.sessionId).toBe('session-restart');
	});

	test('deduplicates pending queue entries for overlapping interests', async () => {
		const workflow = createWorkflow('github/*/*/pull_request.*', [
			'github/*/*/pull_request.review_*',
		]);
		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const event = makeEvent();
		await eventService.publish(event);

		expect(eventStore.listDeliveries(event.id)).toHaveLength(1);
		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: tasks[0]!.id,
			nodeId: 'code',
			agentName: 'coder',
			sessionId: 'session-dedupe',
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(injected).toHaveLength(1);
		expect(injected[0]!.sessionId).toBe('session-dedupe');
	});

	test('fails queued deliveries during terminal run cleanup', async () => {
		const workflow = createWorkflow();
		const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const event = makeEvent();
		await eventService.publish(event);

		workflowRunRepo.updateRun(run.id, { status: 'cancelled' });
		await runtime.executeTick();

		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('failed');
		expect(delivery.failureReason).toBe('run_terminal_cleanup');
		expect(eventStore.getById(event.id)?.state).toBe('failed');
	});

	test('delivers matching events to idle sessions using defer mode', async () => {
		const workflow = createWorkflow();
		const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-idle',
			startedAt: Date.now(),
		});

		const event = makeEvent();
		await eventService.publish(event);

		expect(injected).toHaveLength(1);
		expect(injected[0]!.sessionId).toBe('session-idle');
		expect(injected[0]!.deliveryMode).toBe('defer');
		expect(eventStore.getById(event.id)?.state).toBe('delivered');
	});

	test('enforces pending queue overflow cap and fails oldest delivery', async () => {
		const workflow = createWorkflow();
		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const events = Array.from({ length: 51 }, (_, index) =>
			makeEvent({
				id: `evt-overflow-${index}`,
				dedupeKey: `dedupe-overflow-${index}`,
			})
		);

		for (const event of events) {
			await eventService.publish(event);
		}

		const oldestDelivery = eventStore.listDeliveries(events[0]!.id)[0]!;
		expect(oldestDelivery.state).toBe('failed');
		expect(oldestDelivery.failureReason).toBe('pending_node_queue_overflow');

		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: tasks[0]!.id,
			nodeId: 'code',
			agentName: 'coder',
			sessionId: 'session-overflow',
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(injected).toHaveLength(50);
		expect(injected.some((item) => JSON.parse(item.message).eventId === events[0]!.id)).toBe(false);
	});

	test('marks delivery failed when target execution is not active', async () => {
		const workflow = createWorkflow();
		const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'cancelled',
			agentSessionId: 'session-cancelled',
			completedAt: Date.now(),
		});
		tam.alive.add('session-cancelled');

		const event = makeEvent();
		await eventService.publish(event);

		expect(injected).toHaveLength(0);
		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('failed');
		expect(delivery.failureReason).toBe('node_execution_not_active');
		expect(eventStore.getById(event.id)?.state).toBe('failed');
	});

	test('does not deliver external events to idle executions with retained sessions', async () => {
		const workflow = createWorkflow();
		const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'idle',
			agentSessionId: 'session-idle-stale',
			completedAt: Date.now(),
		});
		tam.alive.add('session-idle-stale');

		const event = makeEvent();
		await eventService.publish(event);

		expect(injected).toHaveLength(0);
		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('failed');
		expect(delivery.failureReason).toBe('node_execution_not_active');
		expect(eventStore.getById(event.id)?.state).toBe('failed');
	});

	test('terminalizes mixed-outcome events after the final delivery succeeds', async () => {
		const event = makeEvent({ topic: 'github/owner/repo/pull_request.review_submitted' });
		eventStore.store(event);
		const failedDeliveryKey = JSON.stringify([
			'github',
			event.dedupeKey,
			'task-failed',
			'node-failed',
			'coder',
			'run-failed',
		]);
		eventStore.registerExpectedDelivery(event.id, failedDeliveryKey, {
			workflowRunId: 'run-failed',
			taskId: 'task-failed',
			nodeId: 'node-failed',
			agentName: 'coder',
		});
		eventStore.markDeliveryFailed(event.id, failedDeliveryKey, {
			terminal: true,
			reason: 'simulated_prior_failure',
		});
		expect(eventStore.getById(event.id)?.state).toBe('published');

		const workflow = createWorkflow(event.topic, [], 'review');
		const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const execution = nodeExecutionRepo.listByNode(run.id, 'review')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-mixed',
			startedAt: Date.now(),
		});
		tam.alive.add('session-mixed');

		await eventService.publish(makeEvent({ id: 'evt-mixed-retry', dedupeKey: event.dedupeKey }));

		const deliveries = eventStore.listDeliveries(event.id);
		expect(deliveries).toHaveLength(2);
		expect(deliveries.some((delivery) => delivery.state === 'delivered')).toBe(true);
		expect(eventStore.getById(event.id)?.state).toBe('failed');
	});

	test('marks unmatched events ignored after stop/start on a rehydrated runtime', async () => {
		const workflow = createWorkflow();
		await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		await runtime.executeTick();
		await runtime.stop();
		runtime.start();

		const event = makeEvent({ topic: 'github/lsm/neokai/pull_request.comment_created' });
		await eventService.publish(event);

		expect(eventStore.getById(event.id)?.state).toBe('ignored');
	});

	test('keeps unmatched events published until restart rehydrate completes', async () => {
		const workflow = createWorkflow();
		const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-rehydrate-race',
			startedAt: Date.now(),
		});
		await runtime.stop();
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus: createInternalCommandBus(),
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.start();
		await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'New run before rehydrate');

		const event = makeEvent({ topic: 'github/lsm/neokai/pull_request.comment_created' });
		await eventService.publish(event);

		expect(eventStore.getById(event.id)?.state).toBe('published');
	});

	test('requeues persisted pending deliveries during runtime rehydrate', async () => {
		const workflow = createWorkflow();
		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const event = makeEvent();
		await eventService.publish(event);
		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('pending');
		await runtime.stop();
		const commandBus = createInternalCommandBus();
		commandBus.register('agent.message.inject', async (command) => {
			injected.push({
				sessionId: command.sessionId,
				message: command.message,
				deliveryMode: command.deliveryMode,
			});
			return { ok: true };
		});
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});

		await runtime.rehydrateExecutors();
		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: tasks[0]!.id,
			nodeId: 'code',
			agentName: 'coder',
			sessionId: 'session-rehydrated-pending',
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(eventStore.getById(event.id)?.state).toBe('delivered');
	});

	test('ignores terminal runs when matching external event deliveries', async () => {
		const workflow = createWorkflow();
		const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		workflowRunRepo.updateRun(run.id, { status: 'cancelled' });
		await runtime.executeTick();

		const event = makeEvent();
		await eventService.publish(event);

		expect(eventStore.getById(event.id)?.state).toBe('ignored');
		expect(eventStore.listDeliveries(event.id)).toHaveLength(0);
	});

	test('preserves queued deliveries while re-registering unchanged interests', async () => {
		const workflow = createWorkflow();
		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const event = makeEvent();
		await eventService.publish(event);

		runtime.registerRunInterests(run.id, tasks[0]!.id, workflow.nodes);
		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: tasks[0]!.id,
			nodeId: 'code',
			agentName: 'coder',
			sessionId: 'session-preserved-reregister',
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(injected).toHaveLength(1);
		expect(eventStore.getById(event.id)?.state).toBe('delivered');
	});

	test('retries transient external event injection failures from the pending queue', async () => {
		const workflow = createWorkflow();
		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'in_progress',
			agentSessionId: 'session-retry',
			startedAt: Date.now(),
		});
		tam.alive.add('session-retry');
		await runtime.stop();
		let failNext = true;
		const commandBus = createInternalCommandBus();
		commandBus.register('agent.message.inject', async (command) => {
			if (failNext) {
				failNext = false;
				return { ok: false, error: 'temporary injection failure' };
			}
			injected.push({
				sessionId: command.sessionId,
				message: command.message,
				deliveryMode: command.deliveryMode,
			});
			return { ok: true };
		});
		runtime = new SpaceRuntime({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			nodeExecutionRepo,
			internalEventBus: bus,
			commandBus,
			externalEventStore: eventStore,
			taskAgentManager: tam as never,
		});
		runtime.registerRunInterests(run.id, tasks[0]!.id, workflow.nodes);

		const event = makeEvent();
		await eventService.publish(event);
		expect(injected).toHaveLength(0);
		expect(eventStore.listDeliveries(event.id)[0]!.state).toBe('pending');
		expect(eventStore.listDeliveries(event.id)[0]!.failureReason).toBe(
			'temporary injection failure'
		);

		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: tasks[0]!.id,
			nodeId: 'code',
			agentName: 'coder',
			sessionId: 'session-retry',
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(injected).toHaveLength(1);
		expect(eventStore.getById(event.id)?.state).toBe('delivered');
	});

	test('queues events for waiting_rebind executions instead of failing them terminally', async () => {
		const workflow = createWorkflow();
		const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		const execution = nodeExecutionRepo.listByNode(run.id, 'code')[0]!;
		nodeExecutionRepo.update(execution.id, {
			status: 'waiting_rebind',
			completedAt: null,
		});

		const event = makeEvent();
		await eventService.publish(event);

		const delivery = eventStore.listDeliveries(event.id)[0]!;
		expect(delivery.state).toBe('pending');
		expect(delivery.failureReason).toBeNull();

		runtime.flushPendingNodeQueue({
			workflowRunId: run.id,
			taskId: tasks[0]!.id,
			nodeId: 'code',
			agentName: 'coder',
			sessionId: 'session-waiting-rebind',
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(injected).toHaveLength(1);
		expect(injected[0]!.sessionId).toBe('session-waiting-rebind');
		expect(eventStore.getById(event.id)?.state).toBe('delivered');
	});
});
