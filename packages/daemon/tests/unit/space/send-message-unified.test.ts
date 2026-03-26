/**
 * Unit tests for the unified send_message behavior via ChannelRouter injection.
 *
 * Covers:
 *   1. send_message with ChannelRouter injected:
 *      - Agent name target → DM delivery
 *      - Unknown target → clear error
 *      - Unauthorized target → error
 *   2. send_message without ChannelRouter (legacy):
 *      - Role target → DM
 *      - Broadcast '*' → broadcast
 *   3. Both paths produce same behavior for role-based DM
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceSessionGroupRepository } from '../../../src/storage/repositories/space-session-group-repository.ts';
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
		triggeredBy: 'test',
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

interface TestCtx {
	db: BunDatabase;
	dir: string;
	spaceId: string;
	sessionGroupRepo: SpaceSessionGroupRepository;
	workflowRunRepo: SpaceWorkflowRunRepository;
	groupId: string;
	coderSessionId: string;
	reviewerSessionId: string;
}

function makeCtx(): TestCtx {
	const { db, dir } = makeDb();
	const spaceId = 'space-send-msg-unified-test';

	seedSpaceRow(db, spaceId);

	const sessionGroupRepo = new SpaceSessionGroupRepository(db);
	const workflowRunRepo = new SpaceWorkflowRunRepository(db);

	const group = sessionGroupRepo.createGroup({
		spaceId,
		name: 'task:test-task-unified',
		taskId: 'test-task-unified',
	});

	const coderSessionId = 'session-coder-unified';
	const reviewerSessionId = 'session-reviewer-unified';

	sessionGroupRepo.addMember(group.id, 'session-task-agent-unified', {
		role: 'task-agent',
		status: 'active',
		orderIndex: 0,
	});
	sessionGroupRepo.addMember(group.id, coderSessionId, {
		role: 'coder',
		status: 'active',
		agentId: 'agent-coder',
		orderIndex: 1,
	});
	sessionGroupRepo.addMember(group.id, reviewerSessionId, {
		role: 'reviewer',
		status: 'active',
		agentId: 'agent-reviewer',
		orderIndex: 2,
	});

	return {
		db,
		dir,
		spaceId,
		sessionGroupRepo,
		workflowRunRepo,
		groupId: group.id,
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
		workflowNodeId: '',
		sessionGroupRepo: ctx.sessionGroupRepo,
		spaceTaskRepo: new SpaceTaskRepository(ctx.db),
		getGroupId: () => ctx.groupId,
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
		const injected: Array<{ sessionId: string; message: string }> = [];
		const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

		const agentMessageRouter = new AgentMessageRouter({
			sessionGroupRepo: ctx.sessionGroupRepo,
			getGroupId: () => ctx.groupId,
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
		const injected: Array<{ sessionId: string; message: string }> = [];
		const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

		const agentMessageRouter = new AgentMessageRouter({
			sessionGroupRepo: ctx.sessionGroupRepo,
			getGroupId: () => ctx.groupId,
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
		const injected: Array<{ sessionId: string; message: string }> = [];
		const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

		const agentMessageRouter = new AgentMessageRouter({
			sessionGroupRepo: ctx.sessionGroupRepo,
			getGroupId: () => ctx.groupId,
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
		const injected: Array<{ sessionId: string; message: string }> = [];
		const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

		const agentMessageRouter = new AgentMessageRouter({
			sessionGroupRepo: ctx.sessionGroupRepo,
			getGroupId: () => ctx.groupId,
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
			sessionGroupRepo: ctx.sessionGroupRepo,
			getGroupId: () => ctx.groupId,
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
