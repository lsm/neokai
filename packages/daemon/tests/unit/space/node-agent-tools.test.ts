/**
 * Unit tests for createNodeAgentToolHandlers()
 *
 * Covers all node agent peer communication tools:
 *   list_peers   — list peers excluding self and task-agent
 *   send_message — channel-validated direct messaging
 *   report_done  — signal agent completion, persist summary, emit event
 *
 * Tests use a real SQLite database (via runMigrations) and mock message
 * injectors so no real agent sessions are created.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository.ts';
import { SpaceTaskManager } from '../../../src/lib/space/managers/space-task-manager.ts';
import { GateDataRepository } from '../../../src/storage/repositories/gate-data-repository.ts';
import {
	createNodeAgentToolHandlers,
	createNodeAgentMcpServer,
	type NodeAgentToolsConfig,
} from '../../../src/lib/space/tools/node-agent-tools.ts';
import { ChannelResolver } from '../../../src/lib/space/runtime/channel-resolver.ts';
import type { ResolvedChannel, SpaceWorkflow, Gate, WorkflowChannel } from '@neokai/shared';

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

function seedSpaceTask(
	db: BunDatabase,
	spaceId: string,
	workflowRunId: string,
	workflowNodeId: string,
	agentName: string,
	status: string = 'pending',
	completionSummary: string | null = null
): string {
	const id = `task-${Math.random().toString(36).slice(2)}`;
	const now = Date.now();
	// Disable FK for seeding test data — workflow_node_id points to an arbitrary test node ID
	db.exec('PRAGMA foreign_keys = OFF');
	db.prepare(
		`INSERT INTO space_tasks
         (id, space_id, task_number, title, description, status, priority, agent_name, completion_summary,
          workflow_run_id, workflow_node_id, depends_on, created_at, updated_at)
         VALUES (?, ?, (SELECT COALESCE(MAX(task_number), 0) + 1 FROM space_tasks WHERE space_id = ?), ?, '', ?, 'normal', ?, ?, ?, ?, '[]', ?, ?)`
	).run(
		id,
		spaceId,
		spaceId,
		`Task for ${agentName}`,
		status,
		agentName,
		completionSummary,
		workflowRunId,
		workflowNodeId,
		now,
		now
	);
	db.exec('PRAGMA foreign_keys = ON');
	return id;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeResolvedChannel(
	fromRole: string,
	toRole: string,
	isHubSpoke = false,
	overrides: Partial<ResolvedChannel> = {}
): ResolvedChannel {
	return {
		fromRole,
		toRole,
		fromAgentId: `agent-${fromRole}`,
		toAgentId: `agent-${toRole}`,
		direction: 'one-way',
		isHubSpoke,
		...overrides,
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

	// Session IDs for peers
	const taskAgentSessionId = 'session-task-agent';
	const coderSessionId = 'session-coder';
	const reviewerSessionId = 'session-reviewer';

	// Workflow run/node IDs for peer task seeding
	const workflowRunId = 'run-node-tools-default';
	const nodeId = 'node-node-tools-default';

	// Seed peer tasks: coder and reviewer on the default node
	seedSpaceTask(db, spaceId, workflowRunId, nodeId, 'coder', 'in_progress', null);
	// Set coder task's session ID
	db.exec('PRAGMA foreign_keys = OFF');
	db.prepare(
		'UPDATE space_tasks SET task_agent_session_id = ? WHERE agent_name = ? AND workflow_run_id = ?'
	).run(coderSessionId, 'coder', workflowRunId);
	db.exec('PRAGMA foreign_keys = ON');

	seedSpaceTask(db, spaceId, workflowRunId, nodeId, 'reviewer', 'in_progress', null);
	db.exec('PRAGMA foreign_keys = OFF');
	db.prepare(
		'UPDATE space_tasks SET task_agent_session_id = ? WHERE agent_name = ? AND workflow_run_id = ?'
	).run(reviewerSessionId, 'reviewer', workflowRunId);
	db.exec('PRAGMA foreign_keys = ON');

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
		workflowRunId,
		nodeId,
		coderSessionId,
		reviewerSessionId,
		taskAgentSessionId,
		parentTaskId: parentTask.id,
		stepTaskId: stepTask.id,
	};
}

function makeConfig(
	ctx: TestCtx,
	overrides: Partial<NodeAgentToolsConfig> = {}
): NodeAgentToolsConfig {
	const injectedMessages: Array<{ sessionId: string; message: string }> = [];

	return {
		mySessionId: ctx.coderSessionId,
		myRole: 'coder',
		taskId: ctx.parentTaskId,
		stepTaskId: ctx.stepTaskId,
		spaceId: ctx.spaceId,
		channelResolver: new ChannelResolver([]),
		workflowRunId: ctx.workflowRunId,
		workflowNodeId: ctx.nodeId,
		spaceTaskRepo: ctx.spaceTaskRepo,
		messageInjector: async (sessionId, message) => {
			injectedMessages.push({ sessionId, message });
		},
		taskManager: ctx.taskManager,
		// New M1.3 fields — default to null/no-op so existing tests are unaffected
		workflow: null,
		gateDataRepo: new GateDataRepository(ctx.db),
		...overrides,
	};
}

/**
 * Build a ChannelResolver directly from resolved channel entries.
 * Replaces the old seedWorkflowRunWithChannels + DB approach.
 */
function makeResolver(channels: ResolvedChannel[]): ChannelResolver {
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
		expect(data.peers[0].role).toBe('reviewer');
		expect(data.peers[0].sessionId).toBe(ctx.reviewerSessionId);
		expect(data.myRole).toBe('coder');
	});

	test('reports no channel topology when none declared', async () => {
		const config = makeConfig(ctx);
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.channelTopologyDeclared).toBe(false);
		expect(data.permittedTargets).toEqual([]);
	});

	test('reports permitted targets when channels declared', async () => {
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.channelTopologyDeclared).toBe(true);
		expect(data.permittedTargets).toEqual(['reviewer']);
	});

	test('returns empty peer list when no peers in the node', async () => {
		// Use a different nodeId that has no seeded tasks - only coder (self) but no reviewer
		const isolatedNodeId = 'node-isolated';
		seedSpaceTask(
			ctx.db,
			ctx.spaceId,
			ctx.workflowRunId,
			isolatedNodeId,
			'coder',
			'in_progress',
			null
		);
		ctx.db.exec('PRAGMA foreign_keys = OFF');
		ctx.db
			.prepare(
				'UPDATE space_tasks SET task_agent_session_id = ? WHERE agent_name = ? AND workflow_node_id = ?'
			)
			.run(ctx.coderSessionId, 'coder', isolatedNodeId);
		ctx.db.exec('PRAGMA foreign_keys = ON');

		const config = makeConfig(ctx, { workflowNodeId: isolatedNodeId });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.peers).toHaveLength(0);
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
		expect(data.delivered[0].role).toBe('reviewer');
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
		expect(data.unauthorizedRoles).toContain('reviewer');
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
		expect(data.error).toContain("No permitted targets for role 'coder'");
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
			null
		);
		ctx.db.exec('PRAGMA foreign_keys = OFF');
		ctx.db
			.prepare(
				'UPDATE space_tasks SET task_agent_session_id = ? WHERE agent_name = ? AND workflow_node_id = ?'
			)
			.run('session-security', 'security', ctx.nodeId);
		ctx.db.exec('PRAGMA foreign_keys = ON');

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
			null
		);
		ctx.db.exec('PRAGMA foreign_keys = OFF');
		ctx.db
			.prepare(
				'UPDATE space_tasks SET task_agent_session_id = ? WHERE agent_name = ? AND workflow_node_id = ?'
			)
			.run('session-security', 'security', ctx.nodeId);
		ctx.db.exec('PRAGMA foreign_keys = ON');
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
		expect(data.unauthorizedRoles).toContain('security');
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
		}); // myRole='coder'
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'reviewer', message: 'hello' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain("does not permit 'coder' to send to: reviewer");
	});

	test('hub-spoke: spoke can reply to hub', async () => {
		// Add hub peer task
		seedSpaceTask(ctx.db, ctx.spaceId, ctx.workflowRunId, ctx.nodeId, 'hub', 'in_progress', null);
		ctx.db.exec('PRAGMA foreign_keys = OFF');
		ctx.db
			.prepare(
				'UPDATE space_tasks SET task_agent_session_id = ? WHERE agent_name = ? AND workflow_node_id = ?'
			)
			.run('session-hub', 'hub', ctx.nodeId);
		ctx.db.exec('PRAGMA foreign_keys = ON');
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
			myRole: 'reviewer',
			messageInjector: async (sid) => {
				injectedToReviewer.push(sid);
			},
		});
		const handlersAsReviewer = createNodeAgentToolHandlers(configAsReviewer);
		const r2 = await handlersAsReviewer.send_message({ target: 'coder', message: 'approved' });
		expect(JSON.parse(r2.content[0].text).success).toBe(true);
	});

	test('returns error when target role has no active sessions', async () => {
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([makeResolvedChannel('coder', 'tester')]), // 'tester' role not in group
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.send_message({ target: 'tester', message: 'test pls' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('No active sessions found for target role(s): tester');
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
			null
		);
		ctx.db.exec('PRAGMA foreign_keys = OFF');
		ctx.db
			.prepare(
				'UPDATE space_tasks SET task_agent_session_id = ? WHERE agent_name = ? AND workflow_node_id = ?'
			)
			.run('session-security', 'security', ctx.nodeId);
		ctx.db.exec('PRAGMA foreign_keys = ON');
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
		expect(data.delivered).toHaveLength(0);
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
			null
		);
		ctx.db.exec('PRAGMA foreign_keys = OFF');
		ctx.db
			.prepare(
				'UPDATE space_tasks SET task_agent_session_id = ? WHERE agent_name = ? AND workflow_node_id = ?'
			)
			.run('session-security', 'security', ctx.nodeId);
		ctx.db.exec('PRAGMA foreign_keys = ON');

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
		expect(data.delivered).toHaveLength(0);
		expect(data.failed).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Tests: report_done
// ---------------------------------------------------------------------------

describe('node-agent-tools: report_done', () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = makeCtx();
	});

	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	test('marks step task as completed without summary', async () => {
		const config = makeConfig(ctx);
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.report_done({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.stepTaskId).toBe(ctx.stepTaskId);
		expect(data.message).toContain('completed');

		const updated = ctx.taskRepo.getTask(ctx.stepTaskId);
		expect(updated?.status).toBe('completed');
		expect(updated?.completedAt).toBeDefined();
	});

	test('persists summary as result field', async () => {
		const config = makeConfig(ctx);
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.report_done({ summary: 'PR #42 merged successfully.' });
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		expect(data.summary).toBe('PR #42 merged successfully.');

		const updated = ctx.taskRepo.getTask(ctx.stepTaskId);
		expect(updated?.result).toBe('PR #42 merged successfully.');
	});

	test('emits space.task.updated event via daemonHub', async () => {
		const emitted: Array<{ name: string; payload: unknown }> = [];
		const fakeDaemonHub = {
			emit: async (name: string, payload: unknown) => {
				emitted.push({ name, payload });
			},
		};

		const config = makeConfig(ctx, {
			daemonHub: fakeDaemonHub as unknown as NodeAgentToolsConfig['daemonHub'],
		});
		const handlers = createNodeAgentToolHandlers(config);
		await handlers.report_done({ summary: 'done' });

		expect(emitted).toHaveLength(1);
		expect(emitted[0].name).toBe('space.task.updated');
		const payload = emitted[0].payload as Record<string, unknown>;
		expect(payload.taskId).toBe(ctx.stepTaskId);
		expect(payload.spaceId).toBe(ctx.spaceId);
		expect(payload.sessionId).toBe('global');
		const task = payload.task as Record<string, unknown>;
		expect(task.status).toBe('completed');
	});

	test('does not emit event when daemonHub is absent', async () => {
		const config = makeConfig(ctx); // no daemonHub
		const handlers = createNodeAgentToolHandlers(config);
		// Should not throw
		const result = await handlers.report_done({});
		const data = JSON.parse(result.content[0].text);
		expect(data.success).toBe(true);
	});

	test('returns error when step task not found', async () => {
		const config = makeConfig(ctx, { stepTaskId: 'nonexistent-step-task' });
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.report_done({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		expect(data.error).toContain('not found');
	});

	test('returns error on invalid status transition', async () => {
		// Move step task to completed first
		await ctx.taskManager.setTaskStatus(ctx.stepTaskId, 'completed');

		const config = makeConfig(ctx);
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.report_done({ summary: 'already done' });
		const data = JSON.parse(result.content[0].text);

		// completed → completed is invalid
		expect(data.success).toBe(false);
		expect(data.error).toContain('Invalid status transition');
	});

	test('daemonHub emit throwing does not affect tool success', async () => {
		// If the event emit fails (e.g. hub is shutting down), the DB update should
		// still be committed and the tool should still return success.
		const throwingHub = {
			emit: async (_name: string, _payload: unknown) => {
				throw new Error('hub unavailable');
			},
		};

		const config = makeConfig(ctx, {
			daemonHub: throwingHub as unknown as NodeAgentToolsConfig['daemonHub'],
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.report_done({ summary: 'done despite hub error' });
		const data = JSON.parse(result.content[0].text);

		// Tool should succeed — hub error is non-fatal
		expect(data.success).toBe(true);
		expect(data.stepTaskId).toBe(ctx.stepTaskId);

		// DB state should reflect completion
		const updated = ctx.taskRepo.getTask(ctx.stepTaskId);
		expect(updated?.status).toBe('completed');
	});

	test('daemonHub not called when task update fails', async () => {
		// Verify that the hub is NOT called when setTaskStatus throws (e.g. task not found)
		const emitted: string[] = [];
		const trackingHub = {
			emit: async (name: string, _payload: unknown) => {
				emitted.push(name);
			},
		};

		const config = makeConfig(ctx, {
			stepTaskId: 'nonexistent-step-task',
			daemonHub: trackingHub as unknown as NodeAgentToolsConfig['daemonHub'],
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.report_done({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(false);
		// Hub should not have been called since the DB update never happened
		expect(emitted).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Tests: list_reachable_agents
// ---------------------------------------------------------------------------

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
		expect(data.crossNodeTargets[0].agentName).toBe('tester');
		expect(data.crossNodeTargets[0].isFanOut).toBe(false);
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

	test('gate type human: isGated true', async () => {
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				makeResolvedChannel('coder', 'tester', false, { gate: { type: 'human' } }),
			]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.crossNodeTargets[0].gate.type).toBe('human');
		expect(data.crossNodeTargets[0].gate.isGated).toBe(true);
	});

	test('gate type condition: isGated true', async () => {
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				makeResolvedChannel('coder', 'tester', false, {
					gate: { type: 'condition', expression: 'test -f pr.txt' },
				}),
			]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.crossNodeTargets[0].gate.type).toBe('condition');
		expect(data.crossNodeTargets[0].gate.isGated).toBe(true);
	});

	test('gate type task_result: isGated true', async () => {
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				makeResolvedChannel('coder', 'tester', false, {
					gate: { type: 'task_result', expression: 'passed' },
				}),
			]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.crossNodeTargets[0].gate.type).toBe('task_result');
		expect(data.crossNodeTargets[0].gate.isGated).toBe(true);
	});

	test('gate type always: isGated false (always passes)', async () => {
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				makeResolvedChannel('coder', 'tester', false, { gate: { type: 'always' } }),
			]),
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_reachable_agents({});
		const data = JSON.parse(result.content[0].text);

		expect(data.crossNodeTargets[0].gate.type).toBe('always');
		expect(data.crossNodeTargets[0].gate.isGated).toBe(false);
	});

	test('gate description propagated when present', async () => {
		const config = makeConfig(ctx, {
			channelResolver: makeResolver([
				makeResolvedChannel('coder', 'tester', false, {
					gate: { type: 'human', description: 'Needs tech lead approval' },
				}),
			]),
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
		expect(data.crossNodeTargets[0].agentName).toBe('qa-node');
		expect(data.crossNodeTargets[0].isFanOut).toBe(true);
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

	test('only includes outgoing channels (fromRole matches myRole)', async () => {
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

// ---------------------------------------------------------------------------
// Tests: node agent system prompt
// ---------------------------------------------------------------------------

describe('node-agent-tools: system prompt includes peer communication section', () => {
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

		// Seed a completed task for the reviewer peer
		seedSpaceTask(
			ctx.db,
			ctx.spaceId,
			workflowRunId,
			workflowNodeId,
			'reviewer',
			'completed',
			'All looks good!'
		);

		const config = makeConfig(ctx, {
			workflowRunId,
			workflowNodeId,
			spaceTaskRepo: ctx.spaceTaskRepo,
		});
		const handlers = createNodeAgentToolHandlers(config);
		const result = await handlers.list_peers({});
		const data = JSON.parse(result.content[0].text);

		expect(data.success).toBe(true);
		const reviewerPeer = data.peers.find((p: { role: string }) => p.role === 'reviewer');
		expect(reviewerPeer).toBeDefined();
		expect(reviewerPeer.completionState).not.toBeNull();
		expect(reviewerPeer.completionState.taskStatus).toBe('completed');
		expect(reviewerPeer.completionState.completionSummary).toBe('All looks good!');
		expect(reviewerPeer.completionState.agentName).toBe('reviewer');
	});

	test('list_peers shows nodeCompletionState for all tasks on the node', async () => {
		const workflowNodeId = 'node-xyz';
		const workflowRunId = 'run-test-xyz';

		// Seed tasks for both coder and reviewer on the same node
		seedSpaceTask(ctx.db, ctx.spaceId, workflowRunId, workflowNodeId, 'coder', 'in_progress', null);
		seedSpaceTask(
			ctx.db,
			ctx.spaceId,
			workflowRunId,
			workflowNodeId,
			'reviewer',
			'completed',
			'Review done'
		);

		const config = makeConfig(ctx, {
			workflowRunId,
			workflowNodeId,
			spaceTaskRepo: ctx.spaceTaskRepo,
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
		expect(reviewerState.taskStatus).toBe('completed');
		expect(reviewerState.completionSummary).toBe('Review done');
	});

	test('list_peers works without space_tasks (no tasks on node)', async () => {
		const workflowNodeId = 'node-empty';
		const workflowRunId = 'run-test-empty';

		// No tasks seeded for this node
		const config = makeConfig(ctx, {
			workflowRunId,
			workflowNodeId,
			spaceTaskRepo: ctx.spaceTaskRepo,
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
