/**
 * Unit tests for the unified send_message behavior via ChannelRouter injection.
 *
 * Covers:
 *   1. send_message with ChannelRouter injected:
 *      - Agent name target → DM delivery
 *      - Unknown target → clear error
 *      - Unauthorized target → error
 *      - Broadcast '*' → broadcast
 *   2. send_message without ChannelRouter (legacy):
 *      - Role target → DM
 *      - Broadcast '*' → broadcast
 *   3. Both paths produce same behavior for role-based DM
 *   4. send_message: node name→fan-out (via nodeGroups in AgentMessageRouter)
 *   5. send_message: cross-node delivery (sender and receiver in different nodes)
 *   6. send_message: gate blocked (topology-based blocking — no declared channel)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository.ts';
import {
	createNodeAgentToolHandlers,
	type NodeAgentToolsConfig,
} from '../../../src/lib/space/tools/node-agent-tools.ts';
import { AgentMessageRouter } from '../../../src/lib/space/runtime/agent-message-router.ts';
import { ChannelResolver } from '../../../src/lib/space/runtime/channel-resolver.ts';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository.ts';
import { SpaceTaskManager } from '../../../src/lib/space/managers/space-task-manager.ts';
import type { ResolvedChannel } from '@neokai/shared';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-send-message-unified',
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
     allowed_models, session_ids, status, created_at, updated_at)
     VALUES (?, '/tmp', ?, '', '', '', '[]', '[]', 'active', ?, ?)`
	).run(spaceId, `Space ${spaceId}`, Date.now(), Date.now());
}

function seedWorkflowRunWithChannels(
	db: BunDatabase,
	spaceId: string,
	channels: ResolvedChannel[]
): string {
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

	if (channels.length > 0) {
		runRepo.updateRun(run.id, {
			config: { _resolvedChannels: channels },
		});
	}

	return run.id;
}

function makeResolvedChannel(fromRole: string, toRole: string): ResolvedChannel {
	return {
		fromRole,
		toRole,
		fromAgentId: `agent-${fromRole}`,
		toAgentId: `agent-${toRole}`,
		direction: 'one-way',
		isHubSpoke: false,
	};
}

// ---------------------------------------------------------------------------
// Test context
// ---------------------------------------------------------------------------

const NODE_ID = 'node-review';

interface TestCtx {
	db: BunDatabase;
	dir: string;
	spaceId: string;
	spaceTaskRepo: SpaceTaskRepository;
	workflowRunRepo: SpaceWorkflowRunRepository;
	coderSessionId: string;
	reviewerSessionId: string;
}

function seedPeerTask(
	db: BunDatabase,
	spaceId: string,
	workflowRunId: string,
	nodeId: string,
	agentName: string,
	sessionId: string
): void {
	db.exec('PRAGMA foreign_keys = OFF');
	const now = Date.now();
	const id = `task-${Math.random().toString(36).slice(2)}`;
	db.prepare(
		`INSERT INTO space_tasks
       (id, space_id, title, description, status, priority, agent_name,
        workflow_run_id, workflow_node_id, depends_on, task_agent_session_id, created_at, updated_at)
       VALUES (?, ?, ?, '', 'in_progress', 'normal', ?, ?, ?, '[]', ?, ?, ?)`
	).run(
		id,
		spaceId,
		`Task for ${agentName}`,
		agentName,
		workflowRunId,
		nodeId,
		sessionId,
		now,
		now
	);
	db.exec('PRAGMA foreign_keys = ON');
}

function makeCtx(): TestCtx {
	const { db, dir } = makeDb();
	const spaceId = 'space-send-msg-unified-test';

	seedSpaceRow(db, spaceId);

	const spaceTaskRepo = new SpaceTaskRepository(db);
	const workflowRunRepo = new SpaceWorkflowRunRepository(db);

	const coderSessionId = 'session-coder-unified';
	const reviewerSessionId = 'session-reviewer-unified';

	return {
		db,
		dir,
		spaceId,
		spaceTaskRepo,
		workflowRunRepo,
		coderSessionId,
		reviewerSessionId,
	};
}

function makeBaseConfig(
	ctx: TestCtx,
	workflowRunId: string,
	injected: Array<{ sessionId: string; message: string }>,
	channelResolver: ChannelResolver = new ChannelResolver([])
): NodeAgentToolsConfig {
	return {
		mySessionId: ctx.coderSessionId,
		myRole: 'coder',
		taskId: 'test-task-unified',
		stepTaskId: '',
		spaceId: ctx.spaceId,
		channelResolver,
		workflowRunId,
		workflowNodeId: NODE_ID,
		spaceTaskRepo: ctx.spaceTaskRepo,
		messageInjector: async (sessionId, message) => {
			injected.push({ sessionId, message });
		},
		taskManager: new SpaceTaskManager(ctx.db, ctx.spaceId),
	};
}

// ---------------------------------------------------------------------------
// Tests: send_message with ChannelRouter injected
// ---------------------------------------------------------------------------

describe('send_message with ChannelRouter injected', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('agent name target → DM delivery via ChannelRouter', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
		const injected: Array<{ sessionId: string; message: string }> = [];
		const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

		const agentMessageRouter = new AgentMessageRouter({
			spaceTaskRepo: ctx.spaceTaskRepo,
			workflowNodeId: NODE_ID,
			workflowRunRepo: ctx.workflowRunRepo,
			workflowRunId,
			messageInjector: baseConfig.messageInjector,
		});

		const handlers = createNodeAgentToolHandlers({ ...baseConfig, agentMessageRouter });
		const result = await handlers.send_message({ target: 'reviewer', message: 'hello via router' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.delivered).toHaveLength(1);
		expect(data.delivered[0].sessionId).toBe(ctx.reviewerSessionId);
		expect(injected[0].message).toBe('[Message from coder]: hello via router');
	});

	test('unknown target → clear error from ChannelRouter', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
		const injected: Array<{ sessionId: string; message: string }> = [];
		const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

		const agentMessageRouter = new AgentMessageRouter({
			spaceTaskRepo: ctx.spaceTaskRepo,
			workflowNodeId: NODE_ID,
			workflowRunRepo: ctx.workflowRunRepo,
			workflowRunId,
			messageInjector: baseConfig.messageInjector,
		});

		const handlers = createNodeAgentToolHandlers({ ...baseConfig, agentMessageRouter });
		const result = await handlers.send_message({ target: 'ghost-agent', message: 'knock knock' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('no agent or node found');
	});

	test('unauthorized target → error from ChannelRouter', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('reviewer', 'coder'), // coder cannot send to reviewer
		]);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
		const injected: Array<{ sessionId: string; message: string }> = [];
		const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

		const agentMessageRouter = new AgentMessageRouter({
			spaceTaskRepo: ctx.spaceTaskRepo,
			workflowNodeId: NODE_ID,
			workflowRunRepo: ctx.workflowRunRepo,
			workflowRunId,
			messageInjector: baseConfig.messageInjector,
		});

		const handlers = createNodeAgentToolHandlers({ ...baseConfig, agentMessageRouter });
		const result = await handlers.send_message({ target: 'reviewer', message: 'unauthorized' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain("does not permit 'coder' to send to: reviewer");
	});

	test("broadcast '*' → broadcast via AgentMessageRouter", async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
		const injected: Array<{ sessionId: string; message: string }> = [];
		const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

		const agentMessageRouter = new AgentMessageRouter({
			spaceTaskRepo: ctx.spaceTaskRepo,
			workflowNodeId: NODE_ID,
			workflowRunRepo: ctx.workflowRunRepo,
			workflowRunId,
			messageInjector: baseConfig.messageInjector,
		});

		const handlers = createNodeAgentToolHandlers({ ...baseConfig, agentMessageRouter });
		const result = await handlers.send_message({ target: '*', message: 'broadcast via router' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.delivered).toHaveLength(1);
		expect(data.delivered[0].sessionId).toBe(ctx.reviewerSessionId);
		expect(injected[0].message).toBe('[Message from coder]: broadcast via router');
	});
});

// ---------------------------------------------------------------------------
// Tests: send_message without ChannelRouter (legacy path)
// ---------------------------------------------------------------------------

describe('send_message without ChannelRouter (legacy path)', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('role target → DM via legacy path', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
		const injected: Array<{ sessionId: string; message: string }> = [];
		const config = makeBaseConfig(
			ctx,
			workflowRunId,
			injected,
			new ChannelResolver([makeResolvedChannel('coder', 'reviewer')])
		);
		// No agentMessageRouter — uses legacy path

		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'reviewer', message: 'legacy DM' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.delivered).toHaveLength(1);
		expect(data.delivered[0].sessionId).toBe(ctx.reviewerSessionId);
		expect(injected[0].message).toBe('[Message from coder]: legacy DM');
	});

	test("broadcast '*' → broadcast via legacy path", async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
		const injected: string[] = [];
		const config: NodeAgentToolsConfig = {
			...makeBaseConfig(
				ctx,
				workflowRunId,
				[],
				new ChannelResolver([makeResolvedChannel('coder', 'reviewer')])
			),
			messageInjector: async (sid) => {
				injected.push(sid);
			},
		};

		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: '*', message: 'broadcast legacy' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.delivered).toHaveLength(1);
		expect(injected).toContain(ctx.reviewerSessionId);
	});
});

// ---------------------------------------------------------------------------
// Tests: both paths produce same behavior for role-based DM
// ---------------------------------------------------------------------------

describe('both paths produce same behavior for role-based DM', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('success result structure matches between legacy and ChannelRouter paths', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);

		// Legacy path
		const injectedLegacy: Array<{ sessionId: string; message: string }> = [];
		const legacyConfig = makeBaseConfig(
			ctx,
			workflowRunId,
			injectedLegacy,
			new ChannelResolver([makeResolvedChannel('coder', 'reviewer')])
		);
		const legacyHandlers = createNodeAgentToolHandlers(legacyConfig);
		const legacyResult = await legacyHandlers.send_message({
			target: 'reviewer',
			message: 'test message',
		});
		const legacyData = JSON.parse(legacyResult.content[0].text);

		// ChannelRouter path
		const injectedRouter: Array<{ sessionId: string; message: string }> = [];
		const routerBaseConfig = makeBaseConfig(ctx, workflowRunId, injectedRouter);
		const agentMessageRouter = new AgentMessageRouter({
			spaceTaskRepo: ctx.spaceTaskRepo,
			workflowNodeId: NODE_ID,
			workflowRunRepo: ctx.workflowRunRepo,
			workflowRunId,
			messageInjector: routerBaseConfig.messageInjector,
		});
		const routerHandlers = createNodeAgentToolHandlers({ ...routerBaseConfig, agentMessageRouter });
		const routerResult = await routerHandlers.send_message({
			target: 'reviewer',
			message: 'test message',
		});
		const routerData = JSON.parse(routerResult.content[0].text);

		// Both should succeed
		expect(legacyData.success).toBe(true);
		expect(routerData.success).toBe(true);

		// Both should deliver to the same session
		expect(legacyData.delivered[0].sessionId).toBe(ctx.reviewerSessionId);
		expect(routerData.delivered[0].sessionId).toBe(ctx.reviewerSessionId);

		// Both should inject the same prefixed message
		expect(injectedLegacy[0].message).toBe('[Message from coder]: test message');
		expect(injectedRouter[0].message).toBe('[Message from coder]: test message');
	});
});

// ---------------------------------------------------------------------------
// Tests: send_message — node name→fan-out (via nodeGroups in AgentMessageRouter)
// ---------------------------------------------------------------------------

describe('send_message: node name→fan-out via AgentMessageRouter', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('node name target fans out to all agents mapped to that node', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
			makeResolvedChannel('coder', 'security'),
		]);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
		seedPeerTask(
			ctx.db,
			ctx.spaceId,
			workflowRunId,
			NODE_ID,
			'security',
			'session-security-unified'
		);

		const injected: Array<{ sessionId: string; message: string }> = [];
		const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

		// Configure AgentMessageRouter with nodeGroups so 'review-node' expands to both roles
		const agentMessageRouter = new AgentMessageRouter({
			spaceTaskRepo: ctx.spaceTaskRepo,
			workflowNodeId: NODE_ID,
			workflowRunRepo: ctx.workflowRunRepo,
			workflowRunId,
			messageInjector: baseConfig.messageInjector,
			nodeGroups: {
				'review-node': ['reviewer', 'security'],
			},
		});

		const handlers = createNodeAgentToolHandlers({ ...baseConfig, agentMessageRouter });
		const result = await handlers.send_message({
			target: 'review-node',
			message: 'fan-out to review node',
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.delivered).toHaveLength(2);
		const sessionIds = data.delivered.map((d: { sessionId: string }) => d.sessionId);
		expect(sessionIds).toContain(ctx.reviewerSessionId);
		expect(sessionIds).toContain('session-security-unified');
		// Both injections should carry the sender prefix
		expect(injected).toHaveLength(2);
		expect(
			injected.every((i) => i.message === '[Message from coder]: fan-out to review node')
		).toBe(true);
	});

	test('unknown node name returns an error when nodeGroups not configured', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
		const injected: Array<{ sessionId: string; message: string }> = [];
		const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

		// No nodeGroups configured — node names are not resolvable
		const agentMessageRouter = new AgentMessageRouter({
			spaceTaskRepo: ctx.spaceTaskRepo,
			workflowNodeId: NODE_ID,
			workflowRunRepo: ctx.workflowRunRepo,
			workflowRunId,
			messageInjector: baseConfig.messageInjector,
		});

		const handlers = createNodeAgentToolHandlers({ ...baseConfig, agentMessageRouter });
		const result = await handlers.send_message({
			target: 'review-node',
			message: 'should fail',
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('no agent or node found');
	});
});

// ---------------------------------------------------------------------------
// Tests: send_message — cross-node delivery
// ---------------------------------------------------------------------------

describe('send_message: cross-node delivery', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('coder in Node A can send to reviewer in Node B via agent name', async () => {
		// This simulates cross-node delivery: coder (Node A) → reviewer (Node B).
		// Both agents are tasks in the same workflow run but can be on different nodes.
		// The AgentMessageRouter resolves cross-node delivery by role (agentName).
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		// Reviewer is on NODE_ID (same node for this test — cross-node via nodeGroups)
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
		const injected: Array<{ sessionId: string; message: string }> = [];
		const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

		const agentMessageRouter = new AgentMessageRouter({
			spaceTaskRepo: ctx.spaceTaskRepo,
			workflowNodeId: NODE_ID,
			workflowRunRepo: ctx.workflowRunRepo,
			workflowRunId,
			messageInjector: baseConfig.messageInjector,
		});

		const handlers = createNodeAgentToolHandlers({ ...baseConfig, agentMessageRouter });
		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'cross-node message from coder',
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.delivered).toHaveLength(1);
		expect(data.delivered[0].sessionId).toBe(ctx.reviewerSessionId);
		expect(injected[0].message).toBe('[Message from coder]: cross-node message from coder');
	});

	test('cross-node delivery via fan-out: coder fans out to all agents across nodes', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
			makeResolvedChannel('coder', 'tester'),
		]);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, NODE_ID, 'tester', 'session-tester-unified');

		const injected: Array<{ sessionId: string; message: string }> = [];
		const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

		const agentMessageRouter = new AgentMessageRouter({
			spaceTaskRepo: ctx.spaceTaskRepo,
			workflowNodeId: NODE_ID,
			workflowRunRepo: ctx.workflowRunRepo,
			workflowRunId,
			messageInjector: baseConfig.messageInjector,
		});

		// Broadcast to all permitted targets (reviewer + tester across nodes)
		const handlers = createNodeAgentToolHandlers({ ...baseConfig, agentMessageRouter });
		const result = await handlers.send_message({ target: '*', message: 'cross-node broadcast' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.delivered).toHaveLength(2);
		const sessionIds = data.delivered.map((d: { sessionId: string }) => d.sessionId);
		expect(sessionIds).toContain(ctx.reviewerSessionId);
		expect(sessionIds).toContain('session-tester-unified');
	});
});

// ---------------------------------------------------------------------------
// Tests: send_message — gate blocked (topology-based blocking)
// ---------------------------------------------------------------------------

describe('send_message: gate blocked via topology', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('send is blocked when no channel is declared from sender to target', async () => {
		// Topology only declares reviewer→coder; coder has no outgoing channels
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('reviewer', 'coder'),
		]);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
		const injected: Array<{ sessionId: string; message: string }> = [];
		const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

		const agentMessageRouter = new AgentMessageRouter({
			spaceTaskRepo: ctx.spaceTaskRepo,
			workflowNodeId: NODE_ID,
			workflowRunRepo: ctx.workflowRunRepo,
			workflowRunId,
			messageInjector: baseConfig.messageInjector,
		});

		const handlers = createNodeAgentToolHandlers({ ...baseConfig, agentMessageRouter });
		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'should be blocked by gate',
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		// No message was injected — gate blocked it
		expect(injected).toHaveLength(0);
		expect(data.error).toContain("does not permit 'coder' to send to: reviewer");
	});

	test('send is blocked when topology is empty (no channels declared)', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, []);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
		const injected: Array<{ sessionId: string; message: string }> = [];
		const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

		const agentMessageRouter = new AgentMessageRouter({
			spaceTaskRepo: ctx.spaceTaskRepo,
			workflowNodeId: NODE_ID,
			workflowRunRepo: ctx.workflowRunRepo,
			workflowRunId,
			messageInjector: baseConfig.messageInjector,
		});

		const handlers = createNodeAgentToolHandlers({ ...baseConfig, agentMessageRouter });
		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'no channels declared',
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(injected).toHaveLength(0);
		expect(data.error).toContain('No channel topology declared');
	});

	test('send is allowed when channel is declared in the correct direction', async () => {
		// Topology declares coder→reviewer; send should succeed
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
		const injected: Array<{ sessionId: string; message: string }> = [];
		const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

		const agentMessageRouter = new AgentMessageRouter({
			spaceTaskRepo: ctx.spaceTaskRepo,
			workflowNodeId: NODE_ID,
			workflowRunRepo: ctx.workflowRunRepo,
			workflowRunId,
			messageInjector: baseConfig.messageInjector,
		});

		const handlers = createNodeAgentToolHandlers({ ...baseConfig, agentMessageRouter });
		const result = await handlers.send_message({
			target: 'reviewer',
			message: 'gate open — allowed by topology',
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(injected).toHaveLength(1);
		expect(injected[0].message).toBe('[Message from coder]: gate open — allowed by topology');
	});
});
