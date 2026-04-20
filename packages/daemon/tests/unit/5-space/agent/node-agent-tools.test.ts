/**
 * Unit tests for createNodeAgentToolHandlers()
 *
 * Covers all node agent peer communication tools:
 *   list_peers              — list peers excluding self and task-agent
 *   send_message            — channel-validated direct messaging + gate-write side-effect
 *   save                    — persist summary and/or structured data to NodeExecution
 *   list_channels           — enumerate declared channels
 *   read_gate / list_gates  — gate inspection
 *   list_reachable_agents   — cross-node reachability
 *
 * Tests use a real SQLite database (via runMigrations) and mock message
 * injectors so no real agent sessions are created.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { GateDataRepository } from '../../../../src/storage/repositories/gate-data-repository.ts';
import {
	createNodeAgentToolHandlers,
	createNodeAgentMcpServer,
	type NodeAgentToolsConfig,
} from '../../../../src/lib/space/tools/node-agent-tools.ts';
import { AgentMessageRouter } from '../../../../src/lib/space/runtime/agent-message-router.ts';
import { ChannelResolver } from '../../../../src/lib/space/runtime/channel-resolver.ts';
import type { SpaceWorkflow, Gate, WorkflowChannel } from '@neokai/shared';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-node-agent-tools',
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return { db, dir };
}

function seedSpaceRow(db: BunDatabase, spaceId: string): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, '/tmp', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
	).run(spaceId, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedSpaceWorkflowRunRow(
	db: BunDatabase,
	runId: string,
	spaceId: string,
	workflowId: string
): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO space_workflow_runs
     (id, space_id, workflow_id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, '', 'pending', ?, ?)`
	).run(runId, spaceId, workflowId, now, now);
}

/**
 * Creates a fresh workflow run and returns its ID.
 * Used by tests that need isolation from the default makeCtx() run.
 */
function makeFreshRunId(db: BunDatabase, spaceId: string): string {
	const runId = `run-${Math.random().toString(36).slice(2)}`;
	seedSpaceWorkflowRunRow(db, runId, spaceId, 'wf-seed');
	return runId;
}

function toNodeExecutionStatus(
	status: string
): 'pending' | 'in_progress' | 'idle' | 'blocked' | 'cancelled' {
	switch (status) {
		case 'pending':
		case 'open':
			return 'pending';
		case 'in_progress':
			return 'in_progress';
		case 'idle':
		case 'done':
		case 'completed':
			return 'idle';
		case 'blocked':
		case 'failed':
			return 'blocked';
		case 'cancelled':
			return 'cancelled';
		default:
			return 'in_progress';
	}
}

function seedSpaceTask(
	db: BunDatabase,
	spaceId: string,
	workflowRunId: string,
	workflowNodeId: string,
	agentName: string,
	status: string = 'in_progress',
	result: string | null = null,
	sessionId: string | null = null
): string {
	const id = `task-${Math.random().toString(36).slice(2)}`;
	const now = Date.now();
	db.exec('PRAGMA foreign_keys = OFF');
	db.prepare(
		`INSERT INTO space_tasks
         (id, space_id, task_number, title, description, status, priority, result,
          workflow_run_id, depends_on, created_at, updated_at)
         VALUES (?, ?, (SELECT COALESCE(MAX(task_number), 0) + 1 FROM space_tasks WHERE space_id = ?), ?, '', ?, 'normal', ?, ?, '[]', ?, ?)`
	).run(id, spaceId, spaceId, agentName, status, result, workflowRunId, now, now);
	if (sessionId) {
		db.prepare('UPDATE space_tasks SET task_agent_session_id = ? WHERE id = ?').run(sessionId, id);
	}
	db.exec('PRAGMA foreign_keys = ON');

	const nodeExecutionRepo = new NodeExecutionRepository(db);
	const execution = nodeExecutionRepo.createOrIgnore({
		workflowRunId,
		workflowNodeId,
		agentName,
		agentSessionId: sessionId,
		status: toNodeExecutionStatus(status),
	});
	nodeExecutionRepo.update(execution.id, {
		agentSessionId: sessionId,
		status: toNodeExecutionStatus(status),
		result,
	});

	return id;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeResolvedChannel(
	from: string,
	to: string,
	_isHubSpoke = false,
	_overrides: Record<string, unknown> = {}
): WorkflowChannel {
	return {
		id: `ch-${from}-${to}`,
		from,
		to,
	};
}

// ---------------------------------------------------------------------------
// Test context
// ---------------------------------------------------------------------------

interface TestCtx {
	db: BunDatabase;
	dir: string;
	spaceId: string;
	taskRepo: SpaceTaskRepository;
	taskManager: SpaceTaskManager;
	spaceTaskRepo: SpaceTaskRepository;
	nodeExecutionRepo: NodeExecutionRepository;
	/** Workflow run ID for peer task seeding. */
	workflowRunId: string;
	/** Workflow node ID for peer task seeding. */
	nodeId: string;
	coderSessionId: string;
	reviewerSessionId: string;
	taskAgentSessionId: string;
	/** ID of the parent (main) task seeded in the DB. */
	parentTaskId: string;
	/** ID of the step task seeded in the DB. */
	stepTaskId: string;
}

function makeCtx(): TestCtx {
	const { db, dir } = makeDb();
	const spaceId = 'space-node-tools-test';

	seedSpaceRow(db, spaceId);

	const taskRepo = new SpaceTaskRepository(db);
	const spaceTaskRepo = taskRepo;
	const taskManager = new SpaceTaskManager(db, spaceId);
	const nodeExecutionRepo = new NodeExecutionRepository(db);

	// Session IDs for peers
	const taskAgentSessionId = 'session-task-agent';
	const coderSessionId = 'session-coder';
	const reviewerSessionId = 'session-reviewer';

	// Workflow run/node IDs for peer task seeding
	const workflowRunId = 'run-node-tools-default';
	const nodeId = 'node-node-tools-default';

	// Seed workflow run so gate_data FK constraint is satisfied for write_gate tests
	seedSpaceWorkflowRunRow(db, workflowRunId, spaceId, 'wf-seed');

	// Seed peer tasks: coder and reviewer on the default node
	seedSpaceTask(db, spaceId, workflowRunId, nodeId, 'coder', 'in_progress', null, coderSessionId);
	seedSpaceTask(
		db,
		spaceId,
		workflowRunId,
		nodeId,
		'reviewer',
		'in_progress',
		null,
		reviewerSessionId
	);

	// Seed a parent task and a step task in the DB
	const parentTask = taskRepo.createTask({
		spaceId,
		title: 'Parent Task',
		description: '',
		status: 'in_progress',
	});
	const stepTask = taskRepo.createTask({
		spaceId,
		title: 'Step Task',
		description: '',
		status: 'in_progress',
	});

	return {
		db,
		dir,
		spaceId,
		taskRepo,
		taskManager,
		spaceTaskRepo,
		nodeExecutionRepo,
		workflowRunId,
		nodeId,
		coderSessionId,
		reviewerSessionId,
		taskAgentSessionId,
		parentTaskId: parentTask.id,
		stepTaskId: stepTask.id,
	};
}

type NodeConfigOverrides = Partial<NodeAgentToolsConfig> & {
	messageInjector?: (sessionId: string, message: string) => Promise<void>;
};

function makeConfig(ctx: TestCtx, overrides: NodeConfigOverrides = {}): NodeAgentToolsConfig {
	const { messageInjector, ...configOverrides } = overrides;
	const workflowRunId = configOverrides.workflowRunId ?? ctx.workflowRunId;
	const nodeExecutionRepo = configOverrides.nodeExecutionRepo ?? ctx.nodeExecutionRepo;
	const channelResolver = configOverrides.channelResolver ?? new ChannelResolver([]);
	const injector = messageInjector ?? (async () => {});
	const agentMessageRouter =
		configOverrides.agentMessageRouter ??
		new AgentMessageRouter({
			nodeExecutionRepo,
			workflowRunId,
			workflowChannels: channelResolver.getChannels(),
			messageInjector: injector,
		});

	return {
		mySessionId: ctx.coderSessionId,
		myAgentName: 'coder',
		taskId: ctx.parentTaskId,
		spaceId: ctx.spaceId,
		channelResolver,
		workflowRunId,
		workflowNodeId: ctx.nodeId,
		nodeExecutionRepo,
		agentMessageRouter,
		workflow: null,
		gateDataRepo: new GateDataRepository(ctx.db),
		...configOverrides,
	};
}

/**
 * Build a ChannelResolver directly from resolved channel entries.
 * Replaces the old seedWorkflowRunWithChannels + DB approach.
 */
function makeResolver(channels: WorkflowChannel[]): ChannelResolver {
	return new ChannelResolver(channels);
}

// ---------------------------------------------------------------------------
// Tests: list_peers
// ---------------------------------------------------------------------------

describe('node-agent-tools: list_peers', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns peers excluding self and task-agent', async () => {
		const config = makeConfig(ctx);
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.peers).toHaveLength(1); // only reviewer (coder=self, task-agent=excluded)
		expect(data.peers[0].agentName).toBe('reviewer');
		expect(data.peers[0].sessionId).toBe(ctx.reviewerSessionId);
		expect(data.myAgentName).toBe('coder');
	});

	test('reports no channel topology when none declared', async () => {
		const config = makeConfig(ctx);
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.channelTopologyDeclared).toBe(false);
		expect(data.permittedTargets).toEqual(['task-agent']);
	});

	test('reports permitted targets when channels declared', async () => {
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.channelTopologyDeclared).toBe(true);
		expect(data.permittedTargets).toEqual(['reviewer', 'task-agent']);
	});

	test('returns empty peer list when no peers in the run', async () => {
		// Use a fresh run that has only the coder task (self) — no reviewer
		const isolatedRunId = makeFreshRunId(ctx.db, ctx.spaceId);
		seedSpaceTask(
			ctx.db,
			ctx.spaceId,
			isolatedRunId,
			ctx.nodeId,
			'coder',
			'in_progress',
			null,
			ctx.coderSessionId
		);

		const config = makeConfig(ctx, { workflowRunId: isolatedRunId });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.peers).toHaveLength(0);
	});

	test('excludes open task with no session from peers list', async () => {
		// Seed an open task with no session — should not appear in peers
		const isolatedRunId = makeFreshRunId(ctx.db, ctx.spaceId);
		seedSpaceTask(ctx.db, ctx.spaceId, isolatedRunId, ctx.nodeId, 'tester', 'open', null);
		// Do NOT set task_agent_session_id — simulates not-yet-spawned task

		const config = makeConfig(ctx, { workflowRunId: isolatedRunId });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.peers).toHaveLength(0);
	});

	test('excludes failed task with no session from peers list', async () => {
		// A blocked task that never got a session should also be excluded
		const isolatedRunId = makeFreshRunId(ctx.db, ctx.spaceId);
		seedSpaceTask(
			ctx.db,
			ctx.spaceId,
			isolatedRunId,
			ctx.nodeId,
			'tester',
			'blocked',
			'Failed before session'
		);

		const config = makeConfig(ctx, { workflowRunId: isolatedRunId });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.peers).toHaveLength(0);
	});

	test('includes idle task with no session in peers list', async () => {
		// An idle task whose session was cleared should still appear for visibility
		// space_tasks uses 'done'; toNodeExecutionStatus maps it to 'idle' for node_executions
		const isolatedRunId = makeFreshRunId(ctx.db, ctx.spaceId);
		seedSpaceTask(ctx.db, ctx.spaceId, isolatedRunId, ctx.nodeId, 'tester', 'done', 'Done');
		// Do NOT set task_agent_session_id — simulates post-session cleanup

		const config = makeConfig(ctx, { workflowRunId: isolatedRunId });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.peers).toHaveLength(1);
		expect(data.peers[0].agentName).toBe('tester');
		expect(data.peers[0].sessionId).toBeNull();
		expect(data.peers[0].status).toBe('completed');
		expect(data.peers[0].completionState.completionSummary).toBe('Done');
	});
});

// ---------------------------------------------------------------------------
// Tests: send_message
// ---------------------------------------------------------------------------

describe('node-agent-tools: send_message', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('point-to-point succeeds when channel declared', async () => {
		const injected: Array<{ sessionId: string; message: string }> = [];
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
			messageInjector: async (sid, msg) => {
				injected.push({ sessionId: sid, message: msg });
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'reviewer', message: 'LGTM!' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.delivered).toHaveLength(1);
		expect(data.delivered[0].sessionId).toBe(ctx.reviewerSessionId);
		expect(data.delivered[0].agentName).toBe('reviewer');
		expect(injected).toHaveLength(1);
		expect(injected[0].message).toBe('[Message from coder]: LGTM!');
	});

	test('point-to-point fails when channel not declared', async () => {
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('reviewer', 'coder')]), // reverse direction only
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'reviewer', message: 'hello' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain("does not permit 'coder' to send to: reviewer");
		expect(data.unauthorizedAgentNames).toContain('reviewer');
	});

	test('returns error when no channels declared at all (empty topology blocks send_message)', async () => {
		const config = makeConfig(ctx); // no workflowRunId, no channels
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'reviewer', message: 'test' });
		const data = JSON.parse(result.content[0].text);

		// With no declared channels, send_message is unavailable.
		expect(data.success).toBe(false);
		expect(data.error).toContain('No channel topology declared');
	});

	test('broadcast (*) succeeds and delivers to all permitted targets', async () => {
		const injected: string[] = [];
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
			messageInjector: async (sid) => {
				injected.push(sid);
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: '*', message: 'broadcast!' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.delivered).toHaveLength(1);
		expect(injected).toContain(ctx.reviewerSessionId);
	});

	test('broadcast (*) fails when no channels declared', async () => {
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('reviewer', 'coder')]), // coder has no outgoing channels
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: '*', message: 'broadcast' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain("No permitted targets for agent 'coder'");
	});

	test('broadcast (*) with empty topology returns error', async () => {
		// No channels declared at all
		const config = makeConfig(ctx);
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: '*', message: 'broadcast' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('No channel topology declared');
	});

	test('multicast delivers to all specified target roles', async () => {
		// Add a security peer task
		seedSpaceTask(
			ctx.db,
			ctx.spaceId,
			ctx.workflowRunId,
			ctx.nodeId,
			'security',
			'in_progress',
			null,
			'session-security'
		);

		const injected: string[] = [];
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				makeResolvedChannel('coder', 'reviewer'),
				makeResolvedChannel('coder', 'security'),
			]),
			messageInjector: async (sid) => {
				injected.push(sid);
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({
			target: ['reviewer', 'security'],
			message: 'multicast!',
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.delivered).toHaveLength(2);
		expect(injected).toContain(ctx.reviewerSessionId);
		expect(injected).toContain('session-security');
	});

	test('multicast partial authorization fails with full error', async () => {
		// Add security peer task
		seedSpaceTask(
			ctx.db,
			ctx.spaceId,
			ctx.workflowRunId,
			ctx.nodeId,
			'security',
			'in_progress',
			null,
			'session-security'
		);
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				makeResolvedChannel('coder', 'reviewer'),
				// no coder → security channel
			]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({
			target: ['reviewer', 'security'],
			message: 'msg',
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.unauthorizedAgentNames).toContain('security');
	});

	test('hub-spoke: spoke cannot send to other spokes', async () => {
		// Hub-spoke topology: hub ↔ coder, hub ↔ reviewer (coder cannot send to reviewer directly)
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				makeResolvedChannel('hub', 'coder', true),
				makeResolvedChannel('coder', 'hub', true),
				makeResolvedChannel('hub', 'reviewer', true),
				makeResolvedChannel('reviewer', 'hub', true),
			]),
		}); // myAgentName='coder'
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'reviewer', message: 'hello' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain("does not permit 'coder' to send to: reviewer");
	});

	test('hub-spoke: spoke can reply to hub', async () => {
		// Add hub peer task
		seedSpaceTask(
			ctx.db,
			ctx.spaceId,
			ctx.workflowRunId,
			ctx.nodeId,
			'hub',
			'in_progress',
			null,
			'session-hub'
		);
		const injected: string[] = [];
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				makeResolvedChannel('hub', 'coder', true),
				makeResolvedChannel('coder', 'hub', true),
			]),
			messageInjector: async (sid) => {
				injected.push(sid);
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'hub', message: 'done!' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(injected).toContain('session-hub');
	});

	test('bidirectional: both directions work', async () => {
		// coder ↔ reviewer
		const biResolver = makeResolver([
			makeResolvedChannel('coder', 'reviewer'),
			makeResolvedChannel('reviewer', 'coder'),
		]);
		const injectedToReviewer: string[] = [];
		const config = makeConfig(ctx, {
			channelResolver: biResolver,
			messageInjector: async (sid) => {
				injectedToReviewer.push(sid);
			},
		});
		const handlers = createNodeAgentToolHandlers(config);

		// coder → reviewer
		const r1 = await handlers.send_message({ target: 'reviewer', message: 'code ready' });
		expect(JSON.parse(r1.content[0].text).success).toBe(true);

		// reviewer → coder (as reviewer)
		const configAsReviewer = makeConfig(ctx, {
			channelResolver: biResolver,
			mySessionId: ctx.reviewerSessionId,
			myAgentName: 'reviewer',
			messageInjector: async (sid) => {
				injectedToReviewer.push(sid);
			},
		});
		const handlersAsReviewer = createNodeAgentToolHandlers(configAsReviewer);
		const r2 = await handlersAsReviewer.send_message({ target: 'coder', message: 'approved' });
		expect(JSON.parse(r2.content[0].text).success).toBe(true);
	});

	test('returns unknown-target when role is not present in active peers', async () => {
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'tester')]), // tester is permitted by topology but not active
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'tester', message: 'test pls' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain("Unknown target 'tester'");
	});

	test('handles partial injection failures gracefully (partial success)', async () => {
		// In the new task-centric model, agent_name is unique per (run, node).
		// Partial success is tested via multicast to two different roles: reviewer + security.
		seedSpaceTask(
			ctx.db,
			ctx.spaceId,
			ctx.workflowRunId,
			ctx.nodeId,
			'security',
			'in_progress',
			null,
			'session-security'
		);
		let callCount = 0;
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				makeResolvedChannel('coder', 'reviewer'),
				makeResolvedChannel('coder', 'security'),
			]),
			messageInjector: async (_sid) => {
				callCount++;
				if (callCount === 1) throw new Error('injection failed');
				// second call succeeds
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({
			target: ['reviewer', 'security'],
			message: 'hello',
		});
		const data = JSON.parse(result.content[0].text);

		// Partial success — one delivered, one failed
		expect(data.success).toBe('partial');
		expect(data.delivered).toHaveLength(1);
		expect(data.failed).toHaveLength(1);
		// Both targets were attempted (best-effort, not stop-on-first-error)
		expect(callCount).toBe(2);
	});

	test('fails entirely when all injections fail', async () => {
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
			messageInjector: async () => {
				throw new Error('always fails');
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'reviewer', message: 'test' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.failed).toHaveLength(1);
		expect(data.delivered).toBeUndefined();
	});

	test('best-effort multicast: first delivery succeeds, second fails — partial success', async () => {
		// Add security peer task so we can send to two different non-task-agent roles
		seedSpaceTask(
			ctx.db,
			ctx.spaceId,
			ctx.workflowRunId,
			ctx.nodeId,
			'security',
			'in_progress',
			null,
			'session-security'
		);

		let callCount = 0;
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				makeResolvedChannel('coder', 'reviewer'),
				makeResolvedChannel('coder', 'security'),
			]),
			messageInjector: async (_sid, _msg) => {
				callCount++;
				if (callCount === 2) throw new Error('session not available');
			},
		});
		const handlers = createNodeAgentToolHandlers(config);

		const result = await handlers.send_message({
			target: ['reviewer', 'security'],
			message: 'Hello',
		});
		const data = JSON.parse(result.content[0].text);

		// Should NOT return success: false for total failure — it's partial
		expect(data.success).toBe('partial');
		expect(data.delivered).toHaveLength(1);
		expect(data.failed).toHaveLength(1);
		expect(data.failed[0].error).toContain('session not available');
		// Both targets were attempted (best-effort, not stop-on-first-error)
		expect(callCount).toBe(2);
	});

	test('best-effort multicast: all deliveries fail — success: false', async () => {
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
			messageInjector: async () => {
				throw new Error('all sessions unavailable');
			},
		});
		const handlers = createNodeAgentToolHandlers(config);

		const result = await handlers.send_message({ target: 'reviewer', message: 'Hello' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.delivered).toBeUndefined();
		expect(data.failed).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Tests: save
// ---------------------------------------------------------------------------

describe('node-agent-tools: save', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	function getCoderExecution() {
		return ctx.nodeExecutionRepo
			.listByNode(ctx.workflowRunId, ctx.nodeId)
			.find((e) => e.agentName === 'coder');
	}

	test('save({ summary }) persists summary to result field', async () => {
		const myExec = getCoderExecution();
		expect(myExec).toBeDefined();

		const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
		const result = await handlers.save({ summary: 'PR #42 merged.' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.executionId).toBe(myExec!.id);
		expect(data.agentName).toBe('coder');
		expect(data.savedSummary).toBe('PR #42 merged.');
		expect(data.savedData).toBeNull();

		const updated = ctx.nodeExecutionRepo.getById(myExec!.id);
		expect(updated?.result).toBe('PR #42 merged.');
		expect(updated?.data).toBeNull();
		expect(updated?.status).toBe('in_progress'); // save does not change status
	});

	test('save({ data }) persists data to data field', async () => {
		const myExec = getCoderExecution();
		expect(myExec).toBeDefined();

		const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
		const result = await handlers.save({ data: { prNumber: 42, merged: true } });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.savedSummary).toBeNull();
		expect(data.savedData).toEqual({ prNumber: 42, merged: true });

		const updated = ctx.nodeExecutionRepo.getById(myExec!.id);
		expect(updated?.data).toEqual({ prNumber: 42, merged: true });
		expect(updated?.result).toBeNull();
	});

	test('save({ summary, data }) persists both fields', async () => {
		const myExec = getCoderExecution();
		expect(myExec).toBeDefined();

		const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
		const result = await handlers.save({ summary: 'work done', data: { pr: 99 } });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.savedSummary).toBe('work done');
		expect(data.savedData).toEqual({ pr: 99 });

		const updated = ctx.nodeExecutionRepo.getById(myExec!.id);
		expect(updated?.result).toBe('work done');
		expect(updated?.data).toEqual({ pr: 99 });
	});

	test('multiple save calls overwrite previous values', async () => {
		const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
		const first = JSON.parse(
			(await handlers.save({ summary: 'first', data: { v: 1 } })).content[0].text
		);
		expect(first.success).toBe(true);

		const second = JSON.parse(
			(await handlers.save({ summary: 'second', data: { v: 2 } })).content[0].text
		);
		expect(second.success).toBe(true);

		const myExec = getCoderExecution();
		expect(myExec?.result).toBe('second');
		expect(myExec?.data).toEqual({ v: 2 });
	});

	test('returns error when NodeExecution not found for agent', async () => {
		const handlers = createNodeAgentToolHandlers(makeConfig(ctx, { myAgentName: 'ghost-agent' }));
		const result = await handlers.save({ summary: 'hello' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('NodeExecution not found');
		expect(data.error).toContain('ghost-agent');
	});

	test('returns error when neither summary nor data provided', async () => {
		const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
		const result = await handlers.save({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('At least one');
	});

	test('does not emit daemonHub events', async () => {
		const emitted: string[] = [];
		const fakeDaemonHub = {
			emit: async (name: string) => {
				emitted.push(name);
			},
		};

		const handlers = createNodeAgentToolHandlers(
			makeConfig(ctx, {
				daemonHub: fakeDaemonHub as unknown as NodeAgentToolsConfig['daemonHub'],
			})
		);
		const result = JSON.parse((await handlers.save({ summary: 'done' })).content[0].text);

		expect(result.success).toBe(true);
		expect(emitted).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Tests: list_channels
// ---------------------------------------------------------------------------

describe('node-agent-tools: list_channels', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns empty channels when workflow is null', async () => {
		const config = makeConfig(ctx, { workflow: null });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_channels({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.channels).toHaveLength(0);
		expect(data.total).toBe(0);
	});

	test('returns empty channels when workflow has no channels', async () => {
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [],
		};
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_channels({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.channels).toHaveLength(0);
	});

	test('returns channel with hasGate false when no inline gate', async () => {
		const channel: WorkflowChannel = {
			id: 'ch-1',
			from: 'coder',
			to: 'reviewer',
		};
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [channel],
		};
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_channels({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.channels).toHaveLength(1);
		expect(data.channels[0].channelId).toBe('ch-1');
		expect(data.channels[0].from).toBe('coder');
		expect(data.channels[0].to).toBe('reviewer');
		expect(data.channels[0].hasGate).toBe(false);
	});

	test('returns channel with hasGate true when inline gate present', async () => {
		const channel: WorkflowChannel = {
			id: 'ch-2',
			from: 'coder',
			to: 'reviewer',
			gateId: 'approval-gate',
		};
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [channel],
		};
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_channels({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.channels).toHaveLength(1);
		expect(data.channels[0].hasGate).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tests: list_gates
// ---------------------------------------------------------------------------

describe('node-agent-tools: list_gates', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns empty gates when workflow is null', async () => {
		const config = makeConfig(ctx, { workflow: null });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_gates({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.gates).toHaveLength(0);
		expect(data.nodeId).toBe(ctx.nodeId);
	});

	test('returns empty gates when workflow has no gates', async () => {
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [],
			gates: [],
		};
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_gates({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.gates).toHaveLength(0);
	});

	test('returns gate with default data when no runtime data exists', async () => {
		const gate: Gate = {
			id: 'gate-approval',
			fields: [
				{
					name: 'approved',
					type: 'boolean',
					writers: [],
					check: { op: '==', value: true },
				},
			],
			resetOnCycle: false,
		};
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [],
			gates: [gate],
		};
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_gates({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.gates).toHaveLength(1);
		expect(data.gates[0].gateId).toBe('gate-approval');
		expect(data.gates[0].currentData).toEqual({});
		expect(data.gates[0].fields).toHaveLength(1);
		expect(data.gates[0].fields[0].name).toBe('approved');
		expect(data.nodeId).toBe(ctx.nodeId);
	});

	test('returns gate with runtime data overriding defaults', async () => {
		const gate: Gate = {
			id: 'gate-vote',
			fields: [
				{
					name: 'votes',
					type: 'map',
					writers: ['*'],
					check: { op: 'count', match: 'approved', min: 2 },
				},
			],
			resetOnCycle: false,
		};
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [],
			gates: [gate],
		};
		// Pre-write some runtime data
		const gateDataRepo = new GateDataRepository(ctx.db);
		gateDataRepo.merge(ctx.workflowRunId, 'gate-vote', {
			votes: { 'node-a': 'approved', 'node-b': 'approved' },
		});

		const config = makeConfig(ctx, { workflow, gateDataRepo });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_gates({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.gates).toHaveLength(1);
		expect(data.gates[0].currentData).toEqual({
			votes: { 'node-a': 'approved', 'node-b': 'approved' },
		});
	});
});

// ---------------------------------------------------------------------------
// Tests: read_gate
// ---------------------------------------------------------------------------

describe('node-agent-tools: read_gate', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns error for non-existent gateId', async () => {
		const gate: Gate = {
			id: 'gate-real',
			fields: [{ name: 'x', type: 'number', writers: [], check: { op: '==', value: 1 } }],
			resetOnCycle: false,
		};
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [],
			gates: [gate],
		};
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.read_gate({ gateId: 'gate-does-not-exist' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('not found');
		expect(data.availableGateIds).toEqual(['gate-real']);
	});

	test('returns gate data and open status for existing gate (closed)', async () => {
		const gate: Gate = {
			id: 'gate-check',
			fields: [
				{ name: 'ready', type: 'boolean', writers: ['coder'], check: { op: '==', value: true } },
			],
			resetOnCycle: false,
		};
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [],
			gates: [gate],
		};
		const gateDataRepo = new GateDataRepository(ctx.db);
		gateDataRepo.set(ctx.workflowRunId, 'gate-check', { ready: false });
		const config = makeConfig(ctx, { workflow, gateDataRepo });
		const handlers = createNodeAgentToolHandlers(config);

		const result = await handlers.read_gate({ gateId: 'gate-check' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.gateId).toBe('gate-check');
		expect(data.data).toEqual({ ready: false });
		expect(data.gateOpen).toBe(false);
	});

	test('returns gate data and open status for existing gate (open)', async () => {
		const gate: Gate = {
			id: 'gate-open',
			fields: [{ name: 'status', type: 'string', writers: [], check: { op: '==', value: 'go' } }],
			resetOnCycle: false,
		};
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [],
			gates: [gate],
		};
		const gateDataRepo = new GateDataRepository(ctx.db);
		gateDataRepo.set(ctx.workflowRunId, 'gate-open', { status: 'go' });
		const config = makeConfig(ctx, { workflow, gateDataRepo });
		const handlers = createNodeAgentToolHandlers(config);

		const result = await handlers.read_gate({ gateId: 'gate-open' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.gateOpen).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tests: send_message (gate-write)
// ---------------------------------------------------------------------------

describe('node-agent-tools: send_message (gate-write)', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	/** Build a workflow with a gated channel from coder → reviewer. */
	function makeWorkflowWithGatedChannel(gate: Gate): SpaceWorkflow {
		return {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [{ id: 'ch-coder-reviewer', from: 'coder', to: 'reviewer', gateId: gate.id }],
			gates: [gate],
		};
	}

	test('gate-write occurs and gateWrite returned in response when data provided on gated channel', async () => {
		const gate: Gate = {
			id: 'gate-writable',
			fields: [{ name: 'x', type: 'string', writers: ['coder'], check: { op: 'exists' } }],
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGatedChannel(gate);
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);

		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'hi',
			data: { x: 'val' },
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.gateWrite).toBeDefined();
		expect(data.gateWrite.gateId).toBe('gate-writable');
		expect(data.gateWrite.gateOpen).toBe(true);
	});

	test('no gateWrite in response when data not provided', async () => {
		const gate: Gate = {
			id: 'gate-no-data',
			fields: [{ name: 'x', type: 'string', writers: ['coder'], check: { op: 'exists' } }],
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGatedChannel(gate);
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);

		const result = await handlers.send_message({ target: 'reviewer', message: 'hi' });
		const data = JSON.parse(result.content[0].text);

		expect(data.gateWrite).toBeUndefined();
	});

	test('no gateWrite when channel has no gateId', async () => {
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [{ id: 'ch-open', from: 'coder', to: 'reviewer' }],
			gates: [],
		};
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);

		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'hi',
			data: { x: 1 },
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.gateWrite).toBeUndefined();
	});

	test('only authorized fields are merged into gate', async () => {
		const gate: Gate = {
			id: 'gate-auth',
			fields: [
				{ name: 'approved', type: 'string', writers: ['coder'], check: { op: 'exists' } },
				{ name: 'score', type: 'string', writers: ['reviewer'], check: { op: 'exists' } },
			],
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGatedChannel(gate);
		const gateDataRepo = new GateDataRepository(ctx.db);
		const config = makeConfig(ctx, { workflow, gateDataRepo });
		const handlers = createNodeAgentToolHandlers(config);

		// coder can write 'approved' but not 'score'
		await handlers.send_message({
			target: 'reviewer',
			message: 'hi',
			data: { approved: 'yes', score: '10' },
		});

		const record = gateDataRepo.get(ctx.workflowRunId, 'gate-auth');
		expect(record?.data.approved).toBe('yes');
		expect(record?.data.score).toBeUndefined();
	});

	test('gate is closed when only partial conditions met', async () => {
		const gate: Gate = {
			id: 'gate-partial',
			fields: [
				{ name: 'a', type: 'string', writers: ['coder'], check: { op: 'exists' } },
				{ name: 'b', type: 'string', writers: ['coder'], check: { op: 'exists' } },
			],
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGatedChannel(gate);
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);

		// Only provide 'a', missing 'b'
		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'hi',
			data: { a: '1' },
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.gateWrite.gateOpen).toBe(false);
	});

	test('gate opens once all conditions satisfied across multiple sends', async () => {
		const gate: Gate = {
			id: 'gate-accumulate',
			fields: [
				{ name: 'x', type: 'string', writers: ['coder'], check: { op: 'exists' } },
				{ name: 'y', type: 'string', writers: ['coder'], check: { op: 'exists' } },
			],
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGatedChannel(gate);
		const gateDataRepo = new GateDataRepository(ctx.db);
		const config = makeConfig(ctx, { workflow, gateDataRepo });
		const handlers = createNodeAgentToolHandlers(config);

		// First send: x only — gate still closed
		const r1 = await handlers.send_message({
			target: 'reviewer',
			message: 'hi',
			data: { x: 'val1' },
		});
		expect(JSON.parse(r1.content[0].text).gateWrite.gateOpen).toBe(false);

		// Second send: y — gate now opens (both x and y satisfied)
		const r2 = await handlers.send_message({
			target: 'reviewer',
			message: 'hi',
			data: { y: 'val2' },
		});
		expect(JSON.parse(r2.content[0].text).gateWrite.gateOpen).toBe(true);

		const record = gateDataRepo.get(ctx.workflowRunId, 'gate-accumulate');
		expect(record?.data.x).toBe('val1');
		expect(record?.data.y).toBe('val2');
	});

	test('onGateDataChanged fires after gate-write via send_message', async () => {
		const gate: Gate = {
			id: 'gate-callback',
			fields: [{ name: 'ready', type: 'string', writers: ['*'], check: { op: 'exists' } }],
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGatedChannel(gate);
		const calls: Array<{ runId: string; gateId: string }> = [];
		const config = makeConfig(ctx, {
			workflow,
			onGateDataChanged: async (runId, gateId) => {
				calls.push({ runId, gateId });
			},
		});
		const handlers = createNodeAgentToolHandlers(config);

		await handlers.send_message({ target: 'reviewer', message: 'hi', data: { ready: true } });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(calls).toHaveLength(1);
		expect(calls[0].runId).toBe(ctx.workflowRunId);
		expect(calls[0].gateId).toBe('gate-callback');
	});

	test('daemonHub emits space.gateData.updated after gate-write via send_message', async () => {
		const gate: Gate = {
			id: 'gate-event',
			fields: [{ name: 'ready', type: 'string', writers: ['*'], check: { op: 'exists' } }],
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGatedChannel(gate);
		const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];
		const fakeDaemonHub = {
			emit: async (name: string, payload: unknown) => {
				emitted.push({ name, payload: payload as Record<string, unknown> });
			},
		};
		const config = makeConfig(ctx, {
			workflow,
			daemonHub: fakeDaemonHub as unknown as NodeAgentToolsConfig['daemonHub'],
		});
		const handlers = createNodeAgentToolHandlers(config);

		await handlers.send_message({ target: 'reviewer', message: 'hi', data: { ready: true } });
		await new Promise((resolve) => setTimeout(resolve, 0));

		const gateEvent = emitted.find((e) => e.name === 'space.gateData.updated');
		expect(gateEvent).toBeDefined();
		expect(gateEvent!.payload.gateId).toBe('gate-event');
	});
});

describe('node-agent-tools: list_reachable_agents', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns within-node peers excluding self and task-agent', async () => {
		const config = makeConfig(ctx);
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.myAgentName).toBe('coder');
		expect(data.withinNodePeers).toHaveLength(1);
		expect(data.withinNodePeers[0].agentName).toBe('reviewer');
		expect(data.withinNodePeers[0].status).toBe('active');
	});

	test('returns empty cross-node targets when no channels declared', async () => {
		const config = makeConfig(ctx);
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.reachabilityDeclared).toBe(false);
		expect(data.crossNodeTargets).toHaveLength(0);
	});

	test('returns cross-node targets for channels to roles not in current group', async () => {
		// 'tester' is not a member of the session group — cross-node target
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'tester')]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.reachabilityDeclared).toBe(true);
		expect(data.crossNodeTargets).toHaveLength(1);
		expect(data.crossNodeTargets[0].nodeName).toBe('tester');
		// isFanOut removed from cross-node targets (fan-out is determined by array 'to')
	});

	test('within-node peer with a channel does not appear in cross-node targets', async () => {
		// 'reviewer' is in the session group — stays in withinNodePeers, not crossNodeTargets
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.withinNodePeers).toHaveLength(1);
		expect(data.withinNodePeers[0].agentName).toBe('reviewer');
		expect(data.crossNodeTargets).toHaveLength(0);
	});

	test('gate type none when no gate on cross-node channel', async () => {
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'tester')]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.crossNodeTargets[0].gate.type).toBe('none');
		expect(data.crossNodeTargets[0].gate.isGated).toBe(false);
	});

	test('gate type check: isGated true', async () => {
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			gates: [
				{
					id: 'approval-gate',
					fields: [
						{ name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
					],
					resetOnCycle: false,
				},
			],
		};
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				{ id: 'ch-1', from: 'coder', to: 'tester', gateId: 'approval-gate' },
			]),
			workflow,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.crossNodeTargets[0].gate.type).toBe('check');
		expect(data.crossNodeTargets[0].gate.isGated).toBe(true);
	});

	test('gate type count: isGated true', async () => {
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			gates: [
				{
					id: 'vote-gate',
					fields: [
						{
							name: 'votes',
							type: 'map',
							writers: ['*'],
							check: { op: 'count', match: 'approved', min: 2 },
						},
					],
					resetOnCycle: false,
				},
			],
		};
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				{ id: 'ch-1', from: 'coder', to: 'tester', gateId: 'vote-gate' },
			]),
			workflow,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.crossNodeTargets[0].gate.type).toBe('count');
		expect(data.crossNodeTargets[0].gate.isGated).toBe(true);
	});

	test('no gateId on channel: isGated false', async () => {
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
		};
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'tester')]),
			workflow,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.crossNodeTargets[0].gate.type).toBe('none');
		expect(data.crossNodeTargets[0].gate.isGated).toBe(false);
	});

	test('gate description propagated when present', async () => {
		const workflow: SpaceWorkflow = {
			id: 'wf-1',
			spaceId: ctx.spaceId,
			name: 'Test Workflow',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			gates: [
				{
					id: 'lead-gate',
					description: 'Needs tech lead approval',
					fields: [
						{ name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
					],
					resetOnCycle: false,
				},
			],
		};
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				{ id: 'ch-1', from: 'coder', to: 'tester', gateId: 'lead-gate' },
			]),
			workflow,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.crossNodeTargets[0].gate.description).toBe('Needs tech lead approval');
	});

	test('fan-out target marked as isFanOut true', async () => {
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				makeResolvedChannel('coder', 'qa-node', false, { isFanOut: true }),
			]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.crossNodeTargets).toHaveLength(1);
		expect(data.crossNodeTargets[0].nodeName).toBe('qa-node');
		// isFanOut removed - channel to[] array already indicates fan-out
	});

	test('deduplicates cross-node targets from multiple channels to same role', async () => {
		// Two channels to 'tester' (e.g. from bidirectional expansion) — should appear once
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				makeResolvedChannel('coder', 'tester'),
				makeResolvedChannel('coder', 'tester'), // duplicate
			]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.crossNodeTargets).toHaveLength(1);
	});

	test('only includes outgoing channels (fromRole matches myAgentName)', async () => {
		// Channel from 'tester' → 'coder' should NOT appear as a cross-node target for coder
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('tester', 'coder')]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.crossNodeTargets).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Tests: createNodeAgentMcpServer (factory)
// ---------------------------------------------------------------------------

describe('node-agent-tools: createNodeAgentMcpServer', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('creates an MCP server with expected tools', () => {
		const config = makeConfig(ctx);
		const server = createNodeAgentMcpServer(config);

		// Server should be an object with a server property (MCP SDK server)
		expect(server).toBeDefined();
		expect(typeof server).toBe('object');
	});
});

describe('node-agent-tools: system prompt uses only visible prompt text', () => {
	test('buildCustomAgentSystemPrompt returns configured text only', async () => {
		const { buildCustomAgentSystemPrompt } = await import(
			'../../../../src/lib/space/agents/custom-agent.ts'
		);

		const prompt = buildCustomAgentSystemPrompt({
			id: 'agent-1',
			spaceId: 'space-1',
			name: 'Coder',
			customPrompt: 'Visible workflow prompt',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		expect(prompt).toBe('Visible workflow prompt');
	});
});

// ---------------------------------------------------------------------------
// Tests: list_peers — completion state
// ---------------------------------------------------------------------------

describe('list_peers — completion state', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('list_peers includes completionState for each peer based on space_tasks', async () => {
		const workflowNodeId = 'node-abc';
		const workflowRunId = 'run-test-abc';

		seedSpaceWorkflowRunRow(ctx.db, workflowRunId, ctx.spaceId, 'wf-seed');

		// Seed a completed task for the reviewer peer
		// space_tasks uses 'done'; toNodeExecutionStatus maps it to 'idle' for node_executions
		seedSpaceTask(
			ctx.db,
			ctx.spaceId,
			workflowRunId,
			workflowNodeId,
			'reviewer',
			'done',
			'All looks good!'
		);

		const config = makeConfig(ctx, {
			workflowRunId,
			workflowNodeId,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		const reviewerPeer = data.peers.find((p: { agentName: string }) => p.agentName === 'reviewer');
		expect(reviewerPeer).toBeDefined();
		expect(reviewerPeer.completionState).not.toBeNull();
		expect(reviewerPeer.completionState.taskStatus).toBe('idle');
		expect(reviewerPeer.completionState.completionSummary).toBe('All looks good!');
		expect(reviewerPeer.completionState.agentName).toBe('reviewer');
	});

	test('list_peers shows nodeCompletionState for all tasks on the node', async () => {
		const workflowNodeId = 'node-xyz';
		const workflowRunId = 'run-test-xyz';

		seedSpaceWorkflowRunRow(ctx.db, workflowRunId, ctx.spaceId, 'wf-seed');

		// Seed tasks for both coder and reviewer on the same node
		seedSpaceTask(ctx.db, ctx.spaceId, workflowRunId, workflowNodeId, 'coder', 'in_progress', null);
		// space_tasks uses 'done'; toNodeExecutionStatus maps it to 'idle' for node_executions
		seedSpaceTask(
			ctx.db,
			ctx.spaceId,
			workflowRunId,
			workflowNodeId,
			'reviewer',
			'done',
			'Review done'
		);

		const config = makeConfig(ctx, {
			workflowRunId,
			workflowNodeId,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(Array.isArray(data.nodeCompletionState)).toBe(true);
		expect(data.nodeCompletionState).toHaveLength(2);

		const coderState = data.nodeCompletionState.find(
			(s: { agentName: string }) => s.agentName === 'coder'
		);
		expect(coderState).toBeDefined();
		expect(coderState.taskStatus).toBe('in_progress');

		const reviewerState = data.nodeCompletionState.find(
			(s: { agentName: string }) => s.agentName === 'reviewer'
		);
		expect(reviewerState).toBeDefined();
		expect(reviewerState.taskStatus).toBe('idle');
		expect(reviewerState.completionSummary).toBe('Review done');
	});

	test('list_peers works without space_tasks (no tasks on node)', async () => {
		const workflowNodeId = 'node-empty';
		const workflowRunId = 'run-test-empty';

		// No tasks seeded for this node
		const config = makeConfig(ctx, {
			workflowRunId,
			workflowNodeId,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.nodeCompletionState).toHaveLength(0);
		// All peers should have null completionState
		for (const peer of data.peers) {
			expect(peer.completionState).toBeNull();
		}
	});
});

// ---------------------------------------------------------------------------
// Tests: async gate evaluation (scriptExecutor + scriptContext)
// ---------------------------------------------------------------------------

describe('node-agent-tools: async gate evaluation', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	/**
	 * Build a workflow with a gated channel from coder → reviewer.
	 * Used by tests that drive gate-write via send_message.
	 */
	function makeWorkflowWithGate(gate: Gate, spaceId: string): SpaceWorkflow {
		return {
			id: 'wf-1',
			spaceId,
			name: 'Test Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [{ id: 'ch-coder-reviewer', from: 'coder', to: 'reviewer', gateId: gate.id }],
			gates: [gate],
		};
	}

	test('send_message gate-write uses scriptExecutor when provided (script passes)', async () => {
		const gate: Gate = {
			id: 'gate-script-pass',
			fields: [
				{ name: 'ready', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
			],
			script: {
				interpreter: 'bash',
				source: 'echo "ok"',
			},
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGate(gate, ctx.spaceId);

		// Script executor that returns success with merged data
		const mockExecutor = async () => ({
			success: true,
			data: { ready: true },
			error: undefined,
		});

		const config = makeConfig(ctx, {
			workflow,
			scriptExecutor: mockExecutor,
			scriptContext: {
				workspacePath: '/tmp',
				runId: ctx.workflowRunId,
				gateId: 'gate-script-pass',
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'hi',
			data: { ready: true },
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.gateWrite).toBeDefined();
		expect(data.gateWrite.gateOpen).toBe(true);
	});

	test('send_message gate-write uses scriptExecutor when provided (script fails)', async () => {
		const gate: Gate = {
			id: 'gate-script-fail',
			fields: [{ name: 'x', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
			script: {
				interpreter: 'bash',
				source: 'exit 1',
			},
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGate(gate, ctx.spaceId);

		const mockExecutor = async () => ({
			success: false,
			data: {},
			error: 'Script check failed: exit code 1',
		});

		const config = makeConfig(ctx, {
			workflow,
			scriptExecutor: mockExecutor,
			scriptContext: {
				workspacePath: '/tmp',
				runId: ctx.workflowRunId,
				gateId: 'gate-script-fail',
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'hi',
			data: { x: true },
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.gateWrite).toBeDefined();
		expect(data.gateWrite.gateOpen).toBe(false);
	});

	test('send_message gate-write emits space.gateData.updated when script fails', async () => {
		const gate: Gate = {
			id: 'gate-event',
			fields: [{ name: 'x', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
			script: {
				interpreter: 'bash',
				source: 'exit 1',
			},
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGate(gate, ctx.spaceId);

		const mockExecutor = async () => ({
			success: false,
			data: {},
			error: 'Script failed',
		});

		const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];
		const fakeDaemonHub = {
			emit: async (name: string, payload: unknown) => {
				emitted.push({ name, payload: payload as Record<string, unknown> });
			},
		};

		const config = makeConfig(ctx, {
			workflow,
			scriptExecutor: mockExecutor,
			scriptContext: { workspacePath: '/tmp', runId: ctx.workflowRunId, gateId: 'gate-event' },
			daemonHub: fakeDaemonHub as unknown as NodeAgentToolsConfig['daemonHub'],
		});
		const handlers = createNodeAgentToolHandlers(config);
		await handlers.send_message({ target: 'reviewer', message: 'hi', data: { x: true } });

		// Allow microtasks to flush
		await new Promise((resolve) => setTimeout(resolve, 0));

		const gateEvent = emitted.find((e) => e.name === 'space.gateData.updated');
		expect(gateEvent).toBeDefined();
		expect(gateEvent!.payload.gateId).toBe('gate-event');
	});

	test('read_gate uses scriptExecutor when provided', async () => {
		const gate: Gate = {
			id: 'gate-read-script',
			fields: [],
			script: {
				interpreter: 'bash',
				source: 'exit 1',
			},
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGate(gate, ctx.spaceId);

		const mockExecutor = async () => ({
			success: false,
			data: {},
			error: 'Script failed',
		});

		const config = makeConfig(ctx, {
			workflow,
			scriptExecutor: mockExecutor,
			scriptContext: {
				workspacePath: '/tmp',
				runId: ctx.workflowRunId,
				gateId: 'gate-read-script',
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.read_gate({ gateId: 'gate-read-script' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.gateOpen).toBe(false);
		expect(data.reason).toContain('Script check failed');
	});

	test('read_gate without scriptExecutor reports script-only gate as open', async () => {
		const gate: Gate = {
			id: 'gate-read-no-exec',
			fields: [],
			script: {
				interpreter: 'bash',
				source: 'echo "should not run"',
			},
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGate(gate, ctx.spaceId);

		// No scriptExecutor provided — script-only gates report as open (documented limitation)
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.read_gate({ gateId: 'gate-read-no-exec' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.gateOpen).toBe(true);
	});

	test('send_message gate-write without scriptExecutor skips script check and opens gate on field pass', async () => {
		const gate: Gate = {
			id: 'gate-write-no-exec',
			fields: [{ name: 'x', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
			script: {
				interpreter: 'bash',
				source: 'echo "should not run"',
			},
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGate(gate, ctx.spaceId);

		// No scriptExecutor provided — script check is skipped, field check alone opens gate
		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'hi',
			data: { x: true },
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.gateWrite).toBeDefined();
		expect(data.gateWrite.gateOpen).toBe(true);
	});

	test('scriptExecutor receives correct context with gateId via send_message', async () => {
		const gate: Gate = {
			id: 'gate-context-check',
			fields: [
				{ name: 'ready', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
			],
			script: {
				interpreter: 'bash',
				source: 'echo "ok"',
			},
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGate(gate, ctx.spaceId);

		let receivedContext: { workspacePath: string; runId: string; gateId: string } | null = null;
		const mockExecutor = async (
			_script: import('@neokai/shared').GateScript,
			context: { workspacePath: string; runId: string; gateId: string }
		) => {
			receivedContext = context;
			return { success: true, data: { ready: true }, error: undefined };
		};

		const config = makeConfig(ctx, {
			workflow,
			scriptExecutor: mockExecutor,
			scriptContext: { workspacePath: '/my-workspace', runId: 'run-123', gateId: '' },
		});
		const handlers = createNodeAgentToolHandlers(config);
		await handlers.send_message({ target: 'reviewer', message: 'hi', data: { ready: true } });

		expect(receivedContext).not.toBeNull();
		expect(receivedContext!.workspacePath).toBe('/my-workspace');
		expect(receivedContext!.runId).toBe('run-123');
		// gateId should be overridden per-gate inside the send_message handler
		expect(receivedContext!.gateId).toBe('gate-context-check');
	});

	test('send_message with script-only gated channel does not perform gate-write (no declared fields)', async () => {
		// Script-only gates have no declared fields, so all data keys are filtered out
		// at the field authorization layer — authorizedData stays empty, gate-write is skipped.
		const gate: Gate = {
			id: 'gate-script-only-no-write',
			script: {
				interpreter: 'bash',
				source: 'echo "ok"',
			},
			resetOnCycle: false,
		};
		const workflow = makeWorkflowWithGate(gate, ctx.spaceId);

		const config = makeConfig(ctx, { workflow });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'hi',
			data: { anyKey: 'val' },
		});
		const data = JSON.parse(result.content[0].text);

		// Gate-write is silently skipped — no gateWrite field in response
		expect(data.gateWrite).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Tests: restore_node_agent (self-heal primitive)
// ---------------------------------------------------------------------------

describe('node-agent-tools: restore_node_agent', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns success with session/agent identity even without onRestoreNodeAgent callback', async () => {
		const config = makeConfig(ctx);
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.restore_node_agent({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.sessionId).toBe(ctx.coderSessionId);
		expect(data.agentName).toBe('coder');
		expect(typeof data.message).toBe('string');
		expect(data.message).toContain('node-agent MCP server is registered');
	});

	test('invokes onRestoreNodeAgent callback with the supplied reason', async () => {
		const captured: Array<{ reason?: string }> = [];
		const config = makeConfig(ctx, {
			onRestoreNodeAgent: (args) => {
				captured.push(args);
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		await handlers.restore_node_agent({ reason: 'previous send_message returned No such tool' });

		expect(captured).toHaveLength(1);
		expect(captured[0]!.reason).toBe('previous send_message returned No such tool');
	});

	test('still returns success when the onRestoreNodeAgent callback throws', async () => {
		const config = makeConfig(ctx, {
			onRestoreNodeAgent: () => {
				throw new Error('reattach failed');
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.restore_node_agent({ reason: 'diagnostic' });
		const data = JSON.parse(result.content[0].text);

		// The tool MUST report success — calling it at all proves node-agent is registered.
		// Server-side reattach failures are logged but must not block the agent's recovery flow.
		expect(data.success).toBe(true);
		expect(data.sessionId).toBe(ctx.coderSessionId);
	});

	test('awaits async onRestoreNodeAgent callback before returning', async () => {
		let resolved = false;
		const config = makeConfig(ctx, {
			onRestoreNodeAgent: async () => {
				await new Promise((r) => setTimeout(r, 10));
				resolved = true;
			},
		});
		const handlers = createNodeAgentToolHandlers(config);
		await handlers.restore_node_agent({});

		expect(resolved).toBe(true);
	});

	test('createNodeAgentMcpServer registers restore_node_agent tool', () => {
		const config = makeConfig(ctx);
		const server = createNodeAgentMcpServer(config);
		const registered = Object.keys(
			(server as unknown as { instance: { _registeredTools: Record<string, unknown> } }).instance
				._registeredTools
		);
		expect(registered).toContain('restore_node_agent');
	});
});

// ---------------------------------------------------------------------------
// Tests: send_message (review-posted-gate artifact append)
// ---------------------------------------------------------------------------

describe('node-agent-tools: review-posted-gate multi-round artifact history', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	/**
	 * Build a workflow with a single Review → Coding channel gated by the
	 * production review-posted-gate definition. The sender is the reviewer,
	 * matching the real coding workflow layout.
	 */
	function makeReviewPostedWorkflow(): SpaceWorkflow {
		const gate: Gate = {
			id: 'review-posted-gate',
			fields: [
				{ name: 'review_url', type: 'string', writers: ['reviewer'], check: { op: 'exists' } },
			],
			resetOnCycle: true,
		};
		return {
			id: 'wf-review-posted',
			spaceId: ctx.spaceId,
			name: 'Test Coding Workflow',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [
				{ id: 'ch-review-coder', from: 'reviewer', to: 'coder', gateId: 'review-posted-gate' },
			],
			gates: [gate],
		};
	}

	test('appends one review artifact per cycle with cycle 0, 1, 2 across 3 rounds', async () => {
		const { WorkflowRunArtifactRepository } = await import(
			'../../../../src/storage/repositories/workflow-run-artifact-repository.ts'
		);
		const artifactRepo = new WorkflowRunArtifactRepository(ctx.db);

		const workflow = makeReviewPostedWorkflow();
		const config = makeConfig(ctx, {
			workflow,
			myAgentName: 'reviewer',
			mySessionId: ctx.reviewerSessionId,
			artifactRepo,
		});
		const handlers = createNodeAgentToolHandlers(config);

		// Round 1
		const r1 = await handlers.send_message({
			target: 'coder',
			message: 'Round 1 — please fix retry logic',
			data: {
				review_url: 'https://github.com/acme/app/pull/42#pullrequestreview-1',
				comment_urls: ['https://github.com/acme/app/pull/42#discussion_r1001'],
			},
		});
		expect(JSON.parse(r1.content[0].text).gateWrite.gateOpen).toBe(true);

		// Round 2
		const r2 = await handlers.send_message({
			target: 'coder',
			message: 'Round 2 — edge case still broken',
			data: {
				review_url: 'https://github.com/acme/app/pull/42#pullrequestreview-2',
				comment_urls: [
					'https://github.com/acme/app/pull/42#discussion_r1002',
					'https://github.com/acme/app/pull/42#discussion_r1003',
				],
			},
		});
		expect(JSON.parse(r2.content[0].text).gateWrite.gateOpen).toBe(true);

		// Round 3
		const r3 = await handlers.send_message({
			target: 'coder',
			message: 'Round 3 — tests missing',
			data: {
				review_url: 'https://github.com/acme/app/pull/42#pullrequestreview-3',
				comment_urls: [],
			},
		});
		expect(JSON.parse(r3.content[0].text).gateWrite.gateOpen).toBe(true);

		const artifacts = artifactRepo.listByRun(ctx.workflowRunId, { artifactType: 'review' });
		expect(artifacts).toHaveLength(3);

		// Artifacts are ordered by createdAt ascending. Cycle numbers must be 0,1,2.
		const cycles = artifacts.map((a) => a.data.cycle);
		expect(cycles).toEqual([0, 1, 2]);

		// Each artifact carries review_url and comment_urls from its round.
		expect(artifacts[0].data.review_url).toBe(
			'https://github.com/acme/app/pull/42#pullrequestreview-1'
		);
		expect(artifacts[0].data.comment_urls).toEqual([
			'https://github.com/acme/app/pull/42#discussion_r1001',
		]);
		expect(artifacts[1].data.review_url).toBe(
			'https://github.com/acme/app/pull/42#pullrequestreview-2'
		);
		expect(artifacts[1].data.comment_urls as string[]).toHaveLength(2);
		expect(artifacts[2].data.review_url).toBe(
			'https://github.com/acme/app/pull/42#pullrequestreview-3'
		);
		expect(artifacts[2].data.comment_urls).toEqual([]);

		// submittedAt is an ISO8601 string set at write time.
		for (const a of artifacts) {
			expect(typeof a.data.submittedAt).toBe('string');
			expect(() => new Date(a.data.submittedAt as string).toISOString()).not.toThrow();
		}

		// Each artifact must have a unique artifactKey so upsert doesn't collapse rounds.
		const keys = artifacts.map((a) => a.artifactKey);
		expect(new Set(keys).size).toBe(3);
		expect(keys).toEqual(['cycle-0', 'cycle-1', 'cycle-2']);
	});

	test('skips artifact append when review_url is absent from gate data', async () => {
		const { WorkflowRunArtifactRepository } = await import(
			'../../../../src/storage/repositories/workflow-run-artifact-repository.ts'
		);
		const artifactRepo = new WorkflowRunArtifactRepository(ctx.db);

		// Use a gate where the reviewer can send data, but we omit review_url.
		const gate: Gate = {
			id: 'review-posted-gate',
			fields: [
				{ name: 'review_url', type: 'string', writers: ['reviewer'], check: { op: 'exists' } },
				{ name: 'other', type: 'string', writers: ['reviewer'], check: { op: 'exists' } },
			],
			resetOnCycle: true,
		};
		const workflow: SpaceWorkflow = {
			id: 'wf-no-url',
			spaceId: ctx.spaceId,
			name: 'Test',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [
				{ id: 'ch-review-coder', from: 'reviewer', to: 'coder', gateId: 'review-posted-gate' },
			],
			gates: [gate],
		};

		const config = makeConfig(ctx, {
			workflow,
			myAgentName: 'reviewer',
			mySessionId: ctx.reviewerSessionId,
			artifactRepo,
		});
		const handlers = createNodeAgentToolHandlers(config);

		// Write to gate but with only `other`, no `review_url`.
		await handlers.send_message({
			target: 'coder',
			message: 'hi',
			data: { other: 'value' },
		});

		// No artifact should have been appended because the review_url field is absent.
		const artifacts = artifactRepo.listByRun(ctx.workflowRunId, { artifactType: 'review' });
		expect(artifacts).toHaveLength(0);
	});

	test('skips artifact append for non-review-posted-gate gates (no false positives)', async () => {
		const { WorkflowRunArtifactRepository } = await import(
			'../../../../src/storage/repositories/workflow-run-artifact-repository.ts'
		);
		const artifactRepo = new WorkflowRunArtifactRepository(ctx.db);

		// Different gate id — the append block is gated on id === 'review-posted-gate'.
		const gate: Gate = {
			id: 'some-other-gate',
			fields: [
				{ name: 'review_url', type: 'string', writers: ['reviewer'], check: { op: 'exists' } },
			],
			resetOnCycle: false,
		};
		const workflow: SpaceWorkflow = {
			id: 'wf-other',
			spaceId: ctx.spaceId,
			name: 'Test',
			description: '',
			nodes: [],
			startNodeId: '',
			rules: [],
			tags: [],
			channels: [
				{ id: 'ch-review-coder', from: 'reviewer', to: 'coder', gateId: 'some-other-gate' },
			],
			gates: [gate],
		};

		const config = makeConfig(ctx, {
			workflow,
			myAgentName: 'reviewer',
			mySessionId: ctx.reviewerSessionId,
			artifactRepo,
		});
		const handlers = createNodeAgentToolHandlers(config);

		await handlers.send_message({
			target: 'coder',
			message: 'hi',
			data: { review_url: 'https://example.com/pr/1#review-1' },
		});

		const artifacts = artifactRepo.listByRun(ctx.workflowRunId, { artifactType: 'review' });
		expect(artifacts).toHaveLength(0);
	});
});
