/**
 * TaskGroupManager - Creates and manages (Craft, Lead) session groups
 *
 * Orchestrates the lifecycle of (Craft, Lead) session groups:
 * 1. Spawns session groups for pending tasks
 * 2. Routes Craft terminal output to Lead for review
 * 3. Routes Lead feedback back to Craft
 * 4. Handles group completion and failure
 *
 * Session creation is injected via SessionFactory for testability.
 */

import { generateUUID } from '@neokai/shared';
import type { Room, RoomGoal, NeoTask } from '@neokai/shared';
import type { SessionGroupRepository, SessionGroup } from './session-group-repository';
import type { SessionObserver, TerminalState } from './session-observer';
import type { TaskManager } from './task-manager';
import type { GoalManager } from './goal-manager';
import type { TurnTracker } from './turn-tracker';
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

/**
 * Factory that receives the actual group ID once the DB record is created.
 * This ensures Lead callbacks reference the correct group.id, not a pre-generated UUID.
 */
export type LeadCallbacksFactory = (groupId: string) => LeadToolCallbacks;

/**
 * Optional factory to produce a custom Craft agent init.
 * When provided, overrides the default createCraftAgentInit.
 * Used by planning groups to inject the planning Craft agent instead of the coding agent.
 */
export type CraftInitFactory = (craftSessionId: string) => ReturnType<typeof createCraftAgentInit>;

export interface TaskGroupManagerConfig {
	room: Room;
	groupRepo: SessionGroupRepository;
	sessionObserver: SessionObserver;
	taskManager: TaskManager;
	goalManager: GoalManager;
	sessionFactory: SessionFactory;
	workspacePath: string;
	model?: string;
	turnTracker?: TurnTracker;
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
	readonly turnTracker?: TurnTracker;

	/** In-memory map tracking whether Lead called a tool in current turn */
	readonly leadCalledToolMap = new Map<string, boolean>();

	constructor(config: TaskGroupManagerConfig) {
		this.room = config.room;
		this.groupRepo = config.groupRepo;
		this.observer = config.sessionObserver;
		this.taskManager = config.taskManager;
		this.goalManager = config.goalManager;
		this.sessionFactory = config.sessionFactory;
		this.workspacePath = config.workspacePath;
		this.model = config.model;
		this.turnTracker = config.turnTracker;
	}

	/**
	 * Spawn a new (Craft, Lead) session group for a task.
	 *
	 * Flow:
	 * 1. Create Craft session with task context
	 * 2. Create Lead session with review tools
	 * 3. Create session_groups DB record (state: awaiting_craft)
	 * 4. Set task status to in_progress
	 * 5. Start observing Craft session
	 * 6. Start Craft session (kicks off work)
	 */
	async spawn(
		task: NeoTask,
		goal: RoomGoal,
		onCraftTerminal: (groupId: string, state: TerminalState) => void,
		onLeadTerminal: (groupId: string, state: TerminalState) => void,
		leadCallbacksFactory: LeadCallbacksFactory,
		craftInitFactory?: CraftInitFactory
	): Promise<SessionGroup> {
		const craftSessionId = `craft:${this.room.id}:${task.id}:${generateUUID().slice(0, 8)}`;
		const leadSessionId = `lead:${this.room.id}:${task.id}:${generateUUID().slice(0, 8)}`;

		// Build Craft init — use the provided factory if given (e.g. planning agent),
		// otherwise fall back to the default coding agent.
		const craftInit = craftInitFactory
			? craftInitFactory(craftSessionId)
			: createCraftAgentInit({
					task,
					goal,
					room: this.room,
					sessionId: craftSessionId,
					workspacePath: this.workspacePath,
					model: this.model,
				} satisfies CraftAgentConfig);

		// Create session_groups record first so we have the real group.id for Lead callbacks.
		// This is critical: Lead MCP tool callbacks must reference group.id, not task.id.
		const group = this.groupRepo.createGroup(task.id, craftSessionId, leadSessionId);

		// Build Lead init using the actual group.id from the DB record
		const leadCallbacks = leadCallbacksFactory(group.id);
		const leadConfig: LeadAgentConfig = {
			task,
			goal,
			room: this.room,
			sessionId: leadSessionId,
			workspacePath: this.workspacePath,
			groupId: group.id,
			model: this.model,
		};
		const leadInit = createLeadAgentInit(leadConfig, leadCallbacks);

		// Set task status to in_progress
		await this.taskManager.startTask(task.id);

		// Create sessions (but don't start Lead yet)
		await this.sessionFactory.createAndStartSession(craftInit, 'craft');
		await this.sessionFactory.createAndStartSession(leadInit, 'lead');

		// Kick off Craft so the SDK streaming loop starts processing immediately
		await this.sessionFactory.injectMessage(
			craftSessionId,
			'Please begin working on the task described in your system prompt.'
		);

		// Start tracking the initial Craft turn
		if (this.turnTracker) {
			this.turnTracker.startTurn(craftSessionId, group.id, 0, 'craft');
		}

		// Observe Craft session for terminal state
		this.observer.observe(craftSessionId, (state) => {
			onCraftTerminal(group.id, state);
		});

		// Observe Lead session for terminal state (contract validation)
		this.observer.observe(leadSessionId, (state) => {
			onLeadTerminal(group.id, state);
		});

		return group;
	}

	/**
	 * Route Craft terminal output to Lead for review.
	 *
	 * Called when Craft reaches a terminal state (completed, error, waiting).
	 * Formats output and injects into Lead session as user message.
	 */
	async routeCraftToLead(groupId: string, craftOutput: string): Promise<SessionGroup | null> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group) return null;

		// Inject craft output into Lead session
		await this.sessionFactory.injectMessage(group.leadSessionId, craftOutput);

		// Update group state to awaiting_lead
		const updated = this.groupRepo.updateGroupState(groupId, 'awaiting_lead', group.version);

		// Reset lead contract violations for the new review round
		if (updated) {
			this.groupRepo.resetLeadContractViolations(groupId, updated.version);
			this.leadCalledToolMap.delete(groupId);
		}

		return this.groupRepo.getGroup(groupId);
	}

	/**
	 * Route Lead feedback to Craft for another iteration.
	 *
	 * Called when Lead calls send_to_craft(message).
	 */
	async routeLeadToCraft(groupId: string, message: string): Promise<SessionGroup | null> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group) return null;

		// Inject feedback into Craft session
		await this.sessionFactory.injectMessage(group.craftSessionId, message);

		// Update group state and increment feedback iteration
		const updated = this.groupRepo.updateGroupState(groupId, 'awaiting_craft', group.version);
		if (updated) {
			this.groupRepo.incrementFeedbackIteration(groupId, updated.version);
		}

		return this.groupRepo.getGroup(groupId);
	}

	/**
	 * Complete a group - task is done.
	 *
	 * Called when Lead calls complete_task(summary).
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
		this.observer.unobserve(group.craftSessionId);
		this.observer.unobserve(group.leadSessionId);
		this.leadCalledToolMap.delete(groupId);

		return updated;
	}

	/**
	 * Fail a group - task cannot be completed.
	 *
	 * Called when Lead calls fail_task(reason).
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
		this.observer.unobserve(group.craftSessionId);
		this.observer.unobserve(group.leadSessionId);
		this.leadCalledToolMap.delete(groupId);

		return updated;
	}

	/**
	 * Cancel a group - urgent control from human.
	 */
	async cancel(groupId: string): Promise<SessionGroup | null> {
		return this.fail(groupId, 'Cancelled by user');
	}
}
