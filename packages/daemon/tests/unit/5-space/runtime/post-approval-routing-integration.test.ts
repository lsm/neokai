/**
 * Integration test for PR 3/5 — built-in workflow + PostApprovalRouter +
 * mark_complete end-to-end.
 *
 * This is the §4.6 "full approve → post-approval → mark_complete" coverage
 * the reviewer asked for (`post-approval-routing.test.ts (or equivalent)`).
 * It is an "equivalent" in the form of a runtime-level integration test
 * rather than an online/E2E test because:
 *
 *   - The online test harness (`tests/online/space/`) boots a real daemon
 *     and drives RPC round-trips. That harness is valuable for UI/RPC
 *     contracts but adds process overhead and non-determinism that isn't
 *     needed here — the work under test is 100% daemon-side plumbing.
 *   - Running against the real SpaceTaskRepository + SpaceWorkflowManager
 *     + seedBuiltInWorkflows + PostApprovalRouter + createMarkCompleteHandler
 *     exercises every production code path PR 3/5 touches, with zero stubs
 *     outside the two delegates (`TaskAgentInjector`, `SubSessionSpawner`)
 *     that the router already expects to be injected at runtime.
 *   - Same determinism + speed profile as the rest of `tests/unit/5-space/`;
 *     runs inside the 5-space shard in CI with no extra harness.
 *
 * Shape of the flow under test:
 *
 *     seedBuiltInWorkflows()
 *         └── Coding workflow row with
 *             postApproval.targetAgent = 'reviewer'
 *     ▼
 *     create task referencing the Coding workflow
 *     transition in_progress → approved (simulating approve_task)
 *     ▼
 *     PostApprovalRouter.route(task, workflow, { …context })
 *         └── mode='spawn', postApprovalSessionId stamped on task
 *     ▼
 *     mark_complete handler (ran on the post-approval sub-session)
 *         └── status approved → done, postApprovalSessionId cleared
 *
 * PLUS a companion test that flips the kill-switch
 * (`NEOKAI_TASK_AGENT_POST_APPROVAL_ROUTING=0`) and confirms the caller-
 * side gate disables routing — i.e. `isPostApprovalRoutingEnabled` returns
 * false, which is what the space-runtime / task-approve handler consults
 * before invoking `router.route()`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import {
	seedBuiltInWorkflows,
	CODING_WORKFLOW,
	PLAN_AND_DECOMPOSE_WORKFLOW,
	getBuiltInWorkflows,
} from '../../../../src/lib/space/workflows/built-in-workflows.ts';
import {
	PostApprovalRouter,
	isPostApprovalRoutingEnabled,
	POST_APPROVAL_ROUTING_FLAG_ENV,
} from '../../../../src/lib/space/runtime/post-approval-router.ts';
import { createMarkCompleteHandler } from '../../../../src/lib/space/tools/end-node-handlers.ts';
import type { SpaceTask, SpaceWorkflow } from '@neokai/shared';

// ---------------------------------------------------------------------------
// DB + seed helpers
// ---------------------------------------------------------------------------

const SPACE_ID = 'space-par-int';

function makeDb(): BunDatabase {
	const db = new BunDatabase(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
	).run(SPACE_ID, '/tmp/par-int', `Space ${SPACE_ID}`, SPACE_ID, Date.now(), Date.now());
	return db;
}

/**
 * Seed one agent per role referenced by ANY built-in workflow. The seeder
 * pre-validates across all five templates before persisting so even tests
 * that only care about Coding have to satisfy the full role set. Mirrors
 * what the `space.create` RPC handler does in production.
 */
function seedAgents(db: BunDatabase): Map<string, string> {
	const names = new Set<string>();
	for (const template of getBuiltInWorkflows()) {
		for (const node of template.nodes) {
			for (const a of node.agents) names.add(a.agentId);
		}
	}
	const roleToId = new Map<string, string>();
	for (const name of names) {
		const id = `agent-${name.toLowerCase().replace(/\s+/g, '-')}`;
		db.prepare(
			`INSERT INTO space_agents (id, space_id, name, description, model, tools, custom_prompt, created_at, updated_at)
       VALUES (?, ?, ?, '', null, '[]', null, ?, ?)`
		).run(id, SPACE_ID, name, Date.now(), Date.now());
		roleToId.set(name.toLowerCase(), id);
	}
	return roleToId;
}

// ---------------------------------------------------------------------------
// Delegate stubs — same pattern as post-approval-router.test.ts
// ---------------------------------------------------------------------------

interface RecordedSpawn {
	taskId: string;
	targetAgent: string;
	kickoffMessage: string;
}

function makeStubs() {
	const spawned: RecordedSpawn[] = [];
	const injected: Array<{ taskId: string; message: string }> = [];
	const aliveSessions = new Set<string>();

	return {
		spawned,
		injected,
		aliveSessions,
		taskAgent: {
			async injectIntoTaskAgent(taskId: string, message: string) {
				injected.push({ taskId, message });
				return { injected: true, sessionId: `ta-${taskId}` };
			},
		},
		spawner: {
			async spawnPostApprovalSubSession(args: {
				task: SpaceTask;
				workflow: SpaceWorkflow;
				targetAgent: string;
				kickoffMessage: string;
			}) {
				const sessionId = `sub-${spawned.length + 1}`;
				spawned.push({
					taskId: args.task.id,
					targetAgent: args.targetAgent,
					kickoffMessage: args.kickoffMessage,
				});
				aliveSessions.add(sessionId);
				return { sessionId };
			},
		},
		liveness: {
			isSessionAlive(id: string) {
				return aliveSessions.has(id);
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PR 3/5 integration — approve → post-approval → mark_complete', () => {
	let db: BunDatabase;
	let workflowManager: SpaceWorkflowManager;
	let taskRepo: SpaceTaskRepository;
	let taskManager: SpaceTaskManager;

	beforeEach(() => {
		db = makeDb();
		const agentRoles = seedAgents(db);
		workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
		taskRepo = new SpaceTaskRepository(db);
		taskManager = new SpaceTaskManager(db, SPACE_ID);

		// Seed the five built-in workflows — mirrors the space.create RPC handler.
		const result = seedBuiltInWorkflows(SPACE_ID, workflowManager, (name) =>
			agentRoles.get(name.toLowerCase())
		);
		expect(result.errors).toEqual([]);
		expect(result.seeded.length).toBeGreaterThan(0);
	});

	afterEach(() => {
		db.close();
	});

	test('approved Coding task routes to `reviewer` sub-session; mark_complete closes it', async () => {
		// Pull the seeded Coding workflow — it must carry postApproval.targetAgent='reviewer'.
		const coding = workflowManager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === CODING_WORKFLOW.name);
		expect(coding).toBeDefined();
		expect(coding!.postApproval?.targetAgent).toBe('reviewer');
		expect(coding!.postApproval?.instructions).toContain('{{pr_url}}');

		// ---------------------------------------------------------------
		// Seed a task that is in `approved` (mimicking end-node approve_task
		// having already fired, or a human approving via the RPC handler).
		// ---------------------------------------------------------------
		const createdTask = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Ship feature X',
			description: 'Implementation complete, PR opened',
			status: 'in_progress',
		});
		// Route() is called AFTER the caller has flipped the task into approved.
		const approved = taskRepo.updateTask(createdTask.id, {
			status: 'approved',
			approvalSource: 'agent',
			approvedAt: Date.now(),
		})!;

		// ---------------------------------------------------------------
		// Drive the router end-to-end.
		// ---------------------------------------------------------------
		const stubs = makeStubs();
		const router = new PostApprovalRouter({
			taskRepo,
			taskAgent: stubs.taskAgent,
			spawner: stubs.spawner,
			livenessProbe: stubs.liveness,
		});

		const result = await router.route(approved, coding!, {
			approvalSource: 'agent',
			spaceId: SPACE_ID,
			pr_url: 'https://github.com/example/repo/pull/42',
			reviewer_name: 'reviewer',
			approval_source: 'agent',
			autonomy_level: 4,
			workspacePath: '/tmp/par-int',
		});

		// Reviewer is a node-agent target → spawn mode fires.
		expect(result.mode).toBe('spawn');
		if (result.mode !== 'spawn') throw new Error('unreachable'); // narrow

		// Stub received the spawn request with the interpolated template —
		// critically {{pr_url}} must be replaced with the real URL. This is
		// the regression the "re-stamp must update prompts" fix protects:
		// without a current template on the row, spawning fires against
		// either a stale template with outdated signalling or — worse —
		// uninterpolated `{{pr_url}}` if the task-agent prompt was stale.
		expect(stubs.spawned).toHaveLength(1);
		expect(stubs.spawned[0].taskId).toBe(approved.id);
		expect(stubs.spawned[0].targetAgent).toBe('reviewer');
		expect(stubs.spawned[0].kickoffMessage).toContain('https://github.com/example/repo/pull/42');
		expect(stubs.spawned[0].kickoffMessage).not.toContain('{{pr_url}}');

		// Router stamped the session on the task.
		const mid = taskRepo.getTask(approved.id)!;
		expect(mid.status).toBe('approved'); // NOT done yet — sub-session owns the close.
		expect(mid.postApprovalSessionId).toBe(result.postApprovalSessionId);
		expect(mid.postApprovalStartedAt).toBe(result.postApprovalStartedAt);

		// ---------------------------------------------------------------
		// mark_complete is the tool the reviewer sub-session calls when
		// it's done merging. Invoke the handler directly to prove the
		// approved → done transition.
		// ---------------------------------------------------------------
		const markComplete = createMarkCompleteHandler({
			taskId: approved.id,
			spaceId: SPACE_ID,
			taskRepo,
			taskManager,
		});
		const toolResult = await markComplete({});
		const parsed = JSON.parse(
			toolResult.content.map((c) => ('text' in c ? c.text : '')).join('')
		) as { success: boolean; error?: string };
		expect(parsed.success).toBe(true);

		const finalTask = taskRepo.getTask(approved.id)!;
		expect(finalTask.status).toBe('done');
		expect(finalTask.postApprovalSessionId).toBeNull();
		expect(finalTask.postApprovalStartedAt).toBeNull();
	});

	test('approved task with NO postApproval → router closes directly (Plan-and-Decompose path)', async () => {
		// Plan-and-Decompose is deliberately left without a postApproval route in
		// PR 3/5 — its end-node is the Task Agent itself, so there is no PR to
		// merge and no reviewer to dispatch to. This test locks that in.
		const planDecompose = workflowManager
			.listWorkflows(SPACE_ID)
			.find((w) => w.name === PLAN_AND_DECOMPOSE_WORKFLOW.name);
		expect(planDecompose).toBeDefined();
		expect(planDecompose!.postApproval).toBeUndefined();

		const created = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Plan the work',
			description: 'Break down the epic',
			status: 'in_progress',
		});
		const approved = taskRepo.updateTask(created.id, {
			status: 'approved',
			approvalSource: 'human',
			approvedAt: Date.now(),
		})!;

		const stubs = makeStubs();
		const router = new PostApprovalRouter({
			taskRepo,
			taskAgent: stubs.taskAgent,
			spawner: stubs.spawner,
			livenessProbe: stubs.liveness,
		});

		const result = await router.route(approved, planDecompose!, {
			approvalSource: 'human',
			spaceId: SPACE_ID,
		});

		expect(result.mode).toBe('no-route');
		expect(stubs.spawned).toHaveLength(0);
		expect(stubs.injected).toHaveLength(0);
		expect(taskRepo.getTask(approved.id)!.status).toBe('done');
	});

	test('kill-switch: NEOKAI_TASK_AGENT_POST_APPROVAL_ROUTING=0 disables routing at the call site', () => {
		// The router itself does not consult the flag (its callers do — see the
		// doc comment at the top of post-approval-router.ts). So the kill-switch
		// integration contract is: `isPostApprovalRoutingEnabled` returns false,
		// which makes the runtime fall back to the legacy completion-actions
		// pipeline (deleted in PR 4/5 — kept alive for this intermediate PR).
		expect(isPostApprovalRoutingEnabled({ [POST_APPROVAL_ROUTING_FLAG_ENV]: '0' })).toBe(false);
		expect(isPostApprovalRoutingEnabled({ [POST_APPROVAL_ROUTING_FLAG_ENV]: 'false' })).toBe(false);
		expect(isPostApprovalRoutingEnabled({ [POST_APPROVAL_ROUTING_FLAG_ENV]: 'off' })).toBe(false);
		// Default ON (PR 3/5 flip): unset / truthy values enable routing.
		expect(isPostApprovalRoutingEnabled({})).toBe(true);
		expect(isPostApprovalRoutingEnabled({ [POST_APPROVAL_ROUTING_FLAG_ENV]: '1' })).toBe(true);
	});
});
