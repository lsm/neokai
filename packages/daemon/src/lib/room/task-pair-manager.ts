/**
 * TaskPairManager - Creates and manages (Craft, Lead) agent pairs
 *
 * Orchestrates the lifecycle of task pairs:
 * 1. Spawns (Craft, Lead) pairs for pending tasks
 * 2. Routes Craft terminal output to Lead for review
 * 3. Routes Lead feedback back to Craft
 * 4. Handles pair completion and failure
 *
 * Session creation is injected via SessionFactory for testability.
 */

import { generateUUID } from '@neokai/shared';
import type { Room, RoomGoal, NeoTask } from '@neokai/shared';
import type { TaskPairRepository, TaskPair } from './task-pair-repository';
import type { SessionObserver, TerminalState } from './session-observer';
import type { TaskManager } from './task-manager';
import type { GoalManager } from './goal-manager';
import type { CraftAgentConfig } from './craft-agent';
import type { LeadAgentConfig, LeadToolCallbacks } from './lead-agent';
import { createCraftAgentInit } from './craft-agent';
import { createLeadAgentInit } from './lead-agent';

/**
 * Abstract session interface for testability.
 * The real implementation delegates to AgentSession.fromInit + startStreamingQuery.
 */
export interface SessionFactory {
	createAndStartSession(
		init: ReturnType<typeof createCraftAgentInit>,
		role: 'craft' | 'lead'
	): Promise<void>;
	injectMessage(sessionId: string, message: string): Promise<void>;
}

export interface TaskPairManagerConfig {
	room: Room;
	taskPairRepo: TaskPairRepository;
	sessionObserver: SessionObserver;
	taskManager: TaskManager;
	goalManager: GoalManager;
	sessionFactory: SessionFactory;
	workspacePath: string;
	model?: string;
}

export class TaskPairManager {
	private readonly room: Room;
	private readonly taskPairRepo: TaskPairRepository;
	private readonly observer: SessionObserver;
	private readonly taskManager: TaskManager;
	private readonly goalManager: GoalManager;
	private readonly sessionFactory: SessionFactory;
	private readonly workspacePath: string;
	private readonly model?: string;

	/** In-memory map tracking whether Lead called a tool in current turn */
	readonly leadCalledToolMap = new Map<string, boolean>();

	constructor(config: TaskPairManagerConfig) {
		this.room = config.room;
		this.taskPairRepo = config.taskPairRepo;
		this.observer = config.sessionObserver;
		this.taskManager = config.taskManager;
		this.goalManager = config.goalManager;
		this.sessionFactory = config.sessionFactory;
		this.workspacePath = config.workspacePath;
		this.model = config.model;
	}

	/**
	 * Spawn a new (Craft, Lead) pair for a task.
	 *
	 * Flow:
	 * 1. Create Craft session with task context
	 * 2. Create Lead session with review tools
	 * 3. Create task_pairs DB record (state: awaiting_craft)
	 * 4. Set task status to in_progress
	 * 5. Start observing Craft session
	 * 6. Start Craft session (kicks off work)
	 */
	async spawnPair(
		task: NeoTask,
		goal: RoomGoal,
		onCraftTerminal: (pairId: string, state: TerminalState) => void,
		onLeadTerminal: (pairId: string, state: TerminalState) => void,
		leadCallbacks: LeadToolCallbacks
	): Promise<TaskPair> {
		const craftSessionId = `craft:${this.room.id}:${task.id}:${generateUUID().slice(0, 8)}`;
		const leadSessionId = `lead:${this.room.id}:${task.id}:${generateUUID().slice(0, 8)}`;

		// Build Craft init
		const craftConfig: CraftAgentConfig = {
			task,
			goal,
			room: this.room,
			sessionId: craftSessionId,
			workspacePath: this.workspacePath,
			model: this.model,
		};
		const craftInit = createCraftAgentInit(craftConfig);

		// Build Lead init
		const pairId = generateUUID();
		const leadConfig: LeadAgentConfig = {
			task,
			goal,
			room: this.room,
			sessionId: leadSessionId,
			workspacePath: this.workspacePath,
			pairId,
			model: this.model,
		};
		const leadInit = createLeadAgentInit(leadConfig, leadCallbacks);

		// Create task_pairs record
		const pair = this.taskPairRepo.createPair(task.id, craftSessionId, leadSessionId);

		// Set task status to in_progress
		await this.taskManager.startTask(task.id);

		// Create sessions (but don't start Lead yet)
		await this.sessionFactory.createAndStartSession(craftInit, 'craft');
		await this.sessionFactory.createAndStartSession(leadInit, 'lead');

		// Observe Craft session for terminal state
		this.observer.observe(craftSessionId, (state) => {
			onCraftTerminal(pair.id, state);
		});

		// Observe Lead session for terminal state (contract validation)
		this.observer.observe(leadSessionId, (state) => {
			onLeadTerminal(pair.id, state);
		});

		return pair;
	}

	/**
	 * Route Craft terminal output to Lead for review.
	 *
	 * Called when Craft reaches a terminal state (completed, error, waiting).
	 * Formats output and injects into Lead session as user message.
	 */
	async routeCraftToLead(pairId: string, craftOutput: string): Promise<TaskPair | null> {
		const pair = this.taskPairRepo.getPair(pairId);
		if (!pair) return null;

		// Inject craft output into Lead session
		await this.sessionFactory.injectMessage(pair.leadSessionId, craftOutput);

		// Update pair state to awaiting_lead
		const updated = this.taskPairRepo.updatePairState(pairId, 'awaiting_lead', pair.version);

		// Reset lead contract violations for the new review round
		if (updated) {
			this.taskPairRepo.resetLeadContractViolations(pairId, updated.version);
			this.leadCalledToolMap.delete(pairId);
		}

		return this.taskPairRepo.getPair(pairId);
	}

	/**
	 * Route Lead feedback to Craft for another iteration.
	 *
	 * Called when Lead calls send_to_craft(message).
	 */
	async routeLeadToCraft(pairId: string, message: string): Promise<TaskPair | null> {
		const pair = this.taskPairRepo.getPair(pairId);
		if (!pair) return null;

		// Inject feedback into Craft session
		await this.sessionFactory.injectMessage(pair.craftSessionId, message);

		// Update pair state and increment feedback iteration
		const updated = this.taskPairRepo.updatePairState(pairId, 'awaiting_craft', pair.version);
		if (updated) {
			this.taskPairRepo.incrementFeedbackIteration(pairId, updated.version);
		}

		return this.taskPairRepo.getPair(pairId);
	}

	/**
	 * Complete a pair - task is done.
	 *
	 * Called when Lead calls complete_task(summary).
	 */
	async completePair(pairId: string, summary: string): Promise<TaskPair | null> {
		const pair = this.taskPairRepo.getPair(pairId);
		if (!pair) return null;

		// Complete the pair
		const updated = this.taskPairRepo.completePair(pairId, pair.version);
		if (!updated) return null;

		// Complete the task
		await this.taskManager.completeTask(pair.taskId, summary);

		// Stop observing sessions
		this.observer.unobserve(pair.craftSessionId);
		this.observer.unobserve(pair.leadSessionId);
		this.leadCalledToolMap.delete(pairId);

		return updated;
	}

	/**
	 * Fail a pair - task cannot be completed.
	 *
	 * Called when Lead calls fail_task(reason).
	 */
	async failPair(pairId: string, reason: string): Promise<TaskPair | null> {
		const pair = this.taskPairRepo.getPair(pairId);
		if (!pair) return null;

		// Fail the pair
		const updated = this.taskPairRepo.failPair(pairId, pair.version);
		if (!updated) return null;

		// Fail the task
		await this.taskManager.failTask(pair.taskId, reason);

		// Stop observing sessions
		this.observer.unobserve(pair.craftSessionId);
		this.observer.unobserve(pair.leadSessionId);
		this.leadCalledToolMap.delete(pairId);

		return updated;
	}

	/**
	 * Cancel a pair - urgent control from human.
	 */
	async cancelPair(pairId: string): Promise<TaskPair | null> {
		return this.failPair(pairId, 'Cancelled by user');
	}
}
