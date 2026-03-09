/**
 * TaskGroupManager - Creates and manages (Worker, Leader) session groups
 *
 * Orchestrates the lifecycle of session groups:
 * 1. Spawns worker session immediately, defers leader creation until needed
 * 2. Routes worker terminal output to Leader for review (lazy-starts leader)
 * 3. Routes Leader feedback back to worker
 * 4. Handles group completion and failure
 *
 * Session creation is injected via SessionFactory for testability.
 * The worker role is configurable via WorkerConfig (planner, coder, general).
 */

import { generateUUID } from '@neokai/shared';
import type { Room, RoomGoal, NeoTask, MessageDeliveryMode } from '@neokai/shared';
import type { AgentSessionInit } from '../../agent/agent-session';
import type {
	SessionGroupRepository,
	SessionGroup,
	DeferredLeaderConfig,
} from '../state/session-group-repository';
import type { SessionObserver, TerminalState } from '../state/session-observer';
import type { TaskManager } from '../managers/task-manager';
import type { GoalManager } from '../managers/goal-manager';
import type { LeaderToolCallbacks } from '../agents/leader-agent';
import { createLeaderAgentInit } from '../agents/leader-agent';
import type { LeaderAgentConfig, ReviewContext } from '../agents/leader-agent';

/**
 * Convert a task title to a git branch name slug.
 *
 * e.g. "Add health check endpoint" → "task/add-health-check-endpoint"
 * Falls back to undefined if the title produces an empty slug (caller uses session-based default).
 */
function taskTitleToBranchName(title: string): string | undefined {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '') // remove special chars
		.trim()
		.replace(/\s+/g, '-') // spaces to hyphens
		.replace(/-+/g, '-') // collapse multiple hyphens
		.slice(0, 50); // truncate
	return slug ? `task/${slug}` : undefined;
}

/**
 * Abstract session interface for testability.
 * The real implementation delegates to AgentSession.fromInit + startStreamingQuery.
 */
export interface SessionFactory {
	createAndStartSession(init: AgentSessionInit, role: string): Promise<void>;
	injectMessage(
		sessionId: string,
		message: string,
		opts?: { deliveryMode?: MessageDeliveryMode }
	): Promise<void>;
	hasSession(sessionId: string): boolean;
	/**
	 * Get the current processing state for a session (best-effort).
	 */
	getProcessingState?(
		sessionId: string
	): 'idle' | 'queued' | 'processing' | 'interrupted' | 'waiting_for_input' | undefined;
	/**
	 * Answer a pending AskUserQuestion on the session.
	 * Returns true if a question was pending and answered, false otherwise.
	 */
	answerQuestion(sessionId: string, answer: string): Promise<boolean>;
	/**
	 * Create a git worktree for task isolation.
	 * Returns the worktree path, or null if not in a git repo.
	 */
	createWorktree(basePath: string, sessionId: string, branchName?: string): Promise<string | null>;
	/**
	 * Restore a session from DB after daemon restart.
	 * Adds it to the in-memory cache and starts the streaming query.
	 * Returns true if successful, false if session not found in DB.
	 */
	restoreSession(sessionId: string): Promise<boolean>;
	/**
	 * Set runtime MCP servers on a restored session.
	 * MCP servers are non-serializable and lost on restart — must be re-created.
	 */
	setSessionMcpServers(sessionId: string, mcpServers: Record<string, unknown>): boolean;
	/**
	 * Optional: stop and cleanup a session immediately.
	 * Used for urgent cancellation paths where the group should terminate now.
	 */
	stopSession?(sessionId: string): Promise<void>;
	/**
	 * Remove a worktree when a task group completes/fails/cancels.
	 * Returns true if worktree was removed, false if it didn't exist or was main repo.
	 */
	removeWorktree(workspacePath: string): Promise<boolean>;
}

/**
 * Factory that receives the actual group ID once the DB record is created.
 * This ensures Leader callbacks reference the correct group.id, not a pre-generated UUID.
 */
export type LeaderCallbacksFactory = (groupId: string) => LeaderToolCallbacks;

/**
 * Configuration for the worker agent in a group.
 * Determines which agent type and factory to use.
 */
export interface WorkerConfig {
	/** The specific agent role: 'planner', 'coder', 'general' */
	role: string;
	/** Factory that produces the AgentSessionInit for the worker */
	initFactory: (workerSessionId: string) => AgentSessionInit;
	/**
	 * Task-specific initial message injected into the worker session at startup.
	 * Contains task title, description, goal context, project background, etc.
	 * Built by the appropriate buildXxxTaskMessage() function in room-runtime.ts.
	 */
	taskMessage: string;
	/**
	 * Task/goal context string prepended to the worker output envelope when routing
	 * to the Leader for review. Built by buildLeaderTaskContext() in room-runtime.ts.
	 * If omitted, the envelope is sent without prepended context.
	 */
	leaderTaskContext?: string;
}

export interface TaskGroupManagerConfig {
	groupRepo: SessionGroupRepository;
	sessionObserver: SessionObserver;
	taskManager: TaskManager;
	goalManager: GoalManager;
	sessionFactory: SessionFactory;
	workspacePath: string;
	/** Leader model */
	model?: string;
	/** Worker model (defaults to model if not set) */
	workerModel?: string;
	/** Fetch room from DB by ID. Used to get CURRENT room config at route time. */
	getRoom: (roomId: string) => Room | null;
	/** Fetch task from DB by ID. Used to get CURRENT task data at route time. */
	getTask: (taskId: string) => Promise<NeoTask | null>;
	/** Fetch goal from DB by ID. Used to get CURRENT goal data at route time. */
	getGoal: (goalId: string) => Promise<RoomGoal | null>;
}

export class TaskGroupManager {
	private readonly groupRepo: SessionGroupRepository;
	private readonly observer: SessionObserver;
	private readonly taskManager: TaskManager;
	private readonly goalManager: GoalManager;
	private readonly sessionFactory: SessionFactory;
	private readonly getRoom: (roomId: string) => Room | null;
	private readonly getTaskById: (taskId: string) => Promise<NeoTask | null>;
	private readonly getGoalById: (goalId: string) => Promise<RoomGoal | null>;
	readonly workspacePath: string;
	private _model?: string;
	readonly workerModel?: string;

	constructor(config: TaskGroupManagerConfig) {
		this.groupRepo = config.groupRepo;
		this.observer = config.sessionObserver;
		this.taskManager = config.taskManager;
		this.goalManager = config.goalManager;
		this.sessionFactory = config.sessionFactory;
		this.getRoom = config.getRoom;
		this.getTaskById = config.getTask;
		this.getGoalById = config.getGoal;
		this.workspacePath = config.workspacePath;
		this._model = config.model;
		this.workerModel = config.workerModel;
	}

	/** Get the current model for leader sessions */
	get model(): string | undefined {
		return this._model;
	}

	/** Update the model for new leader sessions (e.g., when room settings change) */
	updateModel(model: string | undefined): void {
		this._model = model;
	}

	/**
	 * Get the effective model to use for worker sessions.
	 * Returns workerModel if set, otherwise falls back to model.
	 */
	getWorkerModel(): string | undefined {
		return this.workerModel ?? this._model;
	}

	/**
	 * Spawn a new (Worker, Leader) session group for a task.
	 *
	 * Flow:
	 * 1. Create worktree for task isolation (ALL roles get an isolated worktree)
	 * 2. Create worker session via workerConfig and start it immediately
	 * 3. Build leader init but DEFER creation until first review round
	 * 4. Create session_groups DB record (state: awaiting_worker)
	 * 5. Set task status to in_progress
	 * 6. Observe worker session for terminal state
	 * 7. Kick off worker (inject initial message)
	 */
	async spawn(
		room: Room,
		task: NeoTask,
		goal: RoomGoal,
		onWorkerTerminal: (groupId: string, state: TerminalState) => void,
		onLeaderTerminal: (groupId: string, state: TerminalState) => void,
		_leaderCallbacksFactory: LeaderCallbacksFactory,
		workerConfig: WorkerConfig,
		reviewContext?: ReviewContext
	): Promise<SessionGroup> {
		const workerSessionId = `${workerConfig.role}:${room.id}:${task.id}:${generateUUID().slice(0, 8)}`;
		const leaderSessionId = `leader:${room.id}:${task.id}:${generateUUID().slice(0, 8)}`;

		// Create an isolated worktree for ALL tasks so each group works in its own branch.
		// Worker and leader sessions share the same worktree for the task.
		// Colons in session IDs are invalid in git branch names, so sanitize the fallback.
		const branchName =
			taskTitleToBranchName(task.title) ?? `task/${workerSessionId.replace(/:/g, '-')}`;
		const worktreePath = await this.sessionFactory.createWorktree(
			this.workspacePath,
			workerSessionId,
			branchName
		);
		if (!worktreePath) {
			await this.taskManager.failTask(task.id, 'Failed to create isolated worktree for task');
			throw new Error('Worktree creation failed — task requires isolation');
		}
		const groupWorkspacePath = worktreePath;

		// Build worker init from the provided config, using the group workspace path
		const workerInit = workerConfig.initFactory(workerSessionId);
		workerInit.workspacePath = groupWorkspacePath;

		// Create session_groups record first so we have the real group.id for Leader callbacks.
		// This is critical: Leader MCP tool callbacks must reference group.id, not task.id.
		const group = this.groupRepo.createGroup(
			task.id,
			workerSessionId,
			leaderSessionId,
			workerConfig.role,
			groupWorkspacePath
		);

		// Persist deferred Leader bootstrap config in DB metadata.
		// This survives daemon restart, unlike in-memory maps.
		const deferredLeader: DeferredLeaderConfig = {
			roomId: room.id,
			goalId: goal.id,
			reviewContext,
			leaderTaskContext: workerConfig.leaderTaskContext,
		};
		this.groupRepo.setDeferredLeader(group.id, deferredLeader);

		// Set task status to in_progress
		await this.taskManager.startTask(task.id);

		// Create and start ONLY the worker session
		await this.sessionFactory.createAndStartSession(workerInit, workerConfig.role);

		// Kick off worker so the SDK streaming loop starts processing immediately.
		await this.sessionFactory.injectMessage(workerSessionId, workerConfig.taskMessage);

		// Observe worker session for terminal state
		this.observer.observe(workerSessionId, (state) => {
			onWorkerTerminal(group.id, state);
		});

		// Observe leader session proactively (even before it's created).
		// SessionObserver filters by sessionId and callback will fire once leader starts.
		this.observer.observe(leaderSessionId, (state) => {
			onLeaderTerminal(group.id, state);
		});

		return group;
	}

	/**
	 * Route worker terminal output to Leader for review.
	 *
	 * Lazy-starts the leader session on first call (deferred from spawn).
	 * Increments feedbackIteration to track review rounds (1-based).
	 *
	 * Called when worker reaches a terminal state (idle, waiting_for_input, interrupted).
	 *
	 * @param leaderCallbacksFactory - Factory to create leader tool callbacks
	 */
	async routeWorkerToLeader(
		groupId: string,
		workerOutput: string,
		leaderCallbacksFactory: LeaderCallbacksFactory
	): Promise<SessionGroup | null> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group) return null;

		// Lazy-start leader session if this is the first review round.
		// Deferred bootstrap data is persisted in DB metadata so restart is safe.
		const deferredLeader = group.deferredLeader;
		let shouldClearDeferredLeader = false;

		if (!this.sessionFactory.hasSession(group.leaderSessionId)) {
			if (!deferredLeader) {
				// No live leader session and no persisted bootstrap config.
				await this.fail(groupId, 'Leader session lost during restart; task will be re-queued');
				return null;
			}

			// Fetch CURRENT room, task, goal from DB (not cached).
			// This ensures config changes made after spawn() are respected
			// when the leader starts.
			const room = this.getRoom(deferredLeader.roomId);
			if (!room) {
				await this.fail(groupId, `Room ${deferredLeader.roomId} not found`);
				return null;
			}

			const task = await this.getTaskById(group.taskId);
			if (!task) {
				await this.fail(groupId, `Task ${group.taskId} not found`);
				return null;
			}

			const goal = await this.getGoalById(deferredLeader.goalId);
			if (!goal) {
				await this.fail(groupId, `Goal ${deferredLeader.goalId} not found`);
				return null;
			}

			const leaderCallbacks = leaderCallbacksFactory(group.id);
			const leaderConfig: LeaderAgentConfig = {
				task,
				goal,
				room, // Fresh from DB
				sessionId: group.leaderSessionId,
				workspacePath: group.workspacePath ?? this.workspacePath,
				groupId: group.id,
				model: this.model,
				reviewContext: deferredLeader.reviewContext,
			};
			const leaderInit = createLeaderAgentInit(leaderConfig, leaderCallbacks);

			await this.sessionFactory.createAndStartSession(leaderInit, 'leader');
		}

		if (deferredLeader) {
			// Clear only after first successful routing to leader.
			shouldClearDeferredLeader = true;
		}

		// Build the message to inject into the Leader session.
		// On the first review round, prepend the task/goal context so the Leader
		// knows what it's reviewing without it being baked into the system prompt.
		const leaderMessage = deferredLeader?.leaderTaskContext
			? `${deferredLeader.leaderTaskContext}\n\n---\n\n${workerOutput}`
			: workerOutput;

		// Inject worker output into Leader session
		await this.sessionFactory.injectMessage(group.leaderSessionId, leaderMessage);

		if (shouldClearDeferredLeader) {
			this.groupRepo.setDeferredLeader(groupId, null);
		}

		// Increment feedback iteration (1-based: first review = iteration 1)
		this.groupRepo.incrementFeedbackIteration(groupId, group.version);
		// Reset leader contract state for the new review round
		const afterIncrement = this.groupRepo.getGroup(groupId);
		if (afterIncrement) {
			this.groupRepo.resetLeaderContractViolations(groupId, afterIncrement.version);
		}
		// Keep legacy state column in sync for compatibility.
		this.groupRepo.setCompatibilityState(groupId, 'awaiting_leader');

		return this.groupRepo.getGroup(groupId);
	}

	/**
	 * Route Leader feedback to worker.
	 *
	 * Called when Leader calls send_to_worker(message).
	 * feedbackIteration is NOT incremented here — it's incremented in routeWorkerToLeader
	 * when the next review round starts.
	 */
	async routeLeaderToWorker(
		groupId: string,
		message: string,
		opts?: {
			deliveryMode?: MessageDeliveryMode;
			transitionState?: boolean;
		}
	): Promise<SessionGroup | null> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group) return null;

		// If worker is waiting for input (AskUserQuestion), answer the question.
		// Otherwise inject feedback as a regular message.
		const answered = await this.sessionFactory.answerQuestion(group.workerSessionId, message);
		if (!answered) {
			await this.sessionFactory.injectMessage(group.workerSessionId, message, {
				deliveryMode: opts?.deliveryMode,
			});
		}

		// Keep legacy state column in sync for compatibility.
		this.groupRepo.setCompatibilityState(groupId, 'awaiting_worker');

		return this.groupRepo.getGroup(groupId);
	}

	/**
	 * Complete a group - task is done.
	 *
	 * Called when Leader calls complete_task(summary).
	 */
	async complete(groupId: string, summary: string): Promise<SessionGroup | null> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group) return null;

		// Complete the group
		const updated = this.groupRepo.completeGroup(groupId, group.version);
		if (!updated) return null;

		// Complete the task
		await this.taskManager.completeTask(group.taskId, summary);

		// Stop observing sessions
		this.observer.unobserve(group.workerSessionId);
		this.observer.unobserve(group.leaderSessionId);

		// Cleanup worktree (best-effort)
		await this.cleanupWorktree(group);

		return updated;
	}

	/**
	 * Fail a group - task cannot be completed.
	 *
	 * Called when Leader calls fail_task(reason).
	 * Note: Worktree is NOT cleaned up on failure to allow debugging.
	 */
	async fail(groupId: string, reason: string): Promise<SessionGroup | null> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group) return null;

		// Fail the group
		const updated = this.groupRepo.failGroup(groupId, group.version);
		if (!updated) return null;

		// Fail the task
		await this.taskManager.failTask(group.taskId, reason);

		// Stop observing sessions
		this.observer.unobserve(group.workerSessionId);
		this.observer.unobserve(group.leaderSessionId);

		// NOTE: Worktree is NOT cleaned up on failure to allow debugging.
		// Use archiveGroup() to cleanup worktree for failed tasks.

		return updated;
	}

	/**
	 * Submit a group for human review - work is done, PR awaits human approval.
	 *
	 * Called when Leader calls submit_for_review(pr_url).
	 * Moves the task to 'review' status. The submittedForReview flag should be
	 * set by the caller to indicate the group is awaiting human action.
	 */
	async submitForReview(groupId: string, prUrl: string): Promise<SessionGroup | null> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group) return null;

		// Move task to review status with PR URL
		await this.taskManager.reviewTask(group.taskId, prUrl);
		this.groupRepo.setCompatibilityState(groupId, 'awaiting_human');

		return this.groupRepo.getGroup(groupId);
	}

	/**
	 * Resume a group from human review by injecting a message into the existing worker.
	 *
	 * Used for:
	 * - Rejection: worker addresses feedback
	 * - Planning approval: worker merges plan PR + creates tasks
	 *
	 * No new sessions are created. The existing observer will fire
	 * onWorkerTerminalState again when the worker finishes.
	 */
	async resumeWorkerFromHuman(groupId: string, message: string): Promise<boolean> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group || !group.submittedForReview) return false;

		// Reset state for the new review round.
		// feedbackIteration is reset to 0 so the resumed task gets a fresh iteration budget —
		// without this the task would immediately re-escalate on the very next leader cycle.
		this.groupRepo.resetLeaderContractViolations(groupId, group.version);
		this.groupRepo.setSubmittedForReview(groupId, false);
		const afterReset = this.groupRepo.getGroup(groupId);
		if (afterReset) {
			this.groupRepo.resetFeedbackIteration(groupId, afterReset.version);
		}

		// Inject approval message into existing worker session.
		await this.sessionFactory.injectMessage(group.workerSessionId, message);
		this.groupRepo.setCompatibilityState(groupId, 'awaiting_worker');

		return true;
	}

	/**
	 * Resume a group from awaiting_human by injecting a message into the existing leader.
	 *
	 * Used for ALL human resumptions (both approval and rejection):
	 * - Approval: leader merges PR and calls complete_task
	 * - Rejection: leader forwards feedback to worker via send_to_worker + handoff_to_worker
	 *
	 * No new sessions are created. The existing observer will fire
	 * onLeaderTerminalState again when the leader finishes.
	 */
	async resumeLeaderFromHuman(groupId: string, message: string): Promise<boolean> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group || !group.submittedForReview) return false;

		// Ensure leader session exists
		if (!this.sessionFactory.hasSession(group.leaderSessionId)) {
			return false;
		}

		// Inject into leader first. If this fails, caller can safely rollback
		// task status/approval without restoring group metadata.
		await this.sessionFactory.injectMessage(group.leaderSessionId, message);

		// Reset state for the new cycle (same as resumeWorkerFromHuman).
		// feedbackIteration is reset to 0 so the worker gets a fresh iteration budget.
		// submittedForReview is reset so the worker must re-submit for review after addressing feedback.
		// For approval path, these resets are harmless since leader will complete the task.
		// For rejection path, these resets are essential for the worker to have a fresh start.
		this.groupRepo.resetLeaderContractViolations(groupId, group.version);
		this.groupRepo.setSubmittedForReview(groupId, false);
		const afterReset = this.groupRepo.getGroup(groupId);
		if (afterReset) {
			this.groupRepo.resetFeedbackIteration(groupId, afterReset.version);
		}
		this.groupRepo.setCompatibilityState(groupId, 'awaiting_leader');

		return true;
	}

	/**
	 * Escalate a group to human review because max feedback iterations were reached.
	 *
	 * Called by the runtime (NOT the leader) when feedbackIteration >= maxFeedbackIterations.
	 * Sets submittedForReview flag and moves task to 'review' status so a human
	 * can inspect progress and decide whether to approve, reject, or provide guidance.
	 *
	 * Unlike submitForReview (triggered by leader's submit_for_review tool call),
	 * this escalation has no PR URL — it is a runtime-enforced lifecycle boundary.
	 */
	async escalateToHumanReview(groupId: string, _reason: string): Promise<SessionGroup | null> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group) return null;

		// Set submittedForReview flag to indicate awaiting human action
		this.groupRepo.setSubmittedForReview(groupId, true);
		this.groupRepo.setCompatibilityState(groupId, 'awaiting_human');

		// Move task to review status (no PR URL — runtime-enforced escalation)
		await this.taskManager.reviewTask(group.taskId);

		return this.groupRepo.getGroup(groupId);
	}

	/**
	 * Terminate a group without mutating task status.
	 * Used by runtime cancellation to clean up orphaned/active groups even when
	 * task status is already cancelled.
	 */
	async terminateGroup(groupId: string): Promise<SessionGroup | null> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group) return null;

		if (group.completedAt !== null) {
			this.observer.unobserve(group.workerSessionId);
			this.observer.unobserve(group.leaderSessionId);
			// Already terminal - cleanup worktree if not done
			await this.cleanupWorktree(group);
			return group;
		}

		const updated = this.groupRepo.failGroup(groupId, group.version);
		if (!updated) return null;

		this.observer.unobserve(group.workerSessionId);
		this.observer.unobserve(group.leaderSessionId);

		// Cleanup worktree (best-effort)
		await this.cleanupWorktree(group);

		return updated;
	}

	/**
	 * Cancel a group - urgent control from human.
	 * Marks the group as failed (terminal group state) and the task as cancelled.
	 */
	async cancel(groupId: string): Promise<SessionGroup | null> {
		const terminated = await this.terminateGroup(groupId);
		if (!terminated) return null;

		// Mark task as cancelled (distinct from failed — intentionally stopped by user)
		await this.taskManager.cancelTask(terminated.taskId);

		return terminated;
	}

	/**
	 * Archive a group - cleanup worktree regardless of state.
	 *
	 * Called when user archives a task via UI. This cleans up the worktree
	 * to free disk space even for failed tasks (kept for debugging initially).
	 *
	 * Note: This only cleans up the worktree. Task archival (archivedAt timestamp)
	 * is handled separately by TaskManager.archiveTask().
	 */
	async archiveGroup(groupId: string): Promise<SessionGroup | null> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group) return null;

		// Cleanup worktree (best-effort)
		await this.cleanupWorktree(group);

		return group;
	}

	/**
	 * Cleanup worktree for a completed/failed/cancelled group.
	 *
	 * Worktrees are created for task isolation and should be removed when
	 * the task reaches a terminal state to prevent disk space accumulation.
	 *
	 * Best-effort: logs errors but does not throw.
	 */
	private async cleanupWorktree(group: SessionGroup): Promise<void> {
		// Skip if no workspace path or if it's the main repo (not a worktree)
		if (!group.workspacePath || group.workspacePath === this.workspacePath) {
			return;
		}

		try {
			await this.sessionFactory.removeWorktree(group.workspacePath);
		} catch (error) {
			// Best-effort cleanup - don't fail the operation
			const errorMsg = error instanceof Error ? error.message : String(error);
			// eslint-disable-next-line no-console
			console.error(`[TaskGroupManager] Worktree cleanup failed for ${group.id}: ${errorMsg}`);
		}
	}
}
