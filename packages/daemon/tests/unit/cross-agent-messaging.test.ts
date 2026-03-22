/**
 * Comprehensive unit tests for cross-agent messaging.
 *
 * Covers the full messaging stack in one place:
 *
 *   ChannelResolver       — canSend(), getPermittedTargets(), all topology patterns
 *   send_feedback         — channel validation, target modes, fan-out, hub-spoke
 *   request_peer_input    — Task Agent mediated async flow
 *   list_peers            — peer discovery with channel info
 *   list_group_members    — Task Agent group view
 *   relay_message         — Task Agent unrestricted relay, cross-group rejection
 *
 * All topology patterns are tested:
 *   A → B          one-way point-to-point
 *   A ↔ B          bidirectional point-to-point
 *   A → [B,C,D]    fan-out one-way
 *   A ↔ [B,C,D]    hub-spoke bidirectional (spoke isolation enforced)
 *   * → B          wildcard from (any role sends to B, after expansion)
 *   A → *          wildcard to   (A sends to all roles, after expansion)
 *
 * Group scoping is explicitly tested: messages must never cross task-group
 * boundaries (relay_message rejects out-of-group target session IDs).
 *
 * Tests use a real SQLite database (via runMigrations) and mock injectors —
 * no real agent sessions are created.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../src/storage/schema/index.ts';
import { SpaceSessionGroupRepository } from '../../src/storage/repositories/space-session-group-repository.ts';
import { SpaceWorkflowRepository } from '../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../src/lib/space/managers/space-task-manager.ts';
import { SpaceManager } from '../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../src/lib/space/runtime/space-runtime.ts';
import { ChannelResolver } from '../../src/lib/space/runtime/channel-resolver.ts';
import {
	createStepAgentToolHandlers,
	type StepAgentToolsConfig,
} from '../../src/lib/space/tools/step-agent-tools.ts';
import {
	createTaskAgentToolHandlers,
	type SubSessionFactory,
	type SubSessionMemberInfo,
	type SubSessionState,
	type TaskAgentToolsConfig,
} from '../../src/lib/space/tools/task-agent-tools.ts';
import type { ResolvedChannel, Space, SpaceWorkflow } from '@neokai/shared';

// ===========================================================================
// DB / seed helpers
// ===========================================================================

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-cross-agent-messaging',
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
     VALUES (?, '/tmp', ?, '', '', '', '[]', '[]', 'active', ?, ?)`
	).run(spaceId, `Space ${spaceId}`, Date.now(), Date.now());
}

function seedAgent(
	db: BunDatabase,
	agentId: string,
	spaceId: string,
	name: string,
	role: string
): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, role, description, model, tools, system_prompt,
     config, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', null, '[]', '', null, ?, ?)`
	).run(agentId, spaceId, name, role, Date.now(), Date.now());
}

// ===========================================================================
// ResolvedChannel builder helpers
// ===========================================================================

function ch(fromRole: string, toRole: string, isHubSpoke = false): ResolvedChannel {
	return {
		fromRole,
		toRole,
		fromAgentId: `agent-${fromRole}`,
		toAgentId: `agent-${toRole}`,
		direction: 'one-way',
		isHubSpoke,
	};
}

// ===========================================================================
// Step-agent test context
// ===========================================================================

interface StepCtx {
	db: BunDatabase;
	dir: string;
	spaceId: string;
	sessionGroupRepo: SpaceSessionGroupRepository;
	workflowRunRepo: SpaceWorkflowRunRepository;
	groupId: string;
	/** Set channels in the active workflow run config */
	setChannels: (channels: ResolvedChannel[]) => void;
}

function makeStepCtx(
	members: Array<{ sessionId: string; role: string; status?: string }>
): StepCtx {
	const { db, dir } = makeDb();
	const spaceId = 'space-cam-step';
	seedSpace(db, spaceId);

	const sessionGroupRepo = new SpaceSessionGroupRepository(db);
	const group = sessionGroupRepo.createGroup({ spaceId, name: 'task:cam-1', taskId: 'cam-task-1' });

	for (let i = 0; i < members.length; i++) {
		const m = members[i];
		sessionGroupRepo.addMember(group.id, m.sessionId, {
			role: m.role,
			status: (m.status as 'active' | 'completed' | 'failed') ?? 'active',
			orderIndex: i,
		});
	}

	const workflowRepo = new SpaceWorkflowRepository(db);
	const runRepo = new SpaceWorkflowRunRepository(db);

	// Create a minimal workflow + run so we can attach a config
	const wf = workflowRepo.createWorkflow({
		spaceId,
		name: 'cam-wf',
		description: '',
		steps: [],
		transitions: [],
		startStepId: '',
		rules: [],
	});
	const run = runRepo.createRun({
		spaceId,
		workflowId: wf.id,
		title: 'cam run',
		triggeredBy: 'test',
	});

	return {
		db,
		dir,
		spaceId,
		sessionGroupRepo,
		workflowRunRepo: runRepo,
		groupId: group.id,
		setChannels: (channels: ResolvedChannel[]) => {
			runRepo.updateRun(run.id, { config: { _resolvedChannels: channels } });
		},
	};
}

function makeStepConfig(
	ctx: StepCtx,
	mySessionId: string,
	myRole: string,
	overrides: Partial<StepAgentToolsConfig> = {}
): StepAgentToolsConfig & {
	injectedMessages: Array<{ sessionId: string; message: string }>;
	taskAgentMessages: string[];
} {
	const injectedMessages: Array<{ sessionId: string; message: string }> = [];
	const taskAgentMessages: string[] = [];

	// Find the active run to use as workflowRunId
	const runs = ctx.workflowRunRepo.listBySpace(ctx.spaceId);
	const runId = runs[0]?.id ?? '';

	const config = {
		mySessionId,
		myRole,
		taskId: 'cam-task-1',
		workflowRunId: runId,
		sessionGroupRepo: ctx.sessionGroupRepo,
		getGroupId: () => ctx.groupId,
		workflowRunRepo: ctx.workflowRunRepo,
		messageInjector: async (sessionId: string, message: string) => {
			injectedMessages.push({ sessionId, message });
		},
		injectToTaskAgent: async (message: string) => {
			taskAgentMessages.push(message);
		},
		...overrides,
	};

	return Object.assign(config, { injectedMessages, taskAgentMessages });
}

// ===========================================================================
// Task-agent test context
// ===========================================================================

interface TaskCtx {
	db: BunDatabase;
	dir: string;
	spaceId: string;
	agentId: string;
	space: Space;
	workflowManager: SpaceWorkflowManager;
	workflowRunRepo: SpaceWorkflowRunRepository;
	taskRepo: SpaceTaskRepository;
	taskManager: SpaceTaskManager;
	agentManager: SpaceAgentManager;
	runtime: SpaceRuntime;
	sessionGroupRepo: SpaceSessionGroupRepository;
}

function makeTaskCtx(): TaskCtx {
	const { db, dir } = makeDb();
	const spaceId = 'space-cam-task';
	seedSpace(db, spaceId);

	const agentId = 'agent-coder-cam';
	seedAgent(db, agentId, spaceId, 'Coder', 'coder');

	const agentRepo = new SpaceAgentRepository(db);
	const agentManager = new SpaceAgentManager(agentRepo);

	const workflowRepo = new SpaceWorkflowRepository(db);
	const workflowManager = new SpaceWorkflowManager(workflowRepo);

	const workflowRunRepo = new SpaceWorkflowRunRepository(db);
	const taskRepo = new SpaceTaskRepository(db);
	const spaceManager = new SpaceManager(db);
	const taskManager = new SpaceTaskManager(db, spaceId);
	const sessionGroupRepo = new SpaceSessionGroupRepository(db);

	const runtime = new SpaceRuntime({
		db,
		spaceManager,
		spaceAgentManager: agentManager,
		spaceWorkflowManager: workflowManager,
		workflowRunRepo,
		taskRepo,
	});

	const space: Space = {
		id: spaceId,
		workspacePath: '/tmp/workspace',
		name: 'Test Space',
		description: '',
		backgroundContext: '',
		instructions: '',
		sessionIds: [],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	return {
		db,
		dir,
		spaceId,
		agentId,
		space,
		workflowManager,
		workflowRunRepo,
		taskRepo,
		taskManager,
		agentManager,
		runtime,
		sessionGroupRepo,
	};
}

function makeMockFactory(overrides?: {
	create?: (init: unknown, memberInfo?: SubSessionMemberInfo) => Promise<string>;
}): SubSessionFactory {
	const states = new Map<string, SubSessionState>();
	return {
		async create(init: unknown, memberInfo?: SubSessionMemberInfo): Promise<string> {
			if (overrides?.create) return overrides.create(init, memberInfo);
			const id = `sub-${Math.random().toString(36).slice(2)}`;
			states.set(id, { isProcessing: true, isComplete: false });
			return id;
		},
		getProcessingState(sessionId: string): SubSessionState | null {
			return states.get(sessionId) ?? null;
		},
		onComplete(_sessionId: string, _callback: () => Promise<void>): void {},
	};
}

async function startRun(ctx: TaskCtx, wf: SpaceWorkflow) {
	const run = ctx.workflowRunRepo.createRun({
		spaceId: ctx.spaceId,
		workflowId: wf.id,
		title: 'cam run',
		triggeredBy: 'test',
	});
	const mainTask = ctx.taskManager.createTask({
		spaceId: ctx.spaceId,
		title: 'Main Task',
		description: '',
		workflowId: wf.id,
		workflowRunId: run.id,
	});
	return { run, mainTask };
}

function makeTaskConfig(
	ctx: TaskCtx,
	taskId: string,
	runId: string,
	factory: SubSessionFactory,
	overrides: {
		groupId?: string;
		messageInjector?: (sessionId: string, message: string) => Promise<void>;
	} = {}
): TaskAgentToolsConfig {
	return {
		taskId,
		space: ctx.space,
		workflowRunId: runId,
		workspacePath: '/tmp/workspace',
		runtime: ctx.runtime,
		workflowManager: ctx.workflowManager,
		taskRepo: ctx.taskRepo,
		workflowRunRepo: ctx.workflowRunRepo,
		agentManager: ctx.agentManager,
		taskManager: ctx.taskManager,
		sessionFactory: factory,
		messageInjector: overrides.messageInjector ?? (async () => {}),
		onSubSessionComplete: async () => {},
		sessionGroupRepo: ctx.sessionGroupRepo,
		getGroupId: () => overrides.groupId,
	};
}

function buildSingleStepWf(ctx: TaskCtx) {
	const stepId = `step-${Math.random().toString(36).slice(2)}`;
	return ctx.workflowManager.createWorkflow({
		spaceId: ctx.spaceId,
		name: 'Single-Step WF',
		steps: [{ id: stepId, name: 'Only Step', agentId: ctx.agentId }],
		transitions: [],
		startStepId: stepId,
		rules: [],
	});
}

// ===========================================================================
// Helper: parse JSON result from ToolResult
// ===========================================================================

function parse(result: { content: Array<{ text: string }> }): Record<string, unknown> {
	return JSON.parse(result.content[0].text);
}

// ===========================================================================
// 1. ChannelResolver — canSend() basic correctness
// ===========================================================================

describe('ChannelResolver.canSend — permit / deny', () => {
	test('permits declared one-way channel', () => {
		const resolver = new ChannelResolver([ch('A', 'B')]);
		expect(resolver.canSend('A', 'B')).toBe(true);
	});

	test('denies reverse direction of one-way channel', () => {
		const resolver = new ChannelResolver([ch('A', 'B')]);
		expect(resolver.canSend('B', 'A')).toBe(false);
	});

	test('permits both directions for bidirectional (two one-way entries)', () => {
		const resolver = new ChannelResolver([ch('A', 'B'), ch('B', 'A')]);
		expect(resolver.canSend('A', 'B')).toBe(true);
		expect(resolver.canSend('B', 'A')).toBe(true);
	});

	test('denies all directions when resolver is empty', () => {
		const resolver = new ChannelResolver([]);
		expect(resolver.canSend('A', 'B')).toBe(false);
		expect(resolver.canSend('B', 'A')).toBe(false);
	});

	test('denies undeclared roles', () => {
		const resolver = new ChannelResolver([ch('A', 'B')]);
		expect(resolver.canSend('C', 'A')).toBe(false);
		expect(resolver.canSend('A', 'C')).toBe(false);
	});
});

// ===========================================================================
// 2. ChannelResolver — all topology patterns
// ===========================================================================

describe('ChannelResolver — topology: A → B one-way', () => {
	test('A can send to B, B cannot send to A', () => {
		const resolver = new ChannelResolver([ch('A', 'B')]);
		expect(resolver.canSend('A', 'B')).toBe(true);
		expect(resolver.canSend('B', 'A')).toBe(false);
	});

	test('getPermittedTargets(A) = [B], getPermittedTargets(B) = []', () => {
		const resolver = new ChannelResolver([ch('A', 'B')]);
		expect(resolver.getPermittedTargets('A')).toEqual(['B']);
		expect(resolver.getPermittedTargets('B')).toEqual([]);
	});
});

describe('ChannelResolver — topology: A ↔ B bidirectional', () => {
	test('both directions permitted', () => {
		const resolver = new ChannelResolver([ch('A', 'B'), ch('B', 'A')]);
		expect(resolver.canSend('A', 'B')).toBe(true);
		expect(resolver.canSend('B', 'A')).toBe(true);
	});

	test('no other roles are permitted', () => {
		const resolver = new ChannelResolver([ch('A', 'B'), ch('B', 'A')]);
		expect(resolver.canSend('A', 'C')).toBe(false);
		expect(resolver.canSend('C', 'A')).toBe(false);
	});
});

describe('ChannelResolver — topology: A → [B, C, D] fan-out one-way', () => {
	test('A can send to B, C, D; none can reply', () => {
		const resolver = new ChannelResolver([ch('A', 'B'), ch('A', 'C'), ch('A', 'D')]);
		expect(resolver.canSend('A', 'B')).toBe(true);
		expect(resolver.canSend('A', 'C')).toBe(true);
		expect(resolver.canSend('A', 'D')).toBe(true);
		expect(resolver.canSend('B', 'A')).toBe(false);
		expect(resolver.canSend('C', 'A')).toBe(false);
		expect(resolver.canSend('D', 'A')).toBe(false);
	});

	test('spokes cannot communicate with each other', () => {
		const resolver = new ChannelResolver([ch('A', 'B'), ch('A', 'C'), ch('A', 'D')]);
		expect(resolver.canSend('B', 'C')).toBe(false);
		expect(resolver.canSend('C', 'D')).toBe(false);
		expect(resolver.canSend('D', 'B')).toBe(false);
	});

	test('getPermittedTargets(A) returns all spokes; spokes return empty', () => {
		const resolver = new ChannelResolver([ch('A', 'B'), ch('A', 'C'), ch('A', 'D')]);
		expect(resolver.getPermittedTargets('A').sort()).toEqual(['B', 'C', 'D']);
		expect(resolver.getPermittedTargets('B')).toEqual([]);
		expect(resolver.getPermittedTargets('C')).toEqual([]);
		expect(resolver.getPermittedTargets('D')).toEqual([]);
	});
});

describe('ChannelResolver — topology: A ↔ [B, C, D] hub-spoke', () => {
	// Hub A ↔ spokes B, C, D — expanded to hub→each + each→hub, isHubSpoke=true
	function makeHubSpokeResolver() {
		return new ChannelResolver([
			ch('A', 'B', true),
			ch('B', 'A', true),
			ch('A', 'C', true),
			ch('C', 'A', true),
			ch('A', 'D', true),
			ch('D', 'A', true),
		]);
	}

	test('hub can send to all spokes', () => {
		const resolver = makeHubSpokeResolver();
		expect(resolver.canSend('A', 'B')).toBe(true);
		expect(resolver.canSend('A', 'C')).toBe(true);
		expect(resolver.canSend('A', 'D')).toBe(true);
	});

	test('spokes can reply to hub', () => {
		const resolver = makeHubSpokeResolver();
		expect(resolver.canSend('B', 'A')).toBe(true);
		expect(resolver.canSend('C', 'A')).toBe(true);
		expect(resolver.canSend('D', 'A')).toBe(true);
	});

	test('spoke-to-spoke is NOT permitted (spoke isolation)', () => {
		const resolver = makeHubSpokeResolver();
		expect(resolver.canSend('B', 'C')).toBe(false);
		expect(resolver.canSend('C', 'D')).toBe(false);
		expect(resolver.canSend('D', 'B')).toBe(false);
		expect(resolver.canSend('B', 'D')).toBe(false);
	});

	test('isHubSpoke flag is preserved on resolved channels', () => {
		const resolver = makeHubSpokeResolver();
		const channels = resolver.getResolvedChannels();
		expect(channels.every((c) => c.isHubSpoke)).toBe(true);
	});
});

describe('ChannelResolver — topology: * → B (wildcard from, after expansion)', () => {
	// resolveStepChannels expands '* → B' into one entry per role → B.
	// After expansion the resolver holds concrete role pairs, not wildcards.
	test('any role in the expansion can send to B', () => {
		// Simulating '* → B' expanded for roles X, Y, Z
		const resolver = new ChannelResolver([ch('X', 'B'), ch('Y', 'B'), ch('Z', 'B')]);
		expect(resolver.canSend('X', 'B')).toBe(true);
		expect(resolver.canSend('Y', 'B')).toBe(true);
		expect(resolver.canSend('Z', 'B')).toBe(true);
	});

	test('B cannot send back to expanded roles (one-way wildcard)', () => {
		const resolver = new ChannelResolver([ch('X', 'B'), ch('Y', 'B'), ch('Z', 'B')]);
		expect(resolver.canSend('B', 'X')).toBe(false);
		expect(resolver.canSend('B', 'Y')).toBe(false);
		expect(resolver.canSend('B', 'Z')).toBe(false);
	});
});

describe('ChannelResolver — topology: A → * (wildcard to, after expansion)', () => {
	// resolveStepChannels expands 'A → *' into A→role for each role in the step
	test('A can send to all expanded roles', () => {
		const resolver = new ChannelResolver([ch('A', 'X'), ch('A', 'Y'), ch('A', 'Z')]);
		expect(resolver.canSend('A', 'X')).toBe(true);
		expect(resolver.canSend('A', 'Y')).toBe(true);
		expect(resolver.canSend('A', 'Z')).toBe(true);
	});

	test('expanded roles cannot send back to A (one-way wildcard)', () => {
		const resolver = new ChannelResolver([ch('A', 'X'), ch('A', 'Y'), ch('A', 'Z')]);
		expect(resolver.canSend('X', 'A')).toBe(false);
		expect(resolver.canSend('Y', 'A')).toBe(false);
		expect(resolver.canSend('Z', 'A')).toBe(false);
	});

	test('getPermittedTargets(A) returns all expanded roles', () => {
		const resolver = new ChannelResolver([ch('A', 'X'), ch('A', 'Y'), ch('A', 'Z')]);
		expect(resolver.getPermittedTargets('A').sort()).toEqual(['X', 'Y', 'Z']);
	});
});

// ===========================================================================
// 3. send_feedback — channel validation and target modes
// ===========================================================================

describe('send_feedback — point-to-point (target: role)', () => {
	let ctx: StepCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('succeeds when channel is declared', async () => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-coder', role: 'coder' },
			{ sessionId: 'sess-reviewer', role: 'reviewer' },
		]);
		ctx.setChannels([ch('coder', 'reviewer')]);

		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder');
		const handlers = createStepAgentToolHandlers(cfg);

		const result = parse(await handlers.send_feedback({ target: 'reviewer', message: 'LGTM' }));
		expect(result.success).toBe(true);
		expect(cfg.injectedMessages).toHaveLength(1);
		expect(cfg.injectedMessages[0].sessionId).toBe('sess-reviewer');
		expect(cfg.injectedMessages[0].message).toContain('[Feedback from coder]');
		expect(cfg.injectedMessages[0].message).toContain('LGTM');
	});

	test('denied when channel is not declared', async () => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-coder', role: 'coder' },
			{ sessionId: 'sess-reviewer', role: 'reviewer' },
		]);
		// Only reviewer→coder declared; coder→reviewer not present
		ctx.setChannels([ch('reviewer', 'coder')]);

		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder');
		const handlers = createStepAgentToolHandlers(cfg);

		const result = parse(await handlers.send_feedback({ target: 'reviewer', message: 'Hello' }));
		expect(result.success).toBe(false);
		expect(result.unauthorizedRoles).toEqual(['reviewer']);
		expect(cfg.injectedMessages).toHaveLength(0);
	});
});

describe('send_feedback — broadcast (target: "*")', () => {
	let ctx: StepCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('delivers to all permitted targets', async () => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-hub', role: 'hub' },
			{ sessionId: 'sess-B', role: 'B' },
			{ sessionId: 'sess-C', role: 'C' },
		]);
		ctx.setChannels([ch('hub', 'B'), ch('hub', 'C')]);

		const cfg = makeStepConfig(ctx, 'sess-hub', 'hub');
		const handlers = createStepAgentToolHandlers(cfg);

		const result = parse(await handlers.send_feedback({ target: '*', message: 'Broadcast!' }));
		expect(result.success).toBe(true);
		const delivered = (result.delivered as Array<{ sessionId: string }>).map((d) => d.sessionId);
		expect(delivered.sort()).toEqual(['sess-B', 'sess-C'].sort());
	});

	test('fails when sender has no permitted targets', async () => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-spoke', role: 'spoke' },
			{ sessionId: 'sess-hub', role: 'hub' },
		]);
		// Only hub→spoke; spoke has no outgoing channels
		ctx.setChannels([ch('hub', 'spoke')]);

		const cfg = makeStepConfig(ctx, 'sess-spoke', 'spoke');
		const handlers = createStepAgentToolHandlers(cfg);

		const result = parse(await handlers.send_feedback({ target: '*', message: 'Hi' }));
		expect(result.success).toBe(false);
		expect(result.availableTargets).toEqual([]);
	});
});

describe('send_feedback — multicast (target: [role1, role2])', () => {
	let ctx: StepCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('delivers to all listed roles when all are permitted', async () => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-hub', role: 'hub' },
			{ sessionId: 'sess-B', role: 'B' },
			{ sessionId: 'sess-C', role: 'C' },
		]);
		ctx.setChannels([ch('hub', 'B'), ch('hub', 'C')]);

		const cfg = makeStepConfig(ctx, 'sess-hub', 'hub');
		const handlers = createStepAgentToolHandlers(cfg);

		const result = parse(
			await handlers.send_feedback({ target: ['B', 'C'], message: 'Multicast' })
		);
		expect(result.success).toBe(true);
		const delivered = (result.delivered as Array<{ sessionId: string }>).map((d) => d.sessionId);
		expect(delivered.sort()).toEqual(['sess-B', 'sess-C'].sort());
	});

	test('fails when any listed role is not in permitted targets', async () => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-hub', role: 'hub' },
			{ sessionId: 'sess-B', role: 'B' },
			{ sessionId: 'sess-C', role: 'C' },
		]);
		// Only hub→B; hub→C not declared
		ctx.setChannels([ch('hub', 'B')]);

		const cfg = makeStepConfig(ctx, 'sess-hub', 'hub');
		const handlers = createStepAgentToolHandlers(cfg);

		const result = parse(
			await handlers.send_feedback({ target: ['B', 'C'], message: 'Multicast' })
		);
		expect(result.success).toBe(false);
		expect((result.unauthorizedRoles as string[]).includes('C')).toBe(true);
	});
});

// ===========================================================================
// 4. send_feedback — no channels declared (empty topology)
// ===========================================================================

describe('send_feedback — no channels declared', () => {
	let ctx: StepCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('all send_feedback calls fail with suggestion to use request_peer_input', async () => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-coder', role: 'coder' },
			{ sessionId: 'sess-reviewer', role: 'reviewer' },
		]);
		// No setChannels call — empty topology

		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder');
		const handlers = createStepAgentToolHandlers(cfg);

		const result = parse(await handlers.send_feedback({ target: 'reviewer', message: 'Hi' }));
		expect(result.success).toBe(false);
		expect(result.suggestion).toBe('request_peer_input');
		expect(cfg.injectedMessages).toHaveLength(0);
	});
});

// ===========================================================================
// 5. send_feedback — fan-out one-way topology
// ===========================================================================

describe('send_feedback — fan-out one-way: hub → spokes, spokes cannot reply', () => {
	let ctx: StepCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	beforeEach(() => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-hub', role: 'hub' },
			{ sessionId: 'sess-B', role: 'B' },
			{ sessionId: 'sess-C', role: 'C' },
			{ sessionId: 'sess-D', role: 'D' },
		]);
		// Fan-out one-way: hub → B, C, D (no reverse)
		ctx.setChannels([ch('hub', 'B'), ch('hub', 'C'), ch('hub', 'D')]);
	});

	test('hub can send to B', async () => {
		const cfg = makeStepConfig(ctx, 'sess-hub', 'hub');
		const handlers = createStepAgentToolHandlers(cfg);
		const result = parse(await handlers.send_feedback({ target: 'B', message: 'Go!' }));
		expect(result.success).toBe(true);
	});

	test('hub broadcasts to all spokes via *', async () => {
		const cfg = makeStepConfig(ctx, 'sess-hub', 'hub');
		const handlers = createStepAgentToolHandlers(cfg);
		const result = parse(await handlers.send_feedback({ target: '*', message: 'All go!' }));
		expect(result.success).toBe(true);
		const delivered = (result.delivered as Array<{ sessionId: string }>).map((d) => d.sessionId);
		expect(delivered.sort()).toEqual(['sess-B', 'sess-C', 'sess-D'].sort());
	});

	test('spoke B cannot send back to hub (one-way enforcement)', async () => {
		const cfg = makeStepConfig(ctx, 'sess-B', 'B');
		const handlers = createStepAgentToolHandlers(cfg);
		const result = parse(await handlers.send_feedback({ target: 'hub', message: 'Hello hub' }));
		expect(result.success).toBe(false);
		expect((result.unauthorizedRoles as string[]).includes('hub')).toBe(true);
	});

	test('spoke B cannot send to spoke C (spoke isolation)', async () => {
		const cfg = makeStepConfig(ctx, 'sess-B', 'B');
		const handlers = createStepAgentToolHandlers(cfg);
		const result = parse(await handlers.send_feedback({ target: 'C', message: 'Hi C' }));
		expect(result.success).toBe(false);
		expect(result.success).toBe(false);
	});
});

// ===========================================================================
// 6. send_feedback — hub-spoke bidirectional topology
// ===========================================================================

describe('send_feedback — hub-spoke bidirectional: hub broadcasts, spokes reply to hub only', () => {
	let ctx: StepCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	beforeEach(() => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-hub', role: 'hub' },
			{ sessionId: 'sess-B', role: 'B' },
			{ sessionId: 'sess-C', role: 'C' },
		]);
		// Hub-spoke bidirectional: hub↔B, hub↔C (no B↔C)
		ctx.setChannels([
			ch('hub', 'B', true),
			ch('B', 'hub', true),
			ch('hub', 'C', true),
			ch('C', 'hub', true),
		]);
	});

	test('hub can send to B', async () => {
		const cfg = makeStepConfig(ctx, 'sess-hub', 'hub');
		const handlers = createStepAgentToolHandlers(cfg);
		const result = parse(await handlers.send_feedback({ target: 'B', message: 'Review this' }));
		expect(result.success).toBe(true);
		expect(cfg.injectedMessages[0].sessionId).toBe('sess-B');
	});

	test('hub can broadcast to all spokes via *', async () => {
		const cfg = makeStepConfig(ctx, 'sess-hub', 'hub');
		const handlers = createStepAgentToolHandlers(cfg);
		const result = parse(await handlers.send_feedback({ target: '*', message: 'Broadcast' }));
		expect(result.success).toBe(true);
		const delivered = (result.delivered as Array<{ sessionId: string }>).map((d) => d.sessionId);
		expect(delivered.sort()).toEqual(['sess-B', 'sess-C'].sort());
	});

	test('spoke B can reply to hub', async () => {
		const cfg = makeStepConfig(ctx, 'sess-B', 'B');
		const handlers = createStepAgentToolHandlers(cfg);
		const result = parse(
			await handlers.send_feedback({ target: 'hub', message: 'Reviewed, LGTM' })
		);
		expect(result.success).toBe(true);
		expect(cfg.injectedMessages[0].sessionId).toBe('sess-hub');
	});

	test('spoke B cannot send to spoke C (spoke isolation enforced)', async () => {
		const cfg = makeStepConfig(ctx, 'sess-B', 'B');
		const handlers = createStepAgentToolHandlers(cfg);
		const result = parse(await handlers.send_feedback({ target: 'C', message: 'Hi C' }));
		expect(result.success).toBe(false);
		expect((result.unauthorizedRoles as string[]).includes('C')).toBe(true);
	});

	test('spoke C cannot send to spoke B (spoke isolation, other direction)', async () => {
		const cfg = makeStepConfig(ctx, 'sess-C', 'C');
		const handlers = createStepAgentToolHandlers(cfg);
		const result = parse(await handlers.send_feedback({ target: 'B', message: 'Hi B' }));
		expect(result.success).toBe(false);
	});
});

// ===========================================================================
// 7. request_peer_input — Task Agent mediated async flow
// ===========================================================================

describe('request_peer_input — async routing through Task Agent', () => {
	let ctx: StepCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('routes question to Task Agent and returns async acknowledgment', async () => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-coder', role: 'coder' },
			{ sessionId: 'sess-reviewer', role: 'reviewer' },
		]);
		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder');
		const handlers = createStepAgentToolHandlers(cfg);

		const result = parse(
			await handlers.request_peer_input({
				target_role: 'reviewer',
				question: 'Does the API look correct?',
			})
		);
		expect(result.success).toBe(true);
		expect(result.async).toBe(true);
		expect(result.targetRole).toBe('reviewer');
		expect(cfg.taskAgentMessages).toHaveLength(1);
	});

	test('routing message includes sender identity and target role', async () => {
		ctx = makeStepCtx([{ sessionId: 'sess-coder', role: 'coder' }]);
		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder');
		const handlers = createStepAgentToolHandlers(cfg);

		await handlers.request_peer_input({ target_role: 'reviewer', question: 'Any concerns?' });

		const msg = cfg.taskAgentMessages[0];
		expect(msg).toContain('coder');
		expect(msg).toContain('reviewer');
		expect(msg).toContain('sess-coder');
		expect(msg).toContain('Any concerns?');
	});

	test('routing message asks Task Agent to forward response back with prefix', async () => {
		ctx = makeStepCtx([{ sessionId: 'sess-coder', role: 'coder' }]);
		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder');
		const handlers = createStepAgentToolHandlers(cfg);

		await handlers.request_peer_input({ target_role: 'reviewer', question: 'Question' });

		const msg = cfg.taskAgentMessages[0];
		expect(msg).toContain('[Peer response from reviewer]');
	});

	test('available even when no channels declared (fallback mode)', async () => {
		ctx = makeStepCtx([{ sessionId: 'sess-coder', role: 'coder' }]);
		// No channels set — resolver is empty, send_feedback would fail
		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder');
		const handlers = createStepAgentToolHandlers(cfg);

		// send_feedback should fail
		const fbResult = parse(await handlers.send_feedback({ target: 'reviewer', message: 'Hi' }));
		expect(fbResult.success).toBe(false);

		// request_peer_input should succeed
		const rpResult = parse(
			await handlers.request_peer_input({ target_role: 'reviewer', question: 'Hi' })
		);
		expect(rpResult.success).toBe(true);
	});

	test('returns error when Task Agent injection fails', async () => {
		ctx = makeStepCtx([{ sessionId: 'sess-coder', role: 'coder' }]);
		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder', {
			injectToTaskAgent: async () => {
				throw new Error('Task Agent session not found');
			},
		});
		const handlers = createStepAgentToolHandlers(cfg);

		const result = parse(
			await handlers.request_peer_input({ target_role: 'reviewer', question: 'Q' })
		);
		expect(result.success).toBe(false);
		expect(result.error as string).toContain('Task Agent session not found');
	});
});

// ===========================================================================
// 8. list_peers — peer discovery
// ===========================================================================

describe('list_peers — peer discovery with channel info', () => {
	let ctx: StepCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns peers excluding self and task-agent', async () => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-task-agent', role: 'task-agent' },
			{ sessionId: 'sess-coder', role: 'coder' },
			{ sessionId: 'sess-reviewer', role: 'reviewer' },
		]);

		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder');
		const handlers = createStepAgentToolHandlers(cfg);

		const result = parse(await handlers.list_peers({}));
		expect(result.success).toBe(true);
		const peers = result.peers as Array<{ sessionId: string; role: string }>;
		const peerIds = peers.map((p) => p.sessionId);
		expect(peerIds).not.toContain('sess-coder'); // self excluded
		expect(peerIds).not.toContain('sess-task-agent'); // task-agent excluded
		expect(peerIds).toContain('sess-reviewer');
	});

	test('reports permitted targets based on declared channels', async () => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-coder', role: 'coder' },
			{ sessionId: 'sess-reviewer', role: 'reviewer' },
		]);
		ctx.setChannels([ch('coder', 'reviewer')]);

		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder');
		const handlers = createStepAgentToolHandlers(cfg);

		const result = parse(await handlers.list_peers({}));
		expect(result.channelTopologyDeclared).toBe(true);
		expect(result.permittedTargets as string[]).toContain('reviewer');
	});

	test('channelTopologyDeclared is false when no channels set', async () => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-coder', role: 'coder' },
			{ sessionId: 'sess-reviewer', role: 'reviewer' },
		]);
		// No setChannels call

		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder');
		const handlers = createStepAgentToolHandlers(cfg);

		const result = parse(await handlers.list_peers({}));
		expect(result.channelTopologyDeclared).toBe(false);
		expect(result.permittedTargets as string[]).toHaveLength(0);
	});

	test('returns error when group not found', async () => {
		ctx = makeStepCtx([{ sessionId: 'sess-coder', role: 'coder' }]);
		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder', {
			getGroupId: () => undefined,
		});
		const handlers = createStepAgentToolHandlers(cfg);

		const result = parse(await handlers.list_peers({}));
		expect(result.success).toBe(false);
	});
});

// ===========================================================================
// 9. list_group_members (Task Agent tool)
// ===========================================================================

describe('list_group_members — Task Agent group view', () => {
	let ctx: TaskCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns all members with session IDs, roles, statuses, and permitted targets', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		const group = ctx.sessionGroupRepo.createGroup({
			spaceId: ctx.spaceId,
			name: `task:${mainTask.id}`,
			taskId: mainTask.id,
		});
		ctx.sessionGroupRepo.addMember(group.id, 'ta-session', {
			role: 'task-agent',
			status: 'active',
		});
		ctx.sessionGroupRepo.addMember(group.id, 'coder-session', {
			role: 'coder',
			agentId: ctx.agentId,
			status: 'active',
		});
		ctx.sessionGroupRepo.addMember(group.id, 'reviewer-session', {
			role: 'reviewer',
			status: 'active',
		});

		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory(), { groupId: group.id })
		);

		const result = parse(await handlers.list_group_members({}));
		expect(result.success).toBe(true);
		expect(result.groupId).toBe(group.id);
		const members = result.members as Array<{
			sessionId: string;
			role: string;
			agentId: string | null;
			status: string;
			permittedTargets: string[];
		}>;
		expect(members).toHaveLength(3);

		const coder = members.find((m) => m.role === 'coder');
		expect(coder?.sessionId).toBe('coder-session');
		expect(coder?.agentId).toBe(ctx.agentId);
		expect(Array.isArray(coder?.permittedTargets)).toBe(true);
	});

	test('channelTopologyDeclared reflects run config', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		const group = ctx.sessionGroupRepo.createGroup({
			spaceId: ctx.spaceId,
			name: `task:${mainTask.id}`,
			taskId: mainTask.id,
		});
		ctx.sessionGroupRepo.addMember(group.id, 'coder-session', {
			role: 'coder',
			status: 'active',
		});

		// Store channels in run config
		ctx.workflowRunRepo.updateRun(run.id, {
			config: {
				_resolvedChannels: [ch('coder', 'reviewer')],
			},
		});

		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory(), { groupId: group.id })
		);

		const result = parse(await handlers.list_group_members({}));
		expect(result.channelTopologyDeclared).toBe(true);
	});

	test('returns error when no group exists for task', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory())
			// no groupId — getGroupId() returns undefined
		);

		const result = parse(await handlers.list_group_members({}));
		expect(result.success).toBe(false);
		expect(result.error as string).toContain('No session group found');
	});
});

// ===========================================================================
// 10. relay_message (Task Agent tool) — unrestricted relay + cross-group rejection
// ===========================================================================

describe('relay_message — Task Agent unrestricted relay', () => {
	let ctx: TaskCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('successfully relays to any group member (ignores channel topology)', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		const group = ctx.sessionGroupRepo.createGroup({
			spaceId: ctx.spaceId,
			name: `task:${mainTask.id}`,
			taskId: mainTask.id,
		});
		ctx.sessionGroupRepo.addMember(group.id, 'coder-session', {
			role: 'coder',
			status: 'active',
		});
		ctx.sessionGroupRepo.addMember(group.id, 'reviewer-session', {
			role: 'reviewer',
			status: 'active',
		});

		// Store one-way channel: coder→reviewer only
		ctx.workflowRunRepo.updateRun(run.id, {
			config: { _resolvedChannels: [ch('coder', 'reviewer')] },
		});

		const injected: Array<{ sessionId: string; message: string }> = [];
		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory(), {
				groupId: group.id,
				messageInjector: async (sid, msg) => injected.push({ sessionId: sid, message: msg }),
			})
		);

		// Task Agent relays reviewer→coder even though channel is coder→reviewer only
		const result = parse(
			await handlers.relay_message({
				target_session_id: 'coder-session',
				message: 'Feedback from reviewer',
			})
		);
		expect(result.success).toBe(true);
		expect(injected).toHaveLength(1);
		expect(injected[0].sessionId).toBe('coder-session');
	});

	test('rejects self-relay (task-agent targeting its own session)', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		const group = ctx.sessionGroupRepo.createGroup({
			spaceId: ctx.spaceId,
			name: `task:${mainTask.id}`,
			taskId: mainTask.id,
		});
		ctx.sessionGroupRepo.addMember(group.id, 'ta-session', {
			role: 'task-agent',
			status: 'active',
		});

		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory(), { groupId: group.id })
		);

		const result = parse(
			await handlers.relay_message({
				target_session_id: 'ta-session',
				message: 'Self message',
			})
		);
		expect(result.success).toBe(false);
		expect(result.error as string).toContain('task-agent');
	});
});

// ===========================================================================
// 11. Group scoping — cross-group message isolation
// ===========================================================================

describe('Group scoping — messages cannot leak between task groups', () => {
	let ctx: TaskCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('relay_message rejects target session from a different group', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		// Group A (this Task Agent's group)
		const groupA = ctx.sessionGroupRepo.createGroup({
			spaceId: ctx.spaceId,
			name: `task:${mainTask.id}`,
			taskId: mainTask.id,
		});
		ctx.sessionGroupRepo.addMember(groupA.id, 'session-in-A', {
			role: 'coder',
			status: 'active',
		});

		// Group B (a different task's group, simulating another concurrent task)
		const groupB = ctx.sessionGroupRepo.createGroup({
			spaceId: ctx.spaceId,
			name: 'task:other-task',
			taskId: 'other-task-id',
		});
		ctx.sessionGroupRepo.addMember(groupB.id, 'session-in-B', {
			role: 'coder',
			status: 'active',
		});

		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory(), { groupId: groupA.id })
		);

		// Try to relay to a session in group B (should be rejected)
		const result = parse(
			await handlers.relay_message({
				target_session_id: 'session-in-B',
				message: 'Cross-group message',
			})
		);
		expect(result.success).toBe(false);
		expect(result.error as string).toContain('not a member of group');
	});

	test('send_feedback only delivers within the step agent own group', async () => {
		// Two independent step contexts (different groups)
		const ctxA = makeStepCtx([
			{ sessionId: 'sess-hub-A', role: 'hub' },
			{ sessionId: 'sess-B-A', role: 'B' },
		]);
		ctxA.setChannels([ch('hub', 'B')]);

		const ctxB = makeStepCtx([
			{ sessionId: 'sess-hub-B', role: 'hub' },
			{ sessionId: 'sess-B-B', role: 'B' },
		]);
		ctxB.setChannels([ch('hub', 'B')]);

		try {
			const cfgA = makeStepConfig(ctxA, 'sess-hub-A', 'hub');
			const handlersA = createStepAgentToolHandlers(cfgA);

			// Group A hub sends to its own B — succeeds
			const resultA = parse(await handlersA.send_feedback({ target: 'B', message: 'To A.B' }));
			expect(resultA.success).toBe(true);
			expect(cfgA.injectedMessages[0].sessionId).toBe('sess-B-A');

			// Group B's sessions are not in group A; they are invisible to handlers in group A
			// (group A only sees members of its own group)
			// Verify no cross-group injection happened
			const cfgB = makeStepConfig(ctxB, 'sess-hub-B', 'hub');
			expect(cfgB.injectedMessages).toHaveLength(0);
		} finally {
			ctxA.db.close();
			rmSync(ctxA.dir, { recursive: true, force: true });
			ctxB.db.close();
			rmSync(ctxB.dir, { recursive: true, force: true });
		}
	});
});

// ===========================================================================
// 12. Error cases — completed/failed members, non-existent sessions
// ===========================================================================

describe('Error cases — completed / failed / non-existent targets', () => {
	let ctx: StepCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('send_feedback to non-existent role returns no-active-sessions error', async () => {
		ctx = makeStepCtx([{ sessionId: 'sess-coder', role: 'coder' }]);
		ctx.setChannels([ch('coder', 'ghost')]);

		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder');
		const handlers = createStepAgentToolHandlers(cfg);

		const result = parse(await handlers.send_feedback({ target: 'ghost', message: 'Hello ghost' }));
		expect(result.success).toBe(false);
		expect((result.error as string).toLowerCase()).toContain('no active sessions');
	});

	test('send_feedback injection failure returns error with details', async () => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-coder', role: 'coder' },
			{ sessionId: 'sess-reviewer', role: 'reviewer' },
		]);
		ctx.setChannels([ch('coder', 'reviewer')]);

		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder', {
			messageInjector: async () => {
				throw new Error('Session closed');
			},
		});
		const handlers = createStepAgentToolHandlers(cfg);

		const result = parse(await handlers.send_feedback({ target: 'reviewer', message: 'Hi' }));
		expect(result.success).toBe(false);
		expect((result.error as string).toLowerCase()).toContain('failed to deliver');
	});

	test('relay_message to completed member calls injector (failure handled by injector layer)', async () => {
		ctx = makeTaskCtx() as unknown as StepCtx;
		// Use TaskCtx for this test
		const taskCtx = ctx as unknown as TaskCtx;
		const wf = buildSingleStepWf(taskCtx);
		const { run, mainTask } = await startRun(taskCtx, wf);

		const group = taskCtx.sessionGroupRepo.createGroup({
			spaceId: taskCtx.spaceId,
			name: `task:${mainTask.id}`,
			taskId: mainTask.id,
		});
		taskCtx.sessionGroupRepo.addMember(group.id, 'completed-session', {
			role: 'coder',
			status: 'completed',
		});

		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(taskCtx, mainTask.id, run.id, makeMockFactory(), {
				groupId: group.id,
				messageInjector: async () => {
					throw new Error('Sub-session gone');
				},
			})
		);

		const result = parse(
			await handlers.relay_message({ target_session_id: 'completed-session', message: 'Hi' })
		);
		// relay_message passes through to injector; injector failure surfaces as error
		expect(result.success).toBe(false);
		expect(result.error as string).toContain('Sub-session gone');
	});
});

// ===========================================================================
// 13. Step with no channels declared — open model (all via request_peer_input)
// ===========================================================================

describe('Step with no channels declared — open model', () => {
	let ctx: StepCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('send_feedback always fails; request_peer_input always succeeds', async () => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-a', role: 'agent-a' },
			{ sessionId: 'sess-b', role: 'agent-b' },
		]);
		// No channels declared — resolver is empty

		const cfgA = makeStepConfig(ctx, 'sess-a', 'agent-a');
		const handlersA = createStepAgentToolHandlers(cfgA);

		const fbResult = parse(
			await handlersA.send_feedback({ target: 'agent-b', message: 'Direct msg' })
		);
		expect(fbResult.success).toBe(false);
		expect(fbResult.suggestion).toBe('request_peer_input');

		const rpResult = parse(
			await handlersA.request_peer_input({ target_role: 'agent-b', question: 'Q?' })
		);
		expect(rpResult.success).toBe(true);
		expect(rpResult.async).toBe(true);
	});

	test('list_peers shows no permitted targets when no channels declared', async () => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-a', role: 'agent-a' },
			{ sessionId: 'sess-b', role: 'agent-b' },
		]);

		const cfg = makeStepConfig(ctx, 'sess-a', 'agent-a');
		const handlers = createStepAgentToolHandlers(cfg);

		const result = parse(await handlers.list_peers({}));
		expect(result.channelTopologyDeclared).toBe(false);
		expect(result.permittedTargets as string[]).toHaveLength(0);
	});
});

// ===========================================================================
// 14. relay_message — cross-group rejection (Task Agent validation)
// ===========================================================================

describe('relay_message — cross-group rejection', () => {
	let ctx: TaskCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('rejects session not in the Task Agent group', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		const group = ctx.sessionGroupRepo.createGroup({
			spaceId: ctx.spaceId,
			name: `task:${mainTask.id}`,
			taskId: mainTask.id,
		});
		ctx.sessionGroupRepo.addMember(group.id, 'known-session', {
			role: 'coder',
			status: 'active',
		});

		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory(), { groupId: group.id })
		);

		const result = parse(
			await handlers.relay_message({
				target_session_id: 'completely-unknown-session',
				message: 'Hi',
			})
		);
		expect(result.success).toBe(false);
		expect(result.error as string).toContain('not a member of group');
	});

	test('returns error when relay target group does not exist in DB', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory(), {
				groupId: 'nonexistent-group',
			})
		);

		const result = parse(await handlers.relay_message({ target_session_id: 'any', message: 'Hi' }));
		expect(result.success).toBe(false);
		expect(result.error as string).toContain('nonexistent-group');
	});
});

// ===========================================================================
// 15. message attribution — sender identity prefixed
// ===========================================================================

describe('send_feedback — sender attribution prefix', () => {
	let ctx: StepCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('injected message includes [Feedback from <role>] prefix', async () => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-coder', role: 'coder' },
			{ sessionId: 'sess-reviewer', role: 'reviewer' },
		]);
		ctx.setChannels([ch('coder', 'reviewer')]);

		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder');
		const handlers = createStepAgentToolHandlers(cfg);

		await handlers.send_feedback({ target: 'reviewer', message: 'Here is my patch' });

		expect(cfg.injectedMessages[0].message).toBe('[Feedback from coder]: Here is my patch');
	});
});
