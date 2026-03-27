/**
 * Unit tests for cross-agent messaging.
 *
 * Exercises the node agent peer communication tools (send_message, list_peers)
 * and the Task Agent list_group_members tool in isolation with a real SQLite DB.
 *
 * Test patterns covered:
 *   send_message  — channel validation, target modes, fan-out, hub-spoke
 *   list_peers    — peer discovery with channel info
 *   list_group_members — Task Agent group view with channel topology
 *
 * Channel topology patterns tested:
 *   A → B          one-way point-to-point
 *   A ↔ B          bidirectional point-to-point
 *   A → [B,C,D]    fan-out one-way
 *   A ↔ [B,C,D]    hub-spoke bidirectional (spoke isolation enforced)
 *
 * Task Agent participation in channel topology:
 *   - list_group_members shows permittedTargets for all members including Task Agent
 *   - When channel to/from Task Agent is declared, it appears in permittedTargets
 *   - When channel to/from Task Agent is removed, permittedTargets updates accordingly
 *
 * Note: Task Agent does not have send_message tool. Node agents cannot deliver
 * messages to Task Agent via send_message (task-agent is filtered from delivery targets).
 * Task Agent's participation in the topology is visible via list_group_members.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository.ts';
import { ChannelResolver } from '../../../src/lib/space/runtime/channel-resolver.ts';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceManager } from '../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../src/lib/space/runtime/space-runtime.ts';
import {
	createNodeAgentToolHandlers,
	type NodeAgentToolsConfig,
} from '../../../src/lib/space/tools/node-agent-tools.ts';
import {
	createTaskAgentToolHandlers,
	type SubSessionFactory,
	type SubSessionMemberInfo,
	type SubSessionState,
	type TaskAgentToolsConfig,
} from '../../../src/lib/space/tools/task-agent-tools.ts';
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

function seedRunTask(
	db: BunDatabase,
	spaceId: string,
	workflowRunId: string,
	agentName: string,
	sessionId: string
): void {
	db.exec('PRAGMA foreign_keys = OFF');
	const now = Date.now();
	const id = `task-cam-${Math.random().toString(36).slice(2)}`;
	db.prepare(
		`INSERT INTO space_tasks
       (id, space_id, task_number, title, description, status, priority, agent_name,
        workflow_run_id, depends_on, task_agent_session_id, created_at, updated_at)
       VALUES (?, ?, (SELECT COALESCE(MAX(task_number), 0) + 1 FROM space_tasks WHERE space_id = ?), ?, '', 'in_progress', 'normal', ?, ?, '[]', ?, ?, ?)`
	).run(
		id,
		spaceId,
		spaceId,
		`Task for ${agentName}`,
		agentName,
		workflowRunId,
		sessionId,
		now,
		now
	);
	db.exec('PRAGMA foreign_keys = ON');
}

// ===========================================================================
// ResolvedChannel builder helper
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
// Each call creates its own isolated SQLite DB so tests never share state.
// ===========================================================================

const STEP_NODE_ID = 'node-cam-step';

interface StepCtx {
	db: BunDatabase;
	dir: string;
	spaceId: string;
	spaceTaskRepo: SpaceTaskRepository;
	workflowRunId: string;
	/** Channel resolver used by makeStepConfig when no override is provided. Defaults to empty. */
	channelResolver: ChannelResolver;
}

function seedStepTask(
	db: BunDatabase,
	spaceId: string,
	workflowRunId: string,
	agentName: string,
	sessionId: string,
	status = 'in_progress'
): void {
	db.exec('PRAGMA foreign_keys = OFF');
	const now = Date.now();
	const id = `task-cam-${Math.random().toString(36).slice(2)}`;
	db.prepare(
		`INSERT INTO space_tasks
       (id, space_id, task_number, title, description, status, priority, agent_name,
        workflow_run_id, workflow_node_id, depends_on, task_agent_session_id, created_at, updated_at)
       VALUES (?, ?, (SELECT COALESCE(MAX(task_number), 0) + 1 FROM space_tasks WHERE space_id = ?), ?, '', ?, 'normal', ?, ?, ?, '[]', ?, ?, ?)`
	).run(
		id,
		spaceId,
		spaceId,
		`Task for ${agentName}`,
		status,
		agentName,
		workflowRunId,
		STEP_NODE_ID,
		sessionId,
		now,
		now
	);
	db.exec('PRAGMA foreign_keys = ON');
}

function makeStepCtx(
	members: Array<{ sessionId: string; role: string; status?: string }>
): StepCtx {
	const { db, dir } = makeDb();
	// Each DB is isolated; using a fixed spaceId within the DB is safe.
	const spaceId = 'space-cam-step';
	seedSpace(db, spaceId);

	// Create a minimal workflow run so we can attach tasks
	const workflowRepo = new SpaceWorkflowRepository(db);
	const workflow = workflowRepo.createWorkflow({
		spaceId,
		name: 'Step Test WF',
		description: '',
		nodes: [],
		transitions: [],
		startNodeId: '',
		rules: [],
	});
	const workflowRunRepo = new SpaceWorkflowRunRepository(db);
	const run = workflowRunRepo.createRun({
		spaceId,
		workflowId: workflow.id,
		title: 'Step Test Run',
	});

	const spaceTaskRepo = new SpaceTaskRepository(db);

	for (const m of members) {
		seedStepTask(db, spaceId, run.id, m.role, m.sessionId, m.status ?? 'in_progress');
	}

	return {
		db,
		dir,
		spaceId,
		spaceTaskRepo,
		workflowRunId: run.id,
		channelResolver: new ChannelResolver([]),
	};
}

function makeStepConfig(
	ctx: StepCtx,
	mySessionId: string,
	myRole: string,
	overrides: Partial<NodeAgentToolsConfig> = {}
): NodeAgentToolsConfig & {
	injectedMessages: Array<{ sessionId: string; message: string }>;
} {
	const injectedMessages: Array<{ sessionId: string; message: string }> = [];

	const config = {
		mySessionId,
		myRole,
		taskId: 'cam-task-1',
		stepTaskId: '',
		spaceId: ctx.spaceId,
		channelResolver: ctx.channelResolver,
		workflowRunId: ctx.workflowRunId,
		spaceTaskRepo: ctx.spaceTaskRepo,
		workflowNodeId: STEP_NODE_ID,
		messageInjector: async (sessionId: string, message: string) => {
			injectedMessages.push({ sessionId, message });
		},
		taskManager: new SpaceTaskManager(ctx.db, ctx.spaceId),
		...overrides,
	};

	return Object.assign(config, { injectedMessages });
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
}

function makeTaskCtx(): TaskCtx {
	const { db, dir } = makeDb();
	// Each DB is isolated; using a fixed spaceId within the DB is safe.
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
		slug: 'test-space',
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
		messageInjector?: (sessionId: string, message: string) => Promise<void>;
	} = {}
): TaskAgentToolsConfig {
	return {
		taskId,
		space: ctx.space,
		workflowRunId: runId,
		workspacePath: '/tmp/workspace',
		workflowManager: ctx.workflowManager,
		taskRepo: ctx.taskRepo,
		workflowRunRepo: ctx.workflowRunRepo,
		agentManager: ctx.agentManager,
		taskManager: ctx.taskManager,
		sessionFactory: factory,
		messageInjector: overrides.messageInjector ?? (async () => {}),
		onSubSessionComplete: async () => {},
	};
}

function buildSingleStepWf(ctx: TaskCtx) {
	const stepId = `step-${Math.random().toString(36).slice(2)}`;
	return ctx.workflowManager.createWorkflow({
		spaceId: ctx.spaceId,
		name: 'Single-Step WF',
		nodes: [{ id: stepId, name: 'Only Step', agentId: ctx.agentId }],
		transitions: [],
		startNodeId: stepId,
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
// 1. send_message — channel validation and target modes
// ===========================================================================

describe('send_message — point-to-point (target: role)', () => {
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
		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder', {
			channelResolver: new ChannelResolver([ch('coder', 'reviewer')]),
		});
		const handlers = createNodeAgentToolHandlers(cfg);

		const result = parse(await handlers.send_message({ target: 'reviewer', message: 'LGTM' }));
		expect(result.success).toBe(true);
		expect(cfg.injectedMessages).toHaveLength(1);
		expect(cfg.injectedMessages[0].sessionId).toBe('sess-reviewer');
		expect(cfg.injectedMessages[0].message).toContain('[Message from coder]');
		expect(cfg.injectedMessages[0].message).toContain('LGTM');
	});

	test('denied when channel is not declared', async () => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-coder', role: 'coder' },
			{ sessionId: 'sess-reviewer', role: 'reviewer' },
		]);
		// Only reviewer→coder declared; coder→reviewer not present
		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder', {
			channelResolver: new ChannelResolver([ch('reviewer', 'coder')]),
		});
		const handlers = createNodeAgentToolHandlers(cfg);

		const result = parse(await handlers.send_message({ target: 'reviewer', message: 'Hello' }));
		expect(result.success).toBe(false);
		expect(result.unauthorizedRoles).toEqual(['reviewer']);
		expect(cfg.injectedMessages).toHaveLength(0);
	});
});

describe('send_message — broadcast (target: "*")', () => {
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
		const cfg = makeStepConfig(ctx, 'sess-hub', 'hub', {
			channelResolver: new ChannelResolver([ch('hub', 'B'), ch('hub', 'C')]),
		});
		const handlers = createNodeAgentToolHandlers(cfg);

		const result = parse(await handlers.send_message({ target: '*', message: 'Broadcast!' }));
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
		const cfg = makeStepConfig(ctx, 'sess-spoke', 'spoke', {
			channelResolver: new ChannelResolver([ch('hub', 'spoke')]),
		});
		const handlers = createNodeAgentToolHandlers(cfg);

		const result = parse(await handlers.send_message({ target: '*', message: 'Hi' }));
		expect(result.success).toBe(false);
		expect(result.availableTargets).toEqual([]);
	});
});

describe('send_message — multicast (target: [role1, role2])', () => {
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
		const cfg = makeStepConfig(ctx, 'sess-hub', 'hub', {
			channelResolver: new ChannelResolver([ch('hub', 'B'), ch('hub', 'C')]),
		});
		const handlers = createNodeAgentToolHandlers(cfg);

		const result = parse(await handlers.send_message({ target: ['B', 'C'], message: 'Multicast' }));
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
		const cfg = makeStepConfig(ctx, 'sess-hub', 'hub', {
			channelResolver: new ChannelResolver([ch('hub', 'B')]),
		});
		const handlers = createNodeAgentToolHandlers(cfg);

		const result = parse(await handlers.send_message({ target: ['B', 'C'], message: 'Multicast' }));
		expect(result.success).toBe(false);
		expect((result.unauthorizedRoles as string[]).includes('C')).toBe(true);
	});

	test('partial delivery: success reported for injected sessions, failures listed separately', async () => {
		// hub→B succeeds, hub→C injection throws — partialFailures field populated
		ctx = makeStepCtx([
			{ sessionId: 'sess-hub', role: 'hub' },
			{ sessionId: 'sess-B', role: 'B' },
			{ sessionId: 'sess-C', role: 'C' },
		]);
		let callCount = 0;
		const cfg = makeStepConfig(ctx, 'sess-hub', 'hub', {
			channelResolver: new ChannelResolver([ch('hub', 'B'), ch('hub', 'C')]),
			messageInjector: async (sessionId: string, message: string) => {
				callCount++;
				if (sessionId === 'sess-C') throw new Error('Session C unavailable');
				cfg.injectedMessages.push({ sessionId, message });
			},
		});
		const handlers = createNodeAgentToolHandlers(cfg);

		const result = parse(
			await handlers.send_message({ target: ['B', 'C'], message: 'Multicast partial' })
		);
		// Partial success: B delivered, C failed → success is 'partial' (not true)
		expect(result.success).toBe('partial');
		const delivered = result.delivered as Array<{ sessionId: string }>;
		expect(delivered).toHaveLength(1);
		expect(delivered[0].sessionId).toBe('sess-B');
		const failures = result.failed as Array<{ sessionId: string; error: string }>;
		expect(failures).toHaveLength(1);
		expect(failures[0].sessionId).toBe('sess-C');
		expect(failures[0].error).toContain('Session C unavailable');
		expect(callCount).toBe(2); // Both injection attempts were made
	});
});

// ===========================================================================
// 2. send_message — no channels declared (empty topology)
// ===========================================================================

describe('send_message — no channels declared', () => {
	let ctx: StepCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('all send_message calls fail when no channels declared', async () => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-coder', role: 'coder' },
			{ sessionId: 'sess-reviewer', role: 'reviewer' },
		]);
		// No channels declared — empty topology (default empty resolver)

		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder');
		const handlers = createNodeAgentToolHandlers(cfg);

		const result = parse(await handlers.send_message({ target: 'reviewer', message: 'Hi' }));
		expect(result.success).toBe(false);
		expect(cfg.injectedMessages).toHaveLength(0);
	});
});

// ===========================================================================
// 3. send_message — fan-out one-way topology
// ===========================================================================

describe('send_message — fan-out one-way: hub → spokes, spokes cannot reply', () => {
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
		ctx.channelResolver = new ChannelResolver([ch('hub', 'B'), ch('hub', 'C'), ch('hub', 'D')]);
	});

	test('hub can send to B', async () => {
		const cfg = makeStepConfig(ctx, 'sess-hub', 'hub');
		const handlers = createNodeAgentToolHandlers(cfg);
		const result = parse(await handlers.send_message({ target: 'B', message: 'Go!' }));
		expect(result.success).toBe(true);
	});

	test('hub broadcasts to all spokes via *', async () => {
		const cfg = makeStepConfig(ctx, 'sess-hub', 'hub');
		const handlers = createNodeAgentToolHandlers(cfg);
		const result = parse(await handlers.send_message({ target: '*', message: 'All go!' }));
		expect(result.success).toBe(true);
		const delivered = (result.delivered as Array<{ sessionId: string }>).map((d) => d.sessionId);
		expect(delivered.sort()).toEqual(['sess-B', 'sess-C', 'sess-D'].sort());
	});

	test('spoke B cannot send back to hub (one-way enforcement)', async () => {
		const cfg = makeStepConfig(ctx, 'sess-B', 'B');
		const handlers = createNodeAgentToolHandlers(cfg);
		const result = parse(await handlers.send_message({ target: 'hub', message: 'Hello hub' }));
		expect(result.success).toBe(false);
		expect((result.unauthorizedRoles as string[]).includes('hub')).toBe(true);
	});

	test('spoke B cannot send to spoke C (spoke isolation)', async () => {
		const cfg = makeStepConfig(ctx, 'sess-B', 'B');
		const handlers = createNodeAgentToolHandlers(cfg);
		const result = parse(await handlers.send_message({ target: 'C', message: 'Hi C' }));
		expect(result.success).toBe(false);
		expect((result.unauthorizedRoles as string[]).includes('C')).toBe(true);
	});
});

// ===========================================================================
// 4. send_message — hub-spoke bidirectional topology
// ===========================================================================

describe('send_message — hub-spoke bidirectional: hub broadcasts, spokes reply to hub only', () => {
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
		ctx.channelResolver = new ChannelResolver([
			ch('hub', 'B', true),
			ch('B', 'hub', true),
			ch('hub', 'C', true),
			ch('C', 'hub', true),
		]);
	});

	test('hub can send to B', async () => {
		const cfg = makeStepConfig(ctx, 'sess-hub', 'hub');
		const handlers = createNodeAgentToolHandlers(cfg);
		const result = parse(await handlers.send_message({ target: 'B', message: 'Review this' }));
		expect(result.success).toBe(true);
		expect(cfg.injectedMessages[0].sessionId).toBe('sess-B');
	});

	test('hub can broadcast to all spokes via *', async () => {
		const cfg = makeStepConfig(ctx, 'sess-hub', 'hub');
		const handlers = createNodeAgentToolHandlers(cfg);
		const result = parse(await handlers.send_message({ target: '*', message: 'Broadcast' }));
		expect(result.success).toBe(true);
		const delivered = (result.delivered as Array<{ sessionId: string }>).map((d) => d.sessionId);
		expect(delivered.sort()).toEqual(['sess-B', 'sess-C'].sort());
	});

	test('spoke B can reply to hub', async () => {
		const cfg = makeStepConfig(ctx, 'sess-B', 'B');
		const handlers = createNodeAgentToolHandlers(cfg);
		const result = parse(await handlers.send_message({ target: 'hub', message: 'Reviewed, LGTM' }));
		expect(result.success).toBe(true);
		expect(cfg.injectedMessages[0].sessionId).toBe('sess-hub');
	});

	test('spoke B cannot send to spoke C (spoke isolation enforced)', async () => {
		const cfg = makeStepConfig(ctx, 'sess-B', 'B');
		const handlers = createNodeAgentToolHandlers(cfg);
		const result = parse(await handlers.send_message({ target: 'C', message: 'Hi C' }));
		expect(result.success).toBe(false);
		expect((result.unauthorizedRoles as string[]).includes('C')).toBe(true);
	});

	test('spoke C cannot send to spoke B (spoke isolation, other direction)', async () => {
		const cfg = makeStepConfig(ctx, 'sess-C', 'C');
		const handlers = createNodeAgentToolHandlers(cfg);
		const result = parse(await handlers.send_message({ target: 'B', message: 'Hi B' }));
		expect(result.success).toBe(false);
		expect((result.unauthorizedRoles as string[]).includes('B')).toBe(true);
	});
});

// ===========================================================================
// 5. list_peers — peer discovery
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
		const handlers = createNodeAgentToolHandlers(cfg);

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
		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder', {
			channelResolver: new ChannelResolver([ch('coder', 'reviewer')]),
		});
		const handlers = createNodeAgentToolHandlers(cfg);

		const result = parse(await handlers.list_peers({}));
		expect(result.channelTopologyDeclared).toBe(true);
		expect(result.permittedTargets as string[]).toContain('reviewer');
	});

	test('channelTopologyDeclared is false when no channels set', async () => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-coder', role: 'coder' },
			{ sessionId: 'sess-reviewer', role: 'reviewer' },
		]);
		// No channels declared (default empty resolver)

		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder');
		const handlers = createNodeAgentToolHandlers(cfg);

		const result = parse(await handlers.list_peers({}));
		expect(result.channelTopologyDeclared).toBe(false);
		expect(result.permittedTargets as string[]).toHaveLength(0);
	});

	test('returns empty peers when no tasks with sessions exist', async () => {
		ctx = makeStepCtx([]);
		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder');
		const handlers = createNodeAgentToolHandlers(cfg);

		const result = parse(await handlers.list_peers({}));
		expect(result.success).toBe(true);
		expect((result.peers as unknown[]).length).toBe(0);
	});
});

// ===========================================================================
// 6. list_group_members (Task Agent tool)
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

		seedRunTask(ctx.db, ctx.spaceId, run.id, 'task-agent', 'ta-session');
		seedRunTask(ctx.db, ctx.spaceId, run.id, 'coder', 'coder-session');
		seedRunTask(ctx.db, ctx.spaceId, run.id, 'reviewer', 'reviewer-session');

		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory())
		);

		const result = parse(await handlers.list_group_members({}));
		expect(result.success).toBe(true);
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
		expect(Array.isArray(coder?.permittedTargets)).toBe(true);
	});

	test('channelTopologyDeclared reflects run config', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		seedRunTask(ctx.db, ctx.spaceId, run.id, 'coder', 'coder-session');

		// Store channels in run config
		ctx.workflowRunRepo.updateRun(run.id, {
			config: {
				_resolvedChannels: [ch('coder', 'reviewer')],
			},
		});

		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory())
		);

		const result = parse(await handlers.list_group_members({}));
		expect(result.channelTopologyDeclared).toBe(true);
	});

	test('returns empty members when no tasks have sessions', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory())
		);

		const result = parse(await handlers.list_group_members({}));
		expect(result.success).toBe(true);
		expect((result.members as unknown[]).length).toBe(0);
	});
});

// ===========================================================================
// 6b. Task Agent participation in channel topology
// ===========================================================================
// These tests verify that the Task Agent's role in the channel topology is
// correctly reflected via list_group_members. The key insight is:
//   - list_group_members shows permittedTargets for ALL members including Task Agent
//   - When a channel to/from Task Agent is declared, it appears in permittedTargets
//   - When the channel is removed (topology changes), permittedTargets updates
//
// Note: Task Agent does not have a send_message tool. When a node agent calls
// send_message targeting 'task-agent', the channel resolver check passes (if channel
// declared), but the task-agent is filtered from delivery targets, so the message
// is never delivered. This is by design — Task Agent communicates via its own mechanisms,
// not by receiving injected messages.

describe('Task Agent in channel topology — via list_group_members', () => {
	let ctx: TaskCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('coder permittedTargets includes task-agent when channel coder→task-agent is declared', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		seedRunTask(ctx.db, ctx.spaceId, run.id, 'task-agent', 'ta-session');
		seedRunTask(ctx.db, ctx.spaceId, run.id, 'coder', 'coder-session');

		// Declare channel: coder → task-agent
		ctx.workflowRunRepo.updateRun(run.id, {
			config: { _resolvedChannels: [ch('coder', 'task-agent')] },
		});

		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory())
		);

		const result = parse(await handlers.list_group_members({}));
		expect(result.success).toBe(true);

		const members = result.members as Array<{
			role: string;
			permittedTargets: string[];
		}>;
		const coder = members.find((m) => m.role === 'coder');
		expect(coder?.permittedTargets).toContain('task-agent');
	});

	test('reviewer permittedTargets includes task-agent when channel reviewer→task-agent is declared', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		seedRunTask(ctx.db, ctx.spaceId, run.id, 'task-agent', 'ta-session');
		seedRunTask(ctx.db, ctx.spaceId, run.id, 'reviewer', 'reviewer-session');

		// Declare channel: reviewer → task-agent
		ctx.workflowRunRepo.updateRun(run.id, {
			config: { _resolvedChannels: [ch('reviewer', 'task-agent')] },
		});

		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory())
		);

		const result = parse(await handlers.list_group_members({}));
		expect(result.success).toBe(true);

		const members = result.members as Array<{
			role: string;
			permittedTargets: string[];
		}>;
		const reviewer = members.find((m) => m.role === 'reviewer');
		expect(reviewer?.permittedTargets).toContain('task-agent');
	});

	test('task-agent permittedTargets is empty when no channels to/from task-agent declared', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		seedRunTask(ctx.db, ctx.spaceId, run.id, 'task-agent', 'ta-session');
		seedRunTask(ctx.db, ctx.spaceId, run.id, 'coder', 'coder-session');

		// Declare channel between coder and reviewer — NOT involving task-agent
		ctx.workflowRunRepo.updateRun(run.id, {
			config: { _resolvedChannels: [ch('coder', 'reviewer'), ch('reviewer', 'coder')] },
		});

		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory())
		);

		const result = parse(await handlers.list_group_members({}));
		expect(result.success).toBe(true);

		const members = result.members as Array<{
			role: string;
			permittedTargets: string[];
		}>;
		const taskAgentMember = members.find((m) => m.role === 'task-agent');
		expect(taskAgentMember?.permittedTargets).toEqual([]);
	});

	test('task-agent permittedTargets includes coder when channel task-agent→coder is declared', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		seedRunTask(ctx.db, ctx.spaceId, run.id, 'task-agent', 'ta-session');
		seedRunTask(ctx.db, ctx.spaceId, run.id, 'coder', 'coder-session');

		// Declare channel: task-agent → coder (Task Agent can send to coder)
		ctx.workflowRunRepo.updateRun(run.id, {
			config: { _resolvedChannels: [ch('task-agent', 'coder')] },
		});

		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory())
		);

		const result = parse(await handlers.list_group_members({}));
		expect(result.success).toBe(true);

		const members = result.members as Array<{
			role: string;
			permittedTargets: string[];
		}>;
		const taskAgentMember = members.find((m) => m.role === 'task-agent');
		expect(taskAgentMember?.permittedTargets).toContain('coder');
	});

	test('removing channel to task-agent updates permittedTargets', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		seedRunTask(ctx.db, ctx.spaceId, run.id, 'task-agent', 'ta-session');
		seedRunTask(ctx.db, ctx.spaceId, run.id, 'coder', 'coder-session');

		// Initially: channel coder → task-agent
		ctx.workflowRunRepo.updateRun(run.id, {
			config: { _resolvedChannels: [ch('coder', 'task-agent')] },
		});

		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory())
		);

		let result = parse(await handlers.list_group_members({}));
		expect(result.success).toBe(true);
		let members = result.members as Array<{ role: string; permittedTargets: string[] }>;
		let coder = members.find((m) => m.role === 'coder');
		expect(coder?.permittedTargets).toContain('task-agent');

		// Remove channel to task-agent — update topology to empty
		ctx.workflowRunRepo.updateRun(run.id, {
			config: { _resolvedChannels: [] },
		});

		result = parse(await handlers.list_group_members({}));
		expect(result.success).toBe(true);
		members = result.members as Array<{ role: string; permittedTargets: string[] }>;
		coder = members.find((m) => m.role === 'coder');
		expect(coder?.permittedTargets).not.toContain('task-agent');
	});
});

// ===========================================================================
// 7. Group scoping — cross-group message isolation
// ===========================================================================

describe('Group scoping — messages cannot leak between task groups', () => {
	test('send_message only delivers within the node agent own group', async () => {
		// Two independent step contexts (different groups, different DBs)
		const ctxA = makeStepCtx([
			{ sessionId: 'sess-hub-A', role: 'hub' },
			{ sessionId: 'sess-B-A', role: 'B' },
		]);
		ctxA.channelResolver = new ChannelResolver([ch('hub', 'B')]);

		const ctxB = makeStepCtx([
			{ sessionId: 'sess-hub-B', role: 'hub' },
			{ sessionId: 'sess-B-B', role: 'B' },
		]);
		ctxB.channelResolver = new ChannelResolver([ch('hub', 'B')]);

		try {
			const cfgA = makeStepConfig(ctxA, 'sess-hub-A', 'hub');
			const handlersA = createNodeAgentToolHandlers(cfgA);

			// Group A hub sends to its own B — succeeds
			const resultA = parse(await handlersA.send_message({ target: 'B', message: 'To A.B' }));
			expect(resultA.success).toBe(true);
			expect(cfgA.injectedMessages[0].sessionId).toBe('sess-B-A');

			// Group B's sessions are in a different DB; they are invisible to group A
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
// 8. Error cases — non-existent sessions, injection failures
// ===========================================================================

describe('Error cases — non-existent targets and injection failures', () => {
	let ctx: StepCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('send_message to non-existent role returns no-active-sessions error', async () => {
		ctx = makeStepCtx([{ sessionId: 'sess-coder', role: 'coder' }]);
		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder', {
			channelResolver: new ChannelResolver([ch('coder', 'ghost')]),
		});
		const handlers = createNodeAgentToolHandlers(cfg);

		const result = parse(await handlers.send_message({ target: 'ghost', message: 'Hello ghost' }));
		expect(result.success).toBe(false);
		expect((result.error as string).toLowerCase()).toContain('no active sessions');
	});

	test('send_message injection failure returns all-failed error', async () => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-coder', role: 'coder' },
			{ sessionId: 'sess-reviewer', role: 'reviewer' },
		]);
		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder', {
			channelResolver: new ChannelResolver([ch('coder', 'reviewer')]),
			messageInjector: async () => {
				throw new Error('Session closed');
			},
		});
		const handlers = createNodeAgentToolHandlers(cfg);

		const result = parse(await handlers.send_message({ target: 'reviewer', message: 'Hi' }));
		expect(result.success).toBe(false);
		// All-failed path: production returns `message` (not `error`) describing the failure
		expect((result.message as string).toLowerCase()).toContain('failed');
	});
});

// ===========================================================================
// 9. Step with no channels declared — no messaging available
// ===========================================================================

describe('Step with no channels declared', () => {
	let ctx: StepCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('send_message fails when no channels declared', async () => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-a', role: 'agent-a' },
			{ sessionId: 'sess-b', role: 'agent-b' },
		]);
		// No channels declared — resolver is empty

		const cfgA = makeStepConfig(ctx, 'sess-a', 'agent-a');
		const handlersA = createNodeAgentToolHandlers(cfgA);

		const fbResult = parse(
			await handlersA.send_message({ target: 'agent-b', message: 'Direct msg' })
		);
		expect(fbResult.success).toBe(false);
	});

	test('list_peers shows no permitted targets when no channels declared', async () => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-a', role: 'agent-a' },
			{ sessionId: 'sess-b', role: 'agent-b' },
		]);

		const cfg = makeStepConfig(ctx, 'sess-a', 'agent-a');
		const handlers = createNodeAgentToolHandlers(cfg);

		const result = parse(await handlers.list_peers({}));
		expect(result.channelTopologyDeclared).toBe(false);
		expect(result.permittedTargets as string[]).toHaveLength(0);
	});
});

// ===========================================================================
// 10. Message attribution — sender identity prefix
// ===========================================================================

describe('send_message — sender attribution prefix', () => {
	let ctx: StepCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('injected message includes [Message from <role>] prefix', async () => {
		ctx = makeStepCtx([
			{ sessionId: 'sess-coder', role: 'coder' },
			{ sessionId: 'sess-reviewer', role: 'reviewer' },
		]);
		const cfg = makeStepConfig(ctx, 'sess-coder', 'coder', {
			channelResolver: new ChannelResolver([ch('coder', 'reviewer')]),
		});
		const handlers = createNodeAgentToolHandlers(cfg);

		await handlers.send_message({ target: 'reviewer', message: 'Here is my patch' });

		expect(cfg.injectedMessages[0].message).toBe('[Message from coder]: Here is my patch');
	});
});

// ===========================================================================
// 11. Task Agent send_message — channel validation and target modes
// ===========================================================================

describe('Task Agent send_message — point-to-point (target: role)', () => {
	let ctx: TaskCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('succeeds when channel is declared', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		// Set up channel: task-agent → coder (one-way)
		ctx.workflowRunRepo.updateRun(run.id, {
			config: {
				_resolvedChannels: [ch('task-agent', 'coder')],
			},
		});

		seedRunTask(ctx.db, ctx.spaceId, run.id, 'coder', 'coder-session');

		const injectedMessages: Array<{ sessionId: string; message: string }> = [];
		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory(), {
				messageInjector: async (sessionId, message) => {
					injectedMessages.push({ sessionId, message });
				},
			})
		);

		const result = parse(await handlers.send_message({ target: 'coder', message: 'Hello coder' }));
		expect(result.success).toBe(true);
		expect(injectedMessages).toHaveLength(1);
		expect(injectedMessages[0].sessionId).toBe('coder-session');
		expect(injectedMessages[0].message).toContain('[Message from task-agent]');
		expect(injectedMessages[0].message).toContain('Hello coder');
	});

	test('denied when channel is not declared (task-agent → coder missing)', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		// Set up channel: coder → task-agent only (reverse direction)
		ctx.workflowRunRepo.updateRun(run.id, {
			config: {
				_resolvedChannels: [ch('coder', 'task-agent')],
			},
		});

		seedRunTask(ctx.db, ctx.spaceId, run.id, 'coder', 'coder-session');

		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory())
		);

		const result = parse(await handlers.send_message({ target: 'coder', message: 'Should fail' }));
		expect(result.success).toBe(false);
		expect(result.unauthorizedRoles).toEqual(['coder']);
	});

	test('fails when no channels declared (empty topology)', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		// No channels declared
		seedRunTask(ctx.db, ctx.spaceId, run.id, 'coder', 'coder-session');

		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory())
		);

		const result = parse(await handlers.send_message({ target: 'coder', message: 'Should fail' }));
		expect(result.success).toBe(false);
		expect((result.error as string).toLowerCase()).toContain('no channel topology');
	});
});

describe('Task Agent send_message — broadcast (target: "*")', () => {
	let ctx: TaskCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('delivers to all permitted targets', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		// task-agent can send to both coder and reviewer
		ctx.workflowRunRepo.updateRun(run.id, {
			config: {
				_resolvedChannels: [ch('task-agent', 'coder'), ch('task-agent', 'reviewer')],
			},
		});

		seedRunTask(ctx.db, ctx.spaceId, run.id, 'coder', 'coder-session');
		seedRunTask(ctx.db, ctx.spaceId, run.id, 'reviewer', 'reviewer-session');

		const injectedMessages: Array<{ sessionId: string; message: string }> = [];
		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory(), {
				messageInjector: async (sessionId, message) => {
					injectedMessages.push({ sessionId, message });
				},
			})
		);

		const result = parse(await handlers.send_message({ target: '*', message: 'Broadcast!' }));
		expect(result.success).toBe(true);
		const delivered = result.delivered as Array<{ sessionId: string }>;
		expect(delivered.length).toBe(2);
		const deliveredIds = delivered.map((d) => d.sessionId).sort();
		expect(deliveredIds).toEqual(['coder-session', 'reviewer-session'].sort());
	});

	test('fails when task-agent has no permitted targets', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		// Only coder can send to task-agent, not the other way around
		ctx.workflowRunRepo.updateRun(run.id, {
			config: {
				_resolvedChannels: [ch('coder', 'task-agent')],
			},
		});

		seedRunTask(ctx.db, ctx.spaceId, run.id, 'coder', 'coder-session');

		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory())
		);

		const result = parse(await handlers.send_message({ target: '*', message: 'Broadcast!' }));
		expect(result.success).toBe(false);
		expect(result.availableTargets).toEqual([]);
	});
});

describe('Task Agent send_message — default task-agent channels', () => {
	let ctx: TaskCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('task-agent has default bidirectional channels to all node agents', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		// Simulate storeResolvedChannels behavior: default bidirectional channels
		// between task-agent and all node agents are auto-added
		ctx.workflowRunRepo.updateRun(run.id, {
			config: {
				_resolvedChannels: [
					// Default task-agent → coder
					{
						fromRole: 'task-agent',
						toRole: 'coder',
						fromAgentId: 'task-agent',
						toAgentId: 'coder',
						direction: 'one-way',
						isHubSpoke: false,
					},
					// Default coder → task-agent
					{
						fromRole: 'coder',
						toRole: 'task-agent',
						fromAgentId: 'coder',
						toAgentId: 'task-agent',
						direction: 'one-way',
						isHubSpoke: false,
					},
				],
			},
		});

		seedRunTask(ctx.db, ctx.spaceId, run.id, 'coder', 'coder-session');

		const injectedMessages: Array<{ sessionId: string; message: string }> = [];
		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory(), {
				messageInjector: async (sessionId, message) => {
					injectedMessages.push({ sessionId, message });
				},
			})
		);

		// Task Agent can send to coder via default channel
		const result = parse(
			await handlers.send_message({ target: 'coder', message: 'Default channel works' })
		);
		expect(result.success).toBe(true);
		expect(injectedMessages).toHaveLength(1);
		expect(injectedMessages[0].sessionId).toBe('coder-session');
	});

	test('removing task-agent channel prevents messaging (no bypass)', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		// User explicitly removes task-agent → coder channel
		// Only coder → task-agent is declared (not the default task-agent → coder)
		ctx.workflowRunRepo.updateRun(run.id, {
			config: {
				_resolvedChannels: [
					// Only coder can message task-agent, not the other way
					{
						fromRole: 'coder',
						toRole: 'task-agent',
						fromAgentId: 'coder',
						toAgentId: 'task-agent',
						direction: 'one-way',
						isHubSpoke: false,
					},
				],
			},
		});

		seedRunTask(ctx.db, ctx.spaceId, run.id, 'coder', 'coder-session');

		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory())
		);

		// Task Agent cannot send to coder because the channel was removed
		const result = parse(
			await handlers.send_message({ target: 'coder', message: 'Should be blocked' })
		);
		expect(result.success).toBe(false);
		expect(result.unauthorizedRoles).toEqual(['coder']);
	});
});

describe('Task Agent send_message — error cases', () => {
	let ctx: TaskCtx;
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('returns error when no active sessions found for target', async () => {
		ctx = makeTaskCtx();
		const wf = buildSingleStepWf(ctx);
		const { run, mainTask } = await startRun(ctx, wf);

		// Set up a channel but no sessions for coder
		ctx.workflowRunRepo.updateRun(run.id, {
			config: {
				_resolvedChannels: [ch('task-agent', 'coder')],
			},
		});

		const handlers = createTaskAgentToolHandlers(
			makeTaskConfig(ctx, mainTask.id, run.id, makeMockFactory())
		);

		const result = parse(await handlers.send_message({ target: 'coder', message: 'Hello' }));
		expect(result.success).toBe(false);
		expect(result.error as string).toContain('No active sessions found');
	});
});
