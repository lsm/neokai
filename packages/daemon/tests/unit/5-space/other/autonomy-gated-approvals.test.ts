/**
 * Regression tests: autonomy-gated approvals for workflow gates
 *
 * Covers requirement: "platform-level gate-approval contract hardening"
 *
 * Tests:
 *   1. channel-router onGateDataChanged — auto-approval defaults requiredLevel to 5
 *      - No requiredLevel: auto-approve only at level 5, blocked at levels 1-4
 *      - Explicit requiredLevel=3: auto-approve at 3+, blocked below 3
 *      - Explicit requiredLevel=1: auto-approve at any level
 *   2. space-agent-tools approve_gate — autonomy enforcement
 *      - Below required level → blocked
 *      - At or above required level → approved
 *      - Missing requiredLevel defaults to 5
 *      - Human approval RPC is not affected (no autonomy check)
 *   3. task-agent-tools approve_gate — autonomy enforcement
 *      - Same invariants as space-agent-tools
 *   4. node-agent-tools send_message gate write — autonomy enforcement
 *      - Below required level → blocked
 *      - At or above required level → passes
 *      - Missing requiredLevel defaults to 5
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { GateDataRepository } from '../../../../src/storage/repositories/gate-data-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { ChannelRouter } from '../../../../src/lib/space/runtime/channel-router.ts';
import {
	createSpaceAgentToolHandlers,
	type SpaceAgentToolsConfig,
} from '../../../../src/lib/space/tools/space-agent-tools.ts';
import {
	createTaskAgentToolHandlers,
	type TaskAgentToolsConfig,
} from '../../../../src/lib/space/tools/task-agent-tools.ts';
import {
	createNodeAgentToolHandlers,
	type NodeAgentToolsConfig,
} from '../../../../src/lib/space/tools/node-agent-tools.ts';
import { ChannelResolver } from '../../../../src/lib/space/runtime/channel-resolver.ts';
import { AgentMessageRouter } from '../../../../src/lib/space/runtime/agent-message-router.ts';
import type {
	Space,
	SpaceWorkflow,
	SpaceWorkflowRun,
	Gate,
	GateField,
	SpaceAutonomyLevel,
} from '@neokai/shared';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-autonomy-gated',
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return { db, dir };
}

function seedSpaceRow(
	db: BunDatabase,
	spaceId: string,
	autonomyLevel: number = 1,
	workspacePath = '/tmp/workspace'
): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, autonomy_level, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?, ?)`
	).run(spaceId, workspacePath, `Space ${spaceId}`, spaceId, autonomyLevel, Date.now(), Date.now());
}

function seedWorkflowRunRow(
	db: BunDatabase,
	runId: string,
	spaceId: string,
	workflowId: string,
	status = 'in_progress'
): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO space_workflow_runs
     (id, space_id, workflow_id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, 'Test Run', ?, ?, ?)`
	).run(runId, spaceId, workflowId, status, now, now);
}

function seedSpaceTask(
	db: BunDatabase,
	spaceId: string,
	workflowRunId: string,
	workflowNodeId: string,
	agentName: string,
	sessionId: string | null = null
): string {
	const id = `task-${Math.random().toString(36).slice(2)}`;
	const now = Date.now();
	db.exec('PRAGMA foreign_keys = OFF');
	db.prepare(
		`INSERT INTO space_tasks
     (id, space_id, task_number, title, description, status, priority,
      workflow_run_id, depends_on, created_at, updated_at)
     VALUES (?, ?, (SELECT COALESCE(MAX(task_number), 0) + 1 FROM space_tasks WHERE space_id = ?),
             ?, '', 'in_progress', 'normal', ?, '[]', ?, ?)`
	).run(id, spaceId, spaceId, agentName, workflowRunId, now, now);
	if (sessionId) {
		db.prepare('UPDATE space_tasks SET task_agent_session_id = ? WHERE id = ?').run(sessionId, id);
	}
	db.exec('PRAGMA foreign_keys = ON');
	// Seed node_executions so AgentMessageRouter can resolve sessions
	const nodeExecRepo = new NodeExecutionRepository(db);
	const exec = nodeExecRepo.createOrIgnore({
		workflowRunId,
		workflowNodeId,
		agentName,
		agentSessionId: sessionId,
		status: 'in_progress',
	});
	if (sessionId) {
		nodeExecRepo.update(exec.id, { agentSessionId: sessionId });
	}
	return id;
}

// ---------------------------------------------------------------------------
// Build a minimal workflow with a gate
// ---------------------------------------------------------------------------

function buildGatedWorkflow(opts: {
	gateId?: string;
	requiredLevel?: SpaceAutonomyLevel;
	approvedFieldWriters?: string[];
}): SpaceWorkflow {
	const gateId = opts.gateId ?? 'code-ready-gate';
	const writers = opts.approvedFieldWriters ?? ['*'];
	const gate: Gate = {
		id: gateId,
		resetOnCycle: false,
		fields: [
			{
				name: 'approved',
				type: 'boolean',
				writers,
				check: { op: '==', value: true },
			},
		],
		...(opts.requiredLevel !== undefined ? { requiredLevel: opts.requiredLevel } : {}),
	};
	const coderNodeId = 'node-coder';
	const reviewerNodeId = 'node-reviewer';
	return {
		id: 'wf-1',
		spaceId: 'space-1',
		name: 'Test Workflow',
		nodes: [
			{ id: coderNodeId, name: 'Code', agents: [{ agentId: 'a1', name: 'coder' }] },
			{ id: reviewerNodeId, name: 'Review', agents: [{ agentId: 'a2', name: 'reviewer' }] },
		],
		startNodeId: coderNodeId,
		endNodeId: reviewerNodeId,
		gates: [gate],
		channels: [
			{
				id: 'ch-1',
				from: 'Code',
				to: 'Review',
				gateId,
			},
		],
		tags: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function buildGatedWorkflowMixed(opts: {
	gateId?: string;
	requiredLevel?: SpaceAutonomyLevel;
	fields: GateField[];
}): SpaceWorkflow {
	const gateId = opts.gateId ?? 'code-ready-gate';
	const gate: Gate = {
		id: gateId,
		resetOnCycle: false,
		fields: opts.fields,
		...(opts.requiredLevel !== undefined ? { requiredLevel: opts.requiredLevel } : {}),
	};
	const coderNodeId = 'node-coder';
	const reviewerNodeId = 'node-reviewer';
	return {
		id: 'wf-mixed',
		spaceId: 'space-1',
		name: 'Test Workflow Mixed',
		nodes: [
			{ id: coderNodeId, name: 'Code', agents: [{ agentId: 'a1', name: 'coder' }] },
			{ id: reviewerNodeId, name: 'Review', agents: [{ agentId: 'a2', name: 'reviewer' }] },
		],
		startNodeId: coderNodeId,
		endNodeId: reviewerNodeId,
		gates: [gate],
		channels: [
			{
				id: 'ch-1',
				from: 'Code',
				to: 'Review',
				gateId,
			},
		],
		tags: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// 1. channel-router onGateDataChanged — auto-approval with default requiredLevel
// ---------------------------------------------------------------------------

describe('ChannelRouter.onGateDataChanged — requiredLevel enforcement', () => {
	let db: BunDatabase;
	let dir: string;
	let gateDataRepo: GateDataRepository;
	let nodeExecutionRepo: NodeExecutionRepository;

	const spaceId = 'space-cr-test';
	const runId = 'run-cr-1';
	const gateId = 'code-ready-gate';

	beforeEach(() => {
		const result = makeDb();
		db = result.db;
		dir = result.dir;
		gateDataRepo = new GateDataRepository(db);
		nodeExecutionRepo = new NodeExecutionRepository(db);
		seedSpaceRow(db, spaceId);
		seedWorkflowRunRow(db, runId, spaceId, 'wf-1');
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function makeRouter(spaceAutonomyLevel: number, workflow: SpaceWorkflow) {
		const workflowRunRepo = {
			getRun: mock(() => ({
				id: runId,
				spaceId,
				workflowId: workflow.id,
				status: 'in_progress',
			})),
		};
		const workflowManager = {
			getWorkflow: mock(() => workflow),
		};
		const taskRepo = {
			listByWorkflowRun: mock(() => []),
		};
		const agentManager = {
			getAgent: mock(() => null),
			listBySpaceId: mock(() => []),
		};
		return new ChannelRouter({
			taskRepo: taskRepo as never,
			workflowRunRepo: workflowRunRepo as never,
			workflowManager: workflowManager as never,
			agentManager: agentManager as never,
			nodeExecutionRepo,
			gateDataRepo,
			getSpaceAutonomyLevel: async () => spaceAutonomyLevel,
		});
	}

	test('no requiredLevel — auto-approves only at autonomy level 5', async () => {
		const workflow = buildGatedWorkflow({ gateId }); // no requiredLevel
		// Write some data to trigger onGateDataChanged
		gateDataRepo.merge(runId, gateId, { someData: true });

		// Level 4 should NOT auto-approve
		const router4 = makeRouter(4, workflow);
		await router4.onGateDataChanged(runId, gateId);
		const after4 = gateDataRepo.get(runId, gateId);
		expect(after4?.data?.approved).toBeUndefined();

		// Level 5 SHOULD auto-approve
		const router5 = makeRouter(5, workflow);
		await router5.onGateDataChanged(runId, gateId);
		const after5 = gateDataRepo.get(runId, gateId);
		expect(after5?.data?.approved).toBe(true);
	});

	test('explicit requiredLevel=3 — auto-approves at level 3 and above', async () => {
		const workflow = buildGatedWorkflow({ gateId, requiredLevel: 3 });
		gateDataRepo.merge(runId, gateId, { someData: true });

		// Level 2 should NOT auto-approve
		const router2 = makeRouter(2, workflow);
		await router2.onGateDataChanged(runId, gateId);
		const after2 = gateDataRepo.get(runId, gateId);
		expect(after2?.data?.approved).toBeUndefined();

		// Level 3 SHOULD auto-approve
		const router3 = makeRouter(3, workflow);
		await router3.onGateDataChanged(runId, gateId);
		const after3 = gateDataRepo.get(runId, gateId);
		expect(after3?.data?.approved).toBe(true);
	});

	test('explicit requiredLevel=1 — auto-approves at any level', async () => {
		const workflow = buildGatedWorkflow({ gateId, requiredLevel: 1 });
		gateDataRepo.merge(runId, gateId, { someData: true });

		const router = makeRouter(1, workflow);
		await router.onGateDataChanged(runId, gateId);
		const after = gateDataRepo.get(runId, gateId);
		expect(after?.data?.approved).toBe(true);
	});

	test('no getSpaceAutonomyLevel callback — no auto-approval regardless of gate.requiredLevel', async () => {
		const workflow = buildGatedWorkflow({ gateId, requiredLevel: 1 });
		gateDataRepo.merge(runId, gateId, { someData: true });

		const workflowRunRepo = {
			getRun: mock(() => ({
				id: runId,
				spaceId,
				workflowId: workflow.id,
				status: 'in_progress',
			})),
		};
		const router = new ChannelRouter({
			taskRepo: { listByWorkflowRun: mock(() => []) } as never,
			workflowRunRepo: workflowRunRepo as never,
			workflowManager: { getWorkflow: mock(() => workflow) } as never,
			agentManager: { getAgent: mock(() => null) } as never,
			nodeExecutionRepo,
			gateDataRepo,
			// getSpaceAutonomyLevel deliberately omitted
		});

		await router.onGateDataChanged(runId, gateId);
		const after = gateDataRepo.get(runId, gateId);
		expect(after?.data?.approved).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Shared mock factories for approve_gate tests
// ---------------------------------------------------------------------------

function makeWorkflowRun(status: SpaceWorkflowRun['status'] = 'in_progress'): SpaceWorkflowRun {
	return {
		id: 'run-1',
		spaceId: 'space-1',
		workflowId: 'wf-1',
		title: 'Test',
		status,
		startedAt: null,
		completedAt: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function makeGateDataRepo(initialApproved?: boolean) {
	const storedData: Record<string, unknown> = {};
	if (initialApproved !== undefined) {
		storedData['approved'] = initialApproved;
	}
	return {
		get: mock(() => (Object.keys(storedData).length > 0 ? { data: storedData } : null)),
		merge: mock((_runId: string, _gateId: string, partial: Record<string, unknown>) => ({
			data: { ...storedData, ...partial },
		})),
		set: mock((_runId: string, _gateId: string, data: Record<string, unknown>) => ({
			data,
		})),
	};
}

function makeWorkflowRunRepo(run: SpaceWorkflowRun | null = makeWorkflowRun()) {
	let currentRun = run;
	return {
		getRun: mock(() => currentRun),
		transitionStatus: mock((id: string, status: string) => {
			if (!currentRun) return null;
			currentRun = { ...currentRun, status: status as SpaceWorkflowRun['status'] };
			return currentRun;
		}),
		updateRun: mock((id: string, params: Partial<SpaceWorkflowRun>) => {
			if (!currentRun) return null;
			currentRun = { ...currentRun, ...params };
			return currentRun;
		}),
	};
}

// ---------------------------------------------------------------------------
// 2. space-agent-tools approve_gate — autonomy enforcement
// ---------------------------------------------------------------------------

describe('space-agent-tools approve_gate — autonomy enforcement', () => {
	const spaceId = 'space-1';
	const runId = 'run-1';
	const gateId = 'code-ready-gate';

	function makeHandlers(opts: {
		spaceAutonomyLevel: number;
		gateRequiredLevel?: SpaceAutonomyLevel;
		approvedFieldWriters?: string[];
		run?: SpaceWorkflowRun;
	}) {
		const workflow = buildGatedWorkflow({
			gateId,
			requiredLevel: opts.gateRequiredLevel,
			approvedFieldWriters: opts.approvedFieldWriters,
		});
		const gateDataRepo = makeGateDataRepo();
		const workflowRunRepo = makeWorkflowRunRepo(opts.run ?? makeWorkflowRun());
		const workflowManager = {
			getWorkflow: mock(() => workflow),
			listWorkflows: mock(() => [workflow]),
			createWorkflow: mock(() => workflow),
		};
		const config: SpaceAgentToolsConfig = {
			spaceId,
			runtime: { startWorkflowRun: mock(async () => ({ run: {}, tasks: [] })) } as never,
			workflowManager: workflowManager as never,
			taskRepo: {
				listTasks: mock(() => []),
				listByWorkflowRun: mock(() => []),
			} as never,
			nodeExecutionRepo: { listByWorkflowRun: mock(() => []) } as never,
			workflowRunRepo: workflowRunRepo as never,
			taskManager: {
				setTaskStatus: mock(async () => {}),
			} as never,
			spaceAgentManager: {} as never,
			gateDataRepo: gateDataRepo as never,
			getSpaceAutonomyLevel: async () => opts.spaceAutonomyLevel,
		};
		return { handlers: createSpaceAgentToolHandlers(config), gateDataRepo, workflowRunRepo };
	}

	test('agent approve blocked when space autonomy < gate requiredLevel', async () => {
		const { handlers } = makeHandlers({
			spaceAutonomyLevel: 2,
			gateRequiredLevel: 3,
			approvedFieldWriters: [],
		});
		const result = (await handlers.approve_gate({
			run_id: runId,
			gate_id: gateId,
			approved: true,
		})) as { content: Array<{ text: string }> };

		const text = result.content[0].text;
		const parsed = JSON.parse(text) as { success: boolean; error: string };
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('requires autonomy level 3');
		expect(parsed.error).toContain('space autonomy is 2');
	});

	test('agent approve succeeds when space autonomy >= gate requiredLevel', async () => {
		const { handlers, gateDataRepo } = makeHandlers({
			spaceAutonomyLevel: 3,
			gateRequiredLevel: 3,
		});
		const result = (await handlers.approve_gate({
			run_id: runId,
			gate_id: gateId,
			approved: true,
		})) as { content: Array<{ text: string }> };

		const text = result.content[0].text;
		const parsed = JSON.parse(text) as { success: boolean };
		expect(parsed.success).toBe(true);
		expect(gateDataRepo.merge).toHaveBeenCalledWith(
			runId,
			gateId,
			expect.objectContaining({
				approved: true,
				approvalSource: 'agent',
			})
		);
	});

	test('missing requiredLevel defaults to 5 — blocked at level 4', async () => {
		const { handlers } = makeHandlers({ spaceAutonomyLevel: 4, approvedFieldWriters: [] }); // no gateRequiredLevel
		const result = (await handlers.approve_gate({
			run_id: runId,
			gate_id: gateId,
			approved: true,
		})) as { content: Array<{ text: string }> };

		const text = result.content[0].text;
		const parsed = JSON.parse(text) as { success: boolean; error: string };
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('requires autonomy level 5');
	});

	test('missing requiredLevel defaults to 5 — approved at level 5', async () => {
		const { handlers, gateDataRepo } = makeHandlers({ spaceAutonomyLevel: 5 }); // no gateRequiredLevel
		const result = (await handlers.approve_gate({
			run_id: runId,
			gate_id: gateId,
			approved: true,
		})) as { content: Array<{ text: string }> };

		const text = result.content[0].text;
		const parsed = JSON.parse(text) as { success: boolean };
		expect(parsed.success).toBe(true);
		expect(gateDataRepo.merge).toHaveBeenCalled();
	});

	test('approved field with writers bypasses autonomy check — allowed at any level', async () => {
		// writers: ['*'] → writers path → no autonomy check → allowed even at level 1 with requiredLevel 5
		const { handlers, gateDataRepo } = makeHandlers({
			spaceAutonomyLevel: 1,
			gateRequiredLevel: 5,
			approvedFieldWriters: ['*'],
		});
		const result = (await handlers.approve_gate({
			run_id: runId,
			gate_id: gateId,
			approved: true,
		})) as { content: Array<{ text: string }> };

		const text = result.content[0].text;
		const parsed = JSON.parse(text) as { success: boolean };
		expect(parsed.success).toBe(true);
		expect(gateDataRepo.merge).toHaveBeenCalledWith(
			runId,
			gateId,
			expect.objectContaining({ approved: true, approvalSource: 'agent' })
		);
	});

	test('rejection (approved=false) is not autonomy-gated — always succeeds', async () => {
		const { handlers, gateDataRepo } = makeHandlers({
			spaceAutonomyLevel: 1,
			gateRequiredLevel: 5,
		});
		const result = (await handlers.approve_gate({
			run_id: runId,
			gate_id: gateId,
			approved: false,
			reason: 'Not ready',
		})) as { content: Array<{ text: string }> };

		const text = result.content[0].text;
		const parsed = JSON.parse(text) as { success: boolean };
		expect(parsed.success).toBe(true);
		expect(gateDataRepo.merge).toHaveBeenCalledWith(
			runId,
			gateId,
			expect.objectContaining({
				approved: false,
				approvalSource: 'agent',
			})
		);
	});

	test('no getSpaceAutonomyLevel callback — approve_gate not autonomy-gated', async () => {
		const workflow = buildGatedWorkflow({ gateId, requiredLevel: 5 });
		const gateDataRepo = makeGateDataRepo();
		const config: SpaceAgentToolsConfig = {
			spaceId,
			runtime: {} as never,
			workflowManager: {
				getWorkflow: mock(() => workflow),
				listWorkflows: mock(() => []),
			} as never,
			taskRepo: { listByWorkflowRun: mock(() => []) } as never,
			nodeExecutionRepo: {} as never,
			workflowRunRepo: makeWorkflowRunRepo() as never,
			taskManager: { setTaskStatus: mock(async () => {}) } as never,
			spaceAgentManager: {} as never,
			gateDataRepo: gateDataRepo as never,
			// getSpaceAutonomyLevel deliberately omitted
		};
		const handlers = createSpaceAgentToolHandlers(config);
		const result = (await handlers.approve_gate({
			run_id: runId,
			gate_id: gateId,
			approved: true,
		})) as { content: Array<{ text: string }> };

		const text = result.content[0].text;
		const parsed = JSON.parse(text) as { success: boolean };
		expect(parsed.success).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 3. task-agent-tools approve_gate — autonomy enforcement
// ---------------------------------------------------------------------------

describe('task-agent-tools approve_gate — autonomy enforcement', () => {
	const spaceId = 'space-1';
	const workflowRunId = 'run-1';
	const taskId = 'task-1';
	const gateId = 'code-ready-gate';

	const mockSpace: Space = {
		id: spaceId,
		slug: 'test',
		workspacePath: '/tmp',
		name: 'Test',
		description: '',
		backgroundContext: '',
		instructions: '',
		sessionIds: [],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	function makeHandlers(opts: {
		spaceAutonomyLevel: number;
		gateRequiredLevel?: SpaceAutonomyLevel;
		approvedFieldWriters?: string[];
		run?: SpaceWorkflowRun;
	}) {
		const workflow = buildGatedWorkflow({
			gateId,
			requiredLevel: opts.gateRequiredLevel,
			approvedFieldWriters: opts.approvedFieldWriters,
		});
		const gateDataRepo = makeGateDataRepo();
		const workflowRunRepo = makeWorkflowRunRepo(opts.run ?? makeWorkflowRun());
		const workflowManager = {
			getWorkflow: mock(() => workflow),
			listWorkflows: mock(() => [workflow]),
		};
		const taskRepo = {
			getTask: mock(() => ({
				id: taskId,
				status: 'in_progress',
				workflowRunId,
			})),
		};
		const taskManager = {
			setTaskStatus: mock(async () => {}),
		};
		const config: TaskAgentToolsConfig = {
			taskId,
			space: mockSpace,
			workflowRunId,
			taskRepo: taskRepo as never,
			nodeExecutionRepo: { listByWorkflowRun: mock(() => []) } as never,
			taskManager: taskManager as never,
			messageInjector: mock(async () => {}),
			gateDataRepo: gateDataRepo as never,
			workflowRunRepo: workflowRunRepo as never,
			workflowManager: workflowManager as never,
			getSpaceAutonomyLevel: async () => opts.spaceAutonomyLevel,
		};
		return { handlers: createTaskAgentToolHandlers(config), gateDataRepo, workflowRunRepo };
	}

	test('agent approve blocked when space autonomy < gate requiredLevel', async () => {
		const { handlers } = makeHandlers({
			spaceAutonomyLevel: 1,
			gateRequiredLevel: 3,
			approvedFieldWriters: [],
		});
		const result = (await handlers.approve_gate({
			gate_id: gateId,
			approved: true,
		})) as { content: Array<{ text: string }> };

		const text = result.content[0].text;
		const parsed = JSON.parse(text) as { success: boolean; error: string };
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('requires autonomy level 3');
		expect(parsed.error).toContain('space autonomy is 1');
	});

	test('agent approve succeeds when space autonomy >= gate requiredLevel', async () => {
		const { handlers, gateDataRepo } = makeHandlers({
			spaceAutonomyLevel: 4,
			gateRequiredLevel: 4,
		});
		const result = (await handlers.approve_gate({
			gate_id: gateId,
			approved: true,
		})) as { content: Array<{ text: string }> };

		const text = result.content[0].text;
		const parsed = JSON.parse(text) as { success: boolean };
		expect(parsed.success).toBe(true);
		expect(gateDataRepo.merge).toHaveBeenCalledWith(
			workflowRunId,
			gateId,
			expect.objectContaining({
				approved: true,
				approvalSource: 'agent',
			})
		);
	});

	test('missing requiredLevel defaults to 5 — blocked at level 4', async () => {
		const { handlers } = makeHandlers({ spaceAutonomyLevel: 4, approvedFieldWriters: [] }); // no gateRequiredLevel
		const result = (await handlers.approve_gate({
			gate_id: gateId,
			approved: true,
		})) as { content: Array<{ text: string }> };

		const text = result.content[0].text;
		const parsed = JSON.parse(text) as { success: boolean; error: string };
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('requires autonomy level 5');
	});

	test('missing requiredLevel defaults to 5 — approved at level 5', async () => {
		const { handlers, gateDataRepo } = makeHandlers({ spaceAutonomyLevel: 5 });
		const result = (await handlers.approve_gate({
			gate_id: gateId,
			approved: true,
		})) as { content: Array<{ text: string }> };

		const text = result.content[0].text;
		const parsed = JSON.parse(text) as { success: boolean };
		expect(parsed.success).toBe(true);
		expect(gateDataRepo.merge).toHaveBeenCalled();
	});

	test('approved field with writers bypasses autonomy check — allowed at any level', async () => {
		// writers: ['*'] → writers path → no autonomy check → allowed even at level 1 with requiredLevel 5
		const { handlers, gateDataRepo } = makeHandlers({
			spaceAutonomyLevel: 1,
			gateRequiredLevel: 5,
			approvedFieldWriters: ['*'],
		});
		const result = (await handlers.approve_gate({
			gate_id: gateId,
			approved: true,
		})) as { content: Array<{ text: string }> };

		const text = result.content[0].text;
		const parsed = JSON.parse(text) as { success: boolean };
		expect(parsed.success).toBe(true);
		expect(gateDataRepo.merge).toHaveBeenCalledWith(
			workflowRunId,
			gateId,
			expect.objectContaining({ approved: true, approvalSource: 'agent' })
		);
	});

	test('rejection (approved=false) is not autonomy-gated — always succeeds', async () => {
		const { handlers, gateDataRepo } = makeHandlers({
			spaceAutonomyLevel: 1,
			gateRequiredLevel: 5,
		});
		const result = (await handlers.approve_gate({
			gate_id: gateId,
			approved: false,
			reason: 'Not ready yet',
		})) as { content: Array<{ text: string }> };

		const text = result.content[0].text;
		const parsed = JSON.parse(text) as { success: boolean };
		expect(parsed.success).toBe(true);
		expect(gateDataRepo.merge).toHaveBeenCalledWith(
			workflowRunId,
			gateId,
			expect.objectContaining({
				approved: false,
				approvalSource: 'agent',
			})
		);
	});

	test('no workflowManager in config — approve_gate not autonomy-gated', async () => {
		const gateDataRepo = makeGateDataRepo();
		const workflowRunRepo = makeWorkflowRunRepo();
		const taskRepo = {
			getTask: mock(() => ({ id: taskId, status: 'in_progress', workflowRunId })),
		};
		const taskManager = { setTaskStatus: mock(async () => {}) };
		const config: TaskAgentToolsConfig = {
			taskId,
			space: mockSpace,
			workflowRunId,
			taskRepo: taskRepo as never,
			nodeExecutionRepo: { listByWorkflowRun: mock(() => []) } as never,
			taskManager: taskManager as never,
			messageInjector: mock(async () => {}),
			gateDataRepo: gateDataRepo as never,
			workflowRunRepo: workflowRunRepo as never,
			// workflowManager and getSpaceAutonomyLevel deliberately omitted
		};
		const handlers = createTaskAgentToolHandlers(config);
		const result = (await handlers.approve_gate({
			gate_id: gateId,
			approved: true,
		})) as { content: Array<{ text: string }> };

		const text = result.content[0].text;
		const parsed = JSON.parse(text) as { success: boolean };
		// Without workflowManager + getSpaceAutonomyLevel, the check is skipped → success
		expect(parsed.success).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 4. node-agent-tools send_message gate write — autonomy enforcement
// ---------------------------------------------------------------------------

describe('node-agent-tools send_message gate write — autonomy enforcement', () => {
	let db: BunDatabase;
	let dir: string;
	let gateDataRepo: GateDataRepository;
	let nodeExecutionRepo: NodeExecutionRepository;

	const spaceId = 'space-node-test';
	const runId = 'run-node-1';
	const gateId = 'code-ready-gate';
	const coderNodeId = 'node-coder';
	const reviewerNodeId = 'node-reviewer';

	beforeEach(() => {
		const result = makeDb();
		db = result.db;
		dir = result.dir;
		gateDataRepo = new GateDataRepository(db);
		nodeExecutionRepo = new NodeExecutionRepository(db);
		seedSpaceRow(db, spaceId);
		seedWorkflowRunRow(db, runId, spaceId, 'wf-1');
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function makeHandlers(opts: {
		spaceAutonomyLevel: number;
		gateRequiredLevel?: SpaceAutonomyLevel;
		approvedFieldWriters?: string[];
	}) {
		const workflow = buildGatedWorkflow({
			gateId,
			requiredLevel: opts.gateRequiredLevel,
			approvedFieldWriters: opts.approvedFieldWriters,
		});
		const channelResolver = new ChannelResolver(workflow.channels ?? []);
		// AgentMessageRouter that always succeeds delivery for the purpose of these tests
		const agentMessageRouter: AgentMessageRouter = {
			deliverMessage: mock(async () => ({
				success: true as const,
				delivered: [{ agentName: 'reviewer', sessionId: 'sess-reviewer' }],
				failed: [],
				notFoundAgentNames: [],
				permittedTargets: ['reviewer', 'task-agent'],
				unauthorizedAgentNames: [],
			})),
		} as unknown as AgentMessageRouter;

		seedSpaceTask(db, spaceId, runId, coderNodeId, 'coder', 'sess-coder');
		seedSpaceTask(db, spaceId, runId, reviewerNodeId, 'reviewer', 'sess-reviewer');

		const config: NodeAgentToolsConfig = {
			mySessionId: 'sess-coder',
			myAgentName: 'coder',
			taskId: 'task-coder',
			spaceId,
			channelResolver,
			workflowRunId: runId,
			workflowNodeId: coderNodeId,
			nodeExecutionRepo,
			agentMessageRouter,
			workflow,
			gateDataRepo,
			getSpaceAutonomyLevel: async () => opts.spaceAutonomyLevel,
		};
		return createNodeAgentToolHandlers(config);
	}

	test('gate write blocked when space autonomy < gate requiredLevel', async () => {
		const handlers = makeHandlers({
			spaceAutonomyLevel: 2,
			gateRequiredLevel: 3,
			approvedFieldWriters: [],
		});
		const result = (await handlers.send_message({
			target: 'Review',
			message: 'PR ready',
			data: { approved: true },
		})) as { content: Array<{ text: string }> };

		const text = result.content[0].text;
		const parsed = JSON.parse(text) as { success: boolean; error?: string };
		// Gate data should not have been written (field skipped, no authorized data → no gate write)
		expect(gateDataRepo.get(runId, gateId)).toBeNull();
		// Message still delivered, but gate was not written (success: true with no gateWrite data)
		expect(parsed.success).toBe(true);
	});

	test('gate write succeeds when space autonomy >= gate requiredLevel', async () => {
		const handlers = makeHandlers({
			spaceAutonomyLevel: 3,
			gateRequiredLevel: 3,
			approvedFieldWriters: [],
		});
		const result = (await handlers.send_message({
			target: 'Review',
			message: 'PR ready',
			data: { approved: true },
		})) as { content: Array<{ text: string }> };

		const text = result.content[0].text;
		const parsed = JSON.parse(text) as { success: boolean };
		expect(parsed.success).toBe(true);
		// Gate data should have been written
		const gateRecord = gateDataRepo.get(runId, gateId);
		expect(gateRecord?.data?.approved).toBe(true);
		expect(gateRecord?.data?.approvalSource).toBe('agent');
	});

	test('missing requiredLevel defaults to 5 — gate write blocked at level 4', async () => {
		const handlers = makeHandlers({ spaceAutonomyLevel: 4, approvedFieldWriters: [] }); // no gateRequiredLevel
		const result = (await handlers.send_message({
			target: 'Review',
			message: 'PR ready',
			data: { approved: true },
		})) as { content: Array<{ text: string }> };

		const text = result.content[0].text;
		const parsed = JSON.parse(text) as { success: boolean };
		// Field skipped (autonomy path, level 4 < 5), no authorized data → no gate write
		expect(gateDataRepo.get(runId, gateId)).toBeNull();
		expect(parsed.success).toBe(true);
	});

	test('missing requiredLevel defaults to 5 — gate write succeeds at level 5', async () => {
		const handlers = makeHandlers({ spaceAutonomyLevel: 5, approvedFieldWriters: [] }); // no gateRequiredLevel
		const result = (await handlers.send_message({
			target: 'Review',
			message: 'PR ready',
			data: { approved: true },
		})) as { content: Array<{ text: string }> };

		const text = result.content[0].text;
		const parsed = JSON.parse(text) as { success: boolean };
		expect(parsed.success).toBe(true);
		const gateRecord = gateDataRepo.get(runId, gateId);
		expect(gateRecord?.data?.approved).toBe(true);
	});

	test('field with writers bypasses autonomy check — allowed at any level', async () => {
		// approved field has writers: ['*'] → writers path → level 1 can write despite requiredLevel 5
		const handlers = makeHandlers({
			spaceAutonomyLevel: 1,
			gateRequiredLevel: 5,
			approvedFieldWriters: ['*'],
		});
		const result = (await handlers.send_message({
			target: 'Review',
			message: 'PR ready',
			data: { approved: true },
		})) as { content: Array<{ text: string }> };

		const text = result.content[0].text;
		const parsed = JSON.parse(text) as { success: boolean };
		expect(parsed.success).toBe(true);
		const gateRecord = gateDataRepo.get(runId, gateId);
		expect(gateRecord?.data?.approved).toBe(true);
		expect(gateRecord?.data?.approvalSource).toBe('agent');
	});

	test('mixed fields: writers-path field allowed, no-writers field requires autonomy', async () => {
		// Build a workflow where:
		//   - 'approved' field has writers: ['coder'] → writers path for coder
		//   - 'extra_check' field has writers: [] → autonomy path (level 2 < 3)
		const gatedWorkflow = buildGatedWorkflowMixed({
			gateId,
			requiredLevel: 3 as SpaceAutonomyLevel,
			fields: [
				{
					name: 'approved',
					type: 'boolean' as const,
					writers: ['coder'],
					check: { op: '==' as const, value: true },
				},
				{
					name: 'extra_check',
					type: 'boolean' as const,
					writers: [],
					check: { op: '==' as const, value: true },
				},
			],
		});
		const channelResolver = new ChannelResolver(gatedWorkflow.channels ?? []);
		seedSpaceTask(db, spaceId, runId, reviewerNodeId, 'reviewer3', 'sess-reviewer3');
		const config: NodeAgentToolsConfig = {
			mySessionId: 'sess-coder3',
			myAgentName: 'coder',
			taskId: 'task-coder3',
			spaceId,
			channelResolver,
			workflowRunId: runId,
			workflowNodeId: coderNodeId,
			nodeExecutionRepo,
			agentMessageRouter: {
				deliverMessage: mock(async () => ({
					success: true as const,
					delivered: [{ agentName: 'reviewer', sessionId: 'sess-reviewer3' }],
					failed: [],
					notFoundAgentNames: [],
					permittedTargets: ['Review', 'task-agent'],
					unauthorizedAgentNames: [],
				})),
			} as unknown as AgentMessageRouter,
			workflow: gatedWorkflow,
			gateDataRepo,
			getSpaceAutonomyLevel: async () => 2, // below requiredLevel 3
		};
		const handlers = createNodeAgentToolHandlers(config);
		const result = (await handlers.send_message({
			target: 'Review',
			message: 'PR ready',
			data: { approved: true, extra_check: true },
		})) as { content: Array<{ text: string }> };

		const text = result.content[0].text;
		const parsed = JSON.parse(text) as { success: boolean };
		expect(parsed.success).toBe(true); // message still delivered
		const gateRecord = gateDataRepo.get(runId, gateId);
		// 'approved' written via writers path (coder in writers list)
		expect(gateRecord?.data?.approved).toBe(true);
		// 'extra_check' skipped: empty writers + level 2 < requiredLevel 3
		expect(gateRecord?.data?.extra_check).toBeUndefined();
	});

	test('no getSpaceAutonomyLevel in config — gate write is not autonomy-gated', async () => {
		const workflow = buildGatedWorkflow({ gateId, requiredLevel: 5 });
		const channelResolver = new ChannelResolver(workflow.channels ?? []);
		seedSpaceTask(db, spaceId, runId, reviewerNodeId, 'reviewer2', 'sess-reviewer2');

		const config: NodeAgentToolsConfig = {
			mySessionId: 'sess-coder2',
			myAgentName: 'coder',
			taskId: 'task-coder2',
			spaceId,
			channelResolver,
			workflowRunId: runId,
			workflowNodeId: coderNodeId,
			nodeExecutionRepo,
			agentMessageRouter: {
				deliverMessage: mock(async () => ({
					success: true as const,
					delivered: [{ agentName: 'reviewer', sessionId: 'sess-reviewer2' }],
					failed: [],
					notFoundAgentNames: [],
					permittedTargets: ['Review', 'task-agent'],
					unauthorizedAgentNames: [],
				})),
			} as unknown as AgentMessageRouter,
			workflow,
			gateDataRepo,
			// getSpaceAutonomyLevel deliberately omitted
		};
		const handlers = createNodeAgentToolHandlers(config);
		const result = (await handlers.send_message({
			target: 'Review',
			message: 'PR ready',
			data: { approved: true },
		})) as { content: Array<{ text: string }> };

		const text = result.content[0].text;
		const parsed = JSON.parse(text) as { success: boolean };
		// Without getSpaceAutonomyLevel, the autonomy path is skipped → write proceeds via writers path
		expect(parsed.success).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 5. Human approval via RPC — not autonomy-gated (regression guard)
// ---------------------------------------------------------------------------

describe('Human approval path — not subject to autonomy checks', () => {
	/**
	 * The RPC handler `spaceWorkflowRun.approveGate` sets approvalSource: 'human'
	 * and does NOT call getSpaceAutonomyLevel. This is a regression guard to ensure
	 * the human path always works regardless of space autonomy level.
	 *
	 * The full RPC behavior is tested in space-workflow-run-gate-handlers.test.ts.
	 * This test documents the contract: approvalSource must be 'human' for the RPC path.
	 */
	test('human approval sets approvalSource: human (not agent)', async () => {
		// Import the RPC handler and verify it writes approvalSource: 'human'
		const { setupSpaceWorkflowRunHandlers } = await import(
			'../../../../src/lib/rpc-handlers/space-workflow-run-handlers.ts'
		);

		const handlers = new Map<string, (data: unknown) => Promise<unknown>>();
		const mockHub = {
			onRequest: (method: string, handler: (data: unknown) => Promise<unknown>) => {
				handlers.set(method, handler);
				return () => {};
			},
			onEvent: () => () => {},
		};

		const NOW = Date.now();
		const mergeCaptures: Array<Record<string, unknown>> = [];
		const mockGateDataRepo = {
			get: () => null,
			merge: (_runId: string, _gateId: string, partial: Record<string, unknown>) => {
				mergeCaptures.push(partial);
				return { data: partial };
			},
		};
		const mockRun = {
			id: 'run-h1',
			spaceId: 'sp-h1',
			workflowId: 'wf-h1',
			status: 'in_progress' as const,
			title: '',
			startedAt: null,
			completedAt: null,
			createdAt: NOW,
			updatedAt: NOW,
		};
		const mockRunRepo = {
			getRun: () => mockRun,
			transitionStatus: () => mockRun,
			updateRun: () => mockRun,
		};
		const mockSpaceManager = {
			getSpace: async () => ({
				id: 'sp-h1',
				workspacePath: '/tmp',
				name: '',
				description: '',
			}),
		};
		const mockWorkflowManager = {
			getWorkflow: () => null,
		};
		const mockDaemonHub = { emit: async () => {} };

		setupSpaceWorkflowRunHandlers(
			mockHub as never,
			mockSpaceManager as never,
			mockWorkflowManager as never,
			mockRunRepo as never,
			mockGateDataRepo as never,
			{ createOrGetRuntime: async () => ({}), notifyGateDataChanged: async () => {} } as never,
			(() => ({ listTasksByWorkflowRun: async () => [], cancelTask: async () => {} })) as never,
			mockDaemonHub as never,
			{ listByWorkflowRun: () => [] } as never,
			{ getTaskWorktreePath: async () => null } as never,
			{ listByRun: () => [] } as never
		);

		const handler = handlers.get('spaceWorkflowRun.approveGate');
		expect(handler).toBeDefined();

		await handler!({ runId: 'run-h1', gateId: 'gate-h1', approved: true });

		expect(mergeCaptures).toHaveLength(1);
		expect(mergeCaptures[0].approvalSource).toBe('human');
	});
});
