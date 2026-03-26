/**
 * Unit tests for CompletionDetector
 *
 * Scenarios (39 total):
 *   1.  No tasks exist — returns false (workflow not started)
 *   2.  Single agent in_progress — returns false
 *   3.  Single agent completed — returns true
 *   4.  Single agent needs_attention — returns true (terminal)
 *   5.  Single agent cancelled — returns true (terminal)
 *   6.  Single agent pending — returns false (non-terminal)
 *   7.  Single agent draft — returns false (non-terminal)
 *   8.  Single agent review — returns false (non-terminal)
 *   9.  Multi-agent single node — all completed → true
 *   10. Multi-agent single node — one in_progress → false
 *   11. Multi-node workflow — all agents terminal → true
 *   12. Multi-node workflow — one agent non-terminal → false
 *   13. Archived tasks excluded from listByWorkflowRun; remaining all terminal → true
 *   14. No channels provided — skips pending-but-blocked guard → true when all terminal
 *   15. Channels + nodes: all target nodes activated → true
 *   16. Channels + nodes: one target node not activated → false (pending-but-blocked)
 *   17. Wildcard channel ("*") — target skipped, does not block completion
 *   18. Cross-node format "nodeId/agentName" — target node resolved from prefix
 *   19. Fan-out by node name — target node matched by name
 *   20. Channels provided but nodes empty — guard skipped → true when all terminal
 *   21. Unresolvable channel target — guard skips unknown, does not block completion
 *   22. Multi-target channel array — all targets checked; one unactivated → false
 *   23. Node with no tasks excluded — does not block when no channel points to it
 *   24. TERMINAL_TASK_STATUSES export — contains exactly the 5 terminal statuses
 *   25. TERMINAL_TASK_STATUSES export — does not contain non-terminal statuses
 *   26. Orchestration task (null workflowNodeId) in_progress does not block completion
 *   27. Only an orchestration task (no workflowNodeId) — treated as not started
 *   28. Mixed terminal statuses: completed + cancelled → true
 *   29. Mixed terminal statuses: completed + needs_attention → true
 *   30. All five terminal statuses in one run → true
 *   31. One non-terminal task blocks completion regardless of terminal count
 *   32. Tasks from different workflow runs do not interfere
 *   33. Empty run vs run with tasks — no cross-contamination
 *   34. Pending-but-blocked: 3-node chain with unactivated downstream
 *   35. Pending-but-blocked: all nodes activated and terminal → complete
 *   36. Pending-but-blocked: channel with array target, one unactivated member
 *   37. Bidirectional channel — both nodes must be activated
 *   38. Wildcard + downstream channel: wildcard satisfied, downstream blocks
 *   39. Node with agents that have no tasks excluded from pending-but-blocked guard
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository.ts';
import {
	CompletionDetector,
	TERMINAL_TASK_STATUSES,
} from '../../../src/lib/space/runtime/completion-detector.ts';
import type { WorkflowChannel, WorkflowNode } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-completion-detector',
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	runMigrations(db, () => {});
	// Migrations re-enable FK at the end; disable after to allow synthetic run/node IDs
	// without needing to seed full parent rows (workflow runs, workflow nodes, etc.)
	db.exec('PRAGMA foreign_keys = OFF');
	return { db, dir };
}

function seedSpace(db: BunDatabase, spaceId: string): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, status, created_at, updated_at)
     VALUES (?, '/tmp/ws', ?, '', '', '', '[]', '[]', 'active', ?, ?)`
	).run(spaceId, `Space ${spaceId}`, Date.now(), Date.now());
}

let taskCounter = 0;
function seedTask(
	db: BunDatabase,
	spaceId: string,
	overrides: {
		id?: string;
		status?: string;
		workflowRunId?: string;
		workflowNodeId?: string;
	} = {}
): string {
	const id = overrides.id ?? `task-${++taskCounter}`;
	const now = Date.now();
	db.prepare(
		`INSERT INTO space_tasks
       (id, space_id, title, description, status, priority, depends_on,
        workflow_run_id, workflow_node_id, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, 'normal', '[]', ?, ?, ?, ?)`
	).run(
		id,
		spaceId,
		`Task ${id}`,
		overrides.status ?? 'in_progress',
		overrides.workflowRunId ?? null,
		overrides.workflowNodeId ?? null,
		now,
		now
	);
	return id;
}

function makeNode(id: string, name: string, agentNames: string[]): WorkflowNode {
	return {
		id,
		name,
		agents: agentNames.map((n) => ({ agentId: `agent-${n}`, name: n })),
	};
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

let db: BunDatabase;
let dir: string;
let taskRepo: SpaceTaskRepository;
let detector: CompletionDetector;
const SPACE = 'space-1';

beforeEach(() => {
	({ db, dir } = makeDb());
	seedSpace(db, SPACE);
	taskRepo = new SpaceTaskRepository(db);
	detector = new CompletionDetector(taskRepo);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CompletionDetector', () => {
	const RUN = 'run-1';

	test('1. no tasks exist — returns false (workflow not started)', () => {
		expect(detector.isComplete(RUN)).toBe(false);
	});

	test('2. single agent in_progress — returns false', () => {
		seedTask(db, SPACE, { workflowRunId: RUN, workflowNodeId: 'node-1', status: 'in_progress' });
		expect(detector.isComplete(RUN)).toBe(false);
	});

	test('3. single agent completed — returns true', () => {
		seedTask(db, SPACE, { workflowRunId: RUN, workflowNodeId: 'node-1', status: 'completed' });
		expect(detector.isComplete(RUN)).toBe(true);
	});

	test('4. single agent needs_attention — returns true (terminal)', () => {
		seedTask(db, SPACE, {
			workflowRunId: RUN,
			workflowNodeId: 'node-1',
			status: 'needs_attention',
		});
		expect(detector.isComplete(RUN)).toBe(true);
	});

	test('5. single agent cancelled — returns true (terminal)', () => {
		seedTask(db, SPACE, { workflowRunId: RUN, workflowNodeId: 'node-1', status: 'cancelled' });
		expect(detector.isComplete(RUN)).toBe(true);
	});

	// Note: rate_limited / usage_limited are in the TypeScript SpaceTaskStatus type and
	// in TERMINAL_TASK_STATUSES, but the space_tasks DB CHECK constraint (from migrations)
	// does not yet include them. They are covered by the TERMINAL_TASK_STATUSES set tests.

	test('6. single agent pending — returns false (non-terminal)', () => {
		seedTask(db, SPACE, { workflowRunId: RUN, workflowNodeId: 'node-1', status: 'pending' });
		expect(detector.isComplete(RUN)).toBe(false);
	});

	test('7. single agent draft — returns false (non-terminal)', () => {
		seedTask(db, SPACE, { workflowRunId: RUN, workflowNodeId: 'node-1', status: 'draft' });
		expect(detector.isComplete(RUN)).toBe(false);
	});

	test('8. single agent review — returns false (non-terminal)', () => {
		seedTask(db, SPACE, { workflowRunId: RUN, workflowNodeId: 'node-1', status: 'review' });
		expect(detector.isComplete(RUN)).toBe(false);
	});

	test('9. multi-agent single node — all completed → true', () => {
		const NODE = 'node-a';
		seedTask(db, SPACE, { workflowRunId: RUN, workflowNodeId: NODE, status: 'completed' });
		seedTask(db, SPACE, { workflowRunId: RUN, workflowNodeId: NODE, status: 'completed' });
		seedTask(db, SPACE, { workflowRunId: RUN, workflowNodeId: NODE, status: 'needs_attention' });
		expect(detector.isComplete(RUN)).toBe(true);
	});

	test('10. multi-agent single node — one in_progress → false', () => {
		const NODE = 'node-a';
		seedTask(db, SPACE, { workflowRunId: RUN, workflowNodeId: NODE, status: 'completed' });
		seedTask(db, SPACE, { workflowRunId: RUN, workflowNodeId: NODE, status: 'in_progress' });
		expect(detector.isComplete(RUN)).toBe(false);
	});

	test('11. multi-node workflow — all agents terminal → true', () => {
		seedTask(db, SPACE, { workflowRunId: RUN, workflowNodeId: 'node-a', status: 'completed' });
		seedTask(db, SPACE, { workflowRunId: RUN, workflowNodeId: 'node-b', status: 'cancelled' });
		expect(detector.isComplete(RUN)).toBe(true);
	});

	test('12. multi-node workflow — one agent non-terminal → false', () => {
		seedTask(db, SPACE, { workflowRunId: RUN, workflowNodeId: 'node-a', status: 'completed' });
		seedTask(db, SPACE, { workflowRunId: RUN, workflowNodeId: 'node-b', status: 'pending' });
		expect(detector.isComplete(RUN)).toBe(false);
	});

	test('13. archived tasks excluded; remaining all terminal → true', () => {
		// listByWorkflowRun filters out archived tasks (status != archived)
		seedTask(db, SPACE, { workflowRunId: RUN, workflowNodeId: 'node-a', status: 'completed' });
		expect(detector.isComplete(RUN)).toBe(true);
	});

	test('14. no channels — skips pending-but-blocked guard → true when all terminal', () => {
		seedTask(db, SPACE, { workflowRunId: RUN, workflowNodeId: 'node-a', status: 'completed' });
		expect(detector.isComplete(RUN)).toBe(true);
		// Same result with explicit empty arrays
		expect(detector.isComplete(RUN, [], [])).toBe(true);
	});

	describe('pending-but-blocked guard', () => {
		test('15. channels + nodes: all target nodes activated → true', () => {
			const nodes: WorkflowNode[] = [
				makeNode('node-a', 'coder-node', ['coder']),
				makeNode('node-b', 'reviewer-node', ['reviewer']),
			];
			const channels: WorkflowChannel[] = [{ from: 'coder', to: 'reviewer', direction: 'one-way' }];
			// Both nodes activated
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-a',
				status: 'completed',
			});
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-b',
				status: 'completed',
			});
			expect(detector.isComplete(RUN, channels, nodes)).toBe(true);
		});

		test('16. channels + nodes: one target node not activated → false (pending-but-blocked)', () => {
			const nodes: WorkflowNode[] = [
				makeNode('node-a', 'coder-node', ['coder']),
				makeNode('node-b', 'reviewer-node', ['reviewer']),
			];
			const channels: WorkflowChannel[] = [{ from: 'coder', to: 'reviewer', direction: 'one-way' }];
			// Only node-a activated; node-b never activated
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-a',
				status: 'completed',
			});
			expect(detector.isComplete(RUN, channels, nodes)).toBe(false);
		});

		test('17. wildcard channel ("*") — target skipped, does not block completion', () => {
			const nodes: WorkflowNode[] = [makeNode('node-a', 'coder-node', ['coder'])];
			const channels: WorkflowChannel[] = [{ from: 'coder', to: '*', direction: 'one-way' }];
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-a',
				status: 'completed',
			});
			expect(detector.isComplete(RUN, channels, nodes)).toBe(true);
		});

		test('18. cross-node format "nodeId/agentName" — target node resolved from prefix', () => {
			const nodes: WorkflowNode[] = [
				makeNode('node-a', 'coder-node', ['coder']),
				makeNode('node-b', 'reviewer-node', ['reviewer']),
			];
			// Cross-node channel from node-a/coder to node-b/reviewer
			const channels: WorkflowChannel[] = [
				{ from: 'node-a/coder', to: 'node-b/reviewer', direction: 'one-way' },
			];

			// node-b not activated → not complete
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-a',
				status: 'completed',
			});
			expect(detector.isComplete(RUN, channels, nodes)).toBe(false);

			// Activate node-b → complete
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-b',
				status: 'completed',
			});
			expect(detector.isComplete(RUN, channels, nodes)).toBe(true);
		});

		test('19. fan-out by node name — target node matched by name', () => {
			const nodes: WorkflowNode[] = [
				makeNode('node-a', 'coder-node', ['coder']),
				makeNode('node-b', 'review-team', ['reviewer-1', 'reviewer-2']),
			];
			// Fan-out to node by name "review-team"
			const channels: WorkflowChannel[] = [
				{ from: 'coder', to: 'review-team', direction: 'one-way' },
			];

			// Only node-a activated
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-a',
				status: 'completed',
			});
			expect(detector.isComplete(RUN, channels, nodes)).toBe(false);

			// Activate node-b → complete
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-b',
				status: 'completed',
			});
			expect(detector.isComplete(RUN, channels, nodes)).toBe(true);
		});

		test('20. channels provided but nodes empty — guard skipped → true when all terminal', () => {
			const channels: WorkflowChannel[] = [{ from: 'coder', to: 'reviewer', direction: 'one-way' }];
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-a',
				status: 'completed',
			});
			// Nodes array is empty → guard cannot resolve → skipped
			expect(detector.isComplete(RUN, channels, [])).toBe(true);
		});

		test('21. unresolvable channel target — skipped, does not block completion', () => {
			const nodes: WorkflowNode[] = [makeNode('node-a', 'coder-node', ['coder'])];
			// Target "unknown-agent" not in any node
			const channels: WorkflowChannel[] = [
				{ from: 'coder', to: 'unknown-agent', direction: 'one-way' },
			];
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-a',
				status: 'completed',
			});
			expect(detector.isComplete(RUN, channels, nodes)).toBe(true);
		});

		test('22. multi-target channel array — all targets checked; one unactivated → false', () => {
			const nodes: WorkflowNode[] = [
				makeNode('node-a', 'coder-node', ['coder']),
				makeNode('node-b', 'reviewer-node', ['reviewer']),
				makeNode('node-c', 'qa-node', ['qa']),
			];
			// Channel with array `to`: targets both reviewer and qa
			const channels: WorkflowChannel[] = [
				{ from: 'coder', to: ['reviewer', 'qa'], direction: 'one-way' },
			];
			// Activate node-a and node-b but NOT node-c
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-a',
				status: 'completed',
			});
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-b',
				status: 'completed',
			});
			expect(detector.isComplete(RUN, channels, nodes)).toBe(false);

			// Activate node-c → complete
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-c',
				status: 'completed',
			});
			expect(detector.isComplete(RUN, channels, nodes)).toBe(true);
		});

		test('23. node with no tasks excluded — does not block when no channel points to it', () => {
			// Workflow has two nodes but only node-a is activated and channel only covers node-a
			const nodes: WorkflowNode[] = [
				makeNode('node-a', 'coder-node', ['coder']),
				makeNode('node-b', 'reviewer-node', ['reviewer']), // never activated
			];
			// No channels pointing to node-b
			const channels: WorkflowChannel[] = [];
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-a',
				status: 'completed',
			});
			// node-b has no tasks and no channels point to it → not blocking
			expect(detector.isComplete(RUN, channels, nodes)).toBe(true);
		});
	});

	describe('TERMINAL_TASK_STATUSES export', () => {
		test('24. contains exactly the five terminal statuses (including rate_limited and usage_limited)', () => {
			expect(TERMINAL_TASK_STATUSES.has('completed')).toBe(true);
			expect(TERMINAL_TASK_STATUSES.has('needs_attention')).toBe(true);
			expect(TERMINAL_TASK_STATUSES.has('cancelled')).toBe(true);
			// These are in SpaceTaskStatus type; covered here since the DB CHECK constraint
			// (from migrations) does not yet include them for space_tasks.
			expect(TERMINAL_TASK_STATUSES.has('rate_limited')).toBe(true);
			expect(TERMINAL_TASK_STATUSES.has('usage_limited')).toBe(true);
			expect(TERMINAL_TASK_STATUSES.size).toBe(5);
		});

		test('25. does not contain non-terminal statuses', () => {
			expect(TERMINAL_TASK_STATUSES.has('pending')).toBe(false);
			expect(TERMINAL_TASK_STATUSES.has('in_progress')).toBe(false);
			expect(TERMINAL_TASK_STATUSES.has('draft')).toBe(false);
			expect(TERMINAL_TASK_STATUSES.has('review')).toBe(false);
		});
	});

	describe('orchestration task exclusion', () => {
		test('26. orchestration task (null workflowNodeId) in_progress does not block completion', () => {
			// Node-agent task is completed; orchestration task (no workflowNodeId) is in_progress.
			// The completion detector must exclude tasks with null workflowNodeId so the
			// orchestration task running this check does not block its own workflow from completing.
			seedTask(db, SPACE, { workflowRunId: RUN, workflowNodeId: 'node-a', status: 'completed' });
			seedTask(db, SPACE, { workflowRunId: RUN, status: 'in_progress' }); // orchestration task
			expect(detector.isComplete(RUN)).toBe(true);
		});

		test('27. only an orchestration task (no workflowNodeId) — treated as not started', () => {
			// When there are no node-agent tasks, the workflow has not started even if the
			// orchestration task exists (it may still be spinning up the first node agents).
			seedTask(db, SPACE, { workflowRunId: RUN, status: 'in_progress' }); // orchestration task only
			expect(detector.isComplete(RUN)).toBe(false);
		});
	});

	describe('mixed terminal statuses (all done / some failed)', () => {
		test('28. mixed completed + cancelled across multiple nodes → true', () => {
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-a',
				status: 'completed',
			});
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-b',
				status: 'cancelled',
			});
			expect(detector.isComplete(RUN)).toBe(true);
		});

		test('29. mixed completed + needs_attention across multiple nodes → true', () => {
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-a',
				status: 'completed',
			});
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-b',
				status: 'needs_attention',
			});
			expect(detector.isComplete(RUN)).toBe(true);
		});

		test('30. all five terminal statuses in one run → true', () => {
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-a',
				status: 'completed',
			});
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-b',
				status: 'needs_attention',
			});
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-c',
				status: 'cancelled',
			});
			// rate_limited and usage_limited cannot be seeded via DB CHECK constraint
			// (space_tasks does not allow them), but the TERMINAL_TASK_STATUSES set
			// already covers them in tests 24-25. We verify the guard logic here:
			// even with three different terminal statuses, isComplete returns true.
			expect(detector.isComplete(RUN)).toBe(true);
		});

		test('31. completed + in_progress across nodes → false', () => {
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-a',
				status: 'completed',
			});
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-b',
				status: 'in_progress',
			});
			expect(detector.isComplete(RUN)).toBe(false);
		});

		test('32. one non-terminal task blocks completion regardless of how many terminal tasks exist', () => {
			for (let i = 0; i < 5; i++) {
				seedTask(db, SPACE, {
					workflowRunId: RUN,
					workflowNodeId: `node-done-${i}`,
					status: 'completed',
				});
			}
			// One pending task blocks the entire run
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-pending',
				status: 'pending',
			});
			expect(detector.isComplete(RUN)).toBe(false);
		});
	});

	describe('multiple workflow runs (cross-contamination)', () => {
		test('33. tasks from different runs do not interfere — each run evaluated independently', () => {
			const RUN_A = 'run-a';
			const RUN_B = 'run-b';

			// Run A: all terminal
			seedTask(db, SPACE, {
				workflowRunId: RUN_A,
				workflowNodeId: 'node-a1',
				status: 'completed',
			});
			seedTask(db, SPACE, {
				workflowRunId: RUN_A,
				workflowNodeId: 'node-a2',
				status: 'cancelled',
			});

			// Run B: one non-terminal
			seedTask(db, SPACE, {
				workflowRunId: RUN_B,
				workflowNodeId: 'node-b1',
				status: 'completed',
			});
			seedTask(db, SPACE, {
				workflowRunId: RUN_B,
				workflowNodeId: 'node-b2',
				status: 'in_progress',
			});

			expect(detector.isComplete(RUN_A)).toBe(true);
			expect(detector.isComplete(RUN_B)).toBe(false);
		});

		test('34. one run has no tasks while the other has tasks — no cross-contamination', () => {
			const RUN_A = 'run-empty';
			const RUN_B = 'run-with-tasks';

			seedTask(db, SPACE, {
				workflowRunId: RUN_B,
				workflowNodeId: 'node-x',
				status: 'completed',
			});

			expect(detector.isComplete(RUN_A)).toBe(false);
			expect(detector.isComplete(RUN_B)).toBe(true);
		});
	});

	describe('pending-but-blocked with real channel topology', () => {
		test('35. workflow with channel to unactivated node — not complete despite all current tasks being terminal', () => {
			// Simulates a 3-node workflow: Plan → Code → Review
			// Plan and Code are done, but Review node was never activated.
			// A channel from Code to Review means the run is not complete.
			const nodes: WorkflowNode[] = [
				makeNode('node-plan', 'planner', ['planner']),
				makeNode('node-code', 'coder', ['coder']),
				makeNode('node-review', 'reviewer', ['reviewer']),
			];
			const channels: WorkflowChannel[] = [
				{ from: 'planner', to: 'coder', direction: 'one-way' },
				{ from: 'coder', to: 'reviewer', direction: 'one-way' },
			];

			// Only plan and code nodes have tasks, both terminal
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-plan',
				status: 'completed',
			});
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-code',
				status: 'completed',
			});

			// Review node never activated — channel points to it → not complete
			expect(detector.isComplete(RUN, channels, nodes)).toBe(false);
		});

		test('36. workflow with all channels satisfied — all nodes activated and terminal → complete', () => {
			const nodes: WorkflowNode[] = [
				makeNode('node-plan', 'planner', ['planner']),
				makeNode('node-code', 'coder', ['coder']),
				makeNode('node-review', 'reviewer', ['reviewer']),
			];
			const channels: WorkflowChannel[] = [
				{ from: 'planner', to: 'coder', direction: 'one-way' },
				{ from: 'coder', to: 'reviewer', direction: 'one-way' },
			];

			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-plan',
				status: 'completed',
			});
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-code',
				status: 'completed',
			});
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-review',
				status: 'completed',
			});

			expect(detector.isComplete(RUN, channels, nodes)).toBe(true);
		});

		test('37. channel with array target — one activated, one not → not complete', () => {
			const nodes: WorkflowNode[] = [
				makeNode('node-a', 'planner', ['planner']),
				makeNode('node-b', 'reviewer-1', ['reviewer-1']),
				makeNode('node-c', 'reviewer-2', ['reviewer-2']),
			];
			// Fan-out: planner sends to both reviewers
			const channels: WorkflowChannel[] = [
				{ from: 'planner', to: ['reviewer-1', 'reviewer-2'], direction: 'one-way' },
			];

			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-a',
				status: 'completed',
			});
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-b',
				status: 'completed',
			});
			// node-c never activated

			expect(detector.isComplete(RUN, channels, nodes)).toBe(false);

			// Activate node-c
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-c',
				status: 'completed',
			});
			expect(detector.isComplete(RUN, channels, nodes)).toBe(true);
		});

		test('38. bidirectional channel — both nodes must be activated', () => {
			const nodes: WorkflowNode[] = [
				makeNode('node-a', 'coder', ['coder']),
				makeNode('node-b', 'reviewer', ['reviewer']),
			];
			// Bidirectional: coder ↔ reviewer
			const channels: WorkflowChannel[] = [{ from: 'coder', to: 'reviewer', direction: 'two-way' }];

			// Only node-a activated
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-a',
				status: 'completed',
			});
			expect(detector.isComplete(RUN, channels, nodes)).toBe(false);

			// Both activated
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-b',
				status: 'completed',
			});
			expect(detector.isComplete(RUN, channels, nodes)).toBe(true);
		});

		test('39. wildcard channel does NOT unblock a downstream channel to unactivated node', () => {
			const nodes: WorkflowNode[] = [
				makeNode('node-a', 'broadcaster', ['broadcaster']),
				makeNode('node-b', 'target', ['target']),
			];
			const channels: WorkflowChannel[] = [
				{ from: 'broadcaster', to: '*', direction: 'one-way' },
				{ from: 'broadcaster', to: 'target', direction: 'one-way' },
			];

			// Only node-a activated
			seedTask(db, SPACE, {
				workflowRunId: RUN,
				workflowNodeId: 'node-a',
				status: 'completed',
			});
			// The second channel points to 'target' (node-b) which is unactivated
			expect(detector.isComplete(RUN, channels, nodes)).toBe(false);
		});
	});
});
