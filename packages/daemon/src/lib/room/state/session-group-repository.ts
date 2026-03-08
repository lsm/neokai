/**
 * SessionGroupRepository - CRUD for session_groups, session_group_members, task_group_events
 *
 * Generic multi-agent collaboration groups. For (Worker, Leader) task groups:
 *   group_type = 'task', ref_id = task_id
 *   members: role='worker' + role='leader'
 *   state: awaiting_worker | awaiting_leader | awaiting_human | hibernated | completed | failed
 *
 * The actual worker type (planner, coder, general) is stored in metadata.workerRole.
 *
 * Orchestration state (feedbackIteration, lastForwardedMessageId, etc.) is stored
 * as JSON in the metadata column — no schema change needed for new fields.
 *
 * All update methods use version-based optimistic locking.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';

export type GroupState =
	| 'awaiting_worker'
	| 'awaiting_leader'
	| 'awaiting_human'
	| 'completed'
	| 'failed';

/** Rate limit backoff state stored in group metadata */
export interface RateLimitBackoff {
	/** When the rate limit was detected (timestamp in ms) */
	detectedAt: number;
	/** When the rate limit resets (timestamp in ms) */
	resetsAt: number;
	/** Which session hit the limit ('worker' | 'leader') */
	sessionRole: 'worker' | 'leader';
}

/** Persisted bootstrap context for lazily creating Leader sessions */
export interface DeferredLeaderConfig {
	roomId: string;
	goalId: string;
	reviewContext?: 'plan_review' | 'code_review';
	leaderTaskContext?: string;
}

/** Type-specific metadata for task groups */
interface TaskGroupMetadata {
	feedbackIteration: number;
	leaderContractViolations: number;
	/** Whether the leader called a tool in the current review turn (persisted for restart safety) */
	leaderCalledTool: boolean;
	lastProcessedLeaderTurnId: string | null;
	lastForwardedMessageId: string | null;
	activeWorkStartedAt: number | null;
	activeWorkElapsed: number;
	hibernatedAt: number | null;
	tokensUsed: number;
	/** The specific worker agent type (planner, coder, general) */
	workerRole?: string;
	/** Workspace path for this group (may be a worktree path, different from room default) */
	workspacePath?: string;
	/** Whether the leader has called submit_for_review (state machine gate for complete_task) */
	submittedForReview?: boolean;
	/** Whether a human has approved the task (gates planner create_task tool, worker exit gate, complete_task gate) */
	approved?: boolean;
	/** Rate limit backoff state - when set, nagging is paused until resetsAt */
	rateLimit?: RateLimitBackoff | null;
	/** Persisted bootstrap config for deferred Leader creation */
	deferredLeader?: DeferredLeaderConfig | null;
}

function defaultMetadata(): TaskGroupMetadata {
	return {
		feedbackIteration: 0,
		leaderContractViolations: 0,
		leaderCalledTool: false,
		lastProcessedLeaderTurnId: null,
		lastForwardedMessageId: null,
		activeWorkStartedAt: null,
		activeWorkElapsed: 0,
		hibernatedAt: null,
		tokensUsed: 0,
		deferredLeader: null,
	};
}

/**
 * Flattened view of a session group that combines session_groups +
 * session_group_members (worker/leader roles) for ease of use in runtime code.
 */
export interface SessionGroup {
	id: string;
	/** ref_id — the task_id for task groups */
	taskId: string;
	groupType: string;
	workerSessionId: string;
	leaderSessionId: string;
	/** The specific worker agent type: 'planner', 'coder', 'general' */
	workerRole: string;
	state: GroupState;
	feedbackIteration: number;
	leaderContractViolations: number;
	leaderCalledTool: boolean;
	lastProcessedLeaderTurnId: string | null;
	lastForwardedMessageId: string | null;
	activeWorkStartedAt: number | null;
	activeWorkElapsed: number;
	hibernatedAt: number | null;
	version: number;
	tokensUsed: number;
	/** Workspace path for this group (may differ from room default when using worktrees) */
	workspacePath?: string;
	/** Whether the leader has called submit_for_review (state machine gate for complete_task) */
	submittedForReview: boolean;
	/** Whether a human has approved the task (gates planner create_task tool, worker exit gate, complete_task gate) */
	approved: boolean;
	/** Rate limit backoff state - when set, nagging is paused until resetsAt */
	rateLimit: RateLimitBackoff | null;
	/** Persisted bootstrap config for deferred Leader creation */
	deferredLeader: DeferredLeaderConfig | null;
	createdAt: number;
	completedAt: number | null;
}

export interface TaskGroupEvent {
	id: number;
	groupId: string;
	kind: string;
	payloadJson: string | null;
	createdAt: number;
}

export class SessionGroupRepository {
	constructor(private db: BunDatabase) {}

	// ===== Group lifecycle =====

	createGroup(
		taskId: string,
		workerSessionId: string,
		leaderSessionId: string,
		workerRole: string = 'coder',
		workspacePath?: string
	): SessionGroup {
		const id = generateUUID();
		const now = Date.now();
		const metadata: TaskGroupMetadata = { ...defaultMetadata(), workerRole, workspacePath };

		this.db
			.prepare(
				`INSERT INTO session_groups (id, group_type, ref_id, state, version, metadata, created_at)
			 VALUES (?, 'task', ?, 'awaiting_worker', 0, ?, ?)`
			)
			.run(id, taskId, JSON.stringify(metadata), now);

		this.db
			.prepare(
				`INSERT INTO session_group_members (group_id, session_id, role, joined_at)
			 VALUES (?, ?, 'worker', ?), (?, ?, 'leader', ?)`
			)
			.run(id, workerSessionId, now, id, leaderSessionId, now);

		return this.getGroup(id)!;
	}

	getGroup(groupId: string): SessionGroup | null {
		const row = this.db
			.prepare(
				`SELECT
					sg.id, sg.group_type, sg.ref_id, sg.state, sg.version, sg.metadata,
					sg.created_at, sg.completed_at,
					worker.session_id AS worker_session_id,
					leader.session_id AS leader_session_id
				FROM session_groups sg
				LEFT JOIN session_group_members worker ON worker.group_id = sg.id AND worker.role = 'worker'
				LEFT JOIN session_group_members leader ON leader.group_id = sg.id AND leader.role = 'leader'
				WHERE sg.id = ?`
			)
			.get(groupId) as Record<string, unknown> | undefined;
		if (!row) return null;
		return this.rowToGroup(row);
	}

	getGroupByTaskId(taskId: string): SessionGroup | null {
		const row = this.db
			.prepare(
				`SELECT
					sg.id, sg.group_type, sg.ref_id, sg.state, sg.version, sg.metadata,
					sg.created_at, sg.completed_at,
					worker.session_id AS worker_session_id,
					leader.session_id AS leader_session_id
				FROM session_groups sg
				LEFT JOIN session_group_members worker ON worker.group_id = sg.id AND worker.role = 'worker'
				LEFT JOIN session_group_members leader ON leader.group_id = sg.id AND leader.role = 'leader'
				WHERE sg.ref_id = ? AND sg.group_type IN ('task', 'task_pair')
				ORDER BY sg.created_at DESC LIMIT 1`
			)
			.get(taskId) as Record<string, unknown> | undefined;
		if (!row) return null;
		return this.rowToGroup(row);
	}

	getActiveGroups(roomId: string): SessionGroup[] {
		const rows = this.db
			.prepare(
				`SELECT
					sg.id, sg.group_type, sg.ref_id, sg.state, sg.version, sg.metadata,
					sg.created_at, sg.completed_at,
					worker.session_id AS worker_session_id,
					leader.session_id AS leader_session_id
				FROM session_groups sg
				JOIN tasks t ON sg.ref_id = t.id
				LEFT JOIN session_group_members worker ON worker.group_id = sg.id AND worker.role = 'worker'
				LEFT JOIN session_group_members leader ON leader.group_id = sg.id AND leader.role = 'leader'
				WHERE t.room_id = ? AND sg.state NOT IN ('completed', 'failed')`
			)
			.all(roomId) as Record<string, unknown>[];
		return rows.map((r) => this.rowToGroup(r));
	}

	updateGroupState(
		groupId: string,
		newState: GroupState,
		expectedVersion: number
	): SessionGroup | null {
		const result = this.db
			.prepare(
				`UPDATE session_groups SET state = ?, version = version + 1
			 WHERE id = ? AND version = ?`
			)
			.run(newState, groupId, expectedVersion);
		if (result.changes === 0) return null;
		return this.getGroup(groupId);
	}

	completeGroup(groupId: string, expectedVersion: number): SessionGroup | null {
		const now = Date.now();
		const result = this.db
			.prepare(
				`UPDATE session_groups SET state = 'completed', completed_at = ?, version = version + 1
			 WHERE id = ? AND version = ?`
			)
			.run(now, groupId, expectedVersion);
		if (result.changes === 0) return null;
		return this.getGroup(groupId);
	}

	failGroup(groupId: string, expectedVersion: number): SessionGroup | null {
		const now = Date.now();
		const result = this.db
			.prepare(
				`UPDATE session_groups SET state = 'failed', completed_at = ?, version = version + 1
			 WHERE id = ? AND version = ?`
			)
			.run(now, groupId, expectedVersion);
		if (result.changes === 0) return null;
		return this.getGroup(groupId);
	}

	/**
	 * Delete a group and its members.
	 * The database schema uses ON DELETE CASCADE, so members and events are
	 * automatically deleted when the group is deleted.
	 */
	deleteGroup(groupId: string): boolean {
		const result = this.db.prepare(`DELETE FROM session_groups WHERE id = ?`).run(groupId);
		return result.changes > 0;
	}

	/**
	 * Reset a failed/completed group for task restart.
	 * Sets state back to 'awaiting_worker', clears completed_at, and resets
	 * metadata fields to allow the task to be picked up fresh by the runtime.
	 */
	resetGroupForRestart(groupId: string): SessionGroup | null {
		const current = this.getGroup(groupId);
		if (!current) return null;

		// Reset metadata to fresh state
		const resetMetadata: TaskGroupMetadata = {
			...defaultMetadata(),
			workerRole: current.workerRole,
			workspacePath: current.workspacePath,
			deferredLeader: current.deferredLeader,
		};

		const result = this.db
			.prepare(
				`UPDATE session_groups
				 SET state = 'awaiting_worker',
				     completed_at = NULL,
				     metadata = ?,
				     version = version + 1
				 WHERE id = ?`
			)
			.run(JSON.stringify(resetMetadata), groupId);

		if (result.changes === 0) return null;
		return this.getGroup(groupId);
	}

	// ===== Metadata update helpers (partial merge pattern) =====

	private updateMetadata(
		groupId: string,
		expectedVersion: number,
		patch: Partial<TaskGroupMetadata>
	): SessionGroup | null {
		const current = this.getGroup(groupId);
		if (!current) return null;

		const currentMeta = this.parseMetadata(
			(
				this.db.prepare(`SELECT metadata FROM session_groups WHERE id = ?`).get(groupId) as Record<
					string,
					unknown
				>
			)?.metadata as string
		);
		const merged = { ...currentMeta, ...patch };

		const result = this.db
			.prepare(
				`UPDATE session_groups SET metadata = ?, version = version + 1
			 WHERE id = ? AND version = ?`
			)
			.run(JSON.stringify(merged), groupId, expectedVersion);
		if (result.changes === 0) return null;
		return this.getGroup(groupId);
	}

	incrementFeedbackIteration(groupId: string, expectedVersion: number): SessionGroup | null {
		const current = this.getGroup(groupId);
		if (!current) return null;

		const currentMeta = this.parseMetadata(
			(
				this.db.prepare(`SELECT metadata FROM session_groups WHERE id = ?`).get(groupId) as Record<
					string,
					unknown
				>
			)?.metadata as string
		);
		const merged = { ...currentMeta, feedbackIteration: currentMeta.feedbackIteration + 1 };

		const result = this.db
			.prepare(
				`UPDATE session_groups SET metadata = ?, version = version + 1
			 WHERE id = ? AND version = ?`
			)
			.run(JSON.stringify(merged), groupId, expectedVersion);
		if (result.changes === 0) return null;
		return this.getGroup(groupId);
	}

	updateLeaderContractViolations(
		groupId: string,
		violations: number,
		lastTurnId: string,
		expectedVersion: number
	): SessionGroup | null {
		return this.updateMetadata(groupId, expectedVersion, {
			leaderContractViolations: violations,
			lastProcessedLeaderTurnId: lastTurnId,
		});
	}

	resetLeaderContractViolations(groupId: string, expectedVersion: number): SessionGroup | null {
		return this.updateMetadata(groupId, expectedVersion, {
			leaderContractViolations: 0,
			leaderCalledTool: false,
		});
	}

	/**
	 * Reset feedback iteration counter to 0.
	 * Called when a human resumes a task after escalation so the resumed task
	 * gets a fresh iteration budget and doesn't immediately re-escalate.
	 */
	resetFeedbackIteration(groupId: string, expectedVersion: number): SessionGroup | null {
		return this.updateMetadata(groupId, expectedVersion, { feedbackIteration: 0 });
	}

	/**
	 * Set leaderCalledTool flag without version check.
	 * This is a soft signal — safe to race with state transitions.
	 */
	setLeaderCalledTool(groupId: string, called: boolean): void {
		const raw = (
			this.db.prepare(`SELECT metadata FROM session_groups WHERE id = ?`).get(groupId) as Record<
				string,
				unknown
			>
		)?.metadata as string;
		const currentMeta = this.parseMetadata(raw);
		const merged = { ...currentMeta, leaderCalledTool: called };
		this.db
			.prepare(`UPDATE session_groups SET metadata = ? WHERE id = ?`)
			.run(JSON.stringify(merged), groupId);
	}

	/**
	 * Set submittedForReview flag without version check.
	 * Records that the leader has called submit_for_review, gating complete_task.
	 */
	setSubmittedForReview(groupId: string, value: boolean): void {
		const raw = (
			this.db.prepare(`SELECT metadata FROM session_groups WHERE id = ?`).get(groupId) as Record<
				string,
				unknown
			>
		)?.metadata as string;
		const currentMeta = this.parseMetadata(raw);
		const merged = { ...currentMeta, submittedForReview: value };
		this.db
			.prepare(`UPDATE session_groups SET metadata = ? WHERE id = ?`)
			.run(JSON.stringify(merged), groupId);
	}

	/**
	 * Set approved flag without version check.
	 * Records that the human has approved the task (plan or PR).
	 */
	setApproved(groupId: string, value: boolean): void {
		const raw = (
			this.db.prepare(`SELECT metadata FROM session_groups WHERE id = ?`).get(groupId) as Record<
				string,
				unknown
			>
		)?.metadata as string;
		const currentMeta = this.parseMetadata(raw);
		const merged = { ...currentMeta, approved: value };
		this.db
			.prepare(`UPDATE session_groups SET metadata = ? WHERE id = ?`)
			.run(JSON.stringify(merged), groupId);
	}

	/**
	 * Persist deferred Leader bootstrap configuration.
	 * Stored in metadata so runtime restart can still lazy-create the leader session.
	 */
	setDeferredLeader(groupId: string, deferredLeader: DeferredLeaderConfig | null): void {
		const raw = (
			this.db.prepare(`SELECT metadata FROM session_groups WHERE id = ?`).get(groupId) as Record<
				string,
				unknown
			>
		)?.metadata as string;
		const currentMeta = this.parseMetadata(raw);
		const merged = { ...currentMeta, deferredLeader };
		this.db
			.prepare(`UPDATE session_groups SET metadata = ? WHERE id = ?`)
			.run(JSON.stringify(merged), groupId);
	}

	// ===== Rate Limit Backoff =====

	/**
	 * Set rate limit backoff state.
	 * When set, nagging is paused until resetsAt timestamp.
	 */
	setRateLimit(groupId: string, rateLimit: RateLimitBackoff | null): void {
		const raw = (
			this.db.prepare(`SELECT metadata FROM session_groups WHERE id = ?`).get(groupId) as Record<
				string,
				unknown
			>
		)?.metadata as string;
		const currentMeta = this.parseMetadata(raw);
		const merged = { ...currentMeta, rateLimit };
		this.db
			.prepare(`UPDATE session_groups SET metadata = ? WHERE id = ?`)
			.run(JSON.stringify(merged), groupId);
	}

	/**
	 * Clear rate limit backoff state.
	 * Called when rate limit has expired or work resumes.
	 */
	clearRateLimit(groupId: string): void {
		this.setRateLimit(groupId, null);
	}

	/**
	 * Check if group is currently in rate limit backoff period.
	 * Returns true if rateLimit is set and current time is before resetsAt.
	 */
	isRateLimited(groupId: string): boolean {
		const group = this.getGroup(groupId);
		if (!group?.rateLimit) return false;
		return Date.now() < group.rateLimit.resetsAt;
	}

	/**
	 * Get the time remaining until rate limit expires (in ms).
	 * Returns 0 if not rate limited or already expired.
	 */
	getRateLimitRemainingMs(groupId: string): number {
		const group = this.getGroup(groupId);
		if (!group?.rateLimit) return 0;
		const remaining = group.rateLimit.resetsAt - Date.now();
		return Math.max(0, remaining);
	}

	/**
	 * Update the worker member's session_id for a group.
	 * Used when resuming a worker session (e.g., planner phase 2).
	 */
	updateWorkerSession(groupId: string, newSessionId: string): void {
		this.db
			.prepare(
				`UPDATE session_group_members SET session_id = ? WHERE group_id = ? AND role = 'worker'`
			)
			.run(newSessionId, groupId);
	}

	updateLastForwardedMessageId(
		groupId: string,
		messageId: string,
		expectedVersion: number
	): SessionGroup | null {
		return this.updateMetadata(groupId, expectedVersion, {
			lastForwardedMessageId: messageId,
		});
	}

	// ===== Group events (status/system timeline, no mirrored SDK chat) =====

	appendEvent(params: { groupId: string; kind: string; payloadJson?: string }): number {
		const result = this.db
			.prepare(
				`INSERT INTO task_group_events (group_id, kind, payload_json, created_at)
			 VALUES (?, ?, ?, ?)`
			)
			.run(params.groupId, params.kind, params.payloadJson ?? null, Date.now());
		return Number(result.lastInsertRowid);
	}

	getEvents(
		groupId: string,
		options?: { afterId?: number; limit?: number }
	): { events: TaskGroupEvent[]; hasMore: boolean } {
		const limit = options?.limit ?? 100;
		const afterId = options?.afterId ?? 0;

		const rows = this.db
			.prepare(
				`SELECT * FROM task_group_events
			 WHERE group_id = ? AND id > ?
			 ORDER BY id ASC
			 LIMIT ?`
			)
			.all(groupId, afterId, limit + 1) as Record<string, unknown>[];

		const hasMore = rows.length > limit;
		const events = rows.slice(0, limit).map((r) => ({
			id: r.id as number,
			groupId: r.group_id as string,
			kind: r.kind as string,
			payloadJson: r.payload_json as string | null,
			createdAt: r.created_at as number,
		}));

		return { events, hasMore };
	}

	// ===== Private helpers =====

	private parseMetadata(raw: string | null | undefined): TaskGroupMetadata {
		if (!raw) return defaultMetadata();
		try {
			const parsed = JSON.parse(raw) as Partial<TaskGroupMetadata>;
			// Handle migration from old field names
			const compat = parsed as Record<string, unknown>;
			return {
				...defaultMetadata(),
				...parsed,
				// Migrate old field names if present
				leaderContractViolations:
					parsed.leaderContractViolations ?? (compat.leadContractViolations as number) ?? 0,
				lastProcessedLeaderTurnId:
					parsed.lastProcessedLeaderTurnId ??
					(compat.lastProcessedLeadTurnId as string | null) ??
					null,
			};
		} catch {
			return defaultMetadata();
		}
	}

	private rowToGroup(row: Record<string, unknown>): SessionGroup {
		const meta = this.parseMetadata(row.metadata as string | null);
		return {
			id: row.id as string,
			taskId: row.ref_id as string,
			groupType: row.group_type as string,
			workerSessionId: (row.worker_session_id as string) ?? '',
			leaderSessionId: (row.leader_session_id as string) ?? '',
			workerRole: meta.workerRole ?? 'coder',
			state: row.state as GroupState,
			feedbackIteration: meta.feedbackIteration,
			leaderContractViolations: meta.leaderContractViolations,
			leaderCalledTool: meta.leaderCalledTool ?? false,
			lastProcessedLeaderTurnId: meta.lastProcessedLeaderTurnId,
			lastForwardedMessageId: meta.lastForwardedMessageId,
			activeWorkStartedAt: meta.activeWorkStartedAt,
			activeWorkElapsed: meta.activeWorkElapsed,
			hibernatedAt: meta.hibernatedAt,
			version: row.version as number,
			tokensUsed: meta.tokensUsed,
			workspacePath: meta.workspacePath,
			submittedForReview: meta.submittedForReview ?? false,
			approved: meta.approved ?? false,
			rateLimit: meta.rateLimit ?? null,
			deferredLeader: meta.deferredLeader ?? null,
			createdAt: row.created_at as number,
			completedAt: (row.completed_at as number | null) ?? null,
		};
	}
}
