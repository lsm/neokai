/**
 * Unit tests for SessionChannelRouter
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
import { SpaceSessionGroupRepository } from '../../../src/storage/repositories/space-session-group-repository.ts';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SessionChannelRouter } from '../../../src/lib/space/runtime/session-channel-router.ts';
import type { SessionChannelRouterConfig } from '../../../src/lib/space/runtime/session-channel-router.ts';
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
	workflowRunRepo: SpaceWorkflowRunRepository;
	groupId: string;
	coderSessionId: string;
	reviewerSessionId: string;
	taskAgentSessionId: string;
}

function makeCtx(): TestCtx {
	const { db, dir } = makeDb();
	const spaceId = 'space-channel-router-test';

	seedSpaceRow(db, spaceId);

	const sessionGroupRepo = new SpaceSessionGroupRepository(db);
	const workflowRunRepo = new SpaceWorkflowRunRepository(db);

	const group = sessionGroupRepo.createGroup({
		spaceId,
		name: 'task:test-task-router',
		taskId: 'test-task-router',
	});

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

	return {
		db,
		dir,
		spaceId,
		sessionGroupRepo,
		workflowRunRepo,
		groupId: group.id,
		coderSessionId,
		reviewerSessionId,
		taskAgentSessionId,
	};
}

function makeRouter(
	ctx: TestCtx,
	workflowRunId: string,
	injected: Array<{ sessionId: string; message: string }>,
	overrides: Partial<SessionChannelRouterConfig> = {}
): SessionChannelRouter {
	return new SessionChannelRouter({
		sessionGroupRepo: ctx.sessionGroupRepo,
		getGroupId: () => ctx.groupId,
		workflowRunRepo: ctx.workflowRunRepo,
		workflowRunId,
		messageInjector: async (sessionId, message) => {
			injected.push({ sessionId, message });
		},
		...overrides,
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionChannelRouter: agent name (role) target → DM', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('delivers message to single session with matching role', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		const injected: Array<{ sessionId: string; message: string }> = [];
		const router = makeRouter(ctx, workflowRunId, injected);

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

describe('SessionChannelRouter: multiple agents sharing a role → fan-out', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('delivers to all sessions with the target role', async () => {
		// Add a second reviewer
		ctx.sessionGroupRepo.addMember(ctx.groupId, 'session-reviewer-2', {
			role: 'reviewer',
			status: 'active',
			orderIndex: 3,
		});

		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		const injected: Array<{ sessionId: string; message: string }> = [];
		const router = makeRouter(ctx, workflowRunId, injected);

		const result = await router.deliverMessage({
			fromRole: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'reviewer',
			message: 'hello both!',
		});

		expect(result.success).toBe(true);
		expect(result.delivered).toHaveLength(2);
		const sessionIds = result.delivered.map((d) => d.sessionId);
		expect(sessionIds).toContain(ctx.reviewerSessionId);
		expect(sessionIds).toContain('session-reviewer-2');
	});
});

describe('SessionChannelRouter: broadcast * → all permitted targets', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('delivers to all topology-permitted targets', async () => {
		// Add a security member
		ctx.sessionGroupRepo.addMember(ctx.groupId, 'session-security', {
			role: 'security',
			status: 'active',
			orderIndex: 3,
		});

		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
			makeResolvedChannel('coder', 'security'),
		]);
		const injected: string[] = [];
		const router = makeRouter(ctx, workflowRunId, [], {
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
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('reviewer', 'coder'), // coder has no outgoing channels
		]);
		const router = makeRouter(ctx, workflowRunId, []);

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

describe('SessionChannelRouter: unknown target → clear error', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns error with "no agent or node found" when target unknown', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		const router = makeRouter(ctx, workflowRunId, []);

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
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		const router = makeRouter(ctx, workflowRunId, []);

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

describe('SessionChannelRouter: unauthorized target → error with permitted targets', () => {
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
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('reviewer', 'coder'),
		]);
		const router = makeRouter(ctx, workflowRunId, []);

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

describe('SessionChannelRouter: unauthorized target → error with structured fields', () => {
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
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('reviewer', 'coder'),
		]);
		const router = makeRouter(ctx, workflowRunId, []);

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

describe('SessionChannelRouter: empty topology → error', () => {
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
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, []);
		const router = makeRouter(ctx, workflowRunId, []);

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

describe('SessionChannelRouter: partial delivery failure → partial success', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns partial success when one of two sessions fails', async () => {
		// Add a second reviewer
		ctx.sessionGroupRepo.addMember(ctx.groupId, 'session-reviewer-2', {
			role: 'reviewer',
			status: 'active',
			orderIndex: 3,
		});

		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);

		let callCount = 0;
		const router = makeRouter(ctx, workflowRunId, [], {
			messageInjector: async (_sid) => {
				callCount++;
				if (callCount === 1) throw new Error('first injection failed');
			},
		});

		const result = await router.deliverMessage({
			fromRole: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'reviewer',
			message: 'hello',
		});

		expect(result.success).toBe('partial');
		expect(result.delivered).toHaveLength(1);
		expect(result.failed).toHaveLength(1);
		expect(callCount).toBe(2);
	});
});

describe('SessionChannelRouter: all deliveries fail → false success', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns success: false when all injections fail', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		const router = makeRouter(ctx, workflowRunId, [], {
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

describe('SessionChannelRouter: node name target with nodeGroups → fan-out', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('delivers to all roles mapped to a node name', async () => {
		// Add security member
		ctx.sessionGroupRepo.addMember(ctx.groupId, 'session-security', {
			role: 'security',
			status: 'active',
			orderIndex: 3,
		});

		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
			makeResolvedChannel('coder', 'security'),
		]);
		const injected: string[] = [];
		const router = makeRouter(ctx, workflowRunId, [], {
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

describe('SessionChannelRouter: node name target without nodeGroups → unknown target error', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns unknown target error when nodeGroups not configured', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		const router = makeRouter(ctx, workflowRunId, []);
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

describe('SessionChannelRouter: missing group → error', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns error when getGroupId returns undefined', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		const router = makeRouter(ctx, workflowRunId, [], {
			getGroupId: () => undefined,
		});

		const result = await router.deliverMessage({
			fromRole: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'reviewer',
			message: 'test',
		});

		expect(result.success).toBe(false);
		expect(result.reason).toContain('No session group found');
	});

	test('returns error when group ID does not exist in DB', async () => {
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
		]);
		const router = makeRouter(ctx, workflowRunId, [], {
			getGroupId: () => 'nonexistent-group-id',
		});

		const result = await router.deliverMessage({
			fromRole: 'coder',
			fromSessionId: ctx.coderSessionId,
			target: 'reviewer',
			message: 'test',
		});

		expect(result.success).toBe(false);
		expect(result.reason).toContain('not found');
	});
});

describe('SessionChannelRouter: notFoundRoles structured field', () => {
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
		// but ghost-role has no active sessions in the group
		const workflowRunId = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
			makeResolvedChannel('coder', 'reviewer'),
			makeResolvedChannel('coder', 'ghost-role'),
		]);
		const injected: Array<{ sessionId: string; message: string }> = [];
		const router = makeRouter(ctx, workflowRunId, injected);

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
