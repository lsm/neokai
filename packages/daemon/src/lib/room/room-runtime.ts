/**
 * RoomRuntime - Central orchestrator for autonomous room operation
 *
 * Manages the lifecycle of (Craft, Lead) agent pairs:
 * 1. Detects goals needing planning and spawns planning pairs
 * 2. Detects pending tasks and spawns execution pairs
 * 3. Routes Craft output to Lead for review
 * 4. Routes Lead feedback to Craft
 * 5. Handles Lead tool calls (complete_task, fail_task, send_to_craft)
 * 6. Enforces Lead tool contract (retry-then-escalate)
 * 7. Promotes draft tasks to pending when planning completes
 * 8. Periodic tick as safety net
 *
 * All handlers are idempotent. Tick mutex prevents concurrent execution.
 */

import type { Room, NeoTask, RoomGoal } from '@neokai/shared';
import type { SessionGroupRepository, SessionGroup } from './session-group-repository';
import type { TaskManager } from './task-manager';
import type { GoalManager } from './goal-manager';
import type { SessionObserver, TerminalState } from './session-observer';
import type { SessionFactory } from './task-pair-manager';
import { TaskPairManager } from './task-pair-manager';
import type { ConversationSessionWriter } from './conversation-session';
import type { TurnTracker } from './turn-tracker';
import type { DaemonHub } from '../daemon-hub';
import type { LeadToolCallbacks, LeadToolResult } from './lead-agent';
import type { PlanningCraftCreateTaskParams } from './planning-craft-agent';
import { createPlanningCraftAgentInit } from './planning-craft-agent';
import {
	formatCraftToLeadEnvelope,
	formatLeadToCraftFeedback,
	formatLeadContractNudge,
	sortTasksByPriority,
} from './message-routing';
import { Logger } from '../logger';

const log = new Logger('room-runtime');

const MAX_PLANNING_ATTEMPTS = 3;

export type RuntimeState = 'running' | 'paused' | 'stopped';

export interface CraftMessage {
	/** DB row ID in sdk_messages — used to track last_forwarded_message_id */
	id: string;
	/** Extracted assistant text */
	text: string;
	/** Names of tools called (for envelope summary) */
	toolCallNames: string[];
}

export interface RoomRuntimeConfig {
	room: Room;
	groupRepo: SessionGroupRepository;
	sessionObserver: SessionObserver;
	taskManager: TaskManager;
	goalManager: GoalManager;
	sessionFactory: SessionFactory;
	workspacePath: string;
	model?: string;
	/** Max concurrent pairs (default: 1 for MVP) */
	maxConcurrentPairs?: number;
	/** Max feedback iterations before auto-escalation (default: 5) */
	maxFeedbackIterations?: number;
	/** Tick interval in ms (default: 30000) */
	tickInterval?: number;
	/**
	 * Fetch Craft assistant messages for forwarding to Lead.
	 * Returns messages after (exclusive) the message with afterMessageId.
	 * If afterMessageId is null, returns all messages for the session.
	 */
	getCraftMessages?: (sessionId: string, afterMessageId: string | null) => CraftMessage[];
	/** DaemonHub for subscribing to sdk.message events (mirroring) */
	daemonHub?: DaemonHub;
	/** Writer for conversation sessions (legacy, unused) */
	convWriter?: ConversationSessionWriter;
	/** Turn tracker for tagging mirrored messages */
	turnTracker?: TurnTracker;
}

function jsonResult(data: Record<string, unknown>): LeadToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

export class RoomRuntime {
	private state: RuntimeState = 'paused';
	private tickLocked = false;
	private tickQueued = false;
	private tickTimer: ReturnType<typeof setInterval> | null = null;

	private readonly room: Room;
	private readonly groupRepo: SessionGroupRepository;
	private readonly observer: SessionObserver;
	private readonly taskManager: TaskManager;
	private readonly goalManager: GoalManager;
	private readonly sessionFactory: SessionFactory;
	private readonly maxConcurrentPairs: number;
	private readonly maxFeedbackIterations: number;
	private readonly tickInterval: number;
	private readonly getCraftMessages: RoomRuntimeConfig['getCraftMessages'];
	private readonly daemonHub?: DaemonHub;
	private readonly convWriter?: ConversationSessionWriter;
	private readonly turnTracker?: TurnTracker;

	/** Mirroring unsub functions per group ID */
	private mirroringCleanups = new Map<string, () => void>();

	readonly pairManager: TaskPairManager;

	constructor(config: RoomRuntimeConfig) {
		this.room = config.room;
		this.groupRepo = config.groupRepo;
		this.observer = config.sessionObserver;
		this.taskManager = config.taskManager;
		this.goalManager = config.goalManager;
		this.sessionFactory = config.sessionFactory;
		this.maxConcurrentPairs = config.maxConcurrentPairs ?? 1;
		this.maxFeedbackIterations = config.maxFeedbackIterations ?? 5;
		this.tickInterval = config.tickInterval ?? 30_000;
		this.getCraftMessages = config.getCraftMessages;
		this.daemonHub = config.daemonHub;
		this.convWriter = config.convWriter;
		this.turnTracker = config.turnTracker;

		this.pairManager = new TaskPairManager({
			room: config.room,
			groupRepo: config.groupRepo,
			sessionObserver: config.sessionObserver,
			taskManager: config.taskManager,
			goalManager: config.goalManager,
			sessionFactory: config.sessionFactory,
			workspacePath: config.workspacePath,
			model: config.model,
			convWriter: config.convWriter,
			turnTracker: config.turnTracker,
		});
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	start(): void {
		this.state = 'running';
		this.tickTimer = setInterval(() => this.tick(), this.tickInterval);
		this.scheduleTick();
	}

	pause(): void {
		this.state = 'paused';
	}

	resume(): void {
		this.state = 'running';
		this.scheduleTick();
	}

	stop(): void {
		this.state = 'stopped';
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		// Clean up all mirroring subscriptions
		for (const cleanup of this.mirroringCleanups.values()) {
			cleanup();
		}
		this.mirroringCleanups.clear();
		this.turnTracker?.clear();
		this.observer.dispose();
	}

	getState(): RuntimeState {
		return this.state;
	}

	// =========================================================================
	// Event Handlers (trigger tick)
	// =========================================================================

	/**
	 * Called when a goal is created. Triggers a tick to check for pending tasks.
	 */
	onGoalCreated(_goalId: string): void {
		this.scheduleTick();
	}

	/**
	 * Called when a task status changes. Triggers a tick.
	 */
	onTaskStatusChanged(_taskId: string): void {
		this.scheduleTick();
	}

	/**
	 * Called when Craft reaches a terminal state.
	 * Collects Craft output from session messages and routes to Lead.
	 */
	async onCraftTerminalState(pairId: string, terminalState: TerminalState): Promise<void> {
		const group = this.groupRepo.getGroup(pairId);
		if (!group || group.state !== 'awaiting_craft') return;

		// End Craft turn
		this.turnTracker?.endTurn(group.craftSessionId);

		const task = await this.taskManager.getTask(group.taskId);
		if (!task) return;

		// Collect Craft messages since last forwarded message
		const craftMessages = this.getCraftMessages
			? this.getCraftMessages(group.craftSessionId, group.lastForwardedMessageId)
			: [];

		// Build the craft output text
		const craftOutputText =
			craftMessages.length > 0
				? craftMessages
						.map((m) => m.text)
						.filter(Boolean)
						.join('\n\n')
				: `[Craft session ${group.craftSessionId} reached terminal state: ${terminalState.kind}]`;

		// Collect tool call summaries across all messages
		const toolCallNames = craftMessages.flatMap((m) => m.toolCallNames);

		// Format craft output envelope for Lead review
		const envelope = formatCraftToLeadEnvelope({
			iteration: group.feedbackIteration,
			taskTitle: task.title,
			taskType: task.taskType,
			terminalState: terminalState.kind,
			craftOutput: craftOutputText,
			toolCallSummaries: toolCallNames.length > 0 ? toolCallNames : undefined,
		});

		// Update last_forwarded_message_id to the last message we just forwarded
		const lastMessage = craftMessages.at(-1);
		if (lastMessage) {
			this.groupRepo.updateLastForwardedMessageId(pairId, lastMessage.id, group.version);
		}

		// Insert status message into group timeline
		this.groupRepo.appendMessage({
			groupId: pairId,
			role: 'system',
			messageType: 'status',
			content: `Craft finished (${terminalState.kind}). Routing to Lead for review.`,
		});

		// Start Lead turn before routing
		this.turnTracker?.startTurn(group.leadSessionId, pairId, group.feedbackIteration, 'lead');

		// Route to Lead
		await this.pairManager.routeCraftToLead(pairId, envelope);
	}

	/**
	 * Called when Lead reaches a terminal state.
	 * Validates Lead tool contract (retry-then-escalate).
	 */
	async onLeadTerminalState(pairId: string, _terminalState: TerminalState): Promise<void> {
		const group = this.groupRepo.getGroup(pairId);
		if (!group || group.state !== 'awaiting_lead') return;

		// End Lead turn
		this.turnTracker?.endTurn(group.leadSessionId);

		// Check if Lead called a tool (via in-memory map)
		const calledTool = this.pairManager.leadCalledToolMap.get(pairId) ?? false;

		if (calledTool) {
			// Lead called a tool → success, no action needed
			// (The tool handler already processed the action)
			return;
		}

		// Contract violation: Lead reached terminal without calling a tool
		const violations = group.leadContractViolations;

		if (violations === 0) {
			// First violation: nudge
			const nudge = formatLeadContractNudge();
			await this.sessionFactory.injectMessage(group.leadSessionId, nudge);
			this.groupRepo.updateLeadContractViolations(
				pairId,
				1,
				'', // turn ID placeholder - MVP doesn't track turn IDs
				group.version
			);
		} else {
			// Second+ violation: auto-escalate
			const updated = this.groupRepo.updateGroupState(pairId, 'awaiting_human', group.version);
			if (updated) {
				await this.taskManager.escalateTask(
					group.taskId,
					'Lead failed to call required tool after nudge'
				);
			}
		}
	}

	// =========================================================================
	// Lead Tool Handling (called from MCP tool callbacks)
	// =========================================================================

	/**
	 * Handle a Lead tool call. Called synchronously from MCP tool handler.
	 * Returns the tool result to be sent back to the Lead agent.
	 */
	async handleLeadTool(
		pairId: string,
		toolName: string,
		params: { message?: string; summary?: string; reason?: string }
	): Promise<LeadToolResult> {
		const group = this.groupRepo.getGroup(pairId);
		if (!group) {
			return jsonResult({ success: false, error: `Group not found: ${pairId}` });
		}

		if (group.state !== 'awaiting_lead') {
			return jsonResult({
				success: false,
				error: `Group not in awaiting_lead state (current: ${group.state})`,
			});
		}

		// Mark that Lead called a tool
		this.pairManager.leadCalledToolMap.set(pairId, true);

		switch (toolName) {
			case 'send_to_craft': {
				// Enforce max feedback iterations
				if (group.feedbackIteration >= this.maxFeedbackIterations) {
					const updated = this.groupRepo.updateGroupState(pairId, 'awaiting_human', group.version);
					if (updated) {
						await this.taskManager.escalateTask(
							group.taskId,
							`Max feedback iterations (${this.maxFeedbackIterations}) reached`
						);
					}
					return jsonResult({
						success: false,
						error: `Max feedback iterations reached. Task escalated to human.`,
					});
				}
				const message = params.message ?? '';
				const nextIteration = group.feedbackIteration + 1;
				const feedback = formatLeadToCraftFeedback(message, nextIteration);

				// Insert status message into group timeline
				this.groupRepo.appendMessage({
					groupId: pairId,
					role: 'system',
					messageType: 'status',
					content: `Lead sent feedback to Craft (iteration ${nextIteration}).`,
				});

				// Start new Craft turn before routing
				this.turnTracker?.startTurn(group.craftSessionId, pairId, nextIteration, 'craft');

				await this.pairManager.routeLeadToCraft(pairId, feedback);
				return jsonResult({
					success: true,
					message: 'Feedback sent to Craft. Waiting for next iteration.',
				});
			}

			case 'complete_task': {
				const summary = params.summary ?? '';
				await this.pairManager.completePair(pairId, summary);
				this.cleanupMirroring(pairId, 'Task completed.');
				// Phase 2c: If this was a planning task, promote its draft children to pending
				await this.promoteDraftTasksIfPlanning(group.taskId);
				this.scheduleTick();
				return jsonResult({ success: true, message: 'Task completed successfully.' });
			}

			case 'fail_task': {
				const reason = params.reason ?? '';
				await this.pairManager.failPair(pairId, reason);
				this.cleanupMirroring(pairId, `Task failed: ${reason}`);
				this.scheduleTick();
				return jsonResult({ success: true, message: 'Task marked as failed.' });
			}

			default:
				return jsonResult({ success: false, error: `Unknown tool: ${toolName}` });
		}
	}

	/**
	 * Create LeadToolCallbacks that route through this runtime.
	 */
	createLeadCallbacks(pairId: string): LeadToolCallbacks {
		return {
			sendToCraft: async (_pairId: string, message: string) => {
				return this.handleLeadTool(pairId, 'send_to_craft', { message });
			},
			completeTask: async (_pairId: string, summary: string) => {
				return this.handleLeadTool(pairId, 'complete_task', { summary });
			},
			failTask: async (_pairId: string, reason: string) => {
				return this.handleLeadTool(pairId, 'fail_task', { reason });
			},
		};
	}

	// =========================================================================
	// Message Mirroring
	// =========================================================================

	/**
	 * Set up message mirroring for a group's craft/lead sessions.
	 * Subscribes to DaemonHub sdk.message events and appends messages into
	 * the group's session_group_messages timeline.
	 */
	private setupMirroring(group: SessionGroup): void {
		if (!this.daemonHub) return;

		const mirroredUuids = new Set<string>();

		const unsubCraft = this.daemonHub.on(
			'sdk.message',
			(event) => {
				if (event.sessionId !== group.craftSessionId) return;
				const uuid = 'uuid' in event.message ? (event.message.uuid as string) : null;
				if (uuid && mirroredUuids.has(uuid)) return;
				if (uuid) mirroredUuids.add(uuid);

				this.groupRepo.appendMessage({
					groupId: group.id,
					sessionId: group.craftSessionId,
					role: 'craft',
					messageType: event.message.type as string,
					content: JSON.stringify(event.message),
				});
			},
			{ sessionId: group.craftSessionId }
		);

		const unsubLead = this.daemonHub.on(
			'sdk.message',
			(event) => {
				if (event.sessionId !== group.leadSessionId) return;
				const uuid = 'uuid' in event.message ? (event.message.uuid as string) : null;
				if (uuid && mirroredUuids.has(uuid)) return;
				if (uuid) mirroredUuids.add(uuid);

				this.groupRepo.appendMessage({
					groupId: group.id,
					sessionId: group.leadSessionId,
					role: 'lead',
					messageType: event.message.type as string,
					content: JSON.stringify(event.message),
				});
			},
			{ sessionId: group.leadSessionId }
		);

		this.mirroringCleanups.set(group.id, () => {
			unsubCraft();
			unsubLead();
			mirroredUuids.clear();
		});
	}

	/**
	 * Clean up mirroring subscriptions for a group.
	 * Optionally inserts a final status message into the group timeline.
	 */
	private cleanupMirroring(groupId: string, statusText?: string): void {
		const cleanup = this.mirroringCleanups.get(groupId);
		if (cleanup) {
			cleanup();
			this.mirroringCleanups.delete(groupId);
		}

		if (statusText) {
			this.groupRepo.appendMessage({
				groupId,
				role: 'system',
				messageType: 'status',
				content: statusText,
			});
		}

		// Clean up turn tracking for this group's sessions
		if (this.turnTracker) {
			const group = this.groupRepo.getGroup(groupId);
			if (group) {
				this.turnTracker.endTurn(group.craftSessionId);
				this.turnTracker.endTurn(group.leadSessionId);
			}
		}
	}

	// =========================================================================
	// Tick Logic
	// =========================================================================

	/**
	 * Main scheduling loop. Idempotent with mutex protection.
	 */
	async tick(): Promise<void> {
		if (this.state !== 'running') return;

		// Mutex: only one tick at a time
		if (this.tickLocked) {
			this.tickQueued = true;
			return;
		}

		this.tickLocked = true;
		try {
			await this.executeTick();
		} finally {
			this.tickLocked = false;
			// Re-tick if queued while we were running
			if (this.tickQueued) {
				this.tickQueued = false;
				// Use microtask to avoid stack depth issues
				queueMicrotask(() => this.tick());
			}
		}
	}

	private async executeTick(): Promise<void> {
		// Check capacity
		const activeGroups = this.groupRepo.getActiveGroups(this.room.id);
		const availableSlots = this.maxConcurrentPairs - activeGroups.length;

		if (availableSlots <= 0) return;

		// Phase 2b: Planning takes priority over execution.
		// If a goal needs planning (no tasks, or all tasks failed), spawn a planning pair first.
		const goalForPlanning = await this.getNextGoalForPlanning();
		if (goalForPlanning) {
			await this.spawnPlanningPair(goalForPlanning);
			return; // Don't start execution pairs in the same tick
		}

		// Find pending non-planning tasks (planning tasks are spawned directly, not via queue)
		const pendingTasks = await this.taskManager.listTasks({ status: 'pending' });
		const executableTasks = pendingTasks.filter((t) => (t.taskType ?? 'coding') !== 'planning');
		if (executableTasks.length === 0) return;

		// Sort by priority
		const sorted = sortTasksByPriority(executableTasks);

		// Spawn pairs for available slots
		const toSpawn = sorted.slice(0, availableSlots);

		for (const task of toSpawn) {
			await this.spawnPairForTask(task);
		}
	}

	/**
	 * Find the highest-priority active goal that needs planning.
	 *
	 * A goal needs planning when:
	 * - status is 'active'
	 * - has no linked tasks at all, OR all linked tasks are 'failed'
	 * - has no pending/in_progress/draft/escalated tasks
	 * - planning_attempts < MAX_PLANNING_ATTEMPTS
	 *
	 * Goals that exceed MAX_PLANNING_ATTEMPTS are transitioned to 'needs_human'.
	 */
	private async getNextGoalForPlanning(): Promise<RoomGoal | null> {
		const activeGoals = await this.goalManager.listGoals('active');

		for (const goal of activeGoals) {
			const linkedTaskIds = goal.linkedTaskIds ?? [];

			let needsPlanning: boolean;

			if (linkedTaskIds.length === 0) {
				// No tasks at all: brand new goal
				needsPlanning = true;
			} else {
				// Check whether all linked tasks are terminal (completed or failed)
				// and there are no active tasks
				const linkedTasks = await Promise.all(
					linkedTaskIds.map((id) => this.taskManager.getTask(id))
				);
				const validTasks = linkedTasks.filter(Boolean) as NonNullable<
					(typeof linkedTasks)[number]
				>[];
				const hasActiveTask = validTasks.some((t) =>
					(['pending', 'in_progress', 'draft', 'escalated'] as const).includes(
						t.status as 'pending' | 'in_progress' | 'draft' | 'escalated'
					)
				);
				const allFailed = validTasks.length > 0 && validTasks.every((t) => t.status === 'failed');

				// Re-plan if all tasks failed and none are active
				needsPlanning = !hasActiveTask && allFailed;
			}

			if (!needsPlanning) continue;

			const attempts = goal.planning_attempts ?? 0;

			if (attempts >= MAX_PLANNING_ATTEMPTS) {
				// Too many failed planning attempts: escalate to human
				log.warn(
					`Goal ${goal.id} (${goal.title}) exceeded max planning attempts, marking needs_human`
				);
				await this.goalManager.updateGoalStatus(goal.id, 'needs_human');
				continue;
			}

			return goal;
		}

		return null;
	}

	/**
	 * Spawn a planning (Craft, Lead) pair for a goal that has no tasks yet.
	 * Creates a planning task, increments planning_attempts, and starts the pair.
	 */
	private async spawnPlanningPair(goal: RoomGoal): Promise<void> {
		// Create the planning task itself
		const planningTask = await this.taskManager.createTask({
			title: `Plan: ${goal.title}`,
			description: `Examine the codebase and break down the goal "${goal.title}" into concrete, executable tasks.`,
			taskType: 'planning',
			status: 'pending',
		});

		// Link planning task to the goal
		await this.goalManager.linkTaskToGoal(goal.id, planningTask.id);

		// Increment planning attempts BEFORE spawning (counts attempts, not outcomes)
		await this.goalManager.incrementPlanningAttempts(goal.id);

		// Build create_draft_task callback for the planning Craft agent MCP tool
		const createDraftTask = async (
			params: PlanningCraftCreateTaskParams
		): Promise<{ id: string; title: string }> => {
			const task = await this.taskManager.createTask({
				title: params.title,
				description: params.description,
				priority: params.priority,
				taskType: 'coding', // default for planning-created tasks
				status: 'draft',
				createdByTaskId: planningTask.id,
			});
			// Link the draft task to the goal so it appears in the room
			await this.goalManager.linkTaskToGoal(goal.id, task.id);
			log.info(`Planning created draft task: ${task.id} (${task.title})`);
			return { id: task.id, title: task.title };
		};

		// Spawn the planning pair directly (bypasses the tick queue)
		const group = await this.pairManager.spawnPair(
			planningTask,
			goal,
			(pairId, state) => this.onCraftTerminalState(pairId, state),
			(pairId, state) => this.onLeadTerminalState(pairId, state),
			(pairId) => this.createLeadCallbacks(pairId),
			// Planning Craft agent init factory (overrides default coding agent)
			(craftSessionId) =>
				createPlanningCraftAgentInit({
					task: planningTask,
					goal,
					room: this.room,
					sessionId: craftSessionId,
					workspacePath: this.pairManager.workspacePath,
					model: this.pairManager.model,
					createDraftTask,
				})
		);

		this.setupMirroring(group);

		log.info(
			`Spawned planning pair for goal ${goal.id} (${goal.title}), attempt ${(goal.planning_attempts ?? 0) + 1}`
		);
	}

	private async spawnPairForTask(task: NeoTask): Promise<void> {
		// Find the goal linked to this task
		const goals = await this.goalManager.getGoalsForTask(task.id);
		const goal = goals[0] ?? (await this.goalManager.getNextGoal());
		if (!goal) return;

		const group = await this.pairManager.spawnPair(
			task,
			goal,
			(pairId, state) => this.onCraftTerminalState(pairId, state),
			(pairId, state) => this.onLeadTerminalState(pairId, state),
			(pairId) => this.createLeadCallbacks(pairId)
		);

		this.setupMirroring(group);
	}

	// =========================================================================
	// Phase 2c: Draft task promotion
	// =========================================================================

	/**
	 * If the completed task was a planning task, promote its draft children to pending
	 * so they enter the execution queue on the next tick.
	 */
	private async promoteDraftTasksIfPlanning(taskId: string): Promise<void> {
		const task = await this.taskManager.getTask(taskId);
		if (!task || task.taskType !== 'planning') return;

		const promoted = await this.taskManager.promoteDraftTasks(taskId);
		if (promoted > 0) {
			log.info(
				`Promoted ${promoted} draft task(s) to pending after planning task ${taskId} completed`
			);
		}
	}

	private scheduleTick(): void {
		if (this.state !== 'running') return;
		// Use queueMicrotask for non-blocking tick scheduling
		queueMicrotask(() => this.tick());
	}
}
