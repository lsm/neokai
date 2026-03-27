/**
 * Gate Data Repository
 *
 * Persistence layer for gate runtime data, keyed by `(run_id, gate_id)`.
 * Gate data is a JSON key-value store that gate conditions evaluate against.
 * Agents write to gate data via MCP tools; the runtime reads it to decide
 * whether a gated channel is open.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { Logger } from '../../lib/logger';

const log = new Logger('gate-data-repository');

/** A single gate data record as returned by the repository. */
export interface GateDataRecord {
	runId: string;
	gateId: string;
	data: Record<string, unknown>;
	updatedAt: number;
}

export class GateDataRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Get gate data for a specific `(run_id, gate_id)` pair.
	 * Returns null when no data has been written for this gate in this run.
	 */
	get(runId: string, gateId: string): GateDataRecord | null {
		const row = this.db
			.prepare('SELECT * FROM gate_data WHERE run_id = ? AND gate_id = ?')
			.get(runId, gateId) as Record<string, unknown> | undefined;
		if (!row) return null;
		return this.rowToRecord(row);
	}

	/**
	 * Get all gate data records for a workflow run.
	 */
	listByRun(runId: string): GateDataRecord[] {
		const rows = this.db
			.prepare('SELECT * FROM gate_data WHERE run_id = ? ORDER BY gate_id')
			.all(runId) as Record<string, unknown>[];
		return rows.map((r) => this.rowToRecord(r));
	}

	/**
	 * Upsert gate data for a `(run_id, gate_id)` pair.
	 * Replaces the entire data object — callers must merge before calling.
	 */
	set(runId: string, gateId: string, data: Record<string, unknown>): GateDataRecord {
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO gate_data (run_id, gate_id, data, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(run_id, gate_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
			)
			.run(runId, gateId, JSON.stringify(data), now);

		return { runId, gateId, data, updatedAt: now };
	}

	/**
	 * Merge partial data into an existing gate data record.
	 * Creates the record with the provided partial data if it does not exist.
	 *
	 * **Shallow merge only**: top-level keys in `partial` overwrite existing keys.
	 * Nested objects are replaced wholesale, not merged recursively.
	 * Example: merging `{ nested: { b: 2 } }` into `{ nested: { a: 1 } }`
	 * yields `{ nested: { b: 2 } }` — `a` is lost.
	 */
	merge(runId: string, gateId: string, partial: Record<string, unknown>): GateDataRecord {
		const existing = this.get(runId, gateId);
		const merged = existing ? { ...existing.data, ...partial } : { ...partial };
		return this.set(runId, gateId, merged);
	}

	/**
	 * Delete gate data for a specific `(run_id, gate_id)` pair.
	 * Returns true if a record was deleted.
	 */
	delete(runId: string, gateId: string): boolean {
		const result = this.db
			.prepare('DELETE FROM gate_data WHERE run_id = ? AND gate_id = ?')
			.run(runId, gateId);
		return result.changes > 0;
	}

	/**
	 * Delete all gate data for a workflow run.
	 * Returns the number of records deleted.
	 */
	deleteByRun(runId: string): number {
		const result = this.db.prepare('DELETE FROM gate_data WHERE run_id = ?').run(runId);
		return result.changes;
	}

	/**
	 * Initialize gate data for all gates in a workflow run.
	 * Populates each gate's default data. Skips gates that already have data.
	 */
	initializeForRun(
		runId: string,
		gates: Array<{ id: string; data: Record<string, unknown> }>
	): void {
		const stmt = this.db.prepare(
			`INSERT OR IGNORE INTO gate_data (run_id, gate_id, data, updated_at) VALUES (?, ?, ?, ?)`
		);
		const now = Date.now();
		for (const gate of gates) {
			stmt.run(runId, gate.id, JSON.stringify(gate.data), now);
		}
	}

	/**
	 * Reset a gate's data to its defaults.
	 * Used when a cyclic workflow loops back through a gate with `resetOnCycle: true`.
	 */
	reset(runId: string, gateId: string, defaultData: Record<string, unknown>): GateDataRecord {
		return this.set(runId, gateId, defaultData);
	}

	private rowToRecord(row: Record<string, unknown>): GateDataRecord {
		const runId = row.run_id as string;
		const gateId = row.gate_id as string;
		let data: Record<string, unknown> = {};
		const raw = row.data as string;
		try {
			data = JSON.parse(raw) as Record<string, unknown>;
		} catch (err) {
			// Gate data is corrupted — reset to empty object and log so engineers can
			// investigate. Human-approval gates still block correctly: an empty `{}`
			// means no approval key exists, so the gate condition (`check: exists`)
			// remains closed until a human explicitly approves.
			log.error(
				`GateDataRepository: corrupted gate data for run=${runId} gate=${gateId} — ` +
					`JSON.parse failed (${err instanceof Error ? err.message : String(err)}). ` +
					`Resetting to {} to allow gate evaluation to continue.`
			);
			data = {};
		}
		return {
			runId,
			gateId,
			data,
			updatedAt: row.updated_at as number,
		};
	}
}
