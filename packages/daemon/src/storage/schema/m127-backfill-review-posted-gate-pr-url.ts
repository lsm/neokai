/**
 * Migration 127 — Backfill `pr_url` field onto existing `review-posted-gate` definitions.
 *
 * Context: the built-in Coding Workflow's `review-posted-gate` previously declared
 * only a `review_url` field. The gate script needs a clean PR URL to verify reviews
 * via `gh pr view`, but `review_url` is often a review permalink (with
 * `#pullrequestreview-...`) that `gh` may not handle correctly. The fix adds `pr_url`
 * as a second field on the gate, but `seedBuiltInWorkflows` does NOT re-stamp `gates`
 * on existing rows — it only updates `completionAutonomyLevel`, `postApproval`,
 * `templateHash`, and `toolGuards`. Without this migration, existing spaces keep the
 * stale single-field gate definition forever.
 *
 * What this migration does:
 *   For each `space_workflows` row whose `gates` JSON contains a `review-posted-gate`
 *   with a `review_url` field but no `pr_url` field, insert `pr_url` as an additional
 *   field with the same shape (type: 'string', writers: ['Review'], check: exists).
 *   Gates that lack `review_url` are left untouched — the migration only handles the
 *   expected historical shape.
 *
 * Self-contained by design — migrations must not depend on runtime app logic that may
 * drift over time. The gate shape is inlined here so the migration's behaviour is
 * frozen at the time it was authored.
 *
 * Idempotent: re-running on a DB whose gates already have `pr_url` is a no-op.
 */

import type { Database as BunDatabase } from 'bun:sqlite';

// ---------------------------------------------------------------------------
// Frozen gate field shape — matches the built-in-workflows.ts definition at
// the time M127 was authored.
// ---------------------------------------------------------------------------

const PR_URL_FIELD: GateField = {
	name: 'pr_url',
	type: 'string',
	writers: ['Review'],
	check: { op: 'exists' },
};

interface GateField {
	name: string;
	type: string;
	writers: string[];
	check:
		| { op: string }
		| { op: string; value?: unknown }
		| { op: string; match: string; min: number };
}

interface Gate {
	id?: string;
	fields?: GateField[];
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function tableExists(db: BunDatabase, tableName: string): boolean {
	const result = db
		.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
		.get(tableName);
	return !!result;
}

// ---------------------------------------------------------------------------
// Migration entrypoint
// ---------------------------------------------------------------------------

export function runMigration127(db: BunDatabase): void {
	if (!tableExists(db, 'space_workflows')) return;

	// Select rows that have a non-null gates column.
	const rows = db
		.prepare(`SELECT id, gates FROM space_workflows WHERE gates IS NOT NULL`)
		.all() as Array<{ id: string; gates: string | null }>;

	const update = db.prepare(`UPDATE space_workflows SET gates = ? WHERE id = ?`);

	for (const row of rows) {
		if (!row.gates) continue;

		let parsed: Gate[];
		try {
			parsed = JSON.parse(row.gates) as Gate[];
		} catch {
			continue; // skip unparseable JSON
		}
		if (!Array.isArray(parsed)) continue;

		let modified = false;

		for (const gate of parsed) {
			if (gate.id !== 'review-posted-gate') continue;
			if (!Array.isArray(gate.fields)) continue;

			// Already has pr_url — skip this gate
			const hasPrUrl = gate.fields.some((f) => f.name === 'pr_url');
			if (hasPrUrl) continue;

			// Insert pr_url before review_url so the script's `.pr_url // .review_url`
			// jq fallback reads pr_url first when both are present.
			const reviewUrlIndex = gate.fields.findIndex((f) => f.name === 'review_url');
			if (reviewUrlIndex === -1) continue; // unexpected shape — leave alone
			gate.fields.splice(reviewUrlIndex, 0, { ...PR_URL_FIELD });
			modified = true;
		}

		if (modified) {
			update.run(JSON.stringify(parsed), row.id);
		}
	}
}
