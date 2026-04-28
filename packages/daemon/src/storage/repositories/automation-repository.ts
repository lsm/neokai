/**
 * Automation Repository
 *
 * Persistent definitions and run ledger for the Automation system.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID, parseJson, parseJsonOptional } from '@neokai/shared';
import type {
	AutomationTask,
	AutomationRun,
	AutomationStatus,
	AutomationRunStatus,
	AutomationRunEvent,
	CreateAutomationTaskParams,
	UpdateAutomationTaskParams,
	CreateAutomationRunParams,
	UpdateAutomationRunParams,
	CreateAutomationRunEventParams,
	AutomationTaskFilter,
	AutomationRunFilter,
	AutomationRunEventFilter,
	AutomationTriggerConfig,
	AutomationTargetConfig,
	AutomationConditionConfig,
} from '@neokai/shared';
import type { ReactiveDatabase } from '../reactive-database';
import type { SQLiteValue } from '../types';

const ACTIVE_RUN_STATUSES: AutomationRunStatus[] = ['queued', 'running'];

function statusClause(
	column: string,
	status: string | string[] | undefined,
	values: SQLiteValue[]
): string {
	if (status === undefined) return '';
	if (Array.isArray(status)) {
		if (status.length === 0) return ' AND 1 = 0';
		values.push(...status);
		return ` AND ${column} IN (${status.map(() => '?').join(',')})`;
	}
	values.push(status);
	return ` AND ${column} = ?`;
}

export class AutomationRepository {
	constructor(
		private db: BunDatabase,
		private reactiveDb?: ReactiveDatabase
	) {}

	createTask(params: CreateAutomationTaskParams): AutomationTask {
		this.validateOwner(params.ownerType, params.ownerId ?? null);
		const id = generateUUID();
		const now = Date.now();

		this.db
			.prepare(
				`INSERT INTO automation_tasks (
					id, owner_type, owner_id, title, description, status,
					trigger_type, trigger_config, target_type, target_config, condition_config,
					concurrency_policy, notify_policy, max_retries, timeout_ms,
					next_run_at, last_run_at, last_checked_at, last_condition_result,
					condition_failure_count, consecutive_failure_count, last_failure_fingerprint,
					paused_reason, created_at, updated_at, archived_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				params.ownerType,
				params.ownerId ?? null,
				params.title,
				params.description ?? '',
				params.status ?? 'active',
				params.triggerType,
				JSON.stringify(params.triggerConfig ?? {}),
				params.targetType,
				JSON.stringify(params.targetConfig ?? {}),
				params.conditionConfig !== undefined && params.conditionConfig !== null
					? JSON.stringify(params.conditionConfig)
					: null,
				params.concurrencyPolicy ?? 'skip',
				params.notifyPolicy ?? 'done_only',
				params.maxRetries ?? 3,
				params.timeoutMs ?? null,
				params.nextRunAt ?? null,
				null,
				null,
				null,
				0,
				0,
				null,
				null,
				now,
				now,
				null
			);

		this.reactiveDb?.notifyChange('automation_tasks');
		return this.getTask(id)!;
	}

	getTask(id: string): AutomationTask | null {
		const row = this.db.prepare(`SELECT * FROM automation_tasks WHERE id = ?`).get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? this.rowToTask(row) : null;
	}

	listTasks(filter: AutomationTaskFilter = {}): AutomationTask[] {
		const values: SQLiteValue[] = [];
		let query = `SELECT * FROM automation_tasks WHERE 1 = 1`;

		if (filter.ownerType !== undefined) {
			query += ` AND owner_type = ?`;
			values.push(filter.ownerType);
		}
		if (filter.ownerId !== undefined) {
			if (filter.ownerId === null) {
				query += ` AND owner_id IS NULL`;
			} else {
				query += ` AND owner_id = ?`;
				values.push(filter.ownerId);
			}
		}
		query += statusClause('status', filter.status, values);
		if (filter.triggerType !== undefined) {
			query += ` AND trigger_type = ?`;
			values.push(filter.triggerType);
		}
		if (filter.targetType !== undefined) {
			query += ` AND target_type = ?`;
			values.push(filter.targetType);
		}

		query += ` ORDER BY updated_at DESC, created_at DESC LIMIT ?`;
		values.push(filter.limit ?? 100);

		const rows = this.db.prepare(query).all(...values) as Record<string, unknown>[];
		return rows.map((row) => this.rowToTask(row));
	}

	listDueTasks(now = Date.now(), limit = 100): AutomationTask[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM automation_tasks
				 WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
				 ORDER BY next_run_at ASC, created_at ASC
				 LIMIT ?`
			)
			.all(now, limit) as Record<string, unknown>[];
		return rows.map((row) => this.rowToTask(row));
	}

	updateTask(id: string, params: UpdateAutomationTaskParams): AutomationTask | null {
		const fields: string[] = [];
		const values: SQLiteValue[] = [];

		if (params.title !== undefined) {
			fields.push('title = ?');
			values.push(params.title);
		}
		if (params.description !== undefined) {
			fields.push('description = ?');
			values.push(params.description);
		}
		if (params.status !== undefined) {
			fields.push('status = ?');
			values.push(params.status);
			if (params.status === 'archived' && params.archivedAt === undefined) {
				fields.push('archived_at = ?');
				values.push(Date.now());
			}
		}
		if (params.triggerType !== undefined) {
			fields.push('trigger_type = ?');
			values.push(params.triggerType);
		}
		if (params.triggerConfig !== undefined) {
			fields.push('trigger_config = ?');
			values.push(JSON.stringify(params.triggerConfig));
		}
		if (params.targetType !== undefined) {
			fields.push('target_type = ?');
			values.push(params.targetType);
		}
		if (params.targetConfig !== undefined) {
			fields.push('target_config = ?');
			values.push(JSON.stringify(params.targetConfig));
		}
		if (params.conditionConfig !== undefined) {
			fields.push('condition_config = ?');
			values.push(params.conditionConfig !== null ? JSON.stringify(params.conditionConfig) : null);
		}
		if (params.concurrencyPolicy !== undefined) {
			fields.push('concurrency_policy = ?');
			values.push(params.concurrencyPolicy);
		}
		if (params.notifyPolicy !== undefined) {
			fields.push('notify_policy = ?');
			values.push(params.notifyPolicy);
		}
		if (params.maxRetries !== undefined) {
			fields.push('max_retries = ?');
			values.push(params.maxRetries);
		}
		if (params.timeoutMs !== undefined) {
			fields.push('timeout_ms = ?');
			values.push(params.timeoutMs);
		}
		if (params.nextRunAt !== undefined) {
			fields.push('next_run_at = ?');
			values.push(params.nextRunAt);
		}
		if (params.lastRunAt !== undefined) {
			fields.push('last_run_at = ?');
			values.push(params.lastRunAt);
		}
		if (params.lastCheckedAt !== undefined) {
			fields.push('last_checked_at = ?');
			values.push(params.lastCheckedAt);
		}
		if (params.lastConditionResult !== undefined) {
			fields.push('last_condition_result = ?');
			values.push(
				params.lastConditionResult !== null ? JSON.stringify(params.lastConditionResult) : null
			);
		}
		if (params.conditionFailureCount !== undefined) {
			fields.push('condition_failure_count = ?');
			values.push(params.conditionFailureCount);
		}
		if (params.consecutiveFailureCount !== undefined) {
			fields.push('consecutive_failure_count = ?');
			values.push(params.consecutiveFailureCount);
		}
		if (params.lastFailureFingerprint !== undefined) {
			fields.push('last_failure_fingerprint = ?');
			values.push(params.lastFailureFingerprint);
		}
		if (params.pausedReason !== undefined) {
			fields.push('paused_reason = ?');
			values.push(params.pausedReason);
		}
		if (params.archivedAt !== undefined) {
			fields.push('archived_at = ?');
			values.push(params.archivedAt);
		}

		if (fields.length === 0) return this.getTask(id);
		fields.push('updated_at = ?');
		values.push(Date.now(), id);

		const result = this.db
			.prepare(`UPDATE automation_tasks SET ${fields.join(', ')} WHERE id = ?`)
			.run(...values);
		if (result.changes === 0) return null;
		this.reactiveDb?.notifyChange('automation_tasks');
		return this.getTask(id);
	}

	archiveTask(id: string): AutomationTask | null {
		return this.updateTask(id, { status: 'archived' });
	}

	createRun(params: CreateAutomationRunParams): AutomationRun {
		const id = generateUUID();
		const now = Date.now();
		const status = params.status ?? 'queued';
		this.db
			.prepare(
				`INSERT INTO automation_runs (
					id, automation_task_id, owner_type, owner_id, status, trigger_type, trigger_reason,
					dispatch_key, job_id, room_task_id, room_goal_id, mission_execution_id, space_task_id,
					space_workflow_run_id, session_id, attempt, started_at, completed_at,
					result_summary, error, metadata, created_at, updated_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				params.automationTaskId,
				params.ownerType,
				params.ownerId ?? null,
				status,
				params.triggerType,
				params.triggerReason ?? null,
				params.dispatchKey ?? null,
				params.jobId ?? null,
				null,
				null,
				null,
				null,
				null,
				null,
				params.attempt ?? 1,
				status === 'running' ? now : null,
				this.isTerminalRunStatus(status) ? now : null,
				null,
				null,
				params.metadata !== undefined && params.metadata !== null
					? JSON.stringify(params.metadata)
					: null,
				now,
				now
			);
		this.reactiveDb?.notifyChange('automation_runs');
		return this.getRun(id)!;
	}

	getRun(id: string): AutomationRun | null {
		const row = this.db.prepare(`SELECT * FROM automation_runs WHERE id = ?`).get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? this.rowToRun(row) : null;
	}

	listRuns(filter: AutomationRunFilter = {}): AutomationRun[] {
		const values: SQLiteValue[] = [];
		let query = `SELECT * FROM automation_runs WHERE 1 = 1`;

		if (filter.automationTaskId !== undefined) {
			query += ` AND automation_task_id = ?`;
			values.push(filter.automationTaskId);
		}
		if (filter.ownerType !== undefined) {
			query += ` AND owner_type = ?`;
			values.push(filter.ownerType);
		}
		if (filter.ownerId !== undefined) {
			if (filter.ownerId === null) {
				query += ` AND owner_id IS NULL`;
			} else {
				query += ` AND owner_id = ?`;
				values.push(filter.ownerId);
			}
		}
		if (filter.dispatchKey !== undefined) {
			query += ` AND dispatch_key = ?`;
			values.push(filter.dispatchKey);
		}
		query += statusClause('status', filter.status, values);
		query += ` ORDER BY created_at DESC, id DESC LIMIT ?`;
		values.push(filter.limit ?? 100);

		const rows = this.db.prepare(query).all(...values) as Record<string, unknown>[];
		return rows.map((row) => this.rowToRun(row));
	}

	getRunByDispatchKey(dispatchKey: string): AutomationRun | null {
		const row = this.db
			.prepare(`SELECT * FROM automation_runs WHERE dispatch_key = ?`)
			.get(dispatchKey) as Record<string, unknown> | undefined;
		return row ? this.rowToRun(row) : null;
	}

	listActiveRuns(automationTaskId: string): AutomationRun[] {
		return this.listRuns({
			automationTaskId,
			status: ACTIVE_RUN_STATUSES,
			limit: 100,
		});
	}

	listLinkedActiveRuns(limit = 100): AutomationRun[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM automation_runs
				 WHERE status IN ('queued', 'running')
				   AND (
				     room_task_id IS NOT NULL OR
				     space_task_id IS NOT NULL OR
				     space_workflow_run_id IS NOT NULL OR
				     mission_execution_id IS NOT NULL
				   )
				 ORDER BY created_at ASC, id ASC
				 LIMIT ?`
			)
			.all(limit) as Record<string, unknown>[];
		return rows.map((row) => this.rowToRun(row));
	}

	updateRun(id: string, params: UpdateAutomationRunParams): AutomationRun | null {
		const fields: string[] = [];
		const values: SQLiteValue[] = [];

		if (params.status !== undefined) {
			fields.push('status = ?');
			values.push(params.status);
			if (params.status === 'running' && params.startedAt === undefined) {
				fields.push('started_at = COALESCE(started_at, ?)');
				values.push(Date.now());
			}
			if (this.isTerminalRunStatus(params.status) && params.completedAt === undefined) {
				fields.push('completed_at = ?');
				values.push(Date.now());
			}
		}
		const nullableTextFields = [
			['dispatchKey', 'dispatch_key'],
			['jobId', 'job_id'],
			['roomTaskId', 'room_task_id'],
			['roomGoalId', 'room_goal_id'],
			['missionExecutionId', 'mission_execution_id'],
			['spaceTaskId', 'space_task_id'],
			['spaceWorkflowRunId', 'space_workflow_run_id'],
			['sessionId', 'session_id'],
			['resultSummary', 'result_summary'],
			['error', 'error'],
		] as const;
		for (const [key, column] of nullableTextFields) {
			if (params[key] !== undefined) {
				fields.push(`${column} = ?`);
				values.push(params[key]);
			}
		}
		if (params.startedAt !== undefined) {
			fields.push('started_at = ?');
			values.push(params.startedAt);
		}
		if (params.completedAt !== undefined) {
			fields.push('completed_at = ?');
			values.push(params.completedAt);
		}
		if (params.metadata !== undefined) {
			fields.push('metadata = ?');
			values.push(params.metadata !== null ? JSON.stringify(params.metadata) : null);
		}

		if (fields.length === 0) return this.getRun(id);
		fields.push('updated_at = ?');
		values.push(Date.now(), id);

		const result = this.db
			.prepare(`UPDATE automation_runs SET ${fields.join(', ')} WHERE id = ?`)
			.run(...values);
		if (result.changes === 0) return null;
		this.reactiveDb?.notifyChange('automation_runs');
		return this.getRun(id);
	}

	createRunEvent(params: CreateAutomationRunEventParams): AutomationRunEvent {
		const id = generateUUID();
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO automation_run_events (
					id, automation_run_id, automation_task_id, event_type, message, metadata, created_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				params.automationRunId,
				params.automationTaskId,
				params.eventType,
				params.message ?? null,
				params.metadata !== undefined && params.metadata !== null
					? JSON.stringify(params.metadata)
					: null,
				now
			);
		this.reactiveDb?.notifyChange('automation_run_events');
		return this.getRunEvent(id)!;
	}

	getRunEvent(id: string): AutomationRunEvent | null {
		const row = this.db.prepare(`SELECT * FROM automation_run_events WHERE id = ?`).get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? this.rowToRunEvent(row) : null;
	}

	listRunEvents(filter: AutomationRunEventFilter = {}): AutomationRunEvent[] {
		const values: SQLiteValue[] = [];
		let query = `SELECT * FROM automation_run_events WHERE 1 = 1`;
		if (filter.automationRunId !== undefined) {
			query += ` AND automation_run_id = ?`;
			values.push(filter.automationRunId);
		}
		if (filter.automationTaskId !== undefined) {
			query += ` AND automation_task_id = ?`;
			values.push(filter.automationTaskId);
		}
		query += ` ORDER BY created_at ASC, id ASC LIMIT ?`;
		values.push(filter.limit ?? 200);
		const rows = this.db.prepare(query).all(...values) as Record<string, unknown>[];
		return rows.map((row) => this.rowToRunEvent(row));
	}

	private validateOwner(ownerType: string, ownerId: string | null): void {
		if (ownerType === 'global') return;
		if (!ownerId) {
			throw new Error(`ownerId is required for ${ownerType} automations`);
		}
	}

	private isTerminalRunStatus(status: AutomationRunStatus): boolean {
		return ['succeeded', 'failed', 'timed_out', 'cancelled', 'lost'].includes(status);
	}

	private rowToTask(row: Record<string, unknown>): AutomationTask {
		return {
			id: row.id as string,
			ownerType: row.owner_type as AutomationTask['ownerType'],
			ownerId: (row.owner_id as string | null) ?? null,
			title: row.title as string,
			description: row.description as string,
			status: row.status as AutomationStatus,
			triggerType: row.trigger_type as AutomationTask['triggerType'],
			triggerConfig: parseJson<AutomationTriggerConfig>(
				row.trigger_config as string,
				{} as AutomationTriggerConfig
			),
			targetType: row.target_type as AutomationTask['targetType'],
			targetConfig: parseJson<AutomationTargetConfig>(
				row.target_config as string,
				{} as AutomationTargetConfig
			),
			conditionConfig:
				parseJsonOptional<AutomationConditionConfig>(row.condition_config as string | null) ?? null,
			concurrencyPolicy: row.concurrency_policy as AutomationTask['concurrencyPolicy'],
			notifyPolicy: row.notify_policy as AutomationTask['notifyPolicy'],
			maxRetries: row.max_retries as number,
			timeoutMs: (row.timeout_ms as number | null) ?? null,
			nextRunAt: (row.next_run_at as number | null) ?? null,
			lastRunAt: (row.last_run_at as number | null) ?? null,
			lastCheckedAt: (row.last_checked_at as number | null) ?? null,
			lastConditionResult:
				parseJsonOptional<Record<string, unknown>>(row.last_condition_result as string | null) ??
				null,
			conditionFailureCount: (row.condition_failure_count as number | null) ?? 0,
			consecutiveFailureCount: (row.consecutive_failure_count as number | null) ?? 0,
			lastFailureFingerprint: (row.last_failure_fingerprint as string | null) ?? null,
			pausedReason: (row.paused_reason as string | null) ?? null,
			createdAt: row.created_at as number,
			updatedAt: row.updated_at as number,
			archivedAt: (row.archived_at as number | null) ?? null,
		};
	}

	private rowToRun(row: Record<string, unknown>): AutomationRun {
		return {
			id: row.id as string,
			automationTaskId: row.automation_task_id as string,
			ownerType: row.owner_type as AutomationRun['ownerType'],
			ownerId: (row.owner_id as string | null) ?? null,
			status: row.status as AutomationRunStatus,
			triggerType: row.trigger_type as AutomationRun['triggerType'],
			triggerReason: (row.trigger_reason as string | null) ?? null,
			dispatchKey: (row.dispatch_key as string | null) ?? null,
			jobId: (row.job_id as string | null) ?? null,
			roomTaskId: (row.room_task_id as string | null) ?? null,
			roomGoalId: (row.room_goal_id as string | null) ?? null,
			missionExecutionId: (row.mission_execution_id as string | null) ?? null,
			spaceTaskId: (row.space_task_id as string | null) ?? null,
			spaceWorkflowRunId: (row.space_workflow_run_id as string | null) ?? null,
			sessionId: (row.session_id as string | null) ?? null,
			attempt: row.attempt as number,
			startedAt: (row.started_at as number | null) ?? null,
			completedAt: (row.completed_at as number | null) ?? null,
			resultSummary: (row.result_summary as string | null) ?? null,
			error: (row.error as string | null) ?? null,
			metadata: parseJsonOptional<Record<string, unknown>>(row.metadata as string | null) ?? null,
			createdAt: row.created_at as number,
			updatedAt: row.updated_at as number,
		};
	}

	private rowToRunEvent(row: Record<string, unknown>): AutomationRunEvent {
		return {
			id: row.id as string,
			automationRunId: row.automation_run_id as string,
			automationTaskId: row.automation_task_id as string,
			eventType: row.event_type as AutomationRunEvent['eventType'],
			message: (row.message as string | null) ?? null,
			metadata: parseJsonOptional<Record<string, unknown>>(row.metadata as string | null) ?? null,
			createdAt: row.created_at as number,
		};
	}
}
