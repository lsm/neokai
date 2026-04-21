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
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { PendingAgentMessageRepository } from '../../../../src/storage/repositories/pending-agent-message-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { AgentMessageRouter } from '../../../../src/lib/space/runtime/agent-message-router.ts';
import type { AgentMessageRouterConfig } from '../../../../src/lib/space/runtime/agent-message-router.ts';
import type { WorkflowChannel } from '@neokai/shared';

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
	channels: WorkflowChannel[]
): { runId: string; channels: WorkflowChannel[] } {
	const workflowRepo = new SpaceWorkflowRepository(db);
	const workflow = workflowRepo.createWorkflow({
		spaceId,
		name: 'Test Workflow',
		description: '',
		nodes: [],
		transitions: [],
		startNodeId: '',
		rules: [],
		completionAutonomyLevel: 3,
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

function makeChannel(from: string, to: string | string[]): WorkflowChannel {
	return {
		id: `ch-${from}-${Array.isArray(to) ? to.join('-') : to}`,
		from,
		to,
	};
}
function makeResolvedChannel(
	fromAgentName: string,
	toRole: string,
	_isHubSpoke = false
): WorkflowChannel {
	return makeChannel(fromAgentName, toRole);
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
	channels: WorkflowChannel[] = [],
	overrides: Partial<AgentMessageRouterConfig> = {}
): AgentMessageRouter {
	return new AgentMessageRouter({
		nodeExecutionRepo: ctx.nodeExecutionRepo,
		workflowRunId,
		workflowChannels: channels,
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
			fromAgentName: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'reviewer',
			message: 'LGTM!',
		});

		expect(result.success).toBe(true);
		expect(result.delivered).toHaveLength(1);
		expect(result.delivered[0].sessionId).toBe(ctx.reviewerSessionId);
		expect(result.delivered[0].agentName).toBe('reviewer');
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
			fromAgentName: 'coder',
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
			fromAgentName: 'coder',
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
			fromAgentName: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: '*',
			message: 'broadcast',
		});

		expect(result.success).toBe(false);
		expect(result.reason).toContain("No permitted targets for agent 'coder'");
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
			fromAgentName: 'coder',
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
			fromAgentName: 'coder',
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
			fromAgentName: 'coder',
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

	test('populates unauthorizedAgentNames and permittedTargets structured fields on auth failure', async () => {
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
			fromAgentName: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'reviewer',
			message: 'unauthorized!',
		});

		expect(result.success).toBe(false);
		expect(result.unauthorizedAgentNames).toBeDefined();
		expect(result.unauthorizedAgentNames).toContain('reviewer');
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
			fromAgentName: 'coder',
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
			fromAgentName: 'coder',
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
			fromAgentName: 'coder',
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
			fromAgentName: 'coder',
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
		// Use node names in channels (coder-node → review-node), matching nodeGroups
		const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
			ctx.db,
			ctx.spaceId,
			[makeChannel('coder-node', 'review-node')]
		);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'security', 'session-security');

		const injected: string[] = [];
		const router = makeRouter(ctx, workflowRunId, [], runChannels, {
			messageInjector: async (sid) => {
				injected.push(sid);
			},
			nodeGroups: {
				'coder-node': ['coder'],
				'review-node': ['reviewer', 'security'],
			},
		});

		const result = await router.deliverMessage({
			fromAgentName: 'coder',
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
			fromAgentName: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'review-node',
			message: 'fan-out attempt',
		});

		expect(result.success).toBe(false);
		expect(result.reason).toContain("Unknown target 'review-node'");
		expect(result.reason).toContain('no agent or node found');
	});
});

describe('AgentMessageRouter: fromNodeName resolution edge cases', () => {
	// These tests guard the isTopologyDeclared check: when channels are node-name addressed
	// (e.g. from:'Coding') but the agent slot name differs (e.g. 'coder'), the check must
	// not false-positive by treating the slot name as a valid channel source.
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('isTopologyDeclared is false when slot name differs from node-name-addressed channel source (no nodeGroups)', async () => {
		// Channel: { from: 'Coding', to: 'Review' }  ← node-name addressed
		// Agent slot name: 'coder'  ← doesn't match 'Coding'
		// No nodeGroups → fromNodeName resolves to identity 'coder'
		// getPermittedTargets('coder') → [] → isTopologyDeclared('Review') = false
		// Expected: "Unknown target 'Review'" (not "no active sessions found")
		const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeChannel('Coding', 'Review'),
		]);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);

		// No nodeGroups — router cannot translate 'coder' → 'Coding'
		const router = makeRouter(ctx, workflowRunId, [], [makeChannel('Coding', 'Review')]);

		const result = await router.deliverMessage({
			fromAgentName: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'Review',
			message: 'hello review',
		});

		expect(result.success).toBe(false);
		// Target was not in any execution record AND fromNodeName ('coder') ≠ channel source
		// ('Coding'), so topology check returns [] → isTopologyDeclared = false → unknown target
		expect(result.reason).toContain("Unknown target 'Review'");
		expect(result.reason).toContain('no agent or node found');
	});

	test('isTopologyDeclared is true when nodeGroups maps slot name to channel source', async () => {
		// Same channel setup as above, but this time nodeGroups tells the router that
		// agent 'coder' belongs to node 'Coding'. fromNodeName('coder') → 'Coding'.
		// getPermittedTargets('Coding') → ['Review'] → isTopologyDeclared('Review') = true.
		// No active session for 'Review', so message is queued (pendingMessageRepo provided).
		const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeChannel('Coding', 'Review'),
		]);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		// 'Review' node not yet activated — no execution record

		const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
		const router = makeRouter(ctx, workflowRunId, [], [makeChannel('Coding', 'Review')], {
			nodeGroups: { Coding: ['coder'] }, // maps slot → node name
			pendingMessageRepo,
			spaceId: ctx.spaceId,
		});

		const result = await router.deliverMessage({
			fromAgentName: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'Review',
			message: 'hello review',
		});

		// With nodeGroups, the topology resolves correctly → isTopologyDeclared = true
		// No session exists → message queued (not "unknown target")
		expect(result.success).toBe(true);
		expect(result.queued).toHaveLength(1);
		expect(result.queued?.[0].agentName).toBe('Review');
	});
});

describe('AgentMessageRouter: notFoundAgentNames structured field', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('populates notFoundAgentNames on broadcast when some permitted roles have no active sessions', async () => {
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
			fromAgentName: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: '*',
			message: 'broadcast to available',
		});

		// reviewer was delivered, ghost-role was not found
		expect(result.success).toBe(true);
		expect(result.delivered).toHaveLength(1);
		expect(result.delivered[0].agentName).toBe('reviewer');
		expect(result.notFoundAgentNames).toBeDefined();
		expect(result.notFoundAgentNames).toContain('ghost-role');
	});
});

// ---------------------------------------------------------------------------
// Tests: queue-when-inactive — Bug #2 fix (declared-but-no-session targets)
// ---------------------------------------------------------------------------

describe('AgentMessageRouter: queue message for declared-but-inactive target', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('queues message when target has a pending execution but no active session', async () => {
		const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeChannel('coder', 'reviewer'),
		]);

		// Seed coder with session, reviewer WITHOUT a session (pending activation)
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		ctx.nodeExecutionRepo.createOrIgnore({
			workflowRunId,
			workflowNodeId: ctx.nodeId,
			agentName: 'reviewer',
			status: 'pending',
		});

		const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
		const injected: string[] = [];

		const router = new AgentMessageRouter({
			nodeExecutionRepo: ctx.nodeExecutionRepo,
			workflowRunId,
			workflowChannels: [makeChannel('coder', 'reviewer')],
			messageInjector: async (sid) => {
				injected.push(sid);
			},
			pendingMessageRepo,
			spaceId: ctx.spaceId,
			taskId: null,
		});

		const result = await router.deliverMessage({
			fromAgentName: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'reviewer',
			message: 'code ready',
		});

		// Message should be queued, not failed
		expect(result.success).toBe(true);
		expect(result.queued).toBeDefined();
		expect(result.queued).toHaveLength(1);
		expect(result.queued![0].agentName).toBe('reviewer');
		expect(result.delivered).toHaveLength(0);
		expect(injected).toHaveLength(0);

		// Verify queue record
		const pending = pendingMessageRepo.listPendingForTarget(workflowRunId, 'reviewer');
		expect(pending).toHaveLength(1);
		expect(pending[0].sourceAgentName).toBe('coder');
		expect(pending[0].message).toBe('code ready');
		expect(pending[0].targetKind).toBe('node_agent');
	});

	test('resolves target declared in execution even without live session (no sessionId filter)', async () => {
		// Bug #2: target resolution was filtering to only executions with agentSessionId.
		// Now it resolves all declared executions, enabling queuing.
		const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeChannel('coder', 'reviewer'),
		]);

		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		// reviewer has an execution record but NO session ID
		ctx.nodeExecutionRepo.createOrIgnore({
			workflowRunId,
			workflowNodeId: ctx.nodeId,
			agentName: 'reviewer',
			status: 'in_progress', // in_progress but session hasn't been spawned yet
		});

		const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);

		const router = new AgentMessageRouter({
			nodeExecutionRepo: ctx.nodeExecutionRepo,
			workflowRunId,
			workflowChannels: [makeChannel('coder', 'reviewer')],
			messageInjector: async () => {},
			pendingMessageRepo,
			spaceId: ctx.spaceId,
			taskId: null,
		});

		const result = await router.deliverMessage({
			fromAgentName: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'reviewer',
			message: 'hello reviewer',
		});

		// Should succeed by queuing, not fail with "Unknown target" or "No active sessions"
		expect(result.success).toBe(true);
		expect(result.queued).toBeDefined();
		expect(result.queued![0].agentName).toBe('reviewer');
	});

	test('delivers to live session if available, queues for inactive declared agents', async () => {
		const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeChannel('coder', 'reviewer'),
			makeChannel('coder', 'security'),
		]);

		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		// reviewer has live session
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
		// security has no session
		ctx.nodeExecutionRepo.createOrIgnore({
			workflowRunId,
			workflowNodeId: ctx.nodeId,
			agentName: 'security',
			status: 'pending',
		});

		const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
		const injected: string[] = [];

		const router = new AgentMessageRouter({
			nodeExecutionRepo: ctx.nodeExecutionRepo,
			workflowRunId,
			workflowChannels: [makeChannel('coder', 'reviewer'), makeChannel('coder', 'security')],
			messageInjector: async (sid) => {
				injected.push(sid);
			},
			pendingMessageRepo,
			spaceId: ctx.spaceId,
			taskId: null,
		});

		const result = await router.deliverMessage({
			fromAgentName: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: ['reviewer', 'security'],
			message: 'status update',
		});

		expect(result.success).toBe(true);
		expect(result.delivered).toHaveLength(1);
		expect(result.delivered[0].agentName).toBe('reviewer');
		expect(injected).toContain(ctx.reviewerSessionId);

		expect(result.queued).toBeDefined();
		expect(result.queued).toHaveLength(1);
		expect(result.queued![0].agentName).toBe('security');
	});

	test('still returns no-session error for topology-declared target without pendingMessageRepo', async () => {
		// Without a queue, topology-declared targets with no session result in notFound error
		const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeChannel('coder', 'reviewer'),
		]);

		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		// reviewer has an execution but no session
		ctx.nodeExecutionRepo.createOrIgnore({
			workflowRunId,
			workflowNodeId: ctx.nodeId,
			agentName: 'reviewer',
			status: 'pending',
		});

		// No pendingMessageRepo configured
		const router = makeRouter(ctx, workflowRunId, [], [makeChannel('coder', 'reviewer')]);

		const result = await router.deliverMessage({
			fromAgentName: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'reviewer',
			message: 'hello',
		});

		expect(result.success).toBe(false);
		expect(result.reason).toContain('No active sessions found for target agent(s): reviewer');
	});
});

describe('AgentMessageRouter: broadcast * with mixed active/inactive targets', () => {
	// Tests gap: broadcast with pendingMessageRepo where some targets have sessions
	// (deliver) and others are declared-but-inactive (queue).
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('delivers to active targets and queues for inactive declared targets', async () => {
		const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeChannel('coder', 'reviewer'),
			makeChannel('coder', 'security'),
		]);

		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		// reviewer has a live session
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
		// security is declared but has no session yet
		ctx.nodeExecutionRepo.createOrIgnore({
			workflowRunId,
			workflowNodeId: ctx.nodeId,
			agentName: 'security',
			status: 'pending',
		});

		const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
		const delivered: string[] = [];
		const router = makeRouter(
			ctx,
			workflowRunId,
			[],
			[makeChannel('coder', 'reviewer'), makeChannel('coder', 'security')],
			{
				messageInjector: async (sid) => {
					delivered.push(sid);
				},
				pendingMessageRepo,
				spaceId: ctx.spaceId,
			}
		);

		const result = await router.deliverMessage({
			fromAgentName: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: '*',
			message: 'broadcast to all',
		});

		// reviewer is delivered; security is queued
		expect(result.success).toBe(true);
		expect(result.delivered).toHaveLength(1);
		expect(result.delivered[0].agentName).toBe('reviewer');
		expect(result.queued).toHaveLength(1);
		expect(result.queued![0].agentName).toBe('security');
		expect(delivered).toContain(ctx.reviewerSessionId);

		// Verify the queued message is persisted
		const pending = pendingMessageRepo.listPendingForTarget(workflowRunId, 'security');
		expect(pending).toHaveLength(1);
		expect(pending[0].sourceAgentName).toBe('coder');
	});
});

describe('AgentMessageRouter: queue enqueue failure graceful degradation', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('falls back to notFound when pendingMessageRepo.enqueue throws', async () => {
		// If the DB write for queueing fails, the router must not crash — it should
		// treat the target as notFound and return a "no active sessions" error.
		const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeChannel('coder', 'reviewer'),
		]);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		// reviewer declared but no session
		ctx.nodeExecutionRepo.createOrIgnore({
			workflowRunId,
			workflowNodeId: ctx.nodeId,
			agentName: 'reviewer',
			status: 'pending',
		});

		// Mock pendingMessageRepo that always throws on enqueue
		const failingRepo = {
			enqueue: () => {
				throw new Error('DB write failed');
			},
			listPendingForTarget: () => [],
		} as unknown as PendingAgentMessageRepository;

		const router = makeRouter(ctx, workflowRunId, [], [makeChannel('coder', 'reviewer')], {
			pendingMessageRepo: failingRepo,
			spaceId: ctx.spaceId,
		});

		const result = await router.deliverMessage({
			fromAgentName: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'reviewer',
			message: 'hello',
		});

		// Enqueue threw → graceful degradation to notFound path
		expect(result.success).toBe(false);
		expect(result.reason).toContain('No active sessions found for target agent(s): reviewer');
		expect(result.notFoundAgentNames).toContain('reviewer');
	});
});

describe('AgentMessageRouter: pure topology target (no execution, no nodeGroups) with pendingMessageRepo', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('queues message when target is topology-declared but has no execution record', async () => {
		// 'reviewer' is in channel topology (coder→reviewer) but has NO execution record at all
		// (the node hasn't been activated yet). With pendingMessageRepo, the message is queued.
		// This is the pure topology path: isTopologyDeclared = true via getPermittedTargets,
		// but allDeclaredAgentNames does not contain 'reviewer'.
		const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeChannel('coder', 'reviewer'),
		]);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
		// No execution record for 'reviewer' at all

		const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
		const router = makeRouter(ctx, workflowRunId, [], [makeChannel('coder', 'reviewer')], {
			pendingMessageRepo,
			spaceId: ctx.spaceId,
		});

		const result = await router.deliverMessage({
			fromAgentName: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'reviewer',
			message: 'activate and review',
		});

		expect(result.success).toBe(true);
		expect(result.queued).toHaveLength(1);
		expect(result.queued![0].agentName).toBe('reviewer');
		expect(result.delivered).toHaveLength(0);

		const pending = pendingMessageRepo.listPendingForTarget(workflowRunId, 'reviewer');
		expect(pending).toHaveLength(1);
		expect(pending[0].message).toContain('activate and review');
	});
});
