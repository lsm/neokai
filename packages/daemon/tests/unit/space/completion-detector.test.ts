/**
 * Unit tests for CompletionDetector
 *
 * Scenarios (32 total):
 *   1.  No executions exist — returns false (workflow not started)
 *   2.  Single execution in_progress — returns false
 *   3.  Single execution done — returns true
 *   4.  Single execution blocked — returns false (non-terminal)
 *   5.  Single execution cancelled — returns true (terminal)
 *   6.  Single execution pending — returns false (non-terminal)
 *   7.  Multi-node workflow — all agents terminal → true
 *   8.  Multi-node workflow — one agent non-terminal → false
 *   9.  Mixed terminal: done + cancelled → true
 *  10.  One non-terminal execution blocks completion regardless of terminal count
 *  11.  done + in_progress → false
 *  12.  Many done + one blocked → false
 *  13.  All executions in_progress → false
 *  14.  All executions blocked → false
 *  15.  pending + in_progress → false
 *  16. Tasks from different workflow runs do not interfere
 *  17.  Empty run vs run with executions — no cross-contamination
 *  18.  done + blocked → false
 *  19.  Multiple terminal (done + cancelled) in one run → true
 *  20.  TERMINAL_NODE_EXECUTION_STATUSES — size=2 (done, cancelled)
 *  21.  TERMINAL_NODE_EXECUTION_STATUSES — does not contain non-terminal statuses
 *  22.  End-node short-circuit: end node done → true (other nodes still running)
 *  23.  End-node short-circuit: end node cancelled → true (other nodes still running)
 *  24.  End-node short-circuit: end node in_progress → false
 *  25.  End-node short-circuit: end node blocked → false
 *  26.  End-node short-circuit: no execution for end node → falls through to all-agents-done
 *  27.  End-node short-circuit: endNodeId not provided → all-agents-done fallback
 *  28.  All-agents-done fallback: all terminal with no endNodeId → true
 *  29.  All-agents-done fallback: some non-terminal with no endNodeId → false
 *  30.  No executions with endNodeId → false
 *  31.  End-node short-circuit: end node pending → false
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { NodeExecutionRepository } from '../../../src/storage/repositories/node-execution-repository.ts';
import { CompletionDetector } from '../../../src/lib/space/runtime/completion-detector.ts';
import { TERMINAL_NODE_EXECUTION_STATUSES } from '../../../src/lib/space/managers/node-execution-manager.ts';

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
	// Disable FK to allow synthetic run IDs without seeding full parent rows.
	db.exec('PRAGMA foreign_keys = OFF');
	return { db, dir };
}

let execCounter = 0;
function seedExecution(
	db: BunDatabase,
	overrides: {
		id?: string;
		workflowRunId?: string;
		workflowNodeId?: string;
		agentName?: string;
		status?: string;
	} = {}
): string {
	const id = overrides.id ?? `exec-${++execCounter}`;
	const now = Date.now();
	db.prepare(
		`INSERT INTO node_executions
	     (id, workflow_run_id, workflow_node_id, agent_name, agent_id,
	      agent_session_id, status, result, created_at, started_at,
	      completed_at, updated_at)
	     VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?, NULL, NULL, ?)`
	).run(
		id,
		overrides.workflowRunId ?? 'run-1',
		overrides.workflowNodeId ?? 'node-1',
		overrides.agentName ?? `agent-${execCounter}`,
		overrides.status ?? 'in_progress',
		now,
		now
	);
	return id;
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

let db: BunDatabase;
let dir: string;
let nodeExecutionRepo: NodeExecutionRepository;
let detector: CompletionDetector;

beforeEach(() => {
	({ db, dir } = makeDb());
	nodeExecutionRepo = new NodeExecutionRepository(db);
	detector = new CompletionDetector(nodeExecutionRepo);
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

	// ---- Basic completion detection ----

	test('1. no executions exist — returns false (workflow not started)', () => {
		expect(detector.isComplete({ workflowRunId: RUN })).toBe(false);
	});

	test('2. single execution in_progress — returns false', () => {
		seedExecution(db, { workflowRunId: RUN, status: 'in_progress' });
		expect(detector.isComplete({ workflowRunId: RUN })).toBe(false);
	});

	test('3. single execution done — returns true', () => {
		seedExecution(db, { workflowRunId: RUN, status: 'done' });
		expect(detector.isComplete({ workflowRunId: RUN })).toBe(true);
	});

	test('4. single execution blocked — returns false (non-terminal)', () => {
		seedExecution(db, { workflowRunId: RUN, status: 'blocked' });
		expect(detector.isComplete({ workflowRunId: RUN })).toBe(false);
	});

	test('5. single execution cancelled — returns true (terminal)', () => {
		seedExecution(db, { workflowRunId: RUN, status: 'cancelled' });
		expect(detector.isComplete({ workflowRunId: RUN })).toBe(true);
	});

	test('6. single execution pending — returns false (non-terminal)', () => {
		seedExecution(db, { workflowRunId: RUN, status: 'pending' });
		expect(detector.isComplete({ workflowRunId: RUN })).toBe(false);
	});

	// ---- Multi-node workflows ----

	test('7. multi-node workflow — all agents terminal → true', () => {
		seedExecution(db, { workflowRunId: RUN, workflowNodeId: 'node-a', status: 'done' });
		seedExecution(db, { workflowRunId: RUN, workflowNodeId: 'node-b', status: 'cancelled' });
		expect(detector.isComplete({ workflowRunId: RUN })).toBe(true);
	});

	test('8. multi-node workflow — one agent non-terminal → false', () => {
		seedExecution(db, { workflowRunId: RUN, workflowNodeId: 'node-a', status: 'done' });
		seedExecution(db, { workflowRunId: RUN, workflowNodeId: 'node-b', status: 'in_progress' });
		expect(detector.isComplete({ workflowRunId: RUN })).toBe(false);
	});

	// ---- Mixed terminal statuses ----

	test('9. mixed done + cancelled → true', () => {
		seedExecution(db, { workflowRunId: RUN, status: 'done' });
		seedExecution(db, { workflowRunId: RUN, status: 'cancelled' });
		expect(detector.isComplete({ workflowRunId: RUN })).toBe(true);
	});

	test('10. one non-terminal execution blocks completion regardless of terminal count', () => {
		for (let i = 0; i < 5; i++) {
			seedExecution(db, { workflowRunId: RUN, status: 'done' });
		}
		seedExecution(db, { workflowRunId: RUN, status: 'blocked' });
		expect(detector.isComplete({ workflowRunId: RUN })).toBe(false);
	});

	test('11. done + in_progress → false', () => {
		seedExecution(db, { workflowRunId: RUN, status: 'done' });
		seedExecution(db, { workflowRunId: RUN, status: 'in_progress' });
		expect(detector.isComplete({ workflowRunId: RUN })).toBe(false);
	});

	test('12. many done + one blocked → false', () => {
		seedExecution(db, { workflowRunId: RUN, status: 'done' });
		seedExecution(db, { workflowRunId: RUN, status: 'done' });
		seedExecution(db, { workflowRunId: RUN, status: 'blocked' });
		expect(detector.isComplete({ workflowRunId: RUN })).toBe(false);
	});

	test('13. all executions in_progress → false', () => {
		seedExecution(db, { workflowRunId: RUN, status: 'in_progress' });
		seedExecution(db, { workflowRunId: RUN, status: 'in_progress' });
		expect(detector.isComplete({ workflowRunId: RUN })).toBe(false);
	});

	test('14. all executions blocked → false', () => {
		seedExecution(db, { workflowRunId: RUN, status: 'blocked' });
		seedExecution(db, { workflowRunId: RUN, status: 'blocked' });
		expect(detector.isComplete({ workflowRunId: RUN })).toBe(false);
	});

	test('15. pending + in_progress → false', () => {
		seedExecution(db, { workflowRunId: RUN, status: 'pending' });
		seedExecution(db, { workflowRunId: RUN, status: 'in_progress' });
		expect(detector.isComplete({ workflowRunId: RUN })).toBe(false);
	});

	test('18. done + blocked → false', () => {
		seedExecution(db, { workflowRunId: RUN, status: 'done' });
		seedExecution(db, { workflowRunId: RUN, status: 'blocked' });
		expect(detector.isComplete({ workflowRunId: RUN })).toBe(false);
	});

	test('19. multiple terminal (done + cancelled) in one run → true', () => {
		seedExecution(db, { workflowRunId: RUN, status: 'done' });
		seedExecution(db, { workflowRunId: RUN, status: 'cancelled' });
		seedExecution(db, { workflowRunId: RUN, status: 'done' });
		expect(detector.isComplete({ workflowRunId: RUN })).toBe(true);
	});

	// ---- Cross-contamination ----

	describe('multiple workflow runs', () => {
		test('16. tasks from different runs do not interfere — each run evaluated independently', () => {
			const RUN_A = 'run-a';
			const RUN_B = 'run-b';

			// Run A: all terminal
			seedExecution(db, { workflowRunId: RUN_A, status: 'done' });
			seedExecution(db, { workflowRunId: RUN_A, status: 'cancelled' });

			// Run B: one non-terminal
			seedExecution(db, { workflowRunId: RUN_B, status: 'done' });
			seedExecution(db, { workflowRunId: RUN_B, status: 'in_progress' });

			expect(detector.isComplete({ workflowRunId: RUN_A })).toBe(true);
			expect(detector.isComplete({ workflowRunId: RUN_B })).toBe(false);
		});

		test('17. one run has no executions while the other has — no cross-contamination', () => {
			const RUN_A = 'run-empty';
			const RUN_B = 'run-with-tasks';

			seedExecution(db, { workflowRunId: RUN_B, status: 'done' });

			expect(detector.isComplete({ workflowRunId: RUN_A })).toBe(false);
			expect(detector.isComplete({ workflowRunId: RUN_B })).toBe(true);
		});
	});

	// ---- TERMINAL_NODE_EXECUTION_STATUSES ----

	describe('TERMINAL_NODE_EXECUTION_STATUSES', () => {
		test('20. contains exactly two statuses: done and cancelled', () => {
			expect(TERMINAL_NODE_EXECUTION_STATUSES.has('done')).toBe(true);
			expect(TERMINAL_NODE_EXECUTION_STATUSES.has('cancelled')).toBe(true);
			expect(TERMINAL_NODE_EXECUTION_STATUSES.size).toBe(2);
		});

		test('21. does not contain non-terminal statuses', () => {
			expect(TERMINAL_NODE_EXECUTION_STATUSES.has('pending')).toBe(false);
			expect(TERMINAL_NODE_EXECUTION_STATUSES.has('in_progress')).toBe(false);
			expect(TERMINAL_NODE_EXECUTION_STATUSES.has('blocked')).toBe(false);
		});

		// ---- End-node short-circuit ----

		describe('end-node short-circuit', () => {
			const END_NODE_ID = 'end-node';

			test('22. end node done → true (other nodes still running)', () => {
				seedExecution(db, {
					workflowRunId: RUN,
					workflowNodeId: 'start-node',
					status: 'in_progress',
				});
				seedExecution(db, {
					workflowRunId: RUN,
					workflowNodeId: END_NODE_ID,
					status: 'done',
				});
				expect(detector.isComplete({ workflowRunId: RUN, endNodeId: END_NODE_ID })).toBe(true);
			});

			test('23. end node cancelled → true (other nodes still running)', () => {
				seedExecution(db, {
					workflowRunId: RUN,
					workflowNodeId: 'start-node',
					status: 'in_progress',
				});
				seedExecution(db, {
					workflowRunId: RUN,
					workflowNodeId: END_NODE_ID,
					status: 'cancelled',
				});
				expect(detector.isComplete({ workflowRunId: RUN, endNodeId: END_NODE_ID })).toBe(true);
			});

			test('24. end node in_progress → false', () => {
				seedExecution(db, { workflowRunId: RUN, workflowNodeId: 'start-node', status: 'done' });
				seedExecution(db, {
					workflowRunId: RUN,
					workflowNodeId: END_NODE_ID,
					status: 'in_progress',
				});
				expect(detector.isComplete({ workflowRunId: RUN, endNodeId: END_NODE_ID })).toBe(false);
			});

			test('25. end node blocked → false', () => {
				seedExecution(db, { workflowRunId: RUN, workflowNodeId: 'start-node', status: 'done' });
				seedExecution(db, {
					workflowRunId: RUN,
					workflowNodeId: END_NODE_ID,
					status: 'blocked',
				});
				expect(detector.isComplete({ workflowRunId: RUN, endNodeId: END_NODE_ID })).toBe(false);
			});

			test('26. no execution for end node → falls through to all-agents-done', () => {
				// Only a start-node execution exists; end node has none.
				seedExecution(db, { workflowRunId: RUN, workflowNodeId: 'start-node', status: 'done' });
				expect(detector.isComplete({ workflowRunId: RUN, endNodeId: END_NODE_ID })).toBe(true); // Falls through: all executions are terminal
			});

			test('27. endNodeId not provided → all-agents-done fallback', () => {
				seedExecution(db, { workflowRunId: RUN, workflowNodeId: END_NODE_ID, status: 'done' });
				expect(detector.isComplete({ workflowRunId: RUN })).toBe(true);
			});

			test('28. no executions with endNodeId → false', () => {
				expect(detector.isComplete({ workflowRunId: RUN, endNodeId: END_NODE_ID })).toBe(false);
			});

			test('29. end node pending → false', () => {
				seedExecution(db, { workflowRunId: RUN, workflowNodeId: 'start-node', status: 'done' });
				seedExecution(db, {
					workflowRunId: RUN,
					workflowNodeId: END_NODE_ID,
					status: 'pending',
				});
				expect(detector.isComplete({ workflowRunId: RUN, endNodeId: END_NODE_ID })).toBe(false);
			});
		});

		// ---- All-agents-done fallback (no endNodeId) ----

		describe('all-agents-done fallback', () => {
			test('30. all terminal with no endNodeId → true', () => {
				seedExecution(db, { workflowRunId: RUN, workflowNodeId: 'node-a', status: 'done' });
				seedExecution(db, { workflowRunId: RUN, workflowNodeId: 'node-b', status: 'cancelled' });
				expect(detector.isComplete({ workflowRunId: RUN })).toBe(true);
			});

			test('31. some non-terminal with no endNodeId → false', () => {
				seedExecution(db, { workflowRunId: RUN, workflowNodeId: 'node-a', status: 'done' });
				seedExecution(db, { workflowRunId: RUN, workflowNodeId: 'node-b', status: 'blocked' });
				expect(detector.isComplete({ workflowRunId: RUN })).toBe(false);
			});
		});
	});
});
