/**
 * SessionGroupRepository - CRUD for session_groups, session_group_members, task_group_events
 *
 * Generic multi-agent collaboration groups. For (Worker, Leader) task groups:
 *   group_type = 'task', ref_id = task_id
 *   members: role='worker' + role='leader'
 *
 * The actual worker type (planner, coder, general) is stored in metadata.workerRole.
 *
 * Orchestration state (feedbackIteration, lastForwardedMessageId, etc.) is stored
 * as JSON in the metadata column — no schema change needed for new fields.
 *
 * All update methods use version-based optimistic locking.
 *
 * Use `completedAt` to check if a group is terminal, and `submittedForReview` to
 * check if a group is awaiting human review.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type { ReactiveDatabase } from '../../../storage/reactive-database';
import type { GateFailureRecord } from '../runtime/dead-loop-detector';

/** Rate limit backoff state stored in group metadata */
export interface RateLimitBackoff {
	/** When the rate limit was detected (timestamp in ms) */
	detectedAt: number;
	/** When the rate limit resets (timestamp in ms) */
	resetsAt: number;
	/** Which session hit the limit ('worker' | 'leader') */
	sessionRole: 'worker' | 'leader';
}

/**
 * Persisted bootstrap context for the Leader session.
 * Survives daemon restart and is used by recoverZombieGroups() to recreate a
 * missing leader from scratch, and by routeWorkerToLeader() as the restart-recovery
 * fallback when the leader is absent from the in-memory session cache.
 * Also carries leaderTaskContext — the message prefix prepended on the first
 * worker→leader routing call.
 */
export interface LeaderBootstrapConfig {
	roomId: string;
	goalId: string | null;
	reviewContext?: 'plan_review' | 'code_review';
	leaderTaskContext?: string;
	/**
	 * When true, the leader session was already created eagerly in spawn()
	 * alongside the worker. Used by findZombieGroups() to know the leader is
	 * expected in cache even on the first review round (feedbackIteration == 0).
	 */
	eagerlyCreated?: boolean;
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
	/** Persisted bootstrap config for the leader session (restart-recovery and first-routing context) */
	deferredLeader?: LeaderBootstrapConfig | null;
	/** Whether the user interrupted the session mid-generation (prevents auto-routing to leader) */
	humanInterrupted?: boolean;
	/** Gate failure history for dead loop detection */
	gateFailures?: GateFailureRecord[];
	/**
	 * Latest progress summary provided by the leader at the end of each turn.
	 * Summarizes (1) what the task is about and (2) what has been done/changed so far.
	 */
	leaderProgressSummary?: string;
	/** Whether the group is paused waiting for a question to be answered */
	waitingForQuestion?: boolean;
	/** Which session is waiting for a question answer ('worker' | 'leader' | null) */
	waitingSession?: 'worker' | 'leader' | null;
	/**
	 * Whether the worker used a bypass marker (RESEARCH_ONLY, VERIFICATION_COMPLETE, etc.)
	 * to skip git/PR gates. When true, checkLeaderPrMerged fails open even with approved=true
	 * because bypass tasks have no PR.
	 */
	workerBypassed?: boolean;
	/**
	 * Who approved this task. Set to 'human' when a human calls resumeWorkerFromHuman
	 * with approved=true. Set to 'leader_semi_auto' when runtime auto-approves in
	 * semi-autonomous mode. Used as idempotency guard for auto-approve deferred callbacks.
	 */
	approvalSource?: 'human' | 'leader_semi_auto';
	/**
	 * Links this session group to a specific mission_executions row for recurring missions.
	 * Used by recoverZombieGroups() to correlate recovered groups to their execution after restart.
	 */
	executionId?: string;
	/**
	 * True once the leader has had at least one message injected (via routeWorkerToLeader
	 * or resumeLeaderFromHuman). Never reset, so onLeaderTerminalState can reliably
	 * distinguish spurious pre-work idle events from real terminal events.
	 */
	leaderHasWork?: boolean;
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
	/** Persisted bootstrap config for the leader session (restart-recovery and first-routing context) */
	deferredLeader: LeaderBootstrapConfig | null;
	/** Whether the user interrupted the session mid-generation (prevents auto-routing to leader) */
	humanInterrupted: boolean;
	/** Whether the group is paused waiting for a question to be answered */
	waitingForQuestion: boolean;
	/** Which session is waiting for a question answer ('worker' | 'leader' | null) */
	waitingSession: 'worker' | 'leader' | null;
	/**
	 * Whether the worker used a bypass marker to skip git/PR gates.
	 * When true, checkLeaderPrMerged fails open even with approved=true (no PR exists).
	 */
	workerBypassed: boolean;
	/**
	 * Who approved this task ('human' or 'leader_semi_auto'), or null if not yet approved.
	 */
	approvalSource: 'human' | 'leader_semi_auto' | null;
	/**
	 * Links this session group to a specific mission_executions row for recurring missions.
	 * Used by recoverZombieGroups() to correlate recovered groups to their execution after restart.
	 */
	executionId?: string;
	/**
	 * True once the leader has had at least one message injected. Never reset.
	 * Used by onLeaderTerminalState to drop spurious pre-work idle events.
	 */
	leaderHasWork: boolean;
	/**
	 * Latest progress summary provided by the leader at the end of each turn.
	 * Summarizes (1) what the task is about and (2) what has been done/changed so far.
	 */
	leaderProgressSummary: string | null;
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
	constructor(
		private db: BunDatabase,
		private reactiveDb: ReactiveDatabase
	) {}

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

		// reactiveDb.beginTransaction() batches change events only — not a DB transaction.
		// this.db.transaction() provides actual SQLite atomicity so the second INSERT
		// failure rolls back the first.
		this.reactiveDb.beginTransaction();
		try {
			this.db.transaction(() => {
				this.db
					.prepare(
						`INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
			 VALUES (?, 'task', ?, 0, ?, ?)`
					)
					.run(id, taskId, JSON.stringify(metadata), now);

				this.db
					.prepare(
						`INSERT INTO session_group_members (group_id, session_id, role, joined_at)
			 VALUES (?, ?, 'worker', ?), (?, ?, 'leader', ?)`
					)
					.run(id, workerSessionId, now, id, leaderSessionId, now);
			})();

			this.reactiveDb.notifyChange('session_groups');
			this.reactiveDb.commitTransaction();
		} catch (e) {
			this.reactiveDb.abortTransaction();
			throw e;
		}

		return this.getGroup(id)!;
	}

	getGroup(groupId: string): SessionGroup | null {
		const row = this.db
			.prepare(
				`SELECT
					sg.id, sg.group_type, sg.ref_id, sg.version, sg.metadata,
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
					sg.id, sg.group_type, sg.ref_id, sg.version, sg.metadata,
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

	/**
	 * Returns ALL active (completedAt IS NULL) groups for a specific task.
	 * Used for defense-in-depth deduplication in spawnGroupForTask — checks every
	 * active group, not just the most recent, to catch stale zombie groups that
	 * would otherwise allow a duplicate spawn.
	 */
	getActiveGroupsForTask(taskId: string): SessionGroup[] {
		const rows = this.db
			.prepare(
				`SELECT
					sg.id, sg.group_type, sg.ref_id, sg.version, sg.metadata,
					sg.created_at, sg.completed_at,
					worker.session_id AS worker_session_id,
					leader.session_id AS leader_session_id
				FROM session_groups sg
				LEFT JOIN session_group_members worker ON worker.group_id = sg.id AND worker.role = 'worker'
				LEFT JOIN session_group_members leader ON leader.group_id = sg.id AND leader.role = 'leader'
				WHERE sg.ref_id = ? AND sg.group_type IN ('task', 'task_pair') AND sg.completed_at IS NULL
				ORDER BY sg.created_at DESC`
			)
			.all(taskId) as Record<string, unknown>[];
		return rows.map((r) => this.rowToGroup(r));
	}

	getActiveGroups(roomId: string): SessionGroup[] {
		const rows = this.db
			.prepare(
				`SELECT
					sg.id, sg.group_type, sg.ref_id, sg.version, sg.metadata,
					sg.created_at, sg.completed_at,
					worker.session_id AS worker_session_id,
					leader.session_id AS leader_session_id
				FROM session_groups sg
				JOIN tasks t ON sg.ref_id = t.id
				LEFT JOIN session_group_members worker ON worker.group_id = sg.id AND worker.role = 'worker'
				LEFT JOIN session_group_members leader ON leader.group_id = sg.id AND leader.role = 'leader'
				WHERE t.room_id = ? AND sg.completed_at IS NULL`
			)
			.all(roomId) as Record<string, unknown>[];
		return rows.map((r) => this.rowToGroup(r));
	}

	completeGroup(groupId: string, expectedVersion: number): SessionGroup | null {
		const now = Date.now();
		const result = this.db
			.prepare(
				`UPDATE session_groups SET completed_at = ?, version = version + 1
			 WHERE id = ? AND version = ?`
			)
			.run(now, groupId, expectedVersion);
		if (result.changes === 0) return null;
		this.reactiveDb.notifyChange('session_groups');
		return this.getGroup(groupId);
	}

	failGroup(groupId: string, expectedVersion: number): SessionGroup | null {
		const now = Date.now();
		const result = this.db
			.prepare(
				`UPDATE session_groups SET completed_at = ?, version = version + 1
			 WHERE id = ? AND version = ?`
			)
			.run(now, groupId, expectedVersion);
		if (result.changes === 0) return null;
		this.reactiveDb.notifyChange('session_groups');
		return this.getGroup(groupId);
	}

	/**
	 * DB-level zombie cleanup for a room: marks active session groups as completed
	 * when their task is in a terminal state
	 * (completed, cancelled, archived, needs_attention).
	 *
	 * 'needs_attention' is the renamed 'failed' status (migration 24) and IS terminal —
	 * TaskGroupManager.fail() sets it via failTask(). Zombies arise when the group's
	 * completed_at was never set due to a crash after failTask() ran.
	 *
	 * Synchronous and safe to call from stop() without async/await.
	 * Returns the number of groups cleaned up.
	 */
	cleanupZombieGroupsForRoom(roomId: string): number {
		const now = Date.now();
		const result = this.db
			.prepare(
				`UPDATE session_groups
				 SET completed_at = ?, version = version + 1
				 WHERE completed_at IS NULL
				   AND group_type IN ('task', 'task_pair')
				   AND ref_id IN (
				     SELECT t.id FROM tasks t
				     WHERE t.room_id = ?
				       AND t.status IN ('completed', 'cancelled', 'archived', 'needs_attention')
				   )`
			)
			.run(now, roomId);
		if (result.changes > 0) {
			this.reactiveDb.notifyChange('session_groups');
		}
		return result.changes;
	}

	/**
	 * Force-complete all active groups for a task except the specified one.
	 * Used as a safety net in complete()/fail() to clean up any duplicate/stale
	 * groups that slipped past the deduplication check.
	 *
	 * Returns the number of groups cleaned up.
	 */
	cleanupStaleGroupsForTask(taskId: string, keepGroupId: string): number {
		const now = Date.now();
		const result = this.db
			.prepare(
				`UPDATE session_groups
				 SET completed_at = ?, version = version + 1
				 WHERE ref_id = ? AND group_type IN ('task', 'task_pair')
				   AND completed_at IS NULL AND id != ?`
			)
			.run(now, taskId, keepGroupId);
		if (result.changes > 0) {
			this.reactiveDb.notifyChange('session_groups');
		}
		return result.changes;
	}

	/**
	 * Delete a group and its members.
	 * The database schema uses ON DELETE CASCADE, so members and events are
	 * automatically deleted when the group is deleted.
	 */
	deleteGroup(groupId: string): boolean {
		const result = this.db.prepare(`DELETE FROM session_groups WHERE id = ?`).run(groupId);
		if (result.changes > 0) {
			this.reactiveDb.notifyChange('session_groups');
		}
		return result.changes > 0;
	}

	/**
	 * Revive a failed/cancelled group for human message injection.
	 * Clears completed_at WITHOUT resetting metadata — preserves conversation
	 * history, feedback iterations, and other state so the agent can continue
	 * from where it left off after the human provides guidance.
	 *
	 * Unlike resetGroupForRestart() which does a full metadata wipe, this is a
	 * lightweight revive intended for the "send message to failed task" flow.
	 */
	reviveGroup(groupId: string): SessionGroup | null {
		try {
			const result = this.db
				.prepare(
					`UPDATE session_groups
					 SET completed_at = NULL,
					     version = version + 1
					 WHERE id = ?`
				)
				.run(groupId);

			if (result.changes === 0) return null;
			this.reactiveDb.notifyChange('session_groups');
			return this.getGroup(groupId);
		} catch {
			// Unique constraint violation: another active group already exists for this ref_id.
			// Return null so callers treat this the same as a "group not found" condition.
			return null;
		}
	}

	/**
	 * Reset a failed/completed group for task restart.
	 * Clears completed_at and resets metadata fields to allow the task to be
	 * picked up fresh by the runtime.
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

		try {
			const result = this.db
				.prepare(
					`UPDATE session_groups
					 SET completed_at = NULL,
					     metadata = ?,
					     version = version + 1
					 WHERE id = ?`
				)
				.run(JSON.stringify(resetMetadata), groupId);

			if (result.changes === 0) return null;
			this.reactiveDb.notifyChange('session_groups');
			return this.getGroup(groupId);
		} catch {
			// Unique constraint violation: another active group already exists for this ref_id.
			// Return null so callers treat this the same as a "group not found" condition.
			return null;
		}
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
		this.reactiveDb.notifyChange('session_groups');
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
		this.reactiveDb.notifyChange('session_groups');
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
		this.reactiveDb.notifyChange('session_groups');
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
		this.reactiveDb.notifyChange('session_groups');
	}

	/**
	 * Set humanInterrupted flag without version check.
	 * When true, prevents automatic routing to leader when worker reaches idle state.
	 */
	setHumanInterrupted(groupId: string, value: boolean): void {
		const raw = (
			this.db.prepare(`SELECT metadata FROM session_groups WHERE id = ?`).get(groupId) as Record<
				string,
				unknown
			>
		)?.metadata as string;
		const currentMeta = this.parseMetadata(raw);
		const merged = { ...currentMeta, humanInterrupted: value };
		this.db
			.prepare(`UPDATE session_groups SET metadata = ? WHERE id = ?`)
			.run(JSON.stringify(merged), groupId);
		this.reactiveDb.notifyChange('session_groups');
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
		this.reactiveDb.notifyChange('session_groups');
	}

	/**
	 * Set (or clear) approvalSource in metadata without version check.
	 * Tracks who approved the task: 'human' for human approvals, 'leader_semi_auto' for
	 * auto-approvals in semi-autonomous mode. Also serves as an idempotency guard for
	 * the deferred auto-approve callback (skip if already set).
	 * Pass null to clear (roll back after a failed resumeWorkerFromHuman).
	 */
	setApprovalSource(groupId: string, source: 'human' | 'leader_semi_auto' | null): void {
		const raw = (
			this.db.prepare(`SELECT metadata FROM session_groups WHERE id = ?`).get(groupId) as Record<
				string,
				unknown
			>
		)?.metadata as string;
		const currentMeta = this.parseMetadata(raw);
		if (source === null) {
			// Remove the field entirely so rowToGroup returns null for approvalSource
			const { approvalSource: _removed, ...rest } = currentMeta;
			this.db
				.prepare(`UPDATE session_groups SET metadata = ? WHERE id = ?`)
				.run(JSON.stringify(rest), groupId);
		} else {
			const merged = { ...currentMeta, approvalSource: source };
			this.db
				.prepare(`UPDATE session_groups SET metadata = ? WHERE id = ?`)
				.run(JSON.stringify(merged), groupId);
		}
		this.reactiveDb.notifyChange('session_groups');
	}

	/**
	 * Set workerBypassed flag without version check.
	 * Records that the worker used a bypass marker (RESEARCH_ONLY, etc.) to skip git/PR gates.
	 * When set, checkLeaderPrMerged fails open even with approved=true (no PR exists).
	 */
	setWorkerBypassed(groupId: string, value: boolean): void {
		const raw = (
			this.db.prepare(`SELECT metadata FROM session_groups WHERE id = ?`).get(groupId) as Record<
				string,
				unknown
			>
		)?.metadata as string;
		const currentMeta = this.parseMetadata(raw);
		const merged = { ...currentMeta, workerBypassed: value };
		this.db
			.prepare(`UPDATE session_groups SET metadata = ? WHERE id = ?`)
			.run(JSON.stringify(merged), groupId);
		this.reactiveDb.notifyChange('session_groups');
	}

	/**
	 * Set executionId in group metadata without version check.
	 * Links this group to a mission_executions row for recurring mission correlation.
	 */
	setExecutionId(groupId: string, executionId: string): void {
		const raw = (
			this.db.prepare(`SELECT metadata FROM session_groups WHERE id = ?`).get(groupId) as Record<
				string,
				unknown
			>
		)?.metadata as string;
		const currentMeta = this.parseMetadata(raw);
		const merged = { ...currentMeta, executionId };
		this.db
			.prepare(`UPDATE session_groups SET metadata = ? WHERE id = ?`)
			.run(JSON.stringify(merged), groupId);
		this.reactiveDb.notifyChange('session_groups');
	}

	/**
	 * Set waitingForQuestion flag without version check.
	 * When set, the group is paused waiting for a human answer to an agent question.
	 */
	setWaitingForQuestion(
		groupId: string,
		waiting: boolean,
		session: 'worker' | 'leader' | null
	): void {
		const raw = (
			this.db.prepare(`SELECT metadata FROM session_groups WHERE id = ?`).get(groupId) as Record<
				string,
				unknown
			>
		)?.metadata as string;
		const currentMeta = this.parseMetadata(raw);
		const merged = { ...currentMeta, waitingForQuestion: waiting, waitingSession: session };
		this.db
			.prepare(`UPDATE session_groups SET metadata = ? WHERE id = ?`)
			.run(JSON.stringify(merged), groupId);
		this.reactiveDb.notifyChange('session_groups');
	}

	/**
	 * Mark the leader as having received at least one message.
	 * Set once by routeWorkerToLeader and resumeLeaderFromHuman; never reset.
	 * Used by onLeaderTerminalState to drop spurious pre-work idle events.
	 */
	setLeaderHasWork(groupId: string): void {
		const raw = (
			this.db.prepare(`SELECT metadata FROM session_groups WHERE id = ?`).get(groupId) as Record<
				string,
				unknown
			>
		)?.metadata as string;
		const currentMeta = this.parseMetadata(raw);
		if (currentMeta.leaderHasWork) return; // already set, skip the write
		const merged = { ...currentMeta, leaderHasWork: true };
		this.db
			.prepare(`UPDATE session_groups SET metadata = ? WHERE id = ?`)
			.run(JSON.stringify(merged), groupId);
		this.reactiveDb.notifyChange('session_groups');
	}

	/**
	 * Update the leader progress summary for a group without version check.
	 * Called at the end of each leader turn to persist a summary of task progress.
	 */
	setLeaderProgressSummary(groupId: string, summary: string): void {
		const raw = (
			this.db.prepare(`SELECT metadata FROM session_groups WHERE id = ?`).get(groupId) as Record<
				string,
				unknown
			>
		)?.metadata as string;
		const currentMeta = this.parseMetadata(raw);
		const merged = { ...currentMeta, leaderProgressSummary: summary };
		this.db
			.prepare(`UPDATE session_groups SET metadata = ? WHERE id = ?`)
			.run(JSON.stringify(merged), groupId);
		this.reactiveDb.notifyChange('session_groups');
	}

	/**
	 * Persist deferred Leader bootstrap configuration.
	 * Stored in metadata so runtime restart can still lazy-create the leader session.
	 */
	setDeferredLeader(groupId: string, deferredLeader: LeaderBootstrapConfig | null): void {
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
		this.reactiveDb.notifyChange('session_groups');
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
		this.reactiveDb.notifyChange('session_groups');
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

	// ===== Dead Loop Detection =====

	/**
	 * Append a gate failure record for dead loop detection.
	 * Keeps the last 50 records to bound storage size.
	 */
	recordGateFailure(groupId: string, gateName: string, reason: string): void {
		// reactiveDb.beginTransaction() batches change events only — not a DB transaction.
		// this.db.transaction() provides actual SQLite atomicity for the read-modify-write.
		this.reactiveDb.beginTransaction();
		try {
			this.db.transaction(() => {
				const raw = (
					this.db
						.prepare(`SELECT metadata FROM session_groups WHERE id = ?`)
						.get(groupId) as Record<string, unknown>
				)?.metadata as string;
				const currentMeta = this.parseMetadata(raw);
				const existing = currentMeta.gateFailures ?? [];
				const record: GateFailureRecord = { gateName, reason, timestamp: Date.now() };
				// Cap at 50 records — old entries are unlikely to matter for detection
				const updated = [...existing, record].slice(-50);
				const merged = { ...currentMeta, gateFailures: updated };
				this.db
					.prepare(`UPDATE session_groups SET metadata = ? WHERE id = ?`)
					.run(JSON.stringify(merged), groupId);
			})();
			this.reactiveDb.notifyChange('session_groups');
			this.reactiveDb.commitTransaction();
		} catch (e) {
			this.reactiveDb.abortTransaction();
			throw e;
		}
	}

	/**
	 * Get the full gate failure history for dead loop detection.
	 */
	getGateFailureHistory(groupId: string): GateFailureRecord[] {
		const raw = (
			this.db.prepare(`SELECT metadata FROM session_groups WHERE id = ?`).get(groupId) as Record<
				string,
				unknown
			>
		)?.metadata as string;
		const meta = this.parseMetadata(raw);
		return meta.gateFailures ?? [];
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
		this.reactiveDb.notifyChange('session_group_members');
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
		this.reactiveDb.notifyChange('task_group_events');
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
			submittedForReview: meta.submittedForReview === true,
			approved: meta.approved ?? false,
			rateLimit: meta.rateLimit ?? null,
			deferredLeader: meta.deferredLeader ?? null,
			humanInterrupted: meta.humanInterrupted === true,
			waitingForQuestion: meta.waitingForQuestion ?? false,
			waitingSession: meta.waitingSession ?? null,
			workerBypassed: meta.workerBypassed === true,
			approvalSource: meta.approvalSource ?? null,
			executionId: meta.executionId,
			leaderHasWork: meta.leaderHasWork === true,
			leaderProgressSummary: meta.leaderProgressSummary ?? null,
			createdAt: row.created_at as number,
			completedAt: (row.completed_at as number | null) ?? null,
		};
	}
}
