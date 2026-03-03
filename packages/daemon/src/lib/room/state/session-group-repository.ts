/**
 * SessionGroupRepository - CRUD for session_groups, session_group_members, session_group_messages
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
	/** Whether the plan has been approved by human (gates create_task tool and worker exit gate phase) */
	planApproved?: boolean;
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
	/** Whether the plan has been approved by human (gates create_task tool and worker exit gate phase) */
	planApproved: boolean;
	createdAt: number;
	completedAt: number | null;
}

export interface SessionGroupMessage {
	id: number;
	groupId: string;
	sessionId: string | null;
	role: string;
	messageType: string;
	content: string;
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
	 * Set planApproved flag without version check.
	 * Records that the human has approved the plan, gating create_task tool for phase 2.
	 */
	setPlanApproved(groupId: string, value: boolean): void {
		const raw = (
			this.db.prepare(`SELECT metadata FROM session_groups WHERE id = ?`).get(groupId) as Record<
				string,
				unknown
			>
		)?.metadata as string;
		const currentMeta = this.parseMetadata(raw);
		const merged = { ...currentMeta, planApproved: value };
		this.db
			.prepare(`UPDATE session_groups SET metadata = ? WHERE id = ?`)
			.run(JSON.stringify(merged), groupId);
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

	// ===== Messages (append-only unified conversation timeline) =====

	appendMessage(params: {
		groupId: string;
		sessionId?: string;
		role: string;
		messageType: string;
		content: string;
	}): number {
		const result = this.db
			.prepare(
				`INSERT INTO session_group_messages (group_id, session_id, role, message_type, content, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(
				params.groupId,
				params.sessionId ?? null,
				params.role,
				params.messageType,
				params.content,
				Date.now()
			);
		return Number(result.lastInsertRowid);
	}

	getMessages(
		groupId: string,
		options?: { afterId?: number; limit?: number }
	): { messages: SessionGroupMessage[]; hasMore: boolean } {
		const limit = options?.limit ?? 100;
		const afterId = options?.afterId ?? 0;

		const rows = this.db
			.prepare(
				`SELECT * FROM session_group_messages
			 WHERE group_id = ? AND id > ?
			 ORDER BY id ASC
			 LIMIT ?`
			)
			.all(groupId, afterId, limit + 1) as Record<string, unknown>[];

		const hasMore = rows.length > limit;
		const messages = rows.slice(0, limit).map((r) => ({
			id: r.id as number,
			groupId: r.group_id as string,
			sessionId: r.session_id as string | null,
			role: r.role as string,
			messageType: r.message_type as string,
			content: r.content as string,
			createdAt: r.created_at as number,
		}));

		return { messages, hasMore };
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
			planApproved: meta.planApproved ?? false,
			createdAt: row.created_at as number,
			completedAt: (row.completed_at as number | null) ?? null,
		};
	}
}
