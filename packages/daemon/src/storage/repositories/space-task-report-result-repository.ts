/**
 * Space Task Report Result Repository
 *
 * Append-only repository for `space_task_report_results` rows.
 *
 * Each `report_result` tool call creates one row. Never updated; deleted only
 * via ON DELETE CASCADE when the task or space is removed.
 *
 * This table exists so the `report_result` tool can audit what an end-node
 * agent observed without mutating `space_tasks.reported_status` — that field
 * is still the source of truth for whether the task is considered closed,
 * and is only written by `approve_task` (agent self-close) or by the runtime
 * after a human approves a `submit_for_approval` request.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type { SpaceTaskReportResult } from '@neokai/shared';

/** Input for `append()` — the repo generates `id` and `recordedAt`. */
export type AppendSpaceTaskReportResultInput = Omit<SpaceTaskReportResult, 'id' | 'recordedAt'>;

interface ReportResultRow {
	id: string;
	task_id: string;
	space_id: string;
	workflow_node_id: string | null;
	agent_name: string | null;
	summary: string;
	evidence: string | null;
	recorded_at: number;
}

export class SpaceTaskReportResultRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Append a new `report_result` audit row.
	 *
	 * Evidence is stored as a JSON string; null round-trips as SQL NULL.
	 */
	append(input: AppendSpaceTaskReportResultInput): SpaceTaskReportResult {
		const id = generateUUID();
		const recordedAt = Date.now();
		const evidenceJson = input.evidence === null ? null : JSON.stringify(input.evidence);

		this.db
			.prepare(
				`INSERT INTO space_task_report_results
					(id, task_id, space_id, workflow_node_id, agent_name, summary, evidence, recorded_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				input.taskId,
				input.spaceId,
				input.workflowNodeId,
				input.agentName,
				input.summary,
				evidenceJson,
				recordedAt
			);

		return {
			id,
			taskId: input.taskId,
			spaceId: input.spaceId,
			workflowNodeId: input.workflowNodeId,
			agentName: input.agentName,
			summary: input.summary,
			evidence: input.evidence,
			recordedAt,
		};
	}

	/**
	 * List all report results for a task in ascending `recordedAt` order.
	 *
	 * Ordering by `recorded_at ASC, rowid ASC` guarantees that two rows written
	 * in the same millisecond stay in insert order (monotonic rowid tiebreak).
	 */
	listByTask(taskId: string): SpaceTaskReportResult[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM space_task_report_results
				 WHERE task_id = ?
				 ORDER BY recorded_at ASC, rowid ASC`
			)
			.all(taskId) as ReportResultRow[];
		return rows.map((r) => this.rowToRecord(r));
	}

	/**
	 * Return the most recently recorded result for a task, or null if none.
	 */
	getLatestByTask(taskId: string): SpaceTaskReportResult | null {
		const row = this.db
			.prepare(
				`SELECT * FROM space_task_report_results
				 WHERE task_id = ?
				 ORDER BY recorded_at DESC, rowid DESC
				 LIMIT 1`
			)
			.get(taskId) as ReportResultRow | undefined;
		return row ? this.rowToRecord(row) : null;
	}

	private rowToRecord(row: ReportResultRow): SpaceTaskReportResult {
		let evidence: Record<string, unknown> | null = null;
		if (row.evidence !== null) {
			try {
				evidence = JSON.parse(row.evidence) as Record<string, unknown>;
			} catch {
				// Corrupt JSON — surface as null rather than throwing, matching the
				// forgiving pattern used by gate-data-repository.
				evidence = null;
			}
		}
		return {
			id: row.id,
			taskId: row.task_id,
			spaceId: row.space_id,
			workflowNodeId: row.workflow_node_id,
			agentName: row.agent_name,
			summary: row.summary,
			evidence,
			recordedAt: row.recorded_at,
		};
	}
}
