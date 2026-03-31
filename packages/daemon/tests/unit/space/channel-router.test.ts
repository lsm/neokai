/**
 * ChannelRouter Unit Tests
 *
 * Covers:
 * - activateNode(): first activation creates tasks for each agent slot
 * - activateNode(): idempotent — returns existing tasks on repeated calls
 * - activateNode(): concurrent activation (UNIQUE constraint) handled gracefully
 * - activateNode(): cancelled run throws ActivationError
 * - activateNode(): completed run throws ActivationError
 * - activateNode(): missing run throws ActivationError
 * - activateNode(): missing workflow throws ActivationError
 * - activateNode(): missing node throws ActivationError
 * - activateNode(): multi-agent node creates one task per agent slot
 * - deliverMessage(): auto-activates target node when no active tasks
 * - deliverMessage(): does not re-activate when target node is already active
 * - deliverMessage(): sets activatedTasks only on first activation
 * - deliverMessage(): throws when target role not found in workflow
 * - deliverMessage(): fan-out — node name target activates all agents in that node
 * - deliverMessage(): within-node DM — same-node agent-to-agent
 * - deliverMessage(): isFanOut flag set for node-name targets
 * - deliverMessage(): isFanOut false for agent-role targets
 * - deliverMessage(): cyclic channel increments iterationCount
 * - deliverMessage(): cyclic iteration cap throws ActivationError
 * - canDeliver(): open topology allows all deliveries
 * - canDeliver(): cyclic channel — blocked when cycle count >= maxCycles
 * - canDeliver(): cyclic channel — allowed when below cap
 * - canDeliver(): no gate on channel — allowed
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository.ts';
import { GateDataRepository } from '../../../src/storage/repositories/gate-data-repository.ts';
import { ChannelCycleRepository } from '../../../src/storage/repositories/channel-cycle-repository.ts';
import { SpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import {
	ChannelRouter,
	ActivationError,
	ChannelGateBlockedError,
} from '../../../src/lib/space/runtime/channel-router.ts';
import type { Gate, SpaceWorkflow, WorkflowChannel } from '@neokai/shared';
import { computeGateDefaults } from '@neokai/shared';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-channel-router',
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return { db, dir };
}

function seedSpace(db: BunDatabase, spaceId: string): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, '/tmp/ws', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
	).run(spaceId, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgent(
	db: BunDatabase,
	agentId: string,
	spaceId: string,
	role: 'coder' | 'planner' | 'general' | string
): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, role, description, model, tools, system_prompt,
     config, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', null, '[]', '', null, ?, ?)`
	).run(agentId, spaceId, `Agent ${agentId}`, role, Date.now(), Date.now());
}

// ---------------------------------------------------------------------------
// Workflow builder helpers
// ---------------------------------------------------------------------------

function buildWorkflow(
	spaceId: string,
	workflowManager: SpaceWorkflowManager,
	nodes: Array<{
		id: string;
		name: string;
		agentId?: string;
		agents?: Array<{ agentId: string; name: string }>;
	}>,
	channels?: WorkflowChannel[]
): SpaceWorkflow {
	return workflowManager.createWorkflow({
		spaceId,
		name: `Test Workflow ${Date.now()}`,
		description: '',
		nodes: nodes.map((n) => ({
			id: n.id,
			name: n.name,
			agentId: n.agentId,
			agents: n.agents,
		})),
		transitions: [],
		startNodeId: nodes[0].id,
		rules: [],
		tags: [],
		channels: channels ?? [],
	});
}

// ---------------------------------------------------------------------------
// Workflow builder helper with gates support
// ---------------------------------------------------------------------------

function buildWorkflowWithGates(
	spaceId: string,
	workflowManager: SpaceWorkflowManager,
	nodes: Array<{
		id: string;
		name: string;
		agentId?: string;
		agents?: Array<{ agentId: string; name: string }>;
	}>,
	channels: WorkflowChannel[],
	gates: Gate[]
): SpaceWorkflow {
	return workflowManager.createWorkflow({
		spaceId,
		name: `Test Workflow With Gates ${Date.now()}`,
		description: '',
		nodes: nodes.map((n) => ({
			id: n.id,
			name: n.name,
			agentId: n.agentId,
			agents: n.agents,
		})),
		transitions: [],
		startNodeId: nodes[0].id,
		rules: [],
		tags: [],
		channels,
		gates,
	});
}

describe('ChannelRouter', () => {
	let db: BunDatabase;
	let dir: string;

	let taskRepo: SpaceTaskRepository;
	let workflowRunRepo: SpaceWorkflowRunRepository;
	let workflowManager: SpaceWorkflowManager;
	let agentManager: SpaceAgentManager;
	let gateDataRepo: GateDataRepository;
	let channelCycleRepo: ChannelCycleRepository;
	let router: ChannelRouter;

	const SPACE_ID = 'space-cr-1';
	const AGENT_CODER = 'agent-coder';
	const AGENT_PLANNER = 'agent-planner';
	const AGENT_CUSTOM = 'agent-custom';

	const NODE_A = 'node-a';
	const NODE_B = 'node-b';

	beforeEach(() => {
		({ db, dir } = makeDb());

		seedSpace(db, SPACE_ID);
		seedAgent(db, AGENT_CODER, SPACE_ID, 'coder');
		seedAgent(db, AGENT_PLANNER, SPACE_ID, 'planner');
		seedAgent(db, AGENT_CUSTOM, SPACE_ID, 'my-custom-role');

		taskRepo = new SpaceTaskRepository(db);
		workflowRunRepo = new SpaceWorkflowRunRepository(db);
		gateDataRepo = new GateDataRepository(db);
		channelCycleRepo = new ChannelCycleRepository(db);

		const agentRepo = new SpaceAgentRepository(db);
		agentManager = new SpaceAgentManager(agentRepo);

		const workflowRepo = new SpaceWorkflowRepository(db);
		workflowManager = new SpaceWorkflowManager(workflowRepo);

		router = new ChannelRouter({
			taskRepo,
			workflowRunRepo,
			workflowManager,
			agentManager,
			gateDataRepo,
			channelCycleRepo,
			db,
		});
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	// -------------------------------------------------------------------------
	// activateNode — first activation
	// -------------------------------------------------------------------------

	describe('activateNode', () => {
		test('creates one pending task for a single-agent node', async () => {
			const workflow = buildWorkflow(SPACE_ID, workflowManager, [
				{ id: NODE_A, name: 'Node A', agentId: AGENT_CODER },
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Test Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			const tasks = await router.activateNode(run.id, NODE_A);

			expect(tasks).toHaveLength(1);
			expect(tasks[0].status).toBe('pending');
			expect(tasks[0].workflowRunId).toBe(run.id);
			expect(tasks[0].workflowNodeId).toBe(NODE_A);
			expect(tasks[0].agentName).toBe(AGENT_CODER); // resolveNodeAgents uses agentId as name for shorthand
			expect(tasks[0].taskType).toBe('coding');
			expect(tasks[0].customAgentId).toBeFalsy();
		});

		test('creates one task per agent for a multi-agent node', async () => {
			const workflow = buildWorkflow(SPACE_ID, workflowManager, [
				{
					id: NODE_A,
					name: 'Multi Agent Node',
					agents: [
						{ agentId: AGENT_CODER, name: 'coder-slot' },
						{ agentId: AGENT_PLANNER, name: 'planner-slot' },
					],
				},
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Multi Agent Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			const tasks = await router.activateNode(run.id, NODE_A);

			expect(tasks).toHaveLength(2);
			const agentNames = tasks.map((t) => t.agentName).sort();
			expect(agentNames).toEqual(['coder-slot', 'planner-slot']);

			// task types are resolved per-agent
			const coderTask = tasks.find((t) => t.agentName === 'coder-slot')!;
			const plannerTask = tasks.find((t) => t.agentName === 'planner-slot')!;
			expect(coderTask.taskType).toBe('coding');
			expect(plannerTask.taskType).toBe('planning');
		});

		test('sets correct taskType for custom-role agent', async () => {
			const workflow = buildWorkflow(SPACE_ID, workflowManager, [
				{
					id: NODE_A,
					name: 'Custom Node',
					agents: [{ agentId: AGENT_CUSTOM, name: 'custom-slot' }],
				},
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Custom Role Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			const tasks = await router.activateNode(run.id, NODE_A);

			expect(tasks).toHaveLength(1);
			expect(tasks[0].taskType).toBe('coding');
			expect(tasks[0].customAgentId).toBe(AGENT_CUSTOM);
		});

		// -----------------------------------------------------------------------
		// Idempotent activation
		// -----------------------------------------------------------------------

		test('returns existing tasks on repeated activation (idempotent)', async () => {
			const workflow = buildWorkflow(SPACE_ID, workflowManager, [
				{ id: NODE_A, name: 'Node A', agentId: AGENT_CODER },
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Idempotent Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			const firstResult = await router.activateNode(run.id, NODE_A);
			const secondResult = await router.activateNode(run.id, NODE_A);

			// Second call must return the same tasks (same IDs, no duplicates)
			expect(secondResult).toHaveLength(1);
			expect(secondResult[0].id).toBe(firstResult[0].id);

			// Only one task exists in the DB
			const allTasks = taskRepo
				.listByWorkflowRun(run.id)
				.filter((t) => t.workflowNodeId === NODE_A);
			expect(allTasks).toHaveLength(1);
		});

		test('re-activates if the only existing task is cancelled', async () => {
			const workflow = buildWorkflow(SPACE_ID, workflowManager, [
				{ id: NODE_A, name: 'Node A', agentId: AGENT_CODER },
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Cancelled Task Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// First activation
			const firstTasks = await router.activateNode(run.id, NODE_A);
			expect(firstTasks).toHaveLength(1);

			// Cancel the task
			taskRepo.updateTask(firstTasks[0].id, { status: 'cancelled' });

			// Second activation should create fresh tasks (cancelled tasks are excluded)
			const secondTasks = await router.activateNode(run.id, NODE_A);
			expect(secondTasks).toHaveLength(1);
			expect(secondTasks[0].id).not.toBe(firstTasks[0].id);
			expect(secondTasks[0].status).toBe('pending');
		});

		// -----------------------------------------------------------------------
		// Concurrent activation — DB uniqueness
		// -----------------------------------------------------------------------

		test('handles concurrent activation via UNIQUE constraint gracefully', async () => {
			const workflow = buildWorkflow(SPACE_ID, workflowManager, [
				{
					id: NODE_A,
					name: 'Node A',
					agents: [{ agentId: AGENT_CODER, name: 'coder-slot' }],
				},
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Concurrent Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// Simulate a concurrent activation by directly inserting a task with the
			// same (workflow_run_id, workflow_node_id, agent_name) before the router
			// creates its task — triggering the UNIQUE constraint path.
			const firstTask = taskRepo.createTask({
				spaceId: SPACE_ID,
				title: NODE_A,
				description: '',
				workflowRunId: run.id,
				workflowNodeId: NODE_A,
				agentName: 'coder-slot',
				status: 'pending',
			});

			// The router's activateNode() should detect the UNIQUE constraint violation
			// and return the already-inserted task instead of throwing.
			const tasks = await router.activateNode(run.id, NODE_A);

			expect(tasks).toHaveLength(1);
			expect(tasks[0].id).toBe(firstTask.id);
		});

		// -----------------------------------------------------------------------
		// Error cases
		// -----------------------------------------------------------------------

		test('throws ActivationError when run is cancelled', async () => {
			const workflow = buildWorkflow(SPACE_ID, workflowManager, [
				{ id: NODE_A, name: 'Node A', agentId: AGENT_CODER },
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Cancelled Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'cancelled');

			await expect(router.activateNode(run.id, NODE_A)).rejects.toBeInstanceOf(ActivationError);
			await expect(router.activateNode(run.id, NODE_A)).rejects.toThrow(/cancelled/);
		});

		test('throws ActivationError when run is completed', async () => {
			const workflow = buildWorkflow(SPACE_ID, workflowManager, [
				{ id: NODE_A, name: 'Node A', agentId: AGENT_CODER },
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Completed Run',
			});
			workflowRunRepo.updateStatusUnchecked(run.id, 'completed');

			await expect(router.activateNode(run.id, NODE_A)).rejects.toBeInstanceOf(ActivationError);
			await expect(router.activateNode(run.id, NODE_A)).rejects.toThrow(/completed/);
		});

		test('throws ActivationError when run does not exist', async () => {
			await expect(router.activateNode('nonexistent-run', NODE_A)).rejects.toBeInstanceOf(
				ActivationError
			);
			await expect(router.activateNode('nonexistent-run', NODE_A)).rejects.toThrow(/Run not found/);
		});

		test('throws ActivationError when node does not exist in workflow', async () => {
			const workflow = buildWorkflow(SPACE_ID, workflowManager, [
				{ id: NODE_A, name: 'Node A', agentId: AGENT_CODER },
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Bad Node Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			await expect(router.activateNode(run.id, 'nonexistent-node')).rejects.toBeInstanceOf(
				ActivationError
			);
			await expect(router.activateNode(run.id, 'nonexistent-node')).rejects.toThrow(
				/not found in workflow/
			);
		});
	});

	// -------------------------------------------------------------------------
	// deliverMessage — basic routing
	// -------------------------------------------------------------------------

	describe('deliverMessage', () => {
		test('auto-activates target node when no active tasks exist', async () => {
			const workflow = buildWorkflow(SPACE_ID, workflowManager, [
				{
					id: NODE_A,
					name: 'Sender Node',
					agents: [{ agentId: AGENT_CODER, name: 'coder' }],
				},
				{
					id: NODE_B,
					name: 'Receiver Node',
					agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
				},
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Deliver Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			const result = await router.deliverMessage(run.id, 'coder', 'planner', 'hello planner');

			expect(result.fromRole).toBe('coder');
			expect(result.toRole).toBe('planner');
			expect(result.message).toBe('hello planner');
			expect(result.targetNodeId).toBe(NODE_B);
			expect(result.isFanOut).toBe(false);
			// activatedTasks should be set since NODE_B had no tasks
			expect(result.activatedTasks).toBeDefined();
			expect(result.activatedTasks).toHaveLength(1);
			expect(result.activatedTasks![0].workflowNodeId).toBe(NODE_B);
			expect(result.activatedTasks![0].agentName).toBe('planner');
		});

		test('does not re-activate when target node already has active tasks', async () => {
			const workflow = buildWorkflow(SPACE_ID, workflowManager, [
				{
					id: NODE_A,
					name: 'Sender Node',
					agents: [{ agentId: AGENT_CODER, name: 'coder' }],
				},
				{
					id: NODE_B,
					name: 'Receiver Node',
					agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
				},
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Already Active Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// Pre-create a task for NODE_B so it is already active
			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Planner Task',
				description: '',
				workflowRunId: run.id,
				workflowNodeId: NODE_B,
				agentName: 'planner',
				status: 'in_progress',
			});

			const beforeCount = taskRepo
				.listByWorkflowRun(run.id)
				.filter((t) => t.workflowNodeId === NODE_B).length;

			const result = await router.deliverMessage(run.id, 'coder', 'planner', 'hi again');

			// activatedTasks should be undefined (node was already active)
			expect(result.activatedTasks).toBeUndefined();

			// No new tasks should have been created
			const afterCount = taskRepo
				.listByWorkflowRun(run.id)
				.filter((t) => t.workflowNodeId === NODE_B).length;
			expect(afterCount).toBe(beforeCount);
		});

		test('throws ActivationError when target role is not found in workflow', async () => {
			const workflow = buildWorkflow(SPACE_ID, workflowManager, [
				{
					id: NODE_A,
					name: 'Sender Node',
					agents: [{ agentId: AGENT_CODER, name: 'coder' }],
				},
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Missing Role Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			await expect(
				router.deliverMessage(run.id, 'coder', 'nonexistent-role', 'hello')
			).rejects.toBeInstanceOf(ActivationError);
			await expect(
				router.deliverMessage(run.id, 'coder', 'nonexistent-role', 'hello')
			).rejects.toThrow(/No node found/);
		});

		test('returns correct targetNodeId in result', async () => {
			const workflow = buildWorkflow(SPACE_ID, workflowManager, [
				{
					id: NODE_A,
					name: 'Node A',
					agents: [{ agentId: AGENT_CODER, name: 'sender' }],
				},
				{
					id: NODE_B,
					name: 'Node B',
					agents: [{ agentId: AGENT_PLANNER, name: 'receiver' }],
				},
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Target Node Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			const result = await router.deliverMessage(run.id, 'sender', 'receiver', 'test');
			expect(result.targetNodeId).toBe(NODE_B);
		});

		// -----------------------------------------------------------------------
		// Fan-out — node name targeting
		// -----------------------------------------------------------------------

		test('fan-out: node name activates all agents in the target node', async () => {
			const workflow = buildWorkflow(SPACE_ID, workflowManager, [
				{
					id: NODE_A,
					name: 'Sender Node',
					agents: [{ agentId: AGENT_CODER, name: 'coder' }],
				},
				{
					id: NODE_B,
					name: 'Receiver Node',
					agents: [
						{ agentId: AGENT_CODER, name: 'coder-b' },
						{ agentId: AGENT_PLANNER, name: 'planner-b' },
					],
				},
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Fan-out Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// Use node name 'Receiver Node' as target (fan-out)
			const result = await router.deliverMessage(run.id, 'coder', 'Receiver Node', 'broadcast');

			expect(result.targetNodeId).toBe(NODE_B);
			expect(result.isFanOut).toBe(true);
			// Both agents in NODE_B should be activated
			expect(result.activatedTasks).toBeDefined();
			expect(result.activatedTasks).toHaveLength(2);
			const agentNames = result.activatedTasks!.map((t) => t.agentName).sort();
			expect(agentNames).toEqual(['coder-b', 'planner-b']);
		});

		test('fan-out: isFanOut is false when targeting by agent role', async () => {
			const workflow = buildWorkflow(SPACE_ID, workflowManager, [
				{
					id: NODE_A,
					name: 'Sender Node',
					agents: [{ agentId: AGENT_CODER, name: 'coder' }],
				},
				{
					id: NODE_B,
					name: 'Receiver Node',
					agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
				},
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'DM Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			const result = await router.deliverMessage(run.id, 'coder', 'planner', 'dm message');

			expect(result.isFanOut).toBe(false);
		});

		test('within-node DM: agent can message another agent in the same node', async () => {
			const workflow = buildWorkflow(SPACE_ID, workflowManager, [
				{
					id: NODE_A,
					name: 'Collaboration Node',
					agents: [
						{ agentId: AGENT_CODER, name: 'coder' },
						{ agentId: AGENT_PLANNER, name: 'planner' },
					],
				},
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Within-node Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// Both agents are in NODE_A; 'planner' is in the same node as 'coder'
			const result = await router.deliverMessage(run.id, 'coder', 'planner', 'hey planner');

			expect(result.targetNodeId).toBe(NODE_A);
			expect(result.isFanOut).toBe(false);
		});

		// -----------------------------------------------------------------------
		// Cyclic channels — iteration tracking
		// -----------------------------------------------------------------------

		test('cyclic channel: increments cycle count on successful delivery', async () => {
			// Two channels form a cycle: forward coder→planner, backward planner→coder
			const channels: WorkflowChannel[] = [
				{ from: 'coder', to: 'planner', direction: 'one-way' },
				{ from: 'planner', to: 'coder', direction: 'one-way', maxCycles: 5 },
			];
			const workflow = buildWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Sender', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{ id: NODE_B, name: 'Receiver', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
				],
				channels
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Cyclic Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// First delivery on the backward (cyclic) channel: planner → coder
			await router.deliverMessage(run.id, 'planner', 'coder', 'message 1');
			// Channel index 1 is the backward channel
			expect(channelCycleRepo.get(run.id, 1)!.count).toBe(1);

			// Cancel existing tasks to allow re-activation
			for (const t of taskRepo.listByWorkflowRun(run.id)) {
				taskRepo.updateTask(t.id, { status: 'cancelled' });
			}

			// Second delivery
			await router.deliverMessage(run.id, 'planner', 'coder', 'message 2');
			expect(channelCycleRepo.get(run.id, 1)!.count).toBe(2);
		});

		test('cyclic channel: throws ActivationError when cycle cap is reached', async () => {
			const channels: WorkflowChannel[] = [
				{ from: 'coder', to: 'planner', direction: 'one-way' },
				{ from: 'planner', to: 'coder', direction: 'one-way', maxCycles: 2 },
			];
			const workflow = buildWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Sender', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{ id: NODE_B, name: 'Receiver', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
				],
				channels
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Cycle Cap Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// Pre-fill cycle count to the cap via the repo
			channelCycleRepo.incrementCycleCount(run.id, 1, 2);
			channelCycleRepo.incrementCycleCount(run.id, 1, 2);

			await expect(
				router.deliverMessage(run.id, 'planner', 'coder', 'over the limit')
			).rejects.toBeInstanceOf(ActivationError);
			await expect(
				router.deliverMessage(run.id, 'planner', 'coder', 'over the limit')
			).rejects.toThrow(/maximum cycle count/);
		});

		test('non-cyclic channel: cycle count stays unchanged', async () => {
			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: 'planner',
					direction: 'one-way',
					// Forward channel — not cyclic
				},
			];
			const workflow = buildWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Sender', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{ id: NODE_B, name: 'Receiver', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
				],
				channels
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Non-cyclic Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			await router.deliverMessage(run.id, 'coder', 'planner', 'non-cyclic message');

			// No cycle records should exist for this forward-only channel
			expect(channelCycleRepo.get(run.id, 0)).toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// canDeliver
	// -------------------------------------------------------------------------

	describe('canDeliver', () => {
		test('open topology: always allowed when no channels declared', async () => {
			// No channels on workflow
			const workflow = buildWorkflow(SPACE_ID, workflowManager, [
				{ id: NODE_A, name: 'Node A', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
				{ id: NODE_B, name: 'Node B', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
			]);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Open Topology Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			const result = await router.canDeliver(run.id, 'coder', 'planner');
			expect(result.allowed).toBe(true);
		});

		test("open topology: allowed even when channels exist but don't match the pair", async () => {
			const channels: WorkflowChannel[] = [{ from: 'coder', to: 'reviewer', direction: 'one-way' }];
			const workflow = buildWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Node A', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{ id: NODE_B, name: 'Node B', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
				],
				channels
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'No Match Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// coder→planner not declared; open topology for this pair
			const result = await router.canDeliver(run.id, 'coder', 'planner');
			expect(result.allowed).toBe(true);
		});

		test('channel with no gate: always allowed', async () => {
			const channels: WorkflowChannel[] = [{ from: 'coder', to: 'planner', direction: 'one-way' }];
			const workflow = buildWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Node A', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{ id: NODE_B, name: 'Node B', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
				],
				channels
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'No Gate Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			const result = await router.canDeliver(run.id, 'coder', 'planner');
			expect(result.allowed).toBe(true);
		});

		test('cyclic channel: blocked when cycle count >= maxCycles', async () => {
			// Backward channel planner→coder forms a cycle with forward coder→planner
			const channels: WorkflowChannel[] = [
				{ from: 'coder', to: 'planner', direction: 'one-way' },
				{ from: 'planner', to: 'coder', direction: 'one-way', maxCycles: 3 },
			];
			const workflow = buildWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Node A', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{ id: NODE_B, name: 'Node B', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
				],
				channels
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Cycle Cap Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');
			// Pre-fill cycle count to the cap (channel index 1 is the backward channel)
			channelCycleRepo.incrementCycleCount(run.id, 1, 3);
			channelCycleRepo.incrementCycleCount(run.id, 1, 3);
			channelCycleRepo.incrementCycleCount(run.id, 1, 3);

			const result = await router.canDeliver(run.id, 'planner', 'coder');
			expect(result.allowed).toBe(false);
			expect(result.reason).toMatch(/maximum cycle count/);
		});

		test('cyclic channel: allowed when below the cap', async () => {
			const channels: WorkflowChannel[] = [
				{ from: 'coder', to: 'planner', direction: 'one-way' },
				{ from: 'planner', to: 'coder', direction: 'one-way', maxCycles: 5 },
			];
			const workflow = buildWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Node A', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{ id: NODE_B, name: 'Node B', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
				],
				channels
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Below Cap Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');
			channelCycleRepo.incrementCycleCount(run.id, 1, 5);
			channelCycleRepo.incrementCycleCount(run.id, 1, 5);

			const result = await router.canDeliver(run.id, 'planner', 'coder');
			expect(result.allowed).toBe(true);
		});

		test('non-cyclic channel: cycle count does not block delivery', async () => {
			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: 'planner',
					direction: 'one-way',
					// Forward channel — not cyclic
				},
			];
			const workflow = buildWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Node A', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{ id: NODE_B, name: 'Node B', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
				],
				channels
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Non-cyclic Cap Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			const result = await router.canDeliver(run.id, 'coder', 'planner');
			// Non-cyclic (forward) channel is not affected by cycle count
			expect(result.allowed).toBe(true);
		});

		test('canDeliver: throws ActivationError when run not found', async () => {
			await expect(
				router.canDeliver('nonexistent-run', 'coder', 'planner')
			).rejects.toBeInstanceOf(ActivationError);
		});

		test('canDeliver: throws ActivationError when workflow not found', async () => {
			// Create a run, then point it to a nonexistent workflow by bypassing FK checks.
			const workflow = buildWorkflow(SPACE_ID, workflowManager, [
				{ id: NODE_A, name: 'Node A', agentId: AGENT_CODER },
			]);
			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Orphaned Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// Disable FK enforcement, remap workflow_id to a nonexistent ID, then re-enable.
			db.exec('PRAGMA foreign_keys = OFF');
			db.prepare('UPDATE space_workflow_runs SET workflow_id = ? WHERE id = ?').run(
				'nonexistent-workflow-id',
				run.id
			);
			db.exec('PRAGMA foreign_keys = ON');

			await expect(
				router.canDeliver(run.id, 'coder', 'planner')
			).rejects.toBeInstanceOf(ActivationError);
			await expect(
				router.canDeliver(run.id, 'coder', 'planner')
			).rejects.toThrow(/Workflow not found/);
		});

	});

	// -------------------------------------------------------------------------
	// Separated Channel+Gate architecture (M1.4)
	// -------------------------------------------------------------------------

	describe('separated Channel+Gate architecture', () => {
		// -----------------------------------------------------------------------
		// Gateless channels — always open
		// -----------------------------------------------------------------------

		test('gateless channel: deliverMessage always delivers (no gateId, no gate)', async () => {
			const channels: WorkflowChannel[] = [{ from: 'coder', to: 'planner', direction: 'one-way' }];
			const workflow = buildWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Sender', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{ id: NODE_B, name: 'Receiver', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
				],
				channels
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Gateless Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			const result = await router.deliverMessage(run.id, 'coder', 'planner', 'hello');
			expect(result.fromRole).toBe('coder');
			expect(result.toRole).toBe('planner');
			expect(result.activatedTasks).toBeDefined();
			expect(result.activatedTasks!.length).toBeGreaterThan(0);
		});

		test('gateless channel: canDeliver always allowed', async () => {
			const channels: WorkflowChannel[] = [{ from: 'coder', to: 'planner', direction: 'one-way' }];
			const workflow = buildWorkflow(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Sender', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{ id: NODE_B, name: 'Receiver', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
				],
				channels
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Gateless canDeliver Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			const result = await router.canDeliver(run.id, 'coder', 'planner');
			expect(result.allowed).toBe(true);
		});

		// -----------------------------------------------------------------------
		// Gated channels — check condition
		// -----------------------------------------------------------------------

		test('gated channel (check): blocks delivery when condition not satisfied', async () => {
			const gate: Gate = {
				id: 'plan-gate',
				fields: [{ name: 'plan', type: 'string', writers: ['planner'], check: { op: 'exists' } }],
				resetOnCycle: false,
			};
			const channels: WorkflowChannel[] = [
				{ from: 'planner', to: 'coder', direction: 'one-way', gateId: 'plan-gate' },
			];
			const workflow = buildWorkflowWithGates(
				SPACE_ID,
				workflowManager,
				[
					{
						id: NODE_A,
						name: 'Planner Node',
						agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
					},
					{ id: NODE_B, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
				],
				channels,
				[gate]
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Check Gate Blocked Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// No gate data written → field does not exist → gate is closed
			await expect(router.deliverMessage(run.id, 'planner', 'coder', 'msg')).rejects.toBeInstanceOf(
				ChannelGateBlockedError
			);
		});

		test('gated channel (check): allows delivery when condition satisfied', async () => {
			const gate: Gate = {
				id: 'plan-gate',
				fields: [{ name: 'plan', type: 'string', writers: ['planner'], check: { op: 'exists' } }],
				resetOnCycle: false,
			};
			const channels: WorkflowChannel[] = [
				{ from: 'planner', to: 'coder', direction: 'one-way', gateId: 'plan-gate' },
			];
			const workflow = buildWorkflowWithGates(
				SPACE_ID,
				workflowManager,
				[
					{
						id: NODE_A,
						name: 'Planner Node',
						agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
					},
					{ id: NODE_B, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
				],
				channels,
				[gate]
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Check Gate Allowed Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// Write gate data to satisfy the condition
			gateDataRepo.set(run.id, 'plan-gate', { plan: 'step 1: design the system' });

			const result = await router.deliverMessage(run.id, 'planner', 'coder', 'here is the plan');
			expect(result.fromRole).toBe('planner');
			expect(result.toRole).toBe('coder');
		});

		test('gated channel (check): canDeliver returns true when condition satisfied', async () => {
			const gate: Gate = {
				id: 'allow-gate',
				fields: [{ name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } }],
				resetOnCycle: false,
			};
			const channels: WorkflowChannel[] = [
				{ from: 'coder', to: 'planner', direction: 'one-way', gateId: 'allow-gate' },
			];
			const workflow = buildWorkflowWithGates(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{
						id: NODE_B,
						name: 'Planner Node',
						agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
					},
				],
				channels,
				[gate]
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'canDeliver Allowed Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// Write gate data to satisfy the condition
			gateDataRepo.set(run.id, 'allow-gate', { approved: true });

			const result = await router.canDeliver(run.id, 'coder', 'planner');
			expect(result.allowed).toBe(true);
		});

		test('gated channel (check): canDeliver returns false when blocked', async () => {
			const gate: Gate = {
				id: 'approval-gate',
				fields: [{ name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } }],
				resetOnCycle: false,
			};
			const channels: WorkflowChannel[] = [
				{ from: 'coder', to: 'planner', direction: 'one-way', gateId: 'approval-gate' },
			];
			const workflow = buildWorkflowWithGates(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{
						id: NODE_B,
						name: 'Planner Node',
						agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
					},
				],
				channels,
				[gate]
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'canDeliver Blocked Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// Gate data has approved: false
			gateDataRepo.set(run.id, 'approval-gate', { approved: false });

			const result = await router.canDeliver(run.id, 'coder', 'planner');
			expect(result.allowed).toBe(false);
			expect(result.reason).toMatch(/approved/);
		});

		test('gated channel (check): missing gate definition → channel closed (misconfiguration)', async () => {
			const channels: WorkflowChannel[] = [
				{ from: 'coder', to: 'planner', direction: 'one-way', gateId: 'nonexistent-gate' },
			];
			// No gates array in workflow
			const workflow = buildWorkflowWithGates(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{
						id: NODE_B,
						name: 'Planner Node',
						agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
					},
				],
				channels,
				[]
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Missing Gate Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// Missing gate → fails closed
			const blocked = await expect(
				router.deliverMessage(run.id, 'coder', 'planner', 'msg')
			).rejects.toBeInstanceOf(ChannelGateBlockedError);
			void blocked; // satisfy lint
		});

		// -----------------------------------------------------------------------
		// Gate transition: blocked → open triggers node activation
		// -----------------------------------------------------------------------

		test('onGateDataChanged: activates target node when gate opens', async () => {
			const gate: Gate = {
				id: 'plan-ready-gate',
				fields: [{ name: 'ready', type: 'boolean', writers: ['planner'], check: { op: '==', value: true } }],
				resetOnCycle: false,
			};
			const channels: WorkflowChannel[] = [
				{ from: 'planner', to: 'coder', direction: 'one-way', gateId: 'plan-ready-gate' },
			];
			const workflow = buildWorkflowWithGates(
				SPACE_ID,
				workflowManager,
				[
					{
						id: NODE_A,
						name: 'Planner Node',
						agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
					},
					{ id: NODE_B, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
				],
				channels,
				[gate]
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Gate Transition Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// Gate still closed before writing
			const noTasks1 = await router.onGateDataChanged(run.id, 'plan-ready-gate');
			expect(noTasks1).toHaveLength(0);
			expect(
				taskRepo.listByWorkflowRun(run.id).filter((t) => t.workflowNodeId === NODE_B)
			).toHaveLength(0);

			// Write gate data to open the gate
			gateDataRepo.set(run.id, 'plan-ready-gate', { ready: true });

			// Now onGateDataChanged should activate coder node
			const activated = await router.onGateDataChanged(run.id, 'plan-ready-gate');
			expect(activated.length).toBeGreaterThan(0);
			expect(activated[0].workflowNodeId).toBe(NODE_B);
			expect(activated[0].status).toBe('pending');
		});

		test('onGateDataChanged: does not re-activate if target node already active', async () => {
			const gate: Gate = {
				id: 'ready-gate',
				fields: [{ name: 'ready', type: 'boolean', writers: ['*'], check: { op: '==', value: true } }],
				resetOnCycle: false,
			};
			const channels: WorkflowChannel[] = [
				{ from: 'planner', to: 'coder', direction: 'one-way', gateId: 'ready-gate' },
			];
			const workflow = buildWorkflowWithGates(
				SPACE_ID,
				workflowManager,
				[
					{
						id: NODE_A,
						name: 'Planner Node',
						agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
					},
					{ id: NODE_B, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
				],
				channels,
				[gate]
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'No Re-activate Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// Manually pre-activate coder node
			await router.activateNode(run.id, NODE_B);

			// Open gate and call onGateDataChanged
			gateDataRepo.set(run.id, 'ready-gate', { ready: true });
			const activated = await router.onGateDataChanged(run.id, 'ready-gate');

			// Already active → no new tasks created
			expect(activated).toHaveLength(0);
		});

		test('onGateDataChanged: returns empty array when gate is still closed', async () => {
			const gate: Gate = {
				id: 'still-closed-gate',
				fields: [{ name: 'done', type: 'boolean', writers: ['*'], check: { op: '==', value: true } }],
				resetOnCycle: false,
			};
			const channels: WorkflowChannel[] = [
				{ from: 'planner', to: 'coder', direction: 'one-way', gateId: 'still-closed-gate' },
			];
			const workflow = buildWorkflowWithGates(
				SPACE_ID,
				workflowManager,
				[
					{
						id: NODE_A,
						name: 'Planner Node',
						agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
					},
					{ id: NODE_B, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
				],
				channels,
				[gate]
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Still Closed Gate Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// Write partial gate data that does NOT satisfy the condition
			gateDataRepo.set(run.id, 'still-closed-gate', { done: false });

			const activated = await router.onGateDataChanged(run.id, 'still-closed-gate');
			expect(activated).toHaveLength(0);
		});

		test('onGateDataChanged: returns empty array for completed run', async () => {
			const gate: Gate = {
				id: 'done-gate',
				fields: [{ name: 'done', type: 'string', writers: ['*'], check: { op: 'exists' } }],
				resetOnCycle: false,
			};
			const channels: WorkflowChannel[] = [
				{ from: 'planner', to: 'coder', direction: 'one-way', gateId: 'done-gate' },
			];
			const workflow = buildWorkflowWithGates(
				SPACE_ID,
				workflowManager,
				[
					{
						id: NODE_A,
						name: 'Planner Node',
						agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
					},
					{ id: NODE_B, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
				],
				channels,
				[gate]
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Completed Run',
			});
			workflowRunRepo.updateStatusUnchecked(run.id, 'completed');

			gateDataRepo.set(run.id, 'done-gate', { done: true });
			const activated = await router.onGateDataChanged(run.id, 'done-gate');
			expect(activated).toHaveLength(0);
		});

		// -----------------------------------------------------------------------
		// Vote-counting gates (count condition)
		// -----------------------------------------------------------------------

		test('vote-counting gate: each write triggers re-evaluation; activates on quorum', async () => {
			const gate: Gate = {
				id: 'review-votes-gate',
				fields: [{ name: 'reviews', type: 'map', writers: ['reviewer'], check: { op: 'count', match: 'approved', min: 2 } }],
				resetOnCycle: false,
			};
			const channels: WorkflowChannel[] = [
				{ from: 'coder', to: 'qa', direction: 'one-way', gateId: 'review-votes-gate' },
			];
			const AGENT_REVIEWER = 'agent-reviewer';
			db.prepare(
				`INSERT INTO space_agents (id, space_id, name, role, description, model, tools, system_prompt,
				 config, created_at, updated_at)
				 VALUES (?, ?, ?, ?, '', null, '[]', '', null, ?, ?)`
			).run(AGENT_REVIEWER, SPACE_ID, 'Agent Reviewer', 'general', Date.now(), Date.now());

			const NODE_C = 'node-c';
			const workflow = buildWorkflowWithGates(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{ id: NODE_C, name: 'QA Node', agents: [{ agentId: AGENT_REVIEWER, name: 'qa' }] },
				],
				channels,
				[gate]
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Vote Counting Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// Initial: no votes
			gateDataRepo.initializeForRun(run.id, [{ id: gate.id, data: computeGateDefaults(gate.fields) }]);
			let activated = await router.onGateDataChanged(run.id, 'review-votes-gate');
			expect(activated).toHaveLength(0);

			// First vote: 1 approval — gate still closed (min: 2)
			gateDataRepo.merge(run.id, 'review-votes-gate', { reviews: { alice: 'approved' } });
			activated = await router.onGateDataChanged(run.id, 'review-votes-gate');
			expect(activated).toHaveLength(0);

			// Second vote: 2 approvals — gate opens, QA node activated
			gateDataRepo.merge(run.id, 'review-votes-gate', {
				reviews: { alice: 'approved', bob: 'approved' },
			});
			activated = await router.onGateDataChanged(run.id, 'review-votes-gate');
			expect(activated.length).toBeGreaterThan(0);
			expect(activated[0].workflowNodeId).toBe(NODE_C);
		});

		// -----------------------------------------------------------------------
		// resetOnCycle behavior
		// -----------------------------------------------------------------------

		test('resetOnCycle: gate data reset when cyclic channel is traversed', async () => {
			const gate: Gate = {
				id: 'review-votes-gate',
				fields: [{ name: 'votes', type: 'map', writers: ['reviewer'], check: { op: 'count', match: 'approved', min: 2 } }],
				resetOnCycle: true,
			};
			const channels: WorkflowChannel[] = [
				{ from: 'coder', to: 'planner', direction: 'one-way' },
				{ from: 'planner', to: 'coder', direction: 'one-way', maxCycles: 10 },
			];
			const workflow = buildWorkflowWithGates(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{
						id: NODE_B,
						name: 'Planner Node',
						agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
					},
				],
				channels,
				[gate]
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Reset On Cycle Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// Seed some vote data
			gateDataRepo.set(run.id, 'review-votes-gate', {
				votes: { alice: 'approved', bob: 'approved' },
			});

			// Traverse the cyclic (backward) channel: planner → coder
			await router.deliverMessage(run.id, 'planner', 'coder', 'iterating');

			// Gate data should have been reset to default (empty votes map)
			const afterReset = gateDataRepo.get(run.id, 'review-votes-gate');
			expect(afterReset).not.toBeNull();
			expect(afterReset!.data).toEqual({ votes: {} });

			// Cycle count should have been incremented (channel index 1 is the backward channel)
			expect(channelCycleRepo.get(run.id, 1)!.count).toBe(1);
		});

		test('resetOnCycle: gates with resetOnCycle=false are preserved on cyclic traversal', async () => {
			const resetGate: Gate = {
				id: 'review-reject-gate',
				fields: [{ name: 'rejected', type: 'string', writers: ['reviewer'], check: { op: 'exists' } }],
				resetOnCycle: true,
			};
			const preservedGate: Gate = {
				id: 'code-pr-gate',
				fields: [{ name: 'pr', type: 'string', writers: ['coder'], check: { op: 'exists' } }],
				resetOnCycle: false,
			};
			const channels: WorkflowChannel[] = [
				{ from: 'coder', to: 'planner', direction: 'one-way' },
				{ from: 'planner', to: 'coder', direction: 'one-way', maxCycles: 10 },
			];
			const workflow = buildWorkflowWithGates(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{
						id: NODE_B,
						name: 'Planner Node',
						agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
					},
				],
				channels,
				[resetGate, preservedGate]
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Selective Reset Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// Write data for both gates
			gateDataRepo.set(run.id, 'review-reject-gate', { rejected: 'needs work' });
			gateDataRepo.set(run.id, 'code-pr-gate', { pr: 'https://github.com/org/repo/pull/42' });

			// Traverse cyclic (backward) channel: planner → coder
			await router.deliverMessage(run.id, 'planner', 'coder', 'back to coding');

			// resetOnCycle: true gate should be reset to defaults
			const resetRecord = gateDataRepo.get(run.id, 'review-reject-gate');
			expect(resetRecord!.data).toEqual({});

			// resetOnCycle: false gate should be preserved
			const preservedRecord = gateDataRepo.get(run.id, 'code-pr-gate');
			expect(preservedRecord!.data).toEqual({ pr: 'https://github.com/org/repo/pull/42' });
		});

		test('resetOnCycle: multiple cycle-reset gates reset together (atomic)', async () => {
			const gate1: Gate = {
				id: 'review-votes-gate',
				fields: [{ name: 'votes', type: 'map', writers: ['*'], check: { op: 'count', match: 'ok', min: 1 } }],
				resetOnCycle: true,
			};
			const gate2: Gate = {
				id: 'qa-result-gate',
				fields: [{ name: 'result', type: 'string', writers: ['*'], check: { op: 'exists' } }],
				resetOnCycle: true,
			};
			const channels: WorkflowChannel[] = [
				{ from: 'coder', to: 'planner', direction: 'one-way' },
				{ from: 'planner', to: 'coder', direction: 'one-way', maxCycles: 10 },
			];
			const workflow = buildWorkflowWithGates(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{
						id: NODE_B,
						name: 'Planner Node',
						agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
					},
				],
				channels,
				[gate1, gate2]
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Multi Reset Atomic Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// Write data for both gates
			gateDataRepo.set(run.id, 'review-votes-gate', { votes: { alice: 'ok' } });
			gateDataRepo.set(run.id, 'qa-result-gate', { result: 'passed' });

			// Traverse cyclic (backward) channel: planner → coder
			await router.deliverMessage(run.id, 'planner', 'coder', 'cycle');

			// Both should be reset to their defaults
			const votes = gateDataRepo.get(run.id, 'review-votes-gate');
			expect(votes!.data).toEqual({ votes: {} });

			const qa = gateDataRepo.get(run.id, 'qa-result-gate');
			expect(qa!.data).toEqual({});
		});

		// -----------------------------------------------------------------------
		// Incremental writes — correct accumulation pattern for vote-counting
		// -----------------------------------------------------------------------

		test('incremental vote writes accumulate correctly and activate node at quorum', async () => {
			// GateDataRepository.merge() does a shallow top-level merge, so each
			// caller must write the full accumulated votes map (read-then-write pattern)
			// rather than only their own vote. This is the correct usage pattern for
			// vote-counting gates; direct concurrent writes that replace the same key
			// would lose votes due to the shallow merge semantics.
			const gate: Gate = {
				id: 'accumulate-gate',
				fields: [{ name: 'approvals', type: 'map', writers: ['*'], check: { op: 'count', match: 'approved', min: 3 } }],
				resetOnCycle: false,
			};
			const channels: WorkflowChannel[] = [
				{ from: 'coder', to: 'planner', direction: 'one-way', gateId: 'accumulate-gate' },
			];
			const workflow = buildWorkflowWithGates(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{
						id: NODE_B,
						name: 'Planner Node',
						agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
					},
				],
				channels,
				[gate]
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Accumulate Votes Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');
			gateDataRepo.initializeForRun(run.id, [{ id: gate.id, data: computeGateDefaults(gate.fields) }]);

			// Voter 1: write only their vote (gate still closed, min=3)
			gateDataRepo.merge(run.id, 'accumulate-gate', {
				approvals: { alice: 'approved' },
			});
			let activated = await router.onGateDataChanged(run.id, 'accumulate-gate');
			expect(activated).toHaveLength(0);

			// Voter 2: read current state then write accumulated map (2 votes, still closed)
			const after1 = gateDataRepo.get(run.id, 'accumulate-gate')!.data;
			gateDataRepo.merge(run.id, 'accumulate-gate', {
				approvals: { ...(after1.approvals as Record<string, string>), bob: 'approved' },
			});
			activated = await router.onGateDataChanged(run.id, 'accumulate-gate');
			expect(activated).toHaveLength(0);

			// Voter 3: read current state then write accumulated map (3 votes — quorum reached)
			const after2 = gateDataRepo.get(run.id, 'accumulate-gate')!.data;
			gateDataRepo.merge(run.id, 'accumulate-gate', {
				approvals: { ...(after2.approvals as Record<string, string>), carol: 'approved' },
			});
			activated = await router.onGateDataChanged(run.id, 'accumulate-gate');
			expect(activated.length).toBeGreaterThan(0);
			expect(activated[0].workflowNodeId).toBe(NODE_B);

			// All 3 votes are preserved in the final state
			const final = gateDataRepo.get(run.id, 'accumulate-gate')!;
			const approvals = final.data.approvals as Record<string, string>;
			expect(Object.keys(approvals)).toHaveLength(3);
			expect(approvals).toEqual({ alice: 'approved', bob: 'approved', carol: 'approved' });
		});

		// -----------------------------------------------------------------------
		// Parallel activation — shared gate → multiple independent nodes
		// -----------------------------------------------------------------------

		test('parallel activation: shared gate opens → all target nodes activated simultaneously', async () => {
			// Mirrors the code-pr-gate scenario: one gate controls three channels,
			// each pointing to a different reviewer node.
			const gate: Gate = {
				id: 'code-pr-gate',
				fields: [{ name: 'pr_url', type: 'string', writers: ['coder'], check: { op: '!=', value: undefined } }],
				resetOnCycle: false,
			};

			const NODE_REVIEWER1 = 'node-reviewer1';
			const NODE_REVIEWER2 = 'node-reviewer2';
			const NODE_REVIEWER3 = 'node-reviewer3';
			const AGENT_REVIEWER1 = 'agent-reviewer1';
			const AGENT_REVIEWER2 = 'agent-reviewer2';
			const AGENT_REVIEWER3 = 'agent-reviewer3';

			for (const [id, name] of [
				[AGENT_REVIEWER1, 'Reviewer 1'],
				[AGENT_REVIEWER2, 'Reviewer 2'],
				[AGENT_REVIEWER3, 'Reviewer 3'],
			]) {
				db.prepare(
					`INSERT INTO space_agents (id, space_id, name, role, description, model, tools,
					 system_prompt, config, created_at, updated_at)
					 VALUES (?, ?, ?, 'general', '', null, '[]', '', null, ?, ?)`
				).run(id, SPACE_ID, name, Date.now(), Date.now());
			}

			const channels: WorkflowChannel[] = [
				{ from: 'coder', to: 'reviewer-1', direction: 'one-way', gateId: 'code-pr-gate' },
				{ from: 'coder', to: 'reviewer-2', direction: 'one-way', gateId: 'code-pr-gate' },
				{ from: 'coder', to: 'reviewer-3', direction: 'one-way', gateId: 'code-pr-gate' },
			];

			const workflow = buildWorkflowWithGates(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{
						id: NODE_REVIEWER1,
						name: 'Reviewer 1 Node',
						agents: [{ agentId: AGENT_REVIEWER1, name: 'reviewer-1' }],
					},
					{
						id: NODE_REVIEWER2,
						name: 'Reviewer 2 Node',
						agents: [{ agentId: AGENT_REVIEWER2, name: 'reviewer-2' }],
					},
					{
						id: NODE_REVIEWER3,
						name: 'Reviewer 3 Node',
						agents: [{ agentId: AGENT_REVIEWER3, name: 'reviewer-3' }],
					},
				],
				channels,
				[gate]
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Parallel Reviewer Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');
			gateDataRepo.initializeForRun(run.id, [{ id: gate.id, data: computeGateDefaults(gate.fields) }]);

			// Gate closed — no nodes activated
			const noneYet = await router.onGateDataChanged(run.id, 'code-pr-gate');
			expect(noneYet).toHaveLength(0);

			// Open the gate by writing a pr_url
			gateDataRepo.merge(run.id, 'code-pr-gate', { pr_url: 'https://github.com/org/repo/pull/42' });

			// All 3 reviewer nodes should activate simultaneously
			const activated = await router.onGateDataChanged(run.id, 'code-pr-gate');
			expect(activated.length).toBe(3);

			const activatedNodeIds = new Set(activated.map((t) => t.workflowNodeId));
			expect(activatedNodeIds).toContain(NODE_REVIEWER1);
			expect(activatedNodeIds).toContain(NODE_REVIEWER2);
			expect(activatedNodeIds).toContain(NODE_REVIEWER3);
		});

		test('parallel activation: second call is idempotent — already-active nodes not re-activated', async () => {
			const gate: Gate = {
				id: 'shared-gate',
				fields: [{ name: 'ready', type: 'boolean', writers: ['*'], check: { op: '==', value: true } }],
				resetOnCycle: false,
			};

			const NODE_C = 'node-c';
			const AGENT_C = 'agent-c';

			db.prepare(
				`INSERT INTO space_agents (id, space_id, name, role, description, model, tools,
				 system_prompt, config, created_at, updated_at)
				 VALUES (?, ?, 'Agent C', 'general', '', null, '[]', '', null, ?, ?)`
			).run(AGENT_C, SPACE_ID, Date.now(), Date.now());

			const channels: WorkflowChannel[] = [
				{ from: 'coder', to: 'planner', direction: 'one-way', gateId: 'shared-gate' },
				{ from: 'coder', to: 'agent-c', direction: 'one-way', gateId: 'shared-gate' },
			];

			const workflow = buildWorkflowWithGates(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{
						id: NODE_B,
						name: 'Planner Node',
						agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
					},
					{ id: NODE_C, name: 'C Node', agents: [{ agentId: AGENT_C, name: 'agent-c' }] },
				],
				channels,
				[gate]
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Idempotent Parallel Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');
			gateDataRepo.initializeForRun(run.id, [{ id: gate.id, data: computeGateDefaults(gate.fields) }]);
			gateDataRepo.merge(run.id, 'shared-gate', { ready: true });

			// First call: both nodes activated
			const first = await router.onGateDataChanged(run.id, 'shared-gate');
			expect(first.length).toBe(2);

			// Second call: gate still open but nodes already active → nothing new
			const second = await router.onGateDataChanged(run.id, 'shared-gate');
			expect(second).toHaveLength(0);
		});

		// -----------------------------------------------------------------------
		// 3-reviewer vote-counting gate (review-votes-gate pattern)
		// -----------------------------------------------------------------------

		test('review-votes-gate: QA blocked until all 3 reviewers approve (min: 3)', async () => {
			// Mirrors the CODING_WORKFLOW_V2 review-votes-gate:
			// Each of the 3 reviewer nodes writes independently to review-votes-gate.
			// QA only activates when vote count reaches 3.
			const gate: Gate = {
				id: 'review-votes-gate',
				fields: [{ name: 'votes', type: 'map', writers: ['reviewer'], check: { op: 'count', match: 'approved', min: 3 } }],
				resetOnCycle: false,
			};

			const NODE_QA = 'node-qa';
			const AGENT_QA = 'agent-qa';

			db.prepare(
				`INSERT INTO space_agents (id, space_id, name, role, description, model, tools,
				 system_prompt, config, created_at, updated_at)
				 VALUES (?, ?, 'QA Agent', 'general', '', null, '[]', '', null, ?, ?)`
			).run(AGENT_QA, SPACE_ID, Date.now(), Date.now());

			// All 3 reviewer channels share the same review-votes-gate
			const channels: WorkflowChannel[] = [
				{
					from: 'reviewer-1',
					to: 'qa-agent',
					direction: 'one-way',
					gateId: 'review-votes-gate',
				},
				{
					from: 'reviewer-2',
					to: 'qa-agent',
					direction: 'one-way',
					gateId: 'review-votes-gate',
				},
				{
					from: 'reviewer-3',
					to: 'qa-agent',
					direction: 'one-way',
					gateId: 'review-votes-gate',
				},
			];

			const workflow = buildWorkflowWithGates(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{ id: NODE_QA, name: 'QA Node', agents: [{ agentId: AGENT_QA, name: 'qa-agent' }] },
				],
				channels,
				[gate]
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: '3-Reviewer Vote Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');
			gateDataRepo.initializeForRun(run.id, [{ id: gate.id, data: computeGateDefaults(gate.fields) }]);

			// Reviewer 1 votes — gate still closed (1/3)
			gateDataRepo.merge(run.id, 'review-votes-gate', { votes: { 'reviewer-1': 'approved' } });
			let activated = await router.onGateDataChanged(run.id, 'review-votes-gate');
			expect(activated).toHaveLength(0);

			// Reviewer 2 votes — gate still closed (2/3, partial completion)
			const after1 = gateDataRepo.get(run.id, 'review-votes-gate')!.data;
			gateDataRepo.merge(run.id, 'review-votes-gate', {
				votes: { ...(after1.votes as Record<string, string>), 'reviewer-2': 'approved' },
			});
			activated = await router.onGateDataChanged(run.id, 'review-votes-gate');
			expect(activated).toHaveLength(0); // QA still blocked: only 2/3 approved

			// Reviewer 3 votes — quorum reached (3/3), QA activates
			const after2 = gateDataRepo.get(run.id, 'review-votes-gate')!.data;
			gateDataRepo.merge(run.id, 'review-votes-gate', {
				votes: { ...(after2.votes as Record<string, string>), 'reviewer-3': 'approved' },
			});
			activated = await router.onGateDataChanged(run.id, 'review-votes-gate');
			expect(activated.length).toBeGreaterThan(0);
			expect(activated[0].workflowNodeId).toBe(NODE_QA);

			// Verify all 3 votes are preserved in the gate data
			const finalData = gateDataRepo.get(run.id, 'review-votes-gate')!.data;
			const votes = finalData.votes as Record<string, string>;
			expect(Object.keys(votes)).toHaveLength(3);
			expect(votes['reviewer-1']).toBe('approved');
			expect(votes['reviewer-2']).toBe('approved');
			expect(votes['reviewer-3']).toBe('approved');
		});

		test('review-votes-gate: partial completion (2/3) keeps QA blocked', async () => {
			// Explicitly verifies the partial-completion guard: the gate condition
			// min: 3 means 2 votes are insufficient to unblock downstream QA.
			const gate: Gate = {
				id: 'review-votes-gate',
				fields: [{ name: 'votes', type: 'map', writers: ['reviewer'], check: { op: 'count', match: 'approved', min: 3 } }],
				resetOnCycle: false,
			};

			const NODE_QA = 'node-qa-partial';
			const AGENT_QA = 'agent-qa-partial';

			db.prepare(
				`INSERT INTO space_agents (id, space_id, name, role, description, model, tools,
				 system_prompt, config, created_at, updated_at)
				 VALUES (?, ?, 'QA Agent', 'general', '', null, '[]', '', null, ?, ?)`
			).run(AGENT_QA, SPACE_ID, Date.now(), Date.now());

			const channels: WorkflowChannel[] = [
				{ from: 'reviewer-1', to: 'qa', direction: 'one-way', gateId: 'review-votes-gate' },
			];

			const workflow = buildWorkflowWithGates(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{ id: NODE_QA, name: 'QA Node', agents: [{ agentId: AGENT_QA, name: 'qa' }] },
				],
				channels,
				[gate]
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Partial Completion Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');
			gateDataRepo.initializeForRun(run.id, [{ id: gate.id, data: computeGateDefaults(gate.fields) }]);

			// Write 2 approvals — gate needs 3, so QA stays blocked
			gateDataRepo.set(run.id, 'review-votes-gate', {
				votes: { 'reviewer-1': 'approved', 'reviewer-2': 'approved' },
			});
			const activated = await router.onGateDataChanged(run.id, 'review-votes-gate');
			expect(activated).toHaveLength(0);

			// Confirm QA node has no active tasks
			const qaTasks = taskRepo
				.listByWorkflowRun(run.id)
				.filter((t) => t.workflowNodeId === NODE_QA);
			expect(qaTasks).toHaveLength(0);
		});

		// -----------------------------------------------------------------------
		// gateId takes precedence over legacy inline gate
		// -----------------------------------------------------------------------

		// -----------------------------------------------------------------------
		// QA feedback loop — M5.1
		// -----------------------------------------------------------------------

		describe('QA feedback loop', () => {
			const AGENT_REVIEWER = 'agent-reviewer-qa';
			const AGENT_QA = 'agent-qa-loop';
			const AGENT_DONE = 'agent-done-loop';

			const NODE_CODING = 'node-coding-qa';
			const NODE_REV1 = 'node-rev1-qa';
			const NODE_REV2 = 'node-rev2-qa';
			const NODE_REV3 = 'node-rev3-qa';
			const NODE_QA = 'node-qa-loop';
			const NODE_DONE = 'node-done-qa';

			// Gates matching CODING_WORKFLOW_V2 design
			const gateCodePr: Gate = {
				id: 'code-pr-gate',
				fields: [{ name: 'pr_url', type: 'string', writers: ['coder'], check: { op: 'exists' } }],
				resetOnCycle: false, // preserved across fix cycles
			};
			const gateReviewVotes: Gate = {
				id: 'review-votes-gate',
				fields: [{ name: 'votes', type: 'map', writers: ['reviewer'], check: { op: 'count', match: 'approved', min: 3 } }],
				resetOnCycle: true,
			};
			const gateReviewReject: Gate = {
				id: 'review-reject-gate',
				fields: [{ name: 'votes', type: 'map', writers: ['reviewer'], check: { op: 'count', match: 'rejected', min: 1 } }],
				resetOnCycle: true,
			};
			const gateQaResult: Gate = {
				id: 'qa-result-gate',
				fields: [{ name: 'result', type: 'string', writers: ['qa'], check: { op: '==', value: 'passed' } }],
				resetOnCycle: true, // resets on each QA→Coding cycle
			};
			const gateQaFail: Gate = {
				id: 'qa-fail-gate',
				fields: [{ name: 'result', type: 'string', writers: ['qa'], check: { op: '==', value: 'failed' } }],
				resetOnCycle: true,
			};
			const allGates = [gateCodePr, gateReviewVotes, gateReviewReject, gateQaResult, gateQaFail];

			function buildQaWorkflow(qaMaxCycles = 5) {
				const channels: WorkflowChannel[] = [
					// Coding → Code Review node
					{ from: 'Coding', to: 'Code Review', direction: 'one-way', gateId: 'code-pr-gate' },
					// Code Review node → QA
					{
						from: 'Code Review',
						to: 'QA',
						direction: 'one-way',
						gateId: 'review-votes-gate',
					},
					// QA → Done (success)
					{ from: 'QA', to: 'Done', direction: 'one-way', gateId: 'qa-result-gate' },
					// QA → Coding (backward/cyclic channel — topologically backward since QA is after Coding in nodes array)
					{
						from: 'QA',
						to: 'Coding',
						direction: 'one-way',
						gateId: 'qa-fail-gate',
						maxCycles: qaMaxCycles,
					},
				];
				return buildWorkflowWithGates(
					SPACE_ID,
					workflowManager,
					[
						{ id: NODE_CODING, name: 'Coding', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
						{
							id: NODE_REV1,
							name: 'Code Review',
							agents: [
								{ agentId: AGENT_REVIEWER, name: 'Reviewer 1' },
								{ agentId: AGENT_REVIEWER, name: 'Reviewer 2' },
								{ agentId: AGENT_REVIEWER, name: 'Reviewer 3' },
							],
						},
						{ id: NODE_QA, name: 'QA', agents: [{ agentId: AGENT_QA, name: 'qa' }] },
						{
							id: NODE_DONE,
							name: 'Done',
							agents: [{ agentId: AGENT_DONE, name: 'done' }],
						},
					],
					channels,
					allGates
				);
			}

			beforeEach(() => {
				seedAgent(db, AGENT_REVIEWER, SPACE_ID, 'reviewer');
				seedAgent(db, AGENT_QA, SPACE_ID, 'qa');
				seedAgent(db, AGENT_DONE, SPACE_ID, 'general');
			});

			test('QA failure via onGateDataChanged activates Coding, increments counter, resets cycle gates', async () => {
				const workflow = buildQaWorkflow();
				const run = workflowRunRepo.createRun({
					spaceId: SPACE_ID,
					workflowId: workflow.id,
					title: 'QA Fail Loop Run',
				});
				workflowRunRepo.transitionStatus(run.id, 'in_progress');
				gateDataRepo.initializeForRun(run.id, allGates.map(g => ({ id: g.id, data: computeGateDefaults(g.fields) })));

				// Simulate pre-existing state from a completed review cycle
				gateDataRepo.set(run.id, 'code-pr-gate', { pr_url: 'https://github.com/org/repo/pull/42' });
				gateDataRepo.set(run.id, 'review-votes-gate', {
					votes: { 'reviewer-1': 'approved', 'reviewer-2': 'approved', 'reviewer-3': 'approved' },
				});
				gateDataRepo.set(run.id, 'review-reject-gate', { votes: { 'reviewer-1': 'approved' } });
				gateDataRepo.set(run.id, 'qa-result-gate', { result: 'passed' });

				// QA writes failed result with summary to qa-fail-gate (as the write_gate MCP tool would)
				gateDataRepo.set(run.id, 'qa-fail-gate', {
					result: 'failed',
					summary: 'CI pipeline red: 3 tests failing',
				});
				const activated = await router.onGateDataChanged(run.id, 'qa-fail-gate');

				// Exactly one task: the Coding node activated via the cyclic QA→Coding channel
				expect(activated).toHaveLength(1);
				expect(activated[0].workflowNodeId).toBe(NODE_CODING);

				// Per-channel cycle counter must increment (QA→Coding is channel index 3)
				expect(channelCycleRepo.get(run.id, 3)!.count).toBe(1);

				// Cyclic-reset gates must be wiped to computed defaults
				expect(gateDataRepo.get(run.id, 'review-votes-gate')!.data).toEqual({ votes: {} });
				expect(gateDataRepo.get(run.id, 'review-reject-gate')!.data).toEqual({ votes: {} });
				expect(gateDataRepo.get(run.id, 'qa-result-gate')!.data).toEqual({});
				expect(gateDataRepo.get(run.id, 'qa-fail-gate')!.data).toEqual({});

				// code-pr-gate must be preserved (resetOnCycle: false)
				expect(gateDataRepo.get(run.id, 'code-pr-gate')!.data).toEqual({
					pr_url: 'https://github.com/org/repo/pull/42',
				});
			});

			test('QA failure resets review-votes-gate, qa-result-gate, qa-fail-gate; preserves code-pr-gate', async () => {
				const workflow = buildQaWorkflow();
				const run = workflowRunRepo.createRun({
					spaceId: SPACE_ID,
					workflowId: workflow.id,
					title: 'Gate Reset On QA Fail',
				});
				workflowRunRepo.transitionStatus(run.id, 'in_progress');
				gateDataRepo.initializeForRun(run.id, allGates.map(g => ({ id: g.id, data: computeGateDefaults(g.fields) })));

				// Simulate pre-existing gate state from a completed review cycle;
				// qa-fail-gate must be set to satisfy the gated channel before delivery
				gateDataRepo.set(run.id, 'code-pr-gate', { pr_url: 'https://github.com/org/repo/pull/42' });
				gateDataRepo.set(run.id, 'review-votes-gate', {
					votes: { 'reviewer-1': 'approved', 'reviewer-2': 'approved', 'reviewer-3': 'approved' },
				});
				gateDataRepo.set(run.id, 'review-reject-gate', {
					votes: { 'reviewer-1': 'approved' },
				});
				gateDataRepo.set(run.id, 'qa-result-gate', { result: 'passed' });
				gateDataRepo.set(run.id, 'qa-fail-gate', { result: 'failed' });

				// QA delivers to Coding via cyclic channel (gate already satisfied above)
				await router.deliverMessage(run.id, 'QA', 'Coding', 'QA found issues');

				// code-pr-gate must be preserved (not reset) so Coding can update the existing PR
				const codePr = gateDataRepo.get(run.id, 'code-pr-gate');
				expect(codePr!.data).toEqual({
					pr_url: 'https://github.com/org/repo/pull/42',
				});

				// review-votes-gate, review-reject-gate, qa-result-gate, qa-fail-gate must reset
				const reviewVotes = gateDataRepo.get(run.id, 'review-votes-gate');
				expect(reviewVotes!.data).toEqual({ votes: {} });

				const reviewReject = gateDataRepo.get(run.id, 'review-reject-gate');
				expect(reviewReject!.data).toEqual({ votes: {} });

				const qaResult = gateDataRepo.get(run.id, 'qa-result-gate');
				expect(qaResult!.data).toEqual({});

				const qaFail = gateDataRepo.get(run.id, 'qa-fail-gate');
				expect(qaFail!.data).toEqual({});
			});

			test('QA→Coding cycle increments per-channel cycle counter', async () => {
				const workflow = buildQaWorkflow();
				const run = workflowRunRepo.createRun({
					spaceId: SPACE_ID,
					workflowId: workflow.id,
					title: 'Cycle Counter Run',
				});
				workflowRunRepo.transitionStatus(run.id, 'in_progress');
				gateDataRepo.initializeForRun(run.id, allGates.map(g => ({ id: g.id, data: computeGateDefaults(g.fields) })));

				// No cycle record yet
				expect(channelCycleRepo.get(run.id, 3)).toBeNull();

				// Must satisfy qa-fail-gate before delivering on cyclic QA→Coding channel
				gateDataRepo.set(run.id, 'qa-fail-gate', { result: 'failed' });
				await router.deliverMessage(run.id, 'QA', 'Coding', 'QA cycle 1');

				// Channel index 3 is QA→Coding
				expect(channelCycleRepo.get(run.id, 3)!.count).toBe(1);
			});

			test('after QA fail cycle, reviewers must re-vote from scratch (votes reset to empty)', async () => {
				const workflow = buildQaWorkflow();
				const run = workflowRunRepo.createRun({
					spaceId: SPACE_ID,
					workflowId: workflow.id,
					title: 'Re-vote From Scratch',
				});
				workflowRunRepo.transitionStatus(run.id, 'in_progress');
				gateDataRepo.initializeForRun(run.id, allGates.map(g => ({ id: g.id, data: computeGateDefaults(g.fields) })));

				// Populate existing votes and satisfy qa-fail-gate
				gateDataRepo.set(run.id, 'review-votes-gate', {
					votes: { 'reviewer-1': 'approved', 'reviewer-2': 'approved', 'reviewer-3': 'approved' },
				});
				gateDataRepo.set(run.id, 'qa-fail-gate', { result: 'failed' });

				// QA→Coding cycle
				await router.deliverMessage(run.id, 'QA', 'Coding', 'issues found');

				// All votes wiped — reviewers must re-vote
				const votes = gateDataRepo.get(run.id, 'review-votes-gate');
				expect(votes!.data).toEqual({ votes: {} });

				// QA channel now blocked (only 0/3 approved)
				const canDeliver = await router.canDeliver(run.id, 'Reviewer 1', 'QA');
				expect(canDeliver.allowed).toBe(false);
			});

			test('QA→Coding cycle throws ActivationError when max cycles reached', async () => {
				const workflow = buildQaWorkflow(2); // maxCycles: 2
				const run = workflowRunRepo.createRun({
					spaceId: SPACE_ID,
					workflowId: workflow.id,
					title: 'Max Cycles QA',
				});
				workflowRunRepo.transitionStatus(run.id, 'in_progress');
				gateDataRepo.initializeForRun(run.id, allGates.map(g => ({ id: g.id, data: computeGateDefaults(g.fields) })));

				// Use up 2 cycles (must satisfy qa-fail-gate before each delivery; gate resets on each cycle)
				gateDataRepo.set(run.id, 'qa-fail-gate', { result: 'failed' });
				await router.deliverMessage(run.id, 'QA', 'Coding', 'QA cycle 1');
				gateDataRepo.set(run.id, 'qa-fail-gate', { result: 'failed' });
				await router.deliverMessage(run.id, 'QA', 'Coding', 'QA cycle 2');

				// Third attempt should throw
				gateDataRepo.set(run.id, 'qa-fail-gate', { result: 'failed' });
				await expect(
					router.deliverMessage(run.id, 'QA', 'Coding', 'QA cycle 3 — should fail')
				).rejects.toBeInstanceOf(ActivationError);
			});

			test('onGateDataChanged throws ActivationError when cyclic channel at max cycles', async () => {
				const workflow = buildQaWorkflow(1); // maxCycles: 1
				const run = workflowRunRepo.createRun({
					spaceId: SPACE_ID,
					workflowId: workflow.id,
					title: 'Max Cycles via onGateDataChanged',
				});
				workflowRunRepo.transitionStatus(run.id, 'in_progress');
				gateDataRepo.initializeForRun(run.id, allGates.map(g => ({ id: g.id, data: computeGateDefaults(g.fields) })));

				// Use up the 1 cycle via onGateDataChanged
				gateDataRepo.set(run.id, 'qa-fail-gate', { result: 'failed' });
				await router.onGateDataChanged(run.id, 'qa-fail-gate');
				expect(channelCycleRepo.get(run.id, 3)!.count).toBe(1);

				// Second attempt must throw before any activation
				gateDataRepo.set(run.id, 'qa-fail-gate', { result: 'failed' });
				await expect(router.onGateDataChanged(run.id, 'qa-fail-gate')).rejects.toBeInstanceOf(
					ActivationError
				);
			});

			test('QA passes → QA→Done channel opens when qa-result-gate satisfied', async () => {
				const workflow = buildQaWorkflow();
				const run = workflowRunRepo.createRun({
					spaceId: SPACE_ID,
					workflowId: workflow.id,
					title: 'QA Pass Run',
				});
				workflowRunRepo.transitionStatus(run.id, 'in_progress');
				gateDataRepo.initializeForRun(run.id, allGates.map(g => ({ id: g.id, data: computeGateDefaults(g.fields) })));

				// QA writes passed result
				gateDataRepo.set(run.id, 'qa-result-gate', { result: 'passed' });
				const activated = await router.onGateDataChanged(run.id, 'qa-result-gate');

				const doneTask = activated.find((t) => t.workflowNodeId === NODE_DONE);
				expect(doneTask).toBeDefined();
			});
		});

		test('gateId takes precedence over legacy inline gate when both are set', async () => {
			const gate: Gate = {
				id: 'new-gate',
				fields: [{ name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } }],
				resetOnCycle: false,
			};
			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: 'planner',
					direction: 'one-way',
					gateId: 'new-gate',
				},
			];
			const workflow = buildWorkflowWithGates(
				SPACE_ID,
				workflowManager,
				[
					{ id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
					{
						id: NODE_B,
						name: 'Planner Node',
						agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
					},
				],
				channels,
				[gate]
			);

			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Precedence Run',
			});
			workflowRunRepo.transitionStatus(run.id, 'in_progress');

			// Write gate data to satisfy the new-style gate
			gateDataRepo.set(run.id, 'new-gate', { approved: true });

			// Delivery succeeds because gateId evaluation passes (ignoring legacy human gate)
			const result = await router.deliverMessage(run.id, 'coder', 'planner', 'approved');
			expect(result.fromRole).toBe('coder');
		});
	});
});
