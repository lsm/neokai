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
import type { AgentSessionInit } from '../agent/agent-session';
import type { SessionGroupRepository, SessionGroup } from './session-group-repository';
import type { SessionObserver, TerminalState } from './session-observer';
import type { TaskManager } from './task-manager';
import type { GoalManager } from './goal-manager';
import type { LeaderToolCallbacks } from './leader-agent';
import { createLeaderAgentInit } from './leader-agent';
import type { LeaderAgentConfig, ReviewContext } from './leader-agent';

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
}

export interface TaskGroupManagerConfig {
	room: Room;
	groupRepo: SessionGroupRepository;
	sessionObserver: SessionObserver;
	taskManager: TaskManager;
	goalManager: GoalManager;
	sessionFactory: SessionFactory;
	workspacePath: string;
	model?: string;
}

/** Deferred leader session info stored until first routeWorkerToLeader call */
interface PendingLeaderInfo {
	init: AgentSessionInit;
	sessionId: string;
	onTerminal: (groupId: string, state: TerminalState) => void;
}

export class TaskGroupManager {
	private readonly room: Room;
	private readonly groupRepo: SessionGroupRepository;
	private readonly observer: SessionObserver;
	private readonly taskManager: TaskManager;
	private readonly goalManager: GoalManager;
	private readonly sessionFactory: SessionFactory;
	readonly workspacePath: string;
	readonly model?: string;

	/** Deferred leader inits — created in spawn(), consumed in routeWorkerToLeader() */
	private pendingLeaderInits = new Map<string, PendingLeaderInfo>();

	constructor(config: TaskGroupManagerConfig) {
		this.room = config.room;
		this.groupRepo = config.groupRepo;
		this.observer = config.sessionObserver;
		this.taskManager = config.taskManager;
		this.goalManager = config.goalManager;
		this.sessionFactory = config.sessionFactory;
		this.workspacePath = config.workspacePath;
		this.model = config.model;
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
		task: NeoTask,
		goal: RoomGoal,
		onWorkerTerminal: (groupId: string, state: TerminalState) => void,
		onLeaderTerminal: (groupId: string, state: TerminalState) => void,
		leaderCallbacksFactory: LeaderCallbacksFactory,
		workerConfig: WorkerConfig,
		reviewContext?: ReviewContext
	): Promise<SessionGroup> {
		const workerSessionId = `${workerConfig.role}:${this.room.id}:${task.id}:${generateUUID().slice(0, 8)}`;
		const leaderSessionId = `leader:${this.room.id}:${task.id}:${generateUUID().slice(0, 8)}`;

		// Create an isolated worktree for ALL tasks so each group works in its own branch.
		// Worker and leader sessions share the same worktree for the task.
		const branchName = taskTitleToBranchName(task.title) ?? `task/${workerSessionId}`;
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

		// Build Leader init using the actual group.id from the DB record — but don't start yet.
		// Leader reuses the worker's worktree path (no separate worktree).
		const leaderCallbacks = leaderCallbacksFactory(group.id);
		const leaderConfig: LeaderAgentConfig = {
			task,
			goal,
			room: this.room,
			sessionId: leaderSessionId,
			workspacePath: groupWorkspacePath,
			groupId: group.id,
			model: this.model,
			reviewContext,
		};
		const leaderInit = createLeaderAgentInit(leaderConfig, leaderCallbacks);

		// Store leader init for deferred creation in routeWorkerToLeader
		this.pendingLeaderInits.set(group.id, {
			init: leaderInit,
			sessionId: leaderSessionId,
			onTerminal: onLeaderTerminal,
		});

		// Set task status to in_progress
		await this.taskManager.startTask(task.id);

		// Create and start ONLY the worker session
		await this.sessionFactory.createAndStartSession(workerInit, workerConfig.role);

		// Kick off worker so the SDK streaming loop starts processing immediately.
		// Build a rich task context message so the user can see what the agent was tasked with.
		const taskPrompt = [
			`# Task: ${task.title}`,
			task.description ? `\n${task.description}` : '',
			`\n**Goal:** ${goal.title}`,
			`\n**Role:** ${workerConfig.role}`,
			workerConfig.role === 'coder'
				? `\n**Workspace:** Isolated worktree on branch \`${branchName}\``
				: '',
			`\nBegin working on this task.`,
		]
			.filter(Boolean)
			.join('\n');
		await this.sessionFactory.injectMessage(workerSessionId, taskPrompt);

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
	 */
	async routeWorkerToLeader(groupId: string, workerOutput: string): Promise<SessionGroup | null> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group) return null;

		// Lazy-start leader session if this is the first review round
		const pending = this.pendingLeaderInits.get(groupId);
		if (pending) {
			await this.sessionFactory.createAndStartSession(pending.init, 'leader');
			this.observer.observe(pending.sessionId, (state) => {
				pending.onTerminal(groupId, state);
			});
			this.pendingLeaderInits.delete(groupId);
		} else if (!this.sessionFactory.hasSession(group.leaderSessionId)) {
			// After restart: pending init lost and leader session doesn't exist.
			// Fail the group — task will be re-queued on next tick.
			await this.fail(groupId, 'Leader session lost during restart; task will be re-queued');
			return null;
		}

		// Inject worker output into Leader session
		await this.sessionFactory.injectMessage(group.leaderSessionId, workerOutput);

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
		this.pendingLeaderInits.delete(groupId);

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
		this.pendingLeaderInits.delete(groupId);

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
	 * Resume a group from human review — human approved or rejected the PR.
	 *
	 * Called when human calls goal.approveTask or goal.rejectTask.
	 * Transitions back to awaiting_leader and injects the approval/rejection message.
	 */
	async resumeFromHuman(groupId: string, message: string): Promise<SessionGroup | null> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group || group.state !== 'awaiting_human') return null;

		// Transition to awaiting_leader
		const updated = this.groupRepo.updateGroupState(groupId, 'awaiting_leader', group.version);
		if (!updated) return null;

		// Reset leader contract state for the new round
		this.groupRepo.resetLeaderContractViolations(groupId, updated.version);

		// Inject approval/rejection message to leader
		await this.sessionFactory.injectMessage(group.leaderSessionId, message);

		return this.groupRepo.getGroup(groupId);
	}

	/**
	 * Cancel a group - urgent control from human.
	 */
	async cancel(groupId: string): Promise<SessionGroup | null> {
		return this.fail(groupId, 'Cancelled by user');
	}
}
