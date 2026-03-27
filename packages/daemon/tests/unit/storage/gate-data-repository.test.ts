/**
 * GateDataRepository Unit Tests
 *
 * Covers:
 *   - CRUD operations: get, set, merge, delete
 *   - Batch operations: listByRun, deleteByRun, initializeForRun
 *   - Persistence round-trip: data survives close/reopen
 *   - Reset: resetOnCycle behavior
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { GateDataRepository } from '../../../src/storage/repositories/gate-data-repository.ts';
import { createSpaceTables } from '../helpers/space-test-db.ts';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let db: Database;
let repo: GateDataRepository;

const RUN_ID = 'run-001';
const GATE_ID_A = 'gate-a';
const GATE_ID_B = 'gate-b';

function freshDb(): Database {
	const d = new Database(':memory:');
	createSpaceTables(d);
	// Insert required parent rows for FK constraints
	const now = Date.now();
	d.exec(
		`INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES ('sp1', 'sp1', '/tmp/test', 'Test Space', ${now}, ${now})`
	);
	d.exec(
		`INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES ('wf1', 'sp1', 'Test Workflow', ${now}, ${now})`
	);
	d.exec(
		`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, iteration_count, max_iterations, created_at, updated_at) VALUES ('${RUN_ID}', 'sp1', 'wf1', 'Test Run', 'in_progress', 0, 5, ${now}, ${now})`
	);
	return d;
}

beforeEach(() => {
	db = freshDb();
	repo = new GateDataRepository(db);
});

// ---------------------------------------------------------------------------
// get / set
// ---------------------------------------------------------------------------

describe('GateDataRepository — get/set', () => {
	test('returns null for non-existent gate data', () => {
		const result = repo.get(RUN_ID, GATE_ID_A);
		expect(result).toBeNull();
	});

	test('set creates new record and get retrieves it', () => {
		const data = { approved: true, count: 3 };
		repo.set(RUN_ID, GATE_ID_A, data);

		const record = repo.get(RUN_ID, GATE_ID_A);
		expect(record).not.toBeNull();
		expect(record!.runId).toBe(RUN_ID);
		expect(record!.gateId).toBe(GATE_ID_A);
		expect(record!.data).toEqual(data);
		expect(typeof record!.updatedAt).toBe('number');
	});

	test('set upserts existing record', () => {
		repo.set(RUN_ID, GATE_ID_A, { count: 1 });
		repo.set(RUN_ID, GATE_ID_A, { count: 5, extra: true });

		const record = repo.get(RUN_ID, GATE_ID_A);
		expect(record!.data).toEqual({ count: 5, extra: true });
	});

	test('different gate IDs are independent', () => {
		repo.set(RUN_ID, GATE_ID_A, { a: 1 });
		repo.set(RUN_ID, GATE_ID_B, { b: 2 });

		expect(repo.get(RUN_ID, GATE_ID_A)!.data).toEqual({ a: 1 });
		expect(repo.get(RUN_ID, GATE_ID_B)!.data).toEqual({ b: 2 });
	});
});

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

describe('GateDataRepository — merge', () => {
	test('creates record if none exists', () => {
		const result = repo.merge(RUN_ID, GATE_ID_A, { approved: true });
		expect(result.data).toEqual({ approved: true });
		expect(repo.get(RUN_ID, GATE_ID_A)!.data).toEqual({ approved: true });
	});

	test('merges partial data into existing record', () => {
		repo.set(RUN_ID, GATE_ID_A, { count: 1, name: 'test' });
		repo.merge(RUN_ID, GATE_ID_A, { count: 2, extra: true });

		const record = repo.get(RUN_ID, GATE_ID_A);
		expect(record!.data).toEqual({ count: 2, name: 'test', extra: true });
	});
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe('GateDataRepository — delete', () => {
	test('delete removes a specific gate data record', () => {
		repo.set(RUN_ID, GATE_ID_A, { a: 1 });
		repo.set(RUN_ID, GATE_ID_B, { b: 2 });

		const deleted = repo.delete(RUN_ID, GATE_ID_A);
		expect(deleted).toBe(true);
		expect(repo.get(RUN_ID, GATE_ID_A)).toBeNull();
		expect(repo.get(RUN_ID, GATE_ID_B)).not.toBeNull();
	});

	test('delete returns false for non-existent record', () => {
		const deleted = repo.delete(RUN_ID, 'no-such-gate');
		expect(deleted).toBe(false);
	});

	test('deleteByRun removes all gate data for a run', () => {
		repo.set(RUN_ID, GATE_ID_A, { a: 1 });
		repo.set(RUN_ID, GATE_ID_B, { b: 2 });

		const count = repo.deleteByRun(RUN_ID);
		expect(count).toBe(2);
		expect(repo.listByRun(RUN_ID)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// listByRun
// ---------------------------------------------------------------------------

describe('GateDataRepository — listByRun', () => {
	test('returns empty array when no data exists', () => {
		expect(repo.listByRun(RUN_ID)).toEqual([]);
	});

	test('lists all gate data for a run, ordered by gate_id', () => {
		repo.set(RUN_ID, 'gate-z', { z: 1 });
		repo.set(RUN_ID, 'gate-a', { a: 2 });

		const records = repo.listByRun(RUN_ID);
		expect(records).toHaveLength(2);
		expect(records[0].gateId).toBe('gate-a');
		expect(records[1].gateId).toBe('gate-z');
	});
});

// ---------------------------------------------------------------------------
// initializeForRun
// ---------------------------------------------------------------------------

describe('GateDataRepository — initializeForRun', () => {
	test('initializes gate data with defaults', () => {
		repo.initializeForRun(RUN_ID, [
			{ id: GATE_ID_A, data: { approved: false } },
			{ id: GATE_ID_B, data: { count: 0 } },
		]);

		expect(repo.get(RUN_ID, GATE_ID_A)!.data).toEqual({ approved: false });
		expect(repo.get(RUN_ID, GATE_ID_B)!.data).toEqual({ count: 0 });
	});

	test('does not overwrite existing data (INSERT OR IGNORE)', () => {
		repo.set(RUN_ID, GATE_ID_A, { approved: true });

		repo.initializeForRun(RUN_ID, [{ id: GATE_ID_A, data: { approved: false } }]);

		// Should keep the existing data, not overwrite with default
		expect(repo.get(RUN_ID, GATE_ID_A)!.data).toEqual({ approved: true });
	});
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe('GateDataRepository — reset', () => {
	test('resets gate data to defaults', () => {
		repo.set(RUN_ID, GATE_ID_A, { approved: true, extra: 'value' });

		const result = repo.reset(RUN_ID, GATE_ID_A, { approved: false });
		expect(result.data).toEqual({ approved: false });
		expect(repo.get(RUN_ID, GATE_ID_A)!.data).toEqual({ approved: false });
	});
});

// ---------------------------------------------------------------------------
// Persistence round-trip
// ---------------------------------------------------------------------------

describe('GateDataRepository — persistence', () => {
	test('data persists across repository instances (same db)', () => {
		repo.set(RUN_ID, GATE_ID_A, { persistent: true, value: 42 });

		// Create a new repository instance pointing to the same DB
		const repo2 = new GateDataRepository(db);
		const record = repo2.get(RUN_ID, GATE_ID_A);
		expect(record).not.toBeNull();
		expect(record!.data).toEqual({ persistent: true, value: 42 });
	});
});

// ---------------------------------------------------------------------------
// Gate data corruption recovery (M9.4)
// ---------------------------------------------------------------------------

describe('GateDataRepository — corruption recovery', () => {
	test('get() returns {} when stored JSON is corrupted', () => {
		// Directly insert corrupted JSON bypassing the repository write path
		const now = Date.now();
		db.prepare(`INSERT INTO gate_data (run_id, gate_id, data, updated_at) VALUES (?, ?, ?, ?)`).run(
			RUN_ID,
			'gate-corrupted',
			'NOT_VALID_JSON{{{',
			now
		);

		// Should not throw — instead returns record with empty data
		const record = repo.get(RUN_ID, 'gate-corrupted');
		expect(record).not.toBeNull();
		expect(record!.data).toEqual({});
		expect(record!.gateId).toBe('gate-corrupted');
	});

	test('listByRun() returns {} for each corrupted gate and valid data for healthy ones', () => {
		const now = Date.now();
		// Corrupted gate
		db.prepare(`INSERT INTO gate_data (run_id, gate_id, data, updated_at) VALUES (?, ?, ?, ?)`).run(
			RUN_ID,
			'gate-bad',
			'[[invalid',
			now
		);
		// Healthy gate
		repo.set(RUN_ID, GATE_ID_A, { approved: true });

		const records = repo.listByRun(RUN_ID);
		const badRecord = records.find((r) => r.gateId === 'gate-bad');
		const goodRecord = records.find((r) => r.gateId === GATE_ID_A);

		expect(badRecord).not.toBeUndefined();
		expect(badRecord!.data).toEqual({}); // corruption reset to {}

		expect(goodRecord).not.toBeUndefined();
		expect(goodRecord!.data).toEqual({ approved: true }); // healthy data intact
	});

	test('corrupted gate data does not block gate evaluation (empty {} keeps gate closed)', () => {
		// When JSON is corrupted, reset to {} means:
		// - A "check: exists" gate stays CLOSED (field doesn't exist in {})
		// - This is the safe/secure default — no accidental gate opening
		const now = Date.now();
		db.prepare(`INSERT INTO gate_data (run_id, gate_id, data, updated_at) VALUES (?, ?, ?, ?)`).run(
			RUN_ID,
			'gate-human-approval',
			'CORRUPT_DATA',
			now
		);

		const record = repo.get(RUN_ID, 'gate-human-approval');
		expect(record!.data).toEqual({}); // safe fallback
		// Verify that {} means no "approved" key — gate stays closed
		expect(record!.data['approved']).toBeUndefined();
	});

	test('set() after corrupted read writes valid JSON', () => {
		// Even if a record was corrupted, a subsequent set() should write valid data
		const now = Date.now();
		db.prepare(`INSERT INTO gate_data (run_id, gate_id, data, updated_at) VALUES (?, ?, ?, ?)`).run(
			RUN_ID,
			'gate-recoverable',
			'BAD_JSON',
			now
		);

		// set() overwrites corrupted data with valid JSON
		repo.set(RUN_ID, 'gate-recoverable', { approved: true });

		const record = repo.get(RUN_ID, 'gate-recoverable');
		expect(record!.data).toEqual({ approved: true });
	});
});
