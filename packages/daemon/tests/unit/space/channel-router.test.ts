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
 * - deliverMessage(): gate blocked throws ChannelGateBlockedError
 * - deliverMessage(): gate allowed delivers successfully
 * - deliverMessage(): cyclic channel increments iterationCount
 * - deliverMessage(): cyclic iteration cap throws ActivationError
 * - deliverMessage(): no context — gates skipped, delivery succeeds
 * - canDeliver(): open topology allows all deliveries
 * - canDeliver(): gate 'always' — always allowed
 * - canDeliver(): gate 'human' — blocked without approval, allowed with approval
 * - canDeliver(): gate 'task_result' — blocked on mismatch, allowed on match
 * - canDeliver(): cyclic channel — blocked when iterationCount >= maxIterations
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
import { SpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import {
	ChannelRouter,
	ActivationError,
	ChannelGateBlockedError,
} from '../../../src/lib/space/runtime/channel-router.ts';
import { ChannelGateEvaluator } from '../../../src/lib/space/runtime/channel-gate-evaluator.ts';
import type { SpaceWorkflow, WorkflowChannel } from '@neokai/shared';

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
     allowed_models, session_ids, status, created_at, updated_at)
     VALUES (?, '/tmp/ws', ?, '', '', '', '[]', '[]', 'active', ?, ?)`
	).run(spaceId, `Space ${spaceId}`, Date.now(), Date.now());
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
// Mock gate evaluator helpers
// ---------------------------------------------------------------------------

/** Creates a ChannelGateEvaluator that always allows delivery */
function makeAllowingEvaluator(): ChannelGateEvaluator {
	return new ChannelGateEvaluator(async () => ({ exitCode: 0 }));
}

/** Creates a ChannelGateEvaluator that always fails shell conditions */
function makeBlockingEvaluator(): ChannelGateEvaluator {
	return new ChannelGateEvaluator(async () => ({ exitCode: 1 }));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ChannelRouter', () => {
	let db: BunDatabase;
	let dir: string;

	let taskRepo: SpaceTaskRepository;
	let workflowRunRepo: SpaceWorkflowRunRepository;
	let workflowManager: SpaceWorkflowManager;
	let agentManager: SpaceAgentManager;
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

		const agentRepo = new SpaceAgentRepository(db);
		agentManager = new SpaceAgentManager(agentRepo);

		const workflowRepo = new SpaceWorkflowRepository(db);
		workflowManager = new SpaceWorkflowManager(workflowRepo);

		router = new ChannelRouter({ taskRepo, workflowRunRepo, workflowManager, agentManager });
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
			workflowRunRepo.updateStatus(run.id, 'in_progress');

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
			workflowRunRepo.updateStatus(run.id, 'in_progress');

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
			workflowRunRepo.updateStatus(run.id, 'in_progress');

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
			workflowRunRepo.updateStatus(run.id, 'in_progress');

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
			workflowRunRepo.updateStatus(run.id, 'in_progress');

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
			workflowRunRepo.updateStatus(run.id, 'in_progress');

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
			workflowRunRepo.updateStatus(run.id, 'cancelled');

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
			workflowRunRepo.updateStatus(run.id, 'completed');

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
			workflowRunRepo.updateStatus(run.id, 'in_progress');

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
			workflowRunRepo.updateStatus(run.id, 'in_progress');

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
			workflowRunRepo.updateStatus(run.id, 'in_progress');

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
			workflowRunRepo.updateStatus(run.id, 'in_progress');

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
			workflowRunRepo.updateStatus(run.id, 'in_progress');

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
			workflowRunRepo.updateStatus(run.id, 'in_progress');

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
			workflowRunRepo.updateStatus(run.id, 'in_progress');

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
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			// Both agents are in NODE_A; 'planner' is in the same node as 'coder'
			const result = await router.deliverMessage(run.id, 'coder', 'planner', 'hey planner');

			expect(result.targetNodeId).toBe(NODE_A);
			expect(result.isFanOut).toBe(false);
		});

		// -----------------------------------------------------------------------
		// Gate evaluation
		// -----------------------------------------------------------------------

		test('gate blocked: throws ChannelGateBlockedError for human gate without approval', async () => {
			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: 'planner',
					direction: 'one-way',
					gate: { type: 'human', description: 'Needs human review' },
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
				title: 'Human Gate Run',
			});
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			await expect(
				router.deliverMessage(run.id, 'coder', 'planner', 'needs review', {
					workspacePath: '/tmp/ws',
					humanApproved: false,
				})
			).rejects.toBeInstanceOf(ChannelGateBlockedError);
		});

		test('gate allowed: human gate with approval delivers successfully', async () => {
			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: 'planner',
					direction: 'one-way',
					gate: { type: 'human' },
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
				title: 'Human Gate Approved Run',
			});
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			const result = await router.deliverMessage(run.id, 'coder', 'planner', 'approved message', {
				workspacePath: '/tmp/ws',
				humanApproved: true,
			});

			expect(result.fromRole).toBe('coder');
			expect(result.toRole).toBe('planner');
		});

		test('gate blocked: task_result gate blocks on mismatch', async () => {
			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: 'planner',
					direction: 'one-way',
					gate: { type: 'task_result', expression: 'success' },
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
				title: 'Task Result Gate Run',
			});
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			await expect(
				router.deliverMessage(run.id, 'coder', 'planner', 'msg', {
					workspacePath: '/tmp/ws',
					taskResult: 'failure',
				})
			).rejects.toBeInstanceOf(ChannelGateBlockedError);
		});

		test('gate allowed: task_result gate passes on match', async () => {
			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: 'planner',
					direction: 'one-way',
					gate: { type: 'task_result', expression: 'success' },
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
				title: 'Task Result Match Run',
			});
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			const result = await router.deliverMessage(run.id, 'coder', 'planner', 'msg', {
				workspacePath: '/tmp/ws',
				taskResult: 'success: all tests passed',
			});

			expect(result.fromRole).toBe('coder');
		});

		test('no context: gates are skipped and delivery succeeds', async () => {
			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: 'planner',
					direction: 'one-way',
					gate: { type: 'human' },
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
				title: 'No Context Run',
			});
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			// No context provided — gate is not evaluated
			const result = await router.deliverMessage(run.id, 'coder', 'planner', 'msg');
			expect(result.fromRole).toBe('coder');
		});

		test('condition gate: uses injected evaluator (allowed)', async () => {
			const allowingRouter = new ChannelRouter({
				taskRepo,
				workflowRunRepo,
				workflowManager,
				agentManager,
				gateEvaluator: makeAllowingEvaluator(),
			});

			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: 'planner',
					direction: 'one-way',
					gate: { type: 'condition', expression: 'exit 0' },
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
				title: 'Condition Gate Allowed',
			});
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			const result = await allowingRouter.deliverMessage(run.id, 'coder', 'planner', 'msg', {
				workspacePath: '/tmp/ws',
			});
			expect(result.fromRole).toBe('coder');
		});

		test('condition gate: uses injected evaluator (blocked)', async () => {
			const blockingRouter = new ChannelRouter({
				taskRepo,
				workflowRunRepo,
				workflowManager,
				agentManager,
				gateEvaluator: makeBlockingEvaluator(),
			});

			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: 'planner',
					direction: 'one-way',
					gate: { type: 'condition', expression: 'exit 1' },
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
				title: 'Condition Gate Blocked',
			});
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			await expect(
				blockingRouter.deliverMessage(run.id, 'coder', 'planner', 'msg', {
					workspacePath: '/tmp/ws',
				})
			).rejects.toBeInstanceOf(ChannelGateBlockedError);
		});

		// -----------------------------------------------------------------------
		// Cyclic channels — iteration tracking
		// -----------------------------------------------------------------------

		test('cyclic channel: increments iterationCount on successful delivery', async () => {
			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: 'planner',
					direction: 'one-way',
					isCyclic: true,
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
				title: 'Cyclic Run',
				maxIterations: 5,
			});
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			// First delivery
			await router.deliverMessage(run.id, 'coder', 'planner', 'message 1');
			let freshRun = workflowRunRepo.getRun(run.id)!;
			expect(freshRun.iterationCount).toBe(1);

			// Cancel existing tasks to allow re-activation
			for (const t of taskRepo.listByWorkflowRun(run.id)) {
				taskRepo.updateTask(t.id, { status: 'cancelled' });
			}

			// Second delivery
			await router.deliverMessage(run.id, 'coder', 'planner', 'message 2');
			freshRun = workflowRunRepo.getRun(run.id)!;
			expect(freshRun.iterationCount).toBe(2);
		});

		test('cyclic channel: throws ActivationError when iteration cap is reached', async () => {
			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: 'planner',
					direction: 'one-way',
					isCyclic: true,
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
				title: 'Iteration Cap Run',
				maxIterations: 2,
			});
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			// Manually set iterationCount to the cap
			workflowRunRepo.updateRun(run.id, { iterationCount: 2 });

			await expect(
				router.deliverMessage(run.id, 'coder', 'planner', 'over the limit')
			).rejects.toBeInstanceOf(ActivationError);
			await expect(
				router.deliverMessage(run.id, 'coder', 'planner', 'over the limit')
			).rejects.toThrow(/maximum iteration count/);
		});

		test('non-cyclic channel: iterationCount stays unchanged', async () => {
			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: 'planner',
					direction: 'one-way',
					// isCyclic is NOT set
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
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			await router.deliverMessage(run.id, 'coder', 'planner', 'non-cyclic message');

			const freshRun = workflowRunRepo.getRun(run.id)!;
			expect(freshRun.iterationCount).toBe(0);
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
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			const result = await router.canDeliver(run.id, 'coder', 'planner', {
				workspacePath: '/tmp/ws',
			});
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
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			// coder→planner not declared; open topology for this pair
			const result = await router.canDeliver(run.id, 'coder', 'planner', {
				workspacePath: '/tmp/ws',
			});
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
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			const result = await router.canDeliver(run.id, 'coder', 'planner', {
				workspacePath: '/tmp/ws',
			});
			expect(result.allowed).toBe(true);
		});

		test('gate always: allowed', async () => {
			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: 'planner',
					direction: 'one-way',
					gate: { type: 'always' },
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
				title: 'Always Gate Run',
			});
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			const result = await router.canDeliver(run.id, 'coder', 'planner', {
				workspacePath: '/tmp/ws',
			});
			expect(result.allowed).toBe(true);
		});

		test('gate human: blocked without approval', async () => {
			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: 'planner',
					direction: 'one-way',
					gate: { type: 'human' },
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
				title: 'Human Gate Run',
			});
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			const blocked = await router.canDeliver(run.id, 'coder', 'planner', {
				workspacePath: '/tmp/ws',
				humanApproved: false,
			});
			expect(blocked.allowed).toBe(false);
			expect(blocked.reason).toMatch(/human approval/);
		});

		test('gate human: allowed with approval', async () => {
			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: 'planner',
					direction: 'one-way',
					gate: { type: 'human' },
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
				title: 'Human Gate Approved Run',
			});
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			const allowed = await router.canDeliver(run.id, 'coder', 'planner', {
				workspacePath: '/tmp/ws',
				humanApproved: true,
			});
			expect(allowed.allowed).toBe(true);
		});

		test('gate task_result: blocked on mismatch, allowed on match', async () => {
			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: 'planner',
					direction: 'one-way',
					gate: { type: 'task_result', expression: 'success' },
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
				title: 'Task Result Gate Run',
			});
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			const blocked = await router.canDeliver(run.id, 'coder', 'planner', {
				workspacePath: '/tmp/ws',
				taskResult: 'failure',
			});
			expect(blocked.allowed).toBe(false);
			expect(blocked.reason).toMatch(/failure/);

			const allowed = await router.canDeliver(run.id, 'coder', 'planner', {
				workspacePath: '/tmp/ws',
				taskResult: 'success: all tests passed',
			});
			expect(allowed.allowed).toBe(true);
		});

		test('cyclic channel: blocked when iterationCount >= maxIterations', async () => {
			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: 'planner',
					direction: 'one-way',
					isCyclic: true,
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
				title: 'Iteration Cap Run',
				maxIterations: 3,
			});
			workflowRunRepo.updateStatus(run.id, 'in_progress');
			workflowRunRepo.updateRun(run.id, { iterationCount: 3 });

			const result = await router.canDeliver(run.id, 'coder', 'planner', {
				workspacePath: '/tmp/ws',
			});
			expect(result.allowed).toBe(false);
			expect(result.reason).toMatch(/maximum iteration count/);
		});

		test('cyclic channel: allowed when below the cap', async () => {
			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: 'planner',
					direction: 'one-way',
					isCyclic: true,
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
				title: 'Below Cap Run',
				maxIterations: 5,
			});
			workflowRunRepo.updateStatus(run.id, 'in_progress');
			workflowRunRepo.updateRun(run.id, { iterationCount: 2 });

			const result = await router.canDeliver(run.id, 'coder', 'planner', {
				workspacePath: '/tmp/ws',
			});
			expect(result.allowed).toBe(true);
		});

		test('non-cyclic channel: iteration count does not block delivery', async () => {
			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: 'planner',
					direction: 'one-way',
					// isCyclic NOT set
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
				maxIterations: 1,
			});
			workflowRunRepo.updateStatus(run.id, 'in_progress');
			// Set iterationCount above maxIterations
			workflowRunRepo.updateRun(run.id, { iterationCount: 100 });

			const result = await router.canDeliver(run.id, 'coder', 'planner', {
				workspacePath: '/tmp/ws',
			});
			// Non-cyclic channel is not affected by iteration count
			expect(result.allowed).toBe(true);
		});

		test('canDeliver: throws ActivationError when run not found', async () => {
			await expect(
				router.canDeliver('nonexistent-run', 'coder', 'planner', { workspacePath: '/tmp/ws' })
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
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			// Disable FK enforcement, remap workflow_id to a nonexistent ID, then re-enable.
			db.exec('PRAGMA foreign_keys = OFF');
			db.prepare('UPDATE space_workflow_runs SET workflow_id = ? WHERE id = ?').run(
				'nonexistent-workflow-id',
				run.id
			);
			db.exec('PRAGMA foreign_keys = ON');

			await expect(
				router.canDeliver(run.id, 'coder', 'planner', { workspacePath: '/tmp/ws' })
			).rejects.toBeInstanceOf(ActivationError);
			await expect(
				router.canDeliver(run.id, 'coder', 'planner', { workspacePath: '/tmp/ws' })
			).rejects.toThrow(/Workflow not found/);
		});

		test('canDeliver: condition gate — allowed via mock evaluator (exit 0)', async () => {
			const allowingRouter = new ChannelRouter({
				taskRepo,
				workflowRunRepo,
				workflowManager,
				agentManager,
				gateEvaluator: makeAllowingEvaluator(),
			});

			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: 'planner',
					direction: 'one-way',
					gate: { type: 'condition', expression: 'test -f /some/file' },
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
				title: 'Condition Gate Allowed Run',
			});
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			const result = await allowingRouter.canDeliver(run.id, 'coder', 'planner', {
				workspacePath: '/tmp/ws',
			});
			expect(result.allowed).toBe(true);
		});

		test('canDeliver: condition gate — blocked via mock evaluator (exit 1)', async () => {
			const blockingRouter = new ChannelRouter({
				taskRepo,
				workflowRunRepo,
				workflowManager,
				agentManager,
				gateEvaluator: makeBlockingEvaluator(),
			});

			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: 'planner',
					direction: 'one-way',
					gate: { type: 'condition', expression: 'test -f /nonexistent' },
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
				title: 'Condition Gate Blocked Run',
			});
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			const result = await blockingRouter.canDeliver(run.id, 'coder', 'planner', {
				workspacePath: '/tmp/ws',
			});
			expect(result.allowed).toBe(false);
			expect(result.reason).toMatch(/condition expression exited/);
		});

		// -----------------------------------------------------------------------
		// Wildcard channel matching
		// -----------------------------------------------------------------------

		test('wildcard from: channel with from="*" matches any sender', async () => {
			const channels: WorkflowChannel[] = [
				{
					from: '*',
					to: 'planner',
					direction: 'one-way',
					gate: { type: 'human' },
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
				title: 'Wildcard From Run',
			});
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			// 'coder' is not the declared sender, but '*' should match it
			const blocked = await router.canDeliver(run.id, 'coder', 'planner', {
				workspacePath: '/tmp/ws',
				humanApproved: false,
			});
			expect(blocked.allowed).toBe(false);
			expect(blocked.reason).toMatch(/human approval/);
		});

		test('wildcard to: channel with to="*" matches any target', async () => {
			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: '*',
					direction: 'one-way',
					gate: { type: 'task_result', expression: 'pass' },
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
				title: 'Wildcard To Run',
			});
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			// 'planner' should be matched by '*'
			const blocked = await router.canDeliver(run.id, 'coder', 'planner', {
				workspacePath: '/tmp/ws',
				taskResult: 'fail',
			});
			expect(blocked.allowed).toBe(false);

			const allowed = await router.canDeliver(run.id, 'coder', 'planner', {
				workspacePath: '/tmp/ws',
				taskResult: 'pass: all tests green',
			});
			expect(allowed.allowed).toBe(true);
		});

		test('wildcard to: deliverMessage uses wildcard channel gate', async () => {
			const channels: WorkflowChannel[] = [
				{
					from: 'coder',
					to: '*',
					direction: 'one-way',
					gate: { type: 'human' },
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
				title: 'Wildcard Delivery Run',
			});
			workflowRunRepo.updateStatus(run.id, 'in_progress');

			// Wildcard channel gate blocks delivery without approval
			await expect(
				router.deliverMessage(run.id, 'coder', 'planner', 'msg', {
					workspacePath: '/tmp/ws',
					humanApproved: false,
				})
			).rejects.toBeInstanceOf(ChannelGateBlockedError);

			// Wildcard channel gate allows delivery with approval
			const result = await router.deliverMessage(run.id, 'coder', 'planner', 'msg', {
				workspacePath: '/tmp/ws',
				humanApproved: true,
			});
			expect(result.fromRole).toBe('coder');
		});
	});
});
