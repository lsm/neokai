/**
 * TaskGroupManager - Creates and manages (Worker, Leader) session groups
 *
 * Orchestrates the lifecycle of session groups:
 * 1. Spawns session groups for pending tasks
 * 2. Routes worker terminal output to Leader for review
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
 * Abstract session interface for testability.
 * The real implementation delegates to AgentSession.fromInit + startStreamingQuery.
 */
export interface SessionFactory {
	createAndStartSession(init: AgentSessionInit, role: string): Promise<void>;
	injectMessage(sessionId: string, message: string): Promise<void>;
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

export class TaskGroupManager {
	private readonly room: Room;
	private readonly groupRepo: SessionGroupRepository;
	private readonly observer: SessionObserver;
	private readonly taskManager: TaskManager;
	private readonly goalManager: GoalManager;
	private readonly sessionFactory: SessionFactory;
	readonly workspacePath: string;
	readonly model?: string;

	/** In-memory map tracking whether Leader called a tool in current turn */
	readonly leaderCalledToolMap = new Map<string, boolean>();

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
	 * 1. Create worker session via workerConfig
	 * 2. Create Leader session with review tools
	 * 3. Create session_groups DB record (state: awaiting_worker)
	 * 4. Set task status to in_progress
	 * 5. Start observing both sessions
	 * 6. Kick off worker (inject initial message)
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

		// Build worker init from the provided config
		const workerInit = workerConfig.initFactory(workerSessionId);

		// Create session_groups record first so we have the real group.id for Leader callbacks.
		// This is critical: Leader MCP tool callbacks must reference group.id, not task.id.
		const group = this.groupRepo.createGroup(
			task.id,
			workerSessionId,
			leaderSessionId,
			workerConfig.role
		);

		// Build Leader init using the actual group.id from the DB record
		const leaderCallbacks = leaderCallbacksFactory(group.id);
		const leaderConfig: LeaderAgentConfig = {
			task,
			goal,
			room: this.room,
			sessionId: leaderSessionId,
			workspacePath: this.workspacePath,
			groupId: group.id,
			model: this.model,
			reviewContext,
		};
		const leaderInit = createLeaderAgentInit(leaderConfig, leaderCallbacks);

		// Set task status to in_progress
		await this.taskManager.startTask(task.id);

		// Create sessions
		await this.sessionFactory.createAndStartSession(workerInit, workerConfig.role);
		await this.sessionFactory.createAndStartSession(leaderInit, 'leader');

		// Kick off worker so the SDK streaming loop starts processing immediately
		await this.sessionFactory.injectMessage(
			workerSessionId,
			'Please begin working on the task described in your system prompt.'
		);

		// Observe worker session for terminal state
		this.observer.observe(workerSessionId, (state) => {
			onWorkerTerminal(group.id, state);
		});

		// Observe Leader session for terminal state (contract validation)
		this.observer.observe(leaderSessionId, (state) => {
			onLeaderTerminal(group.id, state);
		});

		return group;
	}

	/**
	 * Route worker terminal output to Leader for review.
	 *
	 * Called when worker reaches a terminal state (completed, error, waiting).
	 * Formats output and injects into Leader session as user message.
	 */
	async routeWorkerToLeader(groupId: string, workerOutput: string): Promise<SessionGroup | null> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group) return null;

		// Inject worker output into Leader session
		await this.sessionFactory.injectMessage(group.leaderSessionId, workerOutput);

		// Update group state to awaiting_leader
		const updated = this.groupRepo.updateGroupState(groupId, 'awaiting_leader', group.version);

		// Reset leader contract violations for the new review round
		if (updated) {
			this.groupRepo.resetLeaderContractViolations(groupId, updated.version);
			this.leaderCalledToolMap.delete(groupId);
		}

		return this.groupRepo.getGroup(groupId);
	}

	/**
	 * Route Leader feedback to worker for another iteration.
	 *
	 * Called when Leader calls send_to_worker(message).
	 */
	async routeLeaderToWorker(groupId: string, message: string): Promise<SessionGroup | null> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group) return null;

		// Inject feedback into worker session
		await this.sessionFactory.injectMessage(group.workerSessionId, message);

		// Update group state and increment feedback iteration
		const updated = this.groupRepo.updateGroupState(groupId, 'awaiting_worker', group.version);
		if (updated) {
			this.groupRepo.incrementFeedbackIteration(groupId, updated.version);
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

		// Complete the group
		const updated = this.groupRepo.completeGroup(groupId, group.version);
		if (!updated) return null;

		// Complete the task
		await this.taskManager.completeTask(group.taskId, summary);

		// Stop observing sessions
		this.observer.unobserve(group.workerSessionId);
		this.observer.unobserve(group.leaderSessionId);
		this.leaderCalledToolMap.delete(groupId);

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
		this.leaderCalledToolMap.delete(groupId);

		return updated;
	}

	/**
	 * Cancel a group - urgent control from human.
	 */
	async cancel(groupId: string): Promise<SessionGroup | null> {
		return this.fail(groupId, 'Cancelled by user');
	}
}
