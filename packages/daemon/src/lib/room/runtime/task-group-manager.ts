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
import type { Room, RoomGoal, NeoTask } from '@neokai/shared';
import type { AgentSessionInit } from '../../agent/agent-session';
import type { SessionGroupRepository, SessionGroup } from '../state/session-group-repository';
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
	injectMessage(sessionId: string, message: string): Promise<void>;
	hasSession(sessionId: string): boolean;
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
	model?: string;
	/** Fetch room from DB by ID. Used to get CURRENT room config at route time. */
	getRoom: (roomId: string) => Room | null;
	/** Fetch task from DB by ID. Used to get CURRENT task data at route time. */
	getTask: (taskId: string) => Promise<NeoTask | null>;
	/** Fetch goal from DB by ID. Used to get CURRENT goal data at route time. */
	getGoal: (goalId: string) => Promise<RoomGoal | null>;
}

/** Deferred leader config stored until first routeWorkerToLeader call */
interface DeferredLeaderConfig {
	roomId: string;
	taskId: string;
	goalId: string;
	groupId: string;
	sessionId: string;
	workspacePath: string;
	reviewContext?: ReviewContext;
	onTerminal: (groupId: string, state: TerminalState) => void;
	/** Task/goal context to prepend to the worker envelope on first review round */
	leaderTaskContext?: string;
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

	/** Deferred leader configs — created in spawn(), consumed in routeWorkerToLeader() */
	private pendingLeaderConfigs = new Map<string, DeferredLeaderConfig>();

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

		// Store leader config for deferred creation in routeWorkerToLeader.
		// Only IDs are stored; objects are fetched from DB at route time to ensure
		// config changes (room, task, goal) are respected when the leader starts.
		this.pendingLeaderConfigs.set(group.id, {
			roomId: room.id,
			taskId: task.id,
			goalId: goal.id,
			groupId: group.id,
			sessionId: leaderSessionId,
			workspacePath: groupWorkspacePath,
			reviewContext,
			onTerminal: onLeaderTerminal,
			leaderTaskContext: workerConfig.leaderTaskContext,
		});

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

		// Lazy-start leader session if this is the first review round
		let leaderTaskContext: string | undefined;
		const pending = this.pendingLeaderConfigs.get(groupId);
		if (pending) {
			// Fetch CURRENT room, task, goal from DB (not cached).
			// This ensures config changes made after spawn() are respected
			// when the leader starts.
			const room = this.getRoom(pending.roomId);
			if (!room) {
				await this.fail(groupId, `Room ${pending.roomId} not found`);
				return null;
			}

			const task = await this.getTaskById(pending.taskId);
			if (!task) {
				await this.fail(groupId, `Task ${pending.taskId} not found`);
				return null;
			}

			const goal = await this.getGoalById(pending.goalId);
			if (!goal) {
				await this.fail(groupId, `Goal ${pending.goalId} not found`);
				return null;
			}

			const leaderCallbacks = leaderCallbacksFactory(pending.groupId);
			const leaderConfig: LeaderAgentConfig = {
				task,
				goal,
				room, // Fresh from DB
				sessionId: pending.sessionId,
				workspacePath: pending.workspacePath,
				groupId: pending.groupId,
				model: this.model,
				reviewContext: pending.reviewContext,
			};
			const leaderInit = createLeaderAgentInit(leaderConfig, leaderCallbacks);

			await this.sessionFactory.createAndStartSession(leaderInit, 'leader');
			this.observer.observe(pending.sessionId, (state) => {
				pending.onTerminal(groupId, state);
			});
			leaderTaskContext = pending.leaderTaskContext;
			this.pendingLeaderConfigs.delete(groupId);
		} else if (!this.sessionFactory.hasSession(group.leaderSessionId)) {
			// After restart: pending config lost and leader session doesn't exist.
			// Fail the group — task will be re-queued on next tick.
			await this.fail(groupId, 'Leader session lost during restart; task will be re-queued');
			return null;
		}

		// Build the message to inject into the Leader session.
		// On the first review round, prepend the task/goal context so the Leader
		// knows what it's reviewing without it being baked into the system prompt.
		const leaderMessage = leaderTaskContext
			? `${leaderTaskContext}\n\n---\n\n${workerOutput}`
			: workerOutput;

		// Inject worker output into Leader session
		await this.sessionFactory.injectMessage(group.leaderSessionId, leaderMessage);

		// Update group state to awaiting_leader
		const updated = this.groupRepo.updateGroupState(groupId, 'awaiting_leader', group.version);

		if (updated) {
			// Increment feedback iteration (1-based: first review = iteration 1)
			this.groupRepo.incrementFeedbackIteration(groupId, updated.version);
			// Reset leader contract state for the new review round
			const afterIncrement = this.groupRepo.getGroup(groupId);
			if (afterIncrement) {
				this.groupRepo.resetLeaderContractViolations(groupId, afterIncrement.version);
			}
		}

		return this.groupRepo.getGroup(groupId);
	}

	/**
	 * Route Leader feedback to worker for another iteration.
	 *
	 * Called when Leader calls send_to_worker(message).
	 * feedbackIteration is NOT incremented here — it's incremented in routeWorkerToLeader
	 * when the next review round starts.
	 */
	async routeLeaderToWorker(groupId: string, message: string): Promise<SessionGroup | null> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group) return null;

		// If worker is waiting for input (AskUserQuestion), answer the question.
		// Otherwise inject feedback as a regular message.
		const answered = await this.sessionFactory.answerQuestion(group.workerSessionId, message);
		if (!answered) {
			await this.sessionFactory.injectMessage(group.workerSessionId, message);
		}

		// Update group state back to awaiting_worker
		this.groupRepo.updateGroupState(groupId, 'awaiting_worker', group.version);

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
		this.pendingLeaderConfigs.delete(groupId);

		return updated;
	}

	/**
	 * Fail a group - task cannot be completed.
	 *
	 * Called when Leader calls fail_task(reason).
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
		this.pendingLeaderConfigs.delete(groupId);

		return updated;
	}

	/**
	 * Submit a group for human review - work is done, PR awaits human approval.
	 *
	 * Called when Leader calls submit_for_review(pr_url).
	 * Transitions the group to 'awaiting_human' (slot stays occupied but paused)
	 * and moves the task to 'review' status.
	 */
	async submitForReview(groupId: string, prUrl: string): Promise<SessionGroup | null> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group) return null;

		// Pause the group in awaiting_human (does NOT free the slot — slot exclusion is done in executeTick)
		const updated = this.groupRepo.updateGroupState(groupId, 'awaiting_human', group.version);
		if (!updated) return null;

		// Move task to review status with PR URL
		await this.taskManager.reviewTask(group.taskId, prUrl);

		return updated;
	}

	/**
	 * Resume a group from awaiting_human by injecting a message into the existing worker.
	 *
	 * Used for all task types after human approval or rejection:
	 * - Planning approve: worker merges plan PR + creates tasks
	 * - Coding approve: worker merges code PR
	 * - Coding reject: worker addresses feedback
	 *
	 * No new sessions are created. The existing observer will fire
	 * onWorkerTerminalState again when the worker finishes.
	 */
	async resumeWorkerFromHuman(groupId: string, message: string): Promise<boolean> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group || group.state !== 'awaiting_human') return false;

		// Transition: awaiting_human → awaiting_worker
		const updated = this.groupRepo.updateGroupState(groupId, 'awaiting_worker', group.version);
		if (!updated) return false;

		// Reset state for the new review round.
		// feedbackIteration is reset to 0 so the resumed task gets a fresh iteration budget —
		// without this the task would immediately re-escalate on the very next leader cycle.
		this.groupRepo.resetLeaderContractViolations(groupId, updated.version);
		this.groupRepo.setSubmittedForReview(groupId, false);
		const afterReset = this.groupRepo.getGroup(groupId);
		if (afterReset) {
			this.groupRepo.resetFeedbackIteration(groupId, afterReset.version);
		}

		// Inject approval message into existing worker session.
		// If injection fails (e.g., session not in cache after restart), rollback
		// the group state so the task stays in review for retry.
		try {
			await this.sessionFactory.injectMessage(group.workerSessionId, message);
		} catch (error) {
			// Rollback: revert group back to awaiting_human
			const current = this.groupRepo.getGroup(groupId);
			if (current && current.state === 'awaiting_worker') {
				this.groupRepo.updateGroupState(groupId, 'awaiting_human', current.version);
			}
			throw error;
		}

		return true;
	}

	/**
	 * Escalate a group to human review because max feedback iterations were reached.
	 *
	 * Called by the runtime (NOT the leader) when feedbackIteration >= maxFeedbackIterations.
	 * Transitions the group to 'awaiting_human' and the task to 'review' so a human
	 * can inspect progress and decide whether to approve, reject, or provide guidance.
	 *
	 * Unlike submitForReview (triggered by leader's submit_for_review tool call),
	 * this escalation has no PR URL — it is a runtime-enforced lifecycle boundary.
	 */
	async escalateToHumanReview(groupId: string, reason: string): Promise<SessionGroup | null> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group) return null;

		// Pause the group in awaiting_human (slot stays occupied but paused)
		const updated = this.groupRepo.updateGroupState(groupId, 'awaiting_human', group.version);
		if (!updated) return null;

		// Move task to review status (no PR URL — runtime-enforced escalation)
		await this.taskManager.reviewTask(group.taskId);

		return updated;
	}

	/**
	 * Cancel a group - urgent control from human.
	 * Marks the group as failed (terminal group state) and the task as cancelled.
	 */
	async cancel(groupId: string): Promise<SessionGroup | null> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group) return null;

		const updated = this.groupRepo.failGroup(groupId, group.version);
		if (!updated) return null;

		// Mark task as cancelled (distinct from failed — intentionally stopped by user)
		await this.taskManager.cancelTask(group.taskId);

		this.observer.unobserve(group.workerSessionId);
		this.observer.unobserve(group.leaderSessionId);
		this.pendingLeaderConfigs.delete(groupId);

		return updated;
	}
}
