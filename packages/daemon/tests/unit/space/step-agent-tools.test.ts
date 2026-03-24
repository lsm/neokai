/**
 * Unit tests for createStepAgentToolHandlers()
 *
 * Covers all step agent peer communication tools:
 *   list_peers   — list peers excluding self and task-agent
 *   send_message — channel-validated direct messaging
 *
 * Tests use a real SQLite database (via runMigrations) and mock message
 * injectors so no real agent sessions are created.
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
	createStepAgentToolHandlers,
	createStepAgentMcpServer,
	type StepAgentToolsConfig,
} from '../../../src/lib/space/tools/step-agent-tools.ts';
import type { ResolvedChannel } from '@neokai/shared';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-step-agent-tools',
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

// ---------------------------------------------------------------------------
// Workflow run helper
// ---------------------------------------------------------------------------

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
		steps: [],
		transitions: [],
		startStepId: '',
		rules: [],
	});

	const runRepo = new SpaceWorkflowRunRepository(db);
	const run = runRepo.createRun({
		spaceId,
		workflowId: workflow.id,
		title: 'Test Run',
		triggeredBy: 'test',
	});

	// Store resolved channels in config
	if (channels.length > 0) {
		runRepo.updateRun(run.id, {
			config: { _resolvedChannels: channels },
		});
	}

	return run.id;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

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
	sessionGroupRepo: SpaceSessionGroupRepository;
	groupId: string;
	coderSessionId: string;
	reviewerSessionId: string;
	taskAgentSessionId: string;
	workflowRunRepo: SpaceWorkflowRunRepository;
}

function makeCtx(): TestCtx {
	const { db, dir } = makeDb();
	const spaceId = 'space-step-tools-test';

	seedSpaceRow(db, spaceId);

	const sessionGroupRepo = new SpaceSessionGroupRepository(db);

	// Create a session group for the task
	const group = sessionGroupRepo.createGroup({
		spaceId,
		name: 'task:test-task-1',
		taskId: 'test-task-1',
	});

	// Add members: task-agent, coder, reviewer
	const taskAgentSessionId = 'session-task-agent';
	const coderSessionId = 'session-coder';
	const reviewerSessionId = 'session-reviewer';

	sessionGroupRepo.addMember(group.id, taskAgentSessionId, {
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

	const workflowRunRepo = new SpaceWorkflowRunRepository(db);

	return {
		db,
		dir,
		spaceId,
		sessionGroupRepo,
		groupId: group.id,
		coderSessionId,
		reviewerSessionId,
		taskAgentSessionId,
		workflowRunRepo,
	};
}

function makeConfig(
	ctx: TestCtx,
	overrides: Partial<StepAgentToolsConfig> = {}
): StepAgentToolsConfig {
	const injectedMessages: Array<{ sessionId: string; message: string }> = [];

	return {
		mySessionId: ctx.coderSessionId,
		myRole: 'coder',
		taskId: 'test-task-1',
		workflowRunId: '',
		sessionGroupRepo: ctx.sessionGroupRepo,
		getGroupId: () => ctx.groupId,
		workflowRunRepo: ctx.workflowRunRepo,
		messageInjector: async (sessionId, message) => {
			injectedMessages.push({ sessionId, message });
		},
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests: list_peers
// ---------------------------------------------------------------------------

describe('step-agent-tools: list_peers', () => {
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
		const handlers = createStepAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.peers).toHaveLength(1); // only reviewer (coder=self, task-agent=excluded)
		expect(data.peers[0].role).toBe('reviewer');
		expect(data.peers[0].sessionId).toBe(ctx.reviewerSessionId);
		expect(data.myRole).toBe('coder');
	});

	test('reports no channel topology when none declared', async () => {
		const config = makeConfig(ctx);
		const handlers = createStepAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.channelTopologyDeclared).toBe(false);
		expect(data.permittedTargets).toEqual([]);
	});

	test('reports permitted targets when channels declared', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		const config = makeConfig(ctx, { workflowRunId });
		const handlers = createStepAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.channelTopologyDeclared).toBe(true);
		expect(data.permittedTargets).toEqual(['reviewer']);
	});

	test('returns error when group not found', async () => {
		const config = makeConfig(ctx, { getGroupId: () => undefined });
		const handlers = createStepAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('No session group found');
	});

	test('returns empty peer list when only self and task-agent in group', async () => {
		// Create a group with just task-agent and coder (no reviewer)
		const isolatedGroup = ctx.sessionGroupRepo.createGroup({
			spaceId: ctx.spaceId,
			name: 'task:isolated',
			taskId: 'isolated-task',
		});
		ctx.sessionGroupRepo.addMember(isolatedGroup.id, 'session-isolated-ta', {
			role: 'task-agent',
			status: 'active',
		});
		ctx.sessionGroupRepo.addMember(isolatedGroup.id, ctx.coderSessionId, {
			role: 'coder',
			status: 'active',
		});

		const config = makeConfig(ctx, { getGroupId: () => isolatedGroup.id });
		const handlers = createStepAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.peers).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Tests: send_message
// ---------------------------------------------------------------------------

describe('step-agent-tools: send_message', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('point-to-point succeeds when channel declared', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		const injected: Array<{ sessionId: string; message: string }> = [];
		const config = makeConfig(ctx, {
			workflowRunId,
			messageInjector: async (sid, msg) => {
				injected.push({ sessionId: sid, message: msg });
			},
		});
		const handlers = createStepAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'reviewer', message: 'LGTM!' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.delivered).toHaveLength(1);
		expect(data.delivered[0].sessionId).toBe(ctx.reviewerSessionId);
		expect(data.delivered[0].role).toBe('reviewer');
		expect(injected).toHaveLength(1);
		expect(injected[0].message).toBe('[Message from coder]: LGTM!');
	});

	test('point-to-point fails when channel not declared', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('reviewer', 'coder'), // reverse direction only
		]);
		const config = makeConfig(ctx, { workflowRunId });
		const handlers = createStepAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'reviewer', message: 'hello' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain("does not permit 'coder' to send to: reviewer");
		expect(data.unauthorizedRoles).toContain('reviewer');
	});

	test('returns error when no channels declared at all (empty topology blocks send_message)', async () => {
		const config = makeConfig(ctx); // no workflowRunId, no channels
		const handlers = createStepAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'reviewer', message: 'test' });
		const data = JSON.parse(result.content[0].text);

		// With no declared channels, send_message is unavailable.
		expect(data.success).toBe(false);
		expect(data.error).toContain('No channel topology declared');
	});

	test('broadcast (*) succeeds and delivers to all permitted targets', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		const injected: string[] = [];
		const config = makeConfig(ctx, {
			workflowRunId,
			messageInjector: async (sid) => {
				injected.push(sid);
			},
		});
		const handlers = createStepAgentToolHandlers(config);
		const result = await handlers.send_message({ target: '*', message: 'broadcast!' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.delivered).toHaveLength(1);
		expect(injected).toContain(ctx.reviewerSessionId);
	});

	test('broadcast (*) fails when no channels declared', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('reviewer', 'coder'), // coder has no outgoing channels
		]);
		const config = makeConfig(ctx, { workflowRunId });
		const handlers = createStepAgentToolHandlers(config);
		const result = await handlers.send_message({ target: '*', message: 'broadcast' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain("No permitted targets for role 'coder'");
	});

	test('broadcast (*) with empty topology returns error', async () => {
		// No channels declared at all
		const config = makeConfig(ctx);
		const handlers = createStepAgentToolHandlers(config);
		const result = await handlers.send_message({ target: '*', message: 'broadcast' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('No channel topology declared');
	});

	test('multicast delivers to all specified target roles', async () => {
		// Add a third member (security) to the group
		ctx.sessionGroupRepo.addMember(ctx.groupId, 'session-security', {
			role: 'security',
			status: 'active',
		});

		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
			makeResolvedChannel('coder', 'security'),
		]);
		const injected: string[] = [];
		const config = makeConfig(ctx, {
			workflowRunId,
			messageInjector: async (sid) => {
				injected.push(sid);
			},
		});
		const handlers = createStepAgentToolHandlers(config);
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
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
			// no coder → security channel
		]);
		// Add security member
		ctx.sessionGroupRepo.addMember(ctx.groupId, 'session-security', {
			role: 'security',
			status: 'active',
		});
		const config = makeConfig(ctx, { workflowRunId });
		const handlers = createStepAgentToolHandlers(config);
		const result = await handlers.send_message({
			target: ['reviewer', 'security'],
			message: 'msg',
		});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.unauthorizedRoles).toContain('security');
	});

	test('hub-spoke: spoke cannot send to other spokes', async () => {
		// Hub-spoke topology: hub ↔ coder, hub ↔ reviewer (coder cannot send to reviewer directly)
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('hub', 'coder', true),
			makeResolvedChannel('coder', 'hub', true),
			makeResolvedChannel('hub', 'reviewer', true),
			makeResolvedChannel('reviewer', 'hub', true),
		]);
		const config = makeConfig(ctx, { workflowRunId }); // myRole='coder'
		const handlers = createStepAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'reviewer', message: 'hello' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain("does not permit 'coder' to send to: reviewer");
	});

	test('hub-spoke: spoke can reply to hub', async () => {
		// Add hub member to group
		ctx.sessionGroupRepo.addMember(ctx.groupId, 'session-hub', {
			role: 'hub',
			status: 'active',
		});
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('hub', 'coder', true),
			makeResolvedChannel('coder', 'hub', true),
		]);
		const injected: string[] = [];
		const config = makeConfig(ctx, {
			workflowRunId,
			messageInjector: async (sid) => {
				injected.push(sid);
			},
		});
		const handlers = createStepAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'hub', message: 'done!' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(injected).toContain('session-hub');
	});

	test('bidirectional: both directions work', async () => {
		// coder ↔ reviewer
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
			makeResolvedChannel('reviewer', 'coder'),
		]);
		const injectedToReviewer: string[] = [];
		const config = makeConfig(ctx, {
			workflowRunId,
			messageInjector: async (sid) => {
				injectedToReviewer.push(sid);
			},
		});
		const handlers = createStepAgentToolHandlers(config);

		// coder → reviewer
		const r1 = await handlers.send_message({ target: 'reviewer', message: 'code ready' });
		expect(JSON.parse(r1.content[0].text).success).toBe(true);

		// reviewer → coder (as reviewer)
		const configAsReviewer = makeConfig(ctx, {
			workflowRunId,
			mySessionId: ctx.reviewerSessionId,
			myRole: 'reviewer',
			messageInjector: async (sid) => {
				injectedToReviewer.push(sid);
			},
		});
		const handlersAsReviewer = createStepAgentToolHandlers(configAsReviewer);
		const r2 = await handlersAsReviewer.send_message({ target: 'coder', message: 'approved' });
		expect(JSON.parse(r2.content[0].text).success).toBe(true);
	});

	test('returns error when target role has no active sessions', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'tester'), // 'tester' role not in group
		]);
		const config = makeConfig(ctx, { workflowRunId });
		const handlers = createStepAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'tester', message: 'test pls' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('No active sessions found for target role(s): tester');
	});

	test('handles partial injection failures gracefully (partial success)', async () => {
		// Add second reviewer to group
		ctx.sessionGroupRepo.addMember(ctx.groupId, 'session-reviewer-2', {
			role: 'reviewer',
			status: 'active',
		});
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		let callCount = 0;
		const config = makeConfig(ctx, {
			workflowRunId,
			messageInjector: async (_sid) => {
				callCount++;
				if (callCount === 1) throw new Error('injection failed');
				// second call succeeds
			},
		});
		const handlers = createStepAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'reviewer', message: 'hello' });
		const data = JSON.parse(result.content[0].text);

		// Partial success — one delivered, one failed
		expect(data.success).toBe('partial');
		expect(data.delivered).toHaveLength(1);
		expect(data.failed).toHaveLength(1);
		// Both targets were attempted (best-effort, not stop-on-first-error)
		expect(callCount).toBe(2);
	});

	test('fails entirely when all injections fail', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		const config = makeConfig(ctx, {
			workflowRunId,
			messageInjector: async () => {
				throw new Error('always fails');
			},
		});
		const handlers = createStepAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'reviewer', message: 'test' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.failed).toHaveLength(1);
		expect(data.delivered).toHaveLength(0);
	});

	test('returns error when group not found', async () => {
		const config = makeConfig(ctx, { getGroupId: () => undefined });
		const handlers = createStepAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'reviewer', message: 'test' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('No session group found');
	});

	test('returns error when group ID returned but not in DB', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		const config = makeConfig(ctx, {
			workflowRunId,
			getGroupId: () => 'nonexistent-group-id',
		});
		const handlers = createStepAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'reviewer', message: 'Hello' });
		const data = JSON.parse(result.content[0].text);
		expect(data.success).toBe(false);
		expect(data.error).toMatch(/not found/);
	});

	test('best-effort multicast: first delivery succeeds, second fails — partial success', async () => {
		// Add security member so we can send to two different non-task-agent roles
		ctx.sessionGroupRepo.addMember(ctx.groupId, 'session-security', {
			role: 'security',
			status: 'active',
		});
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
			makeResolvedChannel('coder', 'security'),
		]);

		let callCount = 0;
		const config = makeConfig(ctx, {
			workflowRunId,
			messageInjector: async (_sid, _msg) => {
				callCount++;
				if (callCount === 2) throw new Error('session not available');
			},
		});
		const handlers = createStepAgentToolHandlers(config);

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
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		const config = makeConfig(ctx, {
			workflowRunId,
			messageInjector: async () => {
				throw new Error('all sessions unavailable');
			},
		});
		const handlers = createStepAgentToolHandlers(config);

		const result = await handlers.send_message({ target: 'reviewer', message: 'Hello' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.delivered).toHaveLength(0);
		expect(data.failed).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Tests: createStepAgentMcpServer (factory)
// ---------------------------------------------------------------------------

describe('step-agent-tools: createStepAgentMcpServer', () => {
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
		const server = createStepAgentMcpServer(config);

		// Server should be an object with a server property (MCP SDK server)
		expect(server).toBeDefined();
		expect(typeof server).toBe('object');
	});
});

// ---------------------------------------------------------------------------
// Tests: step agent system prompt
// ---------------------------------------------------------------------------

describe('step-agent-tools: system prompt includes peer communication section', () => {
	test('buildCustomAgentSystemPrompt includes Peer Communication section', async () => {
		const { buildCustomAgentSystemPrompt } = await import(
			'../../../src/lib/space/agents/custom-agent.ts'
		);

		const prompt = buildCustomAgentSystemPrompt({
			id: 'agent-1',
			spaceId: 'space-1',
			name: 'Coder',
			role: 'coder',
			description: '',
			model: null,
			tools: [],
			systemPrompt: null,
			injectWorkflowContext: false,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		expect(prompt).toContain('Peer Communication');
		expect(prompt).toContain('send_message');
		expect(prompt).toContain('list_peers');
		expect(prompt).toContain('channel-validated');
	});
});
