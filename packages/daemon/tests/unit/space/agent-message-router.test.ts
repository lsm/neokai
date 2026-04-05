/**
 * Unit tests for AgentMessageRouter
 *
 * Covers all message routing scenarios:
 *   - Agent name (role) target → DM
 *   - Multiple agents sharing a role → fan-out
 *   - Broadcast '*' → all permitted targets
 *   - Node name target → fan-out via nodeGroups
 *   - Unknown target → clear error
 *   - Unauthorized target → error with permitted targets
 *   - Empty topology → error
 *   - Partial delivery failure → partial success
 *   - All deliveries fail → false success
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { NodeExecutionRepository } from '../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository.ts';
import { AgentMessageRouter } from '../../../src/lib/space/runtime/agent-message-router.ts';
import type { AgentMessageRouterConfig } from '../../../src/lib/space/runtime/agent-message-router.ts';
import type { ResolvedChannel } from '@neokai/shared';

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

function seedSpaceRow(db: BunDatabase, spaceId: string): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, '/tmp', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
	).run(spaceId, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedWorkflowRunWithChannels(
	db: BunDatabase,
	spaceId: string,
	channels: ResolvedChannel[]
): { runId: string; channels: ResolvedChannel[] } {
	const workflowRepo = new SpaceWorkflowRepository(db);
	const workflow = workflowRepo.createWorkflow({
		spaceId,
		name: 'Test Workflow',
		description: '',
		nodes: [],
		transitions: [],
		startNodeId: '',
		rules: [],
	});

	const runRepo = new SpaceWorkflowRunRepository(db);
	const run = runRepo.createRun({
		spaceId,
		workflowId: workflow.id,
		title: 'Test Run',
	});

	// Channels are now passed directly to AgentMessageRouter (not stored in run config)
	return { runId: run.id, channels };
}

function makeResolvedChannel(
	fromRole: string,
	toRole: string,
	isHubSpoke = false
): ResolvedChannel {
	return {
		fromRole,
		toRole,
		fromAgentId: `agent-${fromRole}`,
		toAgentId: `agent-${toRole}`,
		direction: 'one-way',
		isHubSpoke,
	};
}

// ---------------------------------------------------------------------------
// Test context
// ---------------------------------------------------------------------------

interface TestCtx {
	db: BunDatabase;
	dir: string;
	spaceId: string;
	nodeExecutionRepo: NodeExecutionRepository;
	workflowRunRepo: SpaceWorkflowRunRepository;
	nodeId: string;
	coderSessionId: string;
	reviewerSessionId: string;
	taskAgentSessionId: string;
}

/** Seeds a node execution with the given role and session for routing purposes. */
function seedPeerTask(
	repoOrDb: NodeExecutionRepository | BunDatabase,
	arg2: string,
	arg3: string,
	arg4: string,
	arg5: string,
	arg6?: string
): void {
	const nodeExecutionRepo =
		repoOrDb instanceof NodeExecutionRepository ? repoOrDb : new NodeExecutionRepository(repoOrDb);
	const workflowRunId = repoOrDb instanceof NodeExecutionRepository ? arg2 : arg3;
	const nodeId = repoOrDb instanceof NodeExecutionRepository ? arg3 : arg4;
	const agentName = repoOrDb instanceof NodeExecutionRepository ? arg4 : arg5;
	const sessionId = repoOrDb instanceof NodeExecutionRepository ? arg5 : (arg6 ?? '');

	const execution = nodeExecutionRepo.createOrIgnore({
		workflowRunId,
		workflowNodeId: nodeId,
		agentName,
		agentSessionId: sessionId,
		status: 'in_progress',
	});
	nodeExecutionRepo.update(execution.id, {
		agentSessionId: sessionId,
		status: 'in_progress',
	});
}

function makeCtx(): TestCtx {
	const { db, dir } = makeDb();
	const spaceId = 'space-channel-router-test';

	seedSpaceRow(db, spaceId);

	const nodeExecutionRepo = new NodeExecutionRepository(db);
	const workflowRunRepo = new SpaceWorkflowRunRepository(db);

	const nodeId = 'node-test-router';
	const taskAgentSessionId = 'session-task-agent';
	const coderSessionId = 'session-coder';
	const reviewerSessionId = 'session-reviewer';

	return {
		db,
		dir,
		spaceId,
		nodeExecutionRepo,
		workflowRunRepo,
		nodeId,
		coderSessionId,
		reviewerSessionId,
		taskAgentSessionId,
	};
}

function makeRouter(
	ctx: TestCtx,
	workflowRunId: string,
	injected: Array<{ sessionId: string; message: string }>,
	channels: ResolvedChannel[] = [],
	overrides: Partial<AgentMessageRouterConfig> = {}
): AgentMessageRouter {
	return new AgentMessageRouter({
		nodeExecutionRepo: ctx.nodeExecutionRepo,
		workflowRunId,
		resolvedChannels: channels,
		messageInjector: async (sessionId, message) => {
			injected.push({ sessionId, message });
		},
		...overrides,
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentMessageRouter: agent name (role) target → DM', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('delivers message to single session with matching role', async () => {
		const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
			ctx.db,
			ctx.spaceId,
			[makeResolvedChannel('coder', 'reviewer')]
		);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
		const injected: Array<{ sessionId: string; message: string }> = [];
		const router = makeRouter(ctx, workflowRunId, injected, runChannels);

		const result = await router.deliverMessage({
			fromRole: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'reviewer',
			message: 'LGTM!',
		});

		expect(result.success).toBe(true);
		expect(result.delivered).toHaveLength(1);
		expect(result.delivered[0].sessionId).toBe(ctx.reviewerSessionId);
		expect(result.delivered[0].role).toBe('reviewer');
		expect(injected).toHaveLength(1);
		expect(injected[0].message).toBe('[Message from coder]: LGTM!');
	});
});

describe('AgentMessageRouter: single agent per role (task-centric model)', () => {
	// In the new task-centric model, each agent_name is unique per (workflow_run, node).
	// Fan-out to multiple agents of the same role is no longer supported — each role maps
	// to exactly one task/session. This describe block verifies DM to a single peer works.
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('delivers to the single session with the target role', async () => {
		const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
			ctx.db,
			ctx.spaceId,
			[makeResolvedChannel('coder', 'reviewer')]
		);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);

		const injected: Array<{ sessionId: string; message: string }> = [];
		const router = makeRouter(ctx, workflowRunId, injected, runChannels);

		const result = await router.deliverMessage({
			fromRole: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'reviewer',
			message: 'hello!',
		});

		expect(result.success).toBe(true);
		expect(result.delivered).toHaveLength(1);
		expect(result.delivered[0].sessionId).toBe(ctx.reviewerSessionId);
	});
});

describe('AgentMessageRouter: broadcast * → all permitted targets', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('delivers to all topology-permitted targets', async () => {
		const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
			ctx.db,
			ctx.spaceId,
			[makeResolvedChannel('coder', 'reviewer'), makeResolvedChannel('coder', 'security')]
		);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
		// Add a security member
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'security', 'session-security');

		const injected: string[] = [];
		const router = makeRouter(ctx, workflowRunId, [], runChannels, {
			messageInjector: async (sid) => {
				injected.push(sid);
			},
		});

		const result = await router.deliverMessage({
			fromRole: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: '*',
			message: 'broadcast!',
		});

		expect(result.success).toBe(true);
		expect(result.delivered).toHaveLength(2);
		expect(injected).toContain(ctx.reviewerSessionId);
		expect(injected).toContain('session-security');
	});

	test('returns error when role has no permitted targets', async () => {
		const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
			ctx.db,
			ctx.spaceId,
			[
				makeResolvedChannel('reviewer', 'coder'), // coder has no outgoing channels
			]
		);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		const router = makeRouter(ctx, workflowRunId, [], runChannels);

		const result = await router.deliverMessage({
			fromRole: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: '*',
			message: 'broadcast',
		});

		expect(result.success).toBe(false);
		expect(result.reason).toContain("No permitted targets for role 'coder'");
	});
});

describe('AgentMessageRouter: unknown target → clear error', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns error with "no agent or node found" when target unknown', async () => {
		const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
			ctx.db,
			ctx.spaceId,
			[makeResolvedChannel('coder', 'reviewer')]
		);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
		const router = makeRouter(ctx, workflowRunId, [], runChannels);

		const result = await router.deliverMessage({
			fromRole: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'nonexistent-agent',
			message: 'hello',
		});

		expect(result.success).toBe(false);
		expect(result.reason).toContain('no agent or node found');
		expect(result.reason).toContain("Unknown target 'nonexistent-agent'");
	});

	test('lists reachable targets in error when peers exist', async () => {
		const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
			ctx.db,
			ctx.spaceId,
			[makeResolvedChannel('coder', 'reviewer')]
		);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
		const router = makeRouter(ctx, workflowRunId, [], runChannels);

		const result = await router.deliverMessage({
			fromRole: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'ghost',
			message: 'ping',
		});

		expect(result.success).toBe(false);
		expect(result.reason).toContain('Reachable targets: reviewer');
	});
});

describe('AgentMessageRouter: unauthorized target → error with permitted targets', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns error when channel topology forbids the send', async () => {
		// reviewer → coder channel only (coder cannot send to reviewer)
		const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
			ctx.db,
			ctx.spaceId,
			[makeResolvedChannel('reviewer', 'coder')]
		);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
		const router = makeRouter(ctx, workflowRunId, [], runChannels);

		const result = await router.deliverMessage({
			fromRole: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'reviewer',
			message: 'unauthorized!',
		});

		expect(result.success).toBe(false);
		expect(result.reason).toContain("does not permit 'coder' to send to: reviewer");
		expect(result.reason).toContain('Permitted targets:');
	});
});

describe('AgentMessageRouter: unauthorized target → error with structured fields', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('populates unauthorizedRoles and permittedTargets structured fields on auth failure', async () => {
		// reviewer → coder channel only (coder cannot send to reviewer)
		const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
			ctx.db,
			ctx.spaceId,
			[makeResolvedChannel('reviewer', 'coder')]
		);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
		const router = makeRouter(ctx, workflowRunId, [], runChannels);

		const result = await router.deliverMessage({
			fromRole: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'reviewer',
			message: 'unauthorized!',
		});

		expect(result.success).toBe(false);
		expect(result.unauthorizedRoles).toBeDefined();
		expect(result.unauthorizedRoles).toContain('reviewer');
		expect(result.permittedTargets).toBeDefined();
		// coder has no permitted targets in this topology
		expect(result.permittedTargets).toHaveLength(0);
	});
});

describe('AgentMessageRouter: empty topology → error', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns error when no channel topology is declared', async () => {
		// No channels in run config
		const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
			ctx.db,
			ctx.spaceId,
			[]
		);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		const router = makeRouter(ctx, workflowRunId, [], runChannels);

		const result = await router.deliverMessage({
			fromRole: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'reviewer',
			message: 'test',
		});

		expect(result.success).toBe(false);
		expect(result.reason).toContain('No channel topology declared');
	});

	test('returns error when workflowRunId is empty (no run config)', async () => {
		const router = makeRouter(ctx, '', []);

		const result = await router.deliverMessage({
			fromRole: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'reviewer',
			message: 'test',
		});

		expect(result.success).toBe(false);
		expect(result.reason).toContain('No channel topology declared');
	});
});

describe('AgentMessageRouter: partial delivery failure → partial success', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns false success when the single session fails', async () => {
		// In the new model, each agent_name is unique per node — only one reviewer session.
		// Failure to deliver to that session results in success=false, not partial.
		const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
			ctx.db,
			ctx.spaceId,
			[makeResolvedChannel('coder', 'reviewer')]
		);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);

		const router = makeRouter(ctx, workflowRunId, [], runChannels, {
			messageInjector: async (_sid) => {
				throw new Error('injection failed');
			},
		});

		const result = await router.deliverMessage({
			fromRole: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'reviewer',
			message: 'hello',
		});

		expect(result.success).toBe(false);
		expect(result.delivered).toHaveLength(0);
		expect(result.failed).toHaveLength(1);
	});
});

describe('AgentMessageRouter: all deliveries fail → false success', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns success: false when all injections fail', async () => {
		const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
			ctx.db,
			ctx.spaceId,
			[makeResolvedChannel('coder', 'reviewer')]
		);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
		const router = makeRouter(ctx, workflowRunId, [], runChannels, {
			messageInjector: async () => {
				throw new Error('always fails');
			},
		});

		const result = await router.deliverMessage({
			fromRole: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'reviewer',
			message: 'test',
		});

		expect(result.success).toBe(false);
		expect(result.delivered).toHaveLength(0);
		expect(result.failed).toHaveLength(1);
	});
});

describe('AgentMessageRouter: node name target with nodeGroups → fan-out', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('delivers to all roles mapped to a node name', async () => {
		const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
			ctx.db,
			ctx.spaceId,
			[makeResolvedChannel('coder', 'reviewer'), makeResolvedChannel('coder', 'security')]
		);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
		// Add security member
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'security', 'session-security');

		const injected: string[] = [];
		const router = makeRouter(ctx, workflowRunId, [], runChannels, {
			messageInjector: async (sid) => {
				injected.push(sid);
			},
			nodeGroups: {
				'review-node': ['reviewer', 'security'],
			},
		});

		const result = await router.deliverMessage({
			fromRole: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'review-node',
			message: 'fan-out to node!',
		});

		expect(result.success).toBe(true);
		expect(result.delivered).toHaveLength(2);
		expect(injected).toContain(ctx.reviewerSessionId);
		expect(injected).toContain('session-security');
	});
});

describe('AgentMessageRouter: node name target without nodeGroups → unknown target error', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns unknown target error when nodeGroups not configured', async () => {
		const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
			ctx.db,
			ctx.spaceId,
			[makeResolvedChannel('coder', 'reviewer')]
		);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
		const router = makeRouter(ctx, workflowRunId, [], runChannels);
		// No nodeGroups configured

		const result = await router.deliverMessage({
			fromRole: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'review-node',
			message: 'fan-out attempt',
		});

		expect(result.success).toBe(false);
		expect(result.reason).toContain("Unknown target 'review-node'");
		expect(result.reason).toContain('no agent or node found');
	});
});

describe('AgentMessageRouter: notFoundRoles structured field', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('populates notFoundRoles on broadcast when some permitted roles have no active sessions', async () => {
		// topology permits coder → reviewer and coder → ghost-role
		// but ghost-role has no active sessions
		const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
			ctx.db,
			ctx.spaceId,
			[makeResolvedChannel('coder', 'reviewer'), makeResolvedChannel('coder', 'ghost-role')]
		);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
		// ghost-role has no task/session seeded

		const injected: Array<{ sessionId: string; message: string }> = [];
		const router = makeRouter(ctx, workflowRunId, injected, runChannels);

		// Broadcast to all permitted targets — reviewer exists, ghost-role does not
		const result = await router.deliverMessage({
			fromRole: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: '*',
			message: 'broadcast to available',
		});

		// reviewer was delivered, ghost-role was not found
		expect(result.success).toBe(true);
		expect(result.delivered).toHaveLength(1);
		expect(result.delivered[0].role).toBe('reviewer');
		expect(result.notFoundRoles).toBeDefined();
		expect(result.notFoundRoles).toContain('ghost-role');
	});
});
