/**
 * Migration 127 Tests — Backfill `pr_url` field onto existing `review-posted-gate` definitions.
 *
 * Migration 127 walks every `space_workflows` row with a non-null `gates` column
 * and, when a gate has `id === 'review-posted-gate'` with only a `review_url`
 * field (no `pr_url`), inserts `pr_url` as an additional field.
 *
 * Covers:
 *   - Gate with only `review_url` → `pr_url` inserted before `review_url`
 *   - Gate already has `pr_url` → idempotent (no change)
 *   - Multiple workflows — only matching gates are touched
 *   - Workflow without `review-posted-gate` → untouched
 *   - Workflow with null gates → skipped
 *   - Gate with no fields array → skipped
 *   - Re-running migration is a no-op
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration127 } from '../../../../../src/storage/schema/migrations.ts';

interface WorkflowRow {
	id: string;
	gates: string | null;
}

function insertSpace(db: BunDatabase, id: string): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(id, id, `/ws/${id}`, id, now, now);
}

function insertWorkflow(
	db: BunDatabase,
	opts: {
		id: string;
		spaceId: string;
		name: string;
		gates?: unknown[] | null;
	}
): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO space_workflows (
			id, space_id, name, description, start_node_id, end_node_id,
			channels, gates, created_at, updated_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		opts.id,
		opts.spaceId,
		opts.name,
		'',
		'node-start',
		'node-end',
		'[]',
		opts.gates ? JSON.stringify(opts.gates) : null,
		now,
		now
	);
}

function readWorkflow(db: BunDatabase, id: string): WorkflowRow | undefined {
	return db.prepare(`SELECT id, gates FROM space_workflows WHERE id = ?`).get(id) as
		| WorkflowRow
		| undefined;
}

describe('Migration 127: backfill pr_url onto review-posted-gate', () => {
	let testDir: string;
	let db: BunDatabase;

	beforeEach(() => {
		testDir = join(
			process.cwd(),
			'tmp',
			'test-migration-127',
			`test-${Date.now()}-${Math.random()}`
		);
		mkdirSync(testDir, { recursive: true });
		db = new BunDatabase(join(testDir, 'test.db'));
		db.exec('PRAGMA foreign_keys = ON');
		runMigrations(db, () => {});
		insertSpace(db, 'sp-1');
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			// ignore
		}
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	test('gate with only review_url → pr_url inserted before review_url', () => {
		insertWorkflow(db, {
			id: 'wf-1',
			spaceId: 'sp-1',
			name: 'Coding Workflow',
			gates: [
				{
					id: 'code-ready-gate',
					fields: [
						{ name: 'pr_url', type: 'string', writers: ['Coding'], check: { op: 'exists' } },
					],
				},
				{
					id: 'review-posted-gate',
					fields: [
						{ name: 'review_url', type: 'string', writers: ['Review'], check: { op: 'exists' } },
					],
				},
			],
		});

		runMigration127(db);

		const row = readWorkflow(db, 'wf-1')!;
		const gates = JSON.parse(row.gates!);
		expect(gates).toHaveLength(2);

		const reviewGate = gates.find((g: { id: string }) => g.id === 'review-posted-gate');
		expect(reviewGate.fields).toHaveLength(2);
		expect(reviewGate.fields[0].name).toBe('pr_url');
		expect(reviewGate.fields[0].type).toBe('string');
		expect(reviewGate.fields[0].writers).toEqual(['Review']);
		expect(reviewGate.fields[0].check).toEqual({ op: 'exists' });
		expect(reviewGate.fields[1].name).toBe('review_url');
	});

	test('gate already has pr_url → idempotent (no change)', () => {
		const originalGates = [
			{
				id: 'review-posted-gate',
				fields: [
					{ name: 'pr_url', type: 'string', writers: ['Review'], check: { op: 'exists' } },
					{ name: 'review_url', type: 'string', writers: ['Review'], check: { op: 'exists' } },
				],
			},
		];
		insertWorkflow(db, {
			id: 'wf-1',
			spaceId: 'sp-1',
			name: 'Coding Workflow',
			gates: originalGates,
		});

		runMigration127(db);

		const row = readWorkflow(db, 'wf-1')!;
		const gates = JSON.parse(row.gates!);
		expect(gates).toEqual(originalGates);
	});

	test('workflow without review-posted-gate → untouched', () => {
		const originalGates = [
			{
				id: 'code-ready-gate',
				fields: [{ name: 'pr_url', type: 'string', writers: ['Coding'], check: { op: 'exists' } }],
			},
		];
		insertWorkflow(db, {
			id: 'wf-1',
			spaceId: 'sp-1',
			name: 'Research Workflow',
			gates: originalGates,
		});

		runMigration127(db);

		const row = readWorkflow(db, 'wf-1')!;
		const gates = JSON.parse(row.gates!);
		expect(gates).toEqual(originalGates);
	});

	test('workflow with null gates → skipped', () => {
		insertWorkflow(db, {
			id: 'wf-1',
			spaceId: 'sp-1',
			name: 'Custom Workflow',
			gates: null,
		});

		expect(() => runMigration127(db)).not.toThrow();

		const row = readWorkflow(db, 'wf-1')!;
		expect(row.gates).toBeNull();
	});

	test('gate with no fields array → skipped', () => {
		const originalGates = [
			{
				id: 'review-posted-gate',
				// no fields array
			},
		];
		insertWorkflow(db, {
			id: 'wf-1',
			spaceId: 'sp-1',
			name: 'Coding Workflow',
			gates: originalGates,
		});

		runMigration127(db);

		const row = readWorkflow(db, 'wf-1')!;
		const gates = JSON.parse(row.gates!);
		expect(gates).toEqual(originalGates);
	});

	test('gate with fields array but no review_url → left untouched', () => {
		const originalGates = [
			{
				id: 'review-posted-gate',
				fields: [
					{ name: 'other_field', type: 'string', writers: ['Review'], check: { op: 'exists' } },
				],
			},
		];
		insertWorkflow(db, {
			id: 'wf-1',
			spaceId: 'sp-1',
			name: 'Coding Workflow',
			gates: originalGates,
		});

		runMigration127(db);

		const row = readWorkflow(db, 'wf-1')!;
		const gates = JSON.parse(row.gates!);
		expect(gates).toEqual(originalGates);
	});

	test('multiple workflows — only matching gates are touched', () => {
		insertWorkflow(db, {
			id: 'wf-coding',
			spaceId: 'sp-1',
			name: 'Coding Workflow',
			gates: [
				{
					id: 'review-posted-gate',
					fields: [
						{ name: 'review_url', type: 'string', writers: ['Review'], check: { op: 'exists' } },
					],
				},
			],
		});
		insertWorkflow(db, {
			id: 'wf-research',
			spaceId: 'sp-1',
			name: 'Research Workflow',
			gates: [
				{
					id: 'research-ready-gate',
					fields: [{ name: 'pr_url', type: 'string', writers: ['*'], check: { op: 'exists' } }],
				},
			],
		});

		runMigration127(db);

		const codingRow = readWorkflow(db, 'wf-coding')!;
		const codingGates = JSON.parse(codingRow.gates!);
		const reviewGate = codingGates.find((g: { id: string }) => g.id === 'review-posted-gate');
		expect(reviewGate.fields).toHaveLength(2);
		expect(reviewGate.fields[0].name).toBe('pr_url');

		const researchRow = readWorkflow(db, 'wf-research')!;
		const researchGates = JSON.parse(researchRow.gates!);
		expect(researchGates[0].fields).toHaveLength(1);
	});

	test('re-running migration is a no-op', () => {
		insertWorkflow(db, {
			id: 'wf-1',
			spaceId: 'sp-1',
			name: 'Coding Workflow',
			gates: [
				{
					id: 'review-posted-gate',
					fields: [
						{ name: 'review_url', type: 'string', writers: ['Review'], check: { op: 'exists' } },
					],
				},
			],
		});

		runMigration127(db);
		const after1 = readWorkflow(db, 'wf-1')!;

		runMigration127(db);
		const after2 = readWorkflow(db, 'wf-1')!;

		expect(after2.gates).toBe(after1.gates);
	});
});
