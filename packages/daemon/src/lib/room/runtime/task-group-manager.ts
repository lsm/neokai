/**
 * TaskGroupManager - Creates and manages (Worker, Leader) session groups
 *
 * Orchestrates the lifecycle of session groups:
 * 1. Spawns worker and leader sessions together (eager initialization)
 * 2. Routes worker terminal output to Leader for review
 * 3. Routes Leader feedback back to worker
 * 4. Handles group completion and failure
 *
 * Session creation is injected via SessionFactory for testability.
 * The worker role is configurable via WorkerConfig (planner, coder, general).
 */

import { generateUUID } from '@neokai/shared';
import type { Room, RoomGoal, NeoTask, MessageDeliveryMode } from '@neokai/shared';
import type { AgentSessionInit } from '../../agent/agent-session';
import { Logger } from '../../logger';
import type {
	SessionGroupRepository,
	SessionGroup,
	LeaderBootstrapConfig,
} from '../state/session-group-repository';
import type { SessionObserver, TerminalState } from '../state/session-observer';
import type { TaskManager } from '../managers/task-manager';
import type { GoalManager } from '../managers/goal-manager';
import type { DaemonHub } from '../../daemon-hub';
import type { LeaderToolCallbacks } from '../agents/leader-agent';
import { createLeaderAgentInit } from '../agents/leader-agent';
import type { LeaderAgentConfig, ReviewContext } from '../agents/leader-agent';

/**
 * Convert a task title to a git branch name slug.
 *
 * e.g. "Add health check endpoint" → "task/add-health-check-endpoint"
 * Falls back to undefined if the title produces an empty slug (caller uses session-based default).
 */
const log = new Logger('task-group-manager');

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
	 * Adds it to the in-memory cache but does NOT start the streaming query
	 * (lazy start via injectMessage or startSession).
	 * Returns true if successful, false if session not found in DB.
	 */
	restoreSession(sessionId: string): Promise<boolean>;
	/**
	 * Start the SDK streaming query for a restored session without injecting a message.
	 *
	 * Used for sessions in waiting_for_input state after daemon restart: the SDK
	 * will re-encounter the pending AskUserQuestion tool call in its session file
	 * and re-call canUseTool, re-establishing the pendingResolver so the user can
	 * answer the question via question.respond RPC.
	 *
	 * Returns true if successful, false if the session is not in the cache.
	 */
	startSession(sessionId: string): Promise<boolean>;
	/**
	 * Set runtime MCP servers on a restored session.
	 * MCP servers are non-serializable and lost on restart — must be re-created.
	 */
	setSessionMcpServers(sessionId: string, mcpServers: Record<string, unknown>): boolean;
	/**
	 * Optional: interrupt a session's current LLM generation without cleanup.
	 * The session remains in cache and can accept new messages immediately.
	 * Used for user-initiated interrupts that keep the task alive.
	 */
	interruptSession?(sessionId: string): Promise<void>;
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
	/** Leader provider (auto-detected from model if omitted) */
	provider?: string;
	/** Worker model (defaults to model if not set) */
	workerModel?: string;
	/** Worker provider (auto-detected from workerModel if omitted) */
	workerProvider?: string;
	/** Fetch room from DB by ID. Used to get CURRENT room config at route time. */
	getRoom: (roomId: string) => Room | null;
	/** Fetch task from DB by ID. Used to get CURRENT task data at route time. */
	getTask: (taskId: string) => Promise<NeoTask | null>;
	/** Fetch goal from DB by ID. Used to get CURRENT goal data at route time. */
	getGoal: (goalId: string) => Promise<RoomGoal | null>;
	/** Used to emit task update events when leader modifies tasks */
	daemonHub?: DaemonHub;
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
	private readonly daemonHub?: DaemonHub;
	readonly workspacePath: string;
	private _model?: string;
	private _provider?: string;
	readonly workerModel?: string;
	readonly workerProvider?: string;

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
		this._provider = config.provider;
		this.workerModel = config.workerModel;
		this.workerProvider = config.workerProvider;
		this.daemonHub = config.daemonHub;
	}

	/** Get the current model for leader sessions */
	get model(): string | undefined {
		return this._model;
	}

	/** Get the current provider for leader sessions */
	get provider(): string | undefined {
		return this._provider;
	}

	/** Update the model and provider for new leader sessions (e.g., when room settings change) */
	updateModel(model: string | undefined, provider?: string): void {
		this._model = model;
		this._provider = provider;
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
	 * 2. Create session_groups DB record (active group with submittedForReview=false)
	 * 3. Persist leader bootstrap config in DB metadata (for restart recovery + leaderTaskContext)
	 * 4. Set task status to in_progress
	 * 5. Create and start worker session immediately
	 * 6. Create and start leader session immediately (eager initialization)
	 * 7. Observe worker session for terminal state BEFORE injecting message (prevents race condition)
	 * 8. Observe leader session for terminal state
	 * 9. Kick off worker (inject initial message)
	 *
	 * Both sessions are created eagerly so the leader is ready when the worker completes.
	 * The worker observer is set up before injection to prevent a race where the worker
	 * completes before the observer fires.
	 */
	async spawn(
		room: Room,
		task: NeoTask,
		goal: RoomGoal | null,
		onWorkerTerminal: (groupId: string, state: TerminalState) => void,
		onLeaderTerminal: (groupId: string, state: TerminalState) => void,
		leaderCallbacksFactory: LeaderCallbacksFactory,
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

		// Persist leader bootstrap config in DB metadata.
		// Survives daemon restart (used by recoverZombieGroups to recreate leader if lost)
		// and stores leaderTaskContext for the routing message injected when worker completes.
		// eagerlyCreated=true signals that the leader session was created here in spawn(),
		// not deferred — this lets recoverZombieGroups skip injecting "continue reviewing"
		// when feedbackIteration==0 (the leader has no work to review yet on first restore).
		const deferredLeader: LeaderBootstrapConfig = {
			roomId: room.id,
			goalId: goal?.id ?? null,
			reviewContext,
			leaderTaskContext: workerConfig.leaderTaskContext,
			eagerlyCreated: true,
		};
		this.groupRepo.setDeferredLeader(group.id, deferredLeader);

		// Set task status to in_progress
		await this.taskManager.startTask(task.id);

		// Create and start worker session
		await this.sessionFactory.createAndStartSession(workerInit, workerConfig.role);

		// Create and start leader session eagerly alongside the worker.
		// This ensures the leader is ready when the worker completes and routing is triggered.
		// Previously the leader was lazily created in routeWorkerToLeader(), but this caused
		// routing to be skipped when the observer event fired before lazy init ran.
		const leaderCallbacks = leaderCallbacksFactory(group.id);
		const leaderConfig: LeaderAgentConfig = {
			task,
			goal,
			room,
			sessionId: leaderSessionId,
			workspacePath: groupWorkspacePath,
			groupId: group.id,
			model: this._model,
			provider: this._provider,
			reviewContext,
			goalManager: this.goalManager,
			taskManager: this.taskManager,
			groupRepo: this.groupRepo,
			daemonHub: this.daemonHub,
		};
		const leaderInit = createLeaderAgentInit(leaderConfig, leaderCallbacks);
		await this.sessionFactory.createAndStartSession(leaderInit, 'leader');
		log.info(
			`[spawn] Group ${group.id}: leader session ${leaderSessionId} created eagerly alongside worker`
		);

		// Observe worker session for terminal state BEFORE injecting the initial message.
		// This prevents a race where the worker processes and completes synchronously before
		// the observer is registered, causing the terminal event to be missed entirely.
		this.observer.observe(workerSessionId, (state) => {
			onWorkerTerminal(group.id, state);
		});

		// Observe leader session for terminal state
		this.observer.observe(leaderSessionId, (state) => {
			onLeaderTerminal(group.id, state);
		});

		// Kick off worker so the SDK streaming loop starts processing immediately.
		// Observer is already registered above — no race window.
		await this.sessionFactory.injectMessage(workerSessionId, workerConfig.taskMessage);

		return group;
	}

	/**
	 * Route worker terminal output to Leader for review.
	 *
	 * The leader session is created eagerly in spawn(), so this method normally just
	 * injects the worker output into the already-running leader session.
	 * If the leader is missing (e.g., after a daemon restart where restore failed),
	 * falls back to recreating it using the deferredLeader bootstrap config.
	 *
	 * Increments feedbackIteration to track review rounds (1-based).
	 *
	 * Called when worker reaches a terminal state (idle, waiting_for_input, interrupted).
	 *
	 * @param leaderCallbacksFactory - Factory to create leader tool callbacks (used only for restart recovery)
	 */
	async routeWorkerToLeader(
		groupId: string,
		workerOutput: string,
		leaderCallbacksFactory: LeaderCallbacksFactory
	): Promise<SessionGroup | null> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group) {
			log.warn(`[routeWorkerToLeader] Group ${groupId}: not found in repository`);
			return null;
		}

		// Restart-recovery fallback: re-create the leader session from persisted bootstrap config.
		// In the normal code path the leader is created eagerly in spawn(), so leaderAlreadyExists
		// will be true and this block is skipped. This only runs after a daemon restart where the
		// in-memory session cache was cleared.
		const deferredLeader = group.deferredLeader;
		let shouldClearDeferredLeader = false;

		const leaderAlreadyExists = this.sessionFactory.hasSession(group.leaderSessionId);
		log.debug(
			`[routeWorkerToLeader] Group ${groupId}: leader session exists=${leaderAlreadyExists}, ` +
				`deferredLeader=${!!deferredLeader}, feedbackIteration=${group.feedbackIteration}`
		);

		if (!leaderAlreadyExists) {
			if (!deferredLeader) {
				// No live leader session and no persisted bootstrap config.
				log.error(
					`[routeWorkerToLeader] Group ${groupId}: no leader session and no deferredLeader config — failing task`
				);
				await this.fail(groupId, 'Leader session lost during restart; task will be re-queued');
				return null;
			}

			// Fetch CURRENT room, task, goal from DB (not cached).
			// This ensures config changes made after spawn() are respected
			// when the leader starts.
			const room = this.getRoom(deferredLeader.roomId);
			if (!room) {
				log.error(
					`[routeWorkerToLeader] Group ${groupId}: room ${deferredLeader.roomId} not found — failing task`
				);
				await this.fail(groupId, `Room ${deferredLeader.roomId} not found`);
				return null;
			}

			const task = await this.getTaskById(group.taskId);
			if (!task) {
				log.error(
					`[routeWorkerToLeader] Group ${groupId}: task ${group.taskId} not found — failing task`
				);
				await this.fail(groupId, `Task ${group.taskId} not found`);
				return null;
			}

			const goal = deferredLeader.goalId ? await this.getGoalById(deferredLeader.goalId) : null;
			if (deferredLeader.goalId && !goal) {
				log.error(
					`[routeWorkerToLeader] Group ${groupId}: goal ${deferredLeader.goalId} not found — failing task`
				);
				await this.fail(groupId, `Goal ${deferredLeader.goalId} not found`);
				return null;
			}

			log.info(
				`[routeWorkerToLeader] Group ${groupId}: creating leader session ${group.leaderSessionId}`
			);
			const leaderCallbacks = leaderCallbacksFactory(group.id);
			const leaderConfig: LeaderAgentConfig = {
				task,
				goal,
				room, // Fresh from DB
				sessionId: group.leaderSessionId,
				workspacePath: group.workspacePath ?? this.workspacePath,
				groupId: group.id,
				model: this.model,
				provider: this._provider,
				reviewContext: deferredLeader.reviewContext,
				goalManager: this.goalManager,
				taskManager: this.taskManager,
				groupRepo: this.groupRepo,
				daemonHub: this.daemonHub,
			};
			const leaderInit = createLeaderAgentInit(leaderConfig, leaderCallbacks);

			await this.sessionFactory.createAndStartSession(leaderInit, 'leader');
			log.info(
				`[routeWorkerToLeader] Group ${groupId}: leader session ${group.leaderSessionId} created successfully`
			);
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
		log.debug(
			`[routeWorkerToLeader] Group ${groupId}: injecting worker output into leader session`
		);
		// Mark leader as having work before injecting so onLeaderTerminalState won't drop
		// the resulting idle event even if the leader completes synchronously.
		this.groupRepo.setLeaderHasWork(groupId);
		await this.sessionFactory.injectMessage(group.leaderSessionId, leaderMessage);
		log.info(
			`[routeWorkerToLeader] Group ${groupId}: worker output injected into leader session successfully`
		);

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

		// Clear humanInterrupted: the leader is routing a message to the worker,
		// so the next worker completion should route back to leader normally.
		if (group.humanInterrupted) {
			this.groupRepo.setHumanInterrupted(groupId, false);
		}

		// Ensure worker session is alive before attempting to route feedback.
		// If the worker session is not in the runtime cache (e.g., after daemon restart
		// or session eviction), restore it from DB.
		// injectMessage will lazily start the SDK query via ensureQueryStarted().
		if (!this.sessionFactory.hasSession(group.workerSessionId)) {
			const restored = await this.sessionFactory.restoreSession(group.workerSessionId);
			if (restored) {
				log.info(
					`[routeLeaderToWorker] Group ${groupId}: restored worker session ${group.workerSessionId} from DB`
				);
			} else {
				log.error(
					`[routeLeaderToWorker] Group ${groupId}: failed to restore worker session ` +
						`${group.workerSessionId} — session not found in DB`
				);
				await this.fail(groupId, 'Worker session lost during restart; task will be re-queued');
				return null;
			}
		}

		// If worker is waiting for input (AskUserQuestion), answer the question.
		// Otherwise inject feedback as a regular message.
		const answered = await this.sessionFactory.answerQuestion(group.workerSessionId, message);
		if (!answered) {
			await this.sessionFactory.injectMessage(group.workerSessionId, message, {
				deliveryMode: opts?.deliveryMode,
			});
		}

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

		// Safety net: clean up any other stale active groups for this task BEFORE completing
		// the canonical group. This ensures we aren't racing against the unique index, and
		// any stale duplicates are resolved before the primary group transitions.
		const staleCount = this.groupRepo.cleanupStaleGroupsForTask(group.taskId, groupId);
		if (staleCount > 0) {
			log.warn(
				`[complete] Task ${group.taskId}: cleaned up ${staleCount} stale active group(s) before completion`
			);
		}

		// Complete the group
		const updated = this.groupRepo.completeGroup(groupId, group.version);
		if (!updated) return null;

		// Complete the task
		await this.taskManager.completeTask(group.taskId, summary);

		// Stop observing sessions
		this.observer.unobserve(group.workerSessionId);
		this.observer.unobserve(group.leaderSessionId);

		// Worktree preserved for potential reactivation — only archiveGroup() cleans up

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

		// Safety net: clean up any other stale active groups for this task BEFORE failing
		// the canonical group. This ensures stale duplicates are resolved before the
		// primary group transitions.
		const staleCount = this.groupRepo.cleanupStaleGroupsForTask(group.taskId, groupId);
		if (staleCount > 0) {
			log.warn(
				`[fail] Task ${group.taskId}: cleaned up ${staleCount} stale active group(s) before failure`
			);
		}

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

		// Reset group metadata for the new review round.
		// feedbackIteration is reset to 0 so the resumed task gets a fresh iteration budget —
		// without this the task would immediately re-escalate on the very next leader cycle.
		this.groupRepo.resetLeaderContractViolations(groupId, group.version);
		this.groupRepo.setSubmittedForReview(groupId, false);
		const afterReset = this.groupRepo.getGroup(groupId);
		if (afterReset) {
			this.groupRepo.resetFeedbackIteration(groupId, afterReset.version);
		}

		// Inject message into existing worker session.
		await this.sessionFactory.injectMessage(group.workerSessionId, message);

		return true;
	}

	/**
	 * Resume a submitted-for-review group by injecting a message into the existing leader.
	 *
	 * Used for ALL human resumptions (both approval and rejection):
	 * - Approval: leader merges PR and calls complete_task
	 * - Rejection: leader forwards feedback to worker via send_to_worker
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
		// Mark before inject so the resulting terminal event is not dropped.
		this.groupRepo.setLeaderHasWork(groupId);
		await this.sessionFactory.injectMessage(group.leaderSessionId, message);

		// Reset group metadata for the new cycle (same as resumeWorkerFromHuman).
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
			// Worktree preserved for potential reactivation — only archiveGroup() cleans up
			return group;
		}

		const updated = this.groupRepo.failGroup(groupId, group.version);
		if (!updated) return null;

		this.observer.unobserve(group.workerSessionId);
		this.observer.unobserve(group.leaderSessionId);

		// Worktree preserved for potential reactivation — only archiveGroup() cleans up

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
