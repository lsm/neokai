/**
 * RoomRuntime - Central orchestrator for autonomous room operation
 *
 * Manages the lifecycle of (Worker, Leader) session groups:
 * 1. Detects goals needing planning and spawns planning groups
 * 2. Detects pending tasks and spawns execution groups
 * 3. Routes Worker output to Leader for review
 * 4. Routes Leader feedback to Worker
 * 5. Handles Leader tool calls (complete_task, fail_task, send_to_worker)
 * 6. Enforces Leader tool contract (retry-then-escalate)
 * 7. Promotes draft tasks to pending when planning completes
 * 8. Periodic tick as safety net
 *
 * All handlers are idempotent. Tick mutex prevents concurrent execution.
 */

import type { Room, NeoTask, RoomGoal, MessageHub, TaskPriority, AgentType } from '@neokai/shared';
import type { SessionGroupRepository, SessionGroup } from './session-group-repository';
import type { TaskManager } from './task-manager';
import type { GoalManager } from './goal-manager';
import type { SessionObserver, TerminalState } from './session-observer';
import type { SessionFactory, WorkerConfig } from './task-group-manager';
import { TaskGroupManager } from './task-group-manager';
import type { DaemonHub } from '../daemon-hub';
import type { LeaderToolCallbacks, LeaderToolResult } from './leader-agent';
import type { PlannerCreateTaskParams } from './planner-agent';
import { createPlannerAgentInit } from './planner-agent';
import { createCoderAgentInit } from './coder-agent';
import { createGeneralAgentInit } from './general-agent';
import {
	formatWorkerToLeaderEnvelope,
	formatPlanEnvelope,
	formatLeaderToWorkerFeedback,
	formatLeaderContractNudge,
	sortTasksByPriority,
} from './message-routing';
import { Logger } from '../logger';

const log = new Logger('room-runtime');

const MAX_PLANNING_ATTEMPTS = 3;

export type RuntimeState = 'running' | 'paused' | 'stopped';

export interface WorkerMessage {
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
	/** Max concurrent groups (default: 1 for MVP) */
	maxConcurrentGroups?: number;
	/** Max feedback iterations before auto-escalation (default: 5) */
	maxFeedbackIterations?: number;
	/** Tick interval in ms (default: 30000) */
	tickInterval?: number;
	/**
	 * Fetch Worker assistant messages for forwarding to Leader.
	 * Returns messages after (exclusive) the message with afterMessageId.
	 * If afterMessageId is null, returns all messages for the session.
	 */
	getWorkerMessages?: (sessionId: string, afterMessageId: string | null) => WorkerMessage[];
	/** DaemonHub for subscribing to sdk.message events (mirroring) */
	daemonHub?: DaemonHub;
	/** MessageHub for broadcasting group message deltas to frontend */
	messageHub?: MessageHub;
}

function jsonResult(data: Record<string, unknown>): LeaderToolResult {
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
	private readonly maxConcurrentGroups: number;
	private readonly maxFeedbackIterations: number;
	private readonly tickInterval: number;
	private readonly getWorkerMessages: RoomRuntimeConfig['getWorkerMessages'];
	private readonly daemonHub?: DaemonHub;
	private readonly messageHub?: MessageHub;

	/** Mirroring unsub functions per group ID */
	private mirroringCleanups = new Map<string, () => void>();

	readonly taskGroupManager: TaskGroupManager;

	constructor(config: RoomRuntimeConfig) {
		this.room = config.room;
		this.groupRepo = config.groupRepo;
		this.observer = config.sessionObserver;
		this.taskManager = config.taskManager;
		this.goalManager = config.goalManager;
		this.sessionFactory = config.sessionFactory;
		this.maxConcurrentGroups = config.maxConcurrentGroups ?? 1;
		this.maxFeedbackIterations = config.maxFeedbackIterations ?? 5;
		this.tickInterval = config.tickInterval ?? 30_000;
		this.getWorkerMessages = config.getWorkerMessages;
		this.daemonHub = config.daemonHub;
		this.messageHub = config.messageHub;

		this.taskGroupManager = new TaskGroupManager({
			room: config.room,
			groupRepo: config.groupRepo,
			sessionObserver: config.sessionObserver,
			taskManager: config.taskManager,
			goalManager: config.goalManager,
			sessionFactory: config.sessionFactory,
			workspacePath: config.workspacePath,
			model: config.model,
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
	 * Called when Worker reaches a terminal state.
	 * Collects Worker output from session messages and routes to Leader.
	 */
	async onWorkerTerminalState(groupId: string, terminalState: TerminalState): Promise<void> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group || group.state !== 'awaiting_worker') return;

		const task = await this.taskManager.getTask(group.taskId);
		if (!task) return;

		// Collect Worker messages since last forwarded message
		const workerMessages = this.getWorkerMessages
			? this.getWorkerMessages(group.workerSessionId, group.lastForwardedMessageId)
			: [];

		// Build the worker output text
		const workerOutputText =
			workerMessages.length > 0
				? workerMessages
						.map((m) => m.text)
						.filter(Boolean)
						.join('\n\n')
				: `[Worker session ${group.workerSessionId} reached terminal state: ${terminalState.kind}]`;

		// Collect tool call summaries across all messages
		const toolCallNames = workerMessages.flatMap((m) => m.toolCallNames);

		// Format output envelope for Leader review
		// Use plan envelope for planning groups, standard envelope for others
		let envelope: string;
		if (group.workerRole === 'planner') {
			const draftTasks = await this.taskManager.getDraftTasksByCreator(group.taskId);
			const goal = (await this.goalManager.getGoalsForTask(group.taskId))[0];
			envelope = formatPlanEnvelope({
				iteration: group.feedbackIteration,
				goalTitle: goal?.title ?? task.title,
				terminalState: terminalState.kind,
				workerOutput: workerOutputText,
				draftTasks,
			});
		} else {
			envelope = formatWorkerToLeaderEnvelope({
				iteration: group.feedbackIteration,
				taskTitle: task.title,
				taskType: task.taskType,
				terminalState: terminalState.kind,
				workerOutput: workerOutputText,
				toolCallSummaries: toolCallNames.length > 0 ? toolCallNames : undefined,
			});
		}

		// Update last_forwarded_message_id to the last message we just forwarded
		const lastMessage = workerMessages.at(-1);
		if (lastMessage) {
			this.groupRepo.updateLastForwardedMessageId(groupId, lastMessage.id, group.version);
		}

		// Insert status message into group timeline
		this.groupRepo.appendMessage({
			groupId,
			role: 'system',
			messageType: 'status',
			content: `Worker (${group.workerRole}) finished (${terminalState.kind}). Routing to Leader for review.`,
		});

		// Route to Leader
		await this.taskGroupManager.routeWorkerToLeader(groupId, envelope);
	}

	/**
	 * Called when Leader reaches a terminal state.
	 * Validates Leader tool contract (retry-then-escalate).
	 */
	async onLeaderTerminalState(groupId: string, _terminalState: TerminalState): Promise<void> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group || group.state !== 'awaiting_leader') return;

		// Check if Leader called a tool (via in-memory map)
		const calledTool = this.taskGroupManager.leaderCalledToolMap.get(groupId) ?? false;

		if (calledTool) {
			// Leader called a tool → success, no action needed
			// (The tool handler already processed the action)
			return;
		}

		// Contract violation: Leader reached terminal without calling a tool
		const violations = group.leaderContractViolations;

		if (violations === 0) {
			// First violation: nudge
			const nudge = formatLeaderContractNudge();
			await this.sessionFactory.injectMessage(group.leaderSessionId, nudge);
			this.groupRepo.updateLeaderContractViolations(
				groupId,
				1,
				'', // turn ID placeholder - MVP doesn't track turn IDs
				group.version
			);
		} else {
			// Second+ violation: auto-escalate
			const updated = this.groupRepo.updateGroupState(groupId, 'awaiting_human', group.version);
			if (updated) {
				await this.taskManager.escalateTask(
					group.taskId,
					'Leader failed to call required tool after nudge'
				);
			}
		}
	}

	// =========================================================================
	// Leader Tool Handling (called from MCP tool callbacks)
	// =========================================================================

	/**
	 * Handle a Leader tool call. Called synchronously from MCP tool handler.
	 * Returns the tool result to be sent back to the Leader agent.
	 */
	async handleLeaderTool(
		groupId: string,
		toolName: string,
		params: { message?: string; summary?: string; reason?: string }
	): Promise<LeaderToolResult> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group) {
			return jsonResult({ success: false, error: `Group not found: ${groupId}` });
		}

		if (group.state !== 'awaiting_leader') {
			return jsonResult({
				success: false,
				error: `Group not in awaiting_leader state (current: ${group.state})`,
			});
		}

		// Mark that Leader called a tool
		this.taskGroupManager.leaderCalledToolMap.set(groupId, true);

		switch (toolName) {
			case 'send_to_worker': {
				// Enforce max feedback iterations
				if (group.feedbackIteration >= this.maxFeedbackIterations) {
					const updated = this.groupRepo.updateGroupState(groupId, 'awaiting_human', group.version);
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
				const feedback = formatLeaderToWorkerFeedback(message, nextIteration);

				// Insert status message into group timeline
				this.groupRepo.appendMessage({
					groupId,
					role: 'system',
					messageType: 'status',
					content: `Leader sent feedback to Worker (iteration ${nextIteration}).`,
				});

				await this.taskGroupManager.routeLeaderToWorker(groupId, feedback);
				return jsonResult({
					success: true,
					message: 'Feedback sent to Worker. Waiting for next iteration.',
				});
			}

			case 'complete_task': {
				const summary = params.summary ?? '';
				await this.taskGroupManager.complete(groupId, summary);
				this.cleanupMirroring(groupId, 'Task completed.');
				// If this was a planning task, promote its draft children to pending
				await this.promoteDraftTasksIfPlanning(group.taskId);
				this.scheduleTick();
				return jsonResult({ success: true, message: 'Task completed successfully.' });
			}

			case 'fail_task': {
				const reason = params.reason ?? '';
				await this.taskGroupManager.fail(groupId, reason);
				this.cleanupMirroring(groupId, `Task failed: ${reason}`);
				this.scheduleTick();
				return jsonResult({ success: true, message: 'Task marked as failed.' });
			}

			default:
				return jsonResult({ success: false, error: `Unknown tool: ${toolName}` });
		}
	}

	/**
	 * Create LeaderToolCallbacks that route through this runtime.
	 */
	createLeaderCallbacks(groupId: string): LeaderToolCallbacks {
		return {
			sendToWorker: async (_groupId: string, message: string) => {
				return this.handleLeaderTool(groupId, 'send_to_worker', { message });
			},
			completeTask: async (_groupId: string, summary: string) => {
				return this.handleLeaderTool(groupId, 'complete_task', { summary });
			},
			failTask: async (_groupId: string, reason: string) => {
				return this.handleLeaderTool(groupId, 'fail_task', { reason });
			},
		};
	}

	// =========================================================================
	// Message Mirroring
	// =========================================================================

	/**
	 * Set up message mirroring for a group's worker/leader sessions.
	 * Subscribes to DaemonHub sdk.message events and appends enriched messages
	 * into the group's session_group_messages timeline.
	 *
	 * Messages are enriched with _taskMeta (authorRole, turnId, iteration) so
	 * the frontend can render them with turn-based grouping and color-coding.
	 *
	 * turnId is computed deterministically: `turn_{groupId}_{iteration}_{shortSessionId}`
	 * This avoids in-memory state and survives daemon restarts.
	 */
	private setupMirroring(group: SessionGroup): void {
		if (!this.daemonHub) return;

		const mirroredUuids = new Set<string>();

		const mirrorSession = (sessionId: string, role: string) => {
			const shortSessionId = sessionId.slice(0, 8);

			return this.daemonHub!.on(
				'sdk.message',
				(event) => {
					if (event.sessionId !== sessionId) return;
					const uuid = 'uuid' in event.message ? (event.message.uuid as string) : null;
					if (uuid && mirroredUuids.has(uuid)) return;
					if (uuid) mirroredUuids.add(uuid);

					// Read current iteration from DB to stay accurate across feedback cycles
					const currentGroup = this.groupRepo.getGroup(group.id);
					const iteration = currentGroup?.feedbackIteration ?? group.feedbackIteration;
					const turnId = `turn_${group.id}_${iteration}_${shortSessionId}`;

					const enrichedContent = JSON.stringify({
						...event.message,
						_taskMeta: {
							authorRole: role,
							authorSessionId: sessionId,
							turnId,
							iteration,
						},
					});

					this.groupRepo.appendMessage({
						groupId: group.id,
						sessionId,
						role,
						messageType: event.message.type as string,
						content: enrichedContent,
					});

					// Broadcast delta to subscribed frontends
					if (this.messageHub) {
						const parsed = JSON.parse(enrichedContent);
						this.messageHub.event(
							'state.groupMessages.delta',
							{ added: [{ ...parsed, timestamp: Date.now() }], timestamp: Date.now() },
							{ channel: `group:${group.id}` }
						);
					}
				},
				{ sessionId }
			);
		};

		const unsubWorker = mirrorSession(group.workerSessionId, group.workerRole);
		const unsubLeader = mirrorSession(group.leaderSessionId, 'leader');

		this.mirroringCleanups.set(group.id, () => {
			unsubWorker();
			unsubLeader();
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
		const availableSlots = this.maxConcurrentGroups - activeGroups.length;

		if (availableSlots <= 0) return;

		// Planning takes priority over execution.
		// If a goal needs planning (no tasks, or all tasks failed), spawn a planning group first.
		const goalForPlanning = await this.getNextGoalForPlanning();
		if (goalForPlanning) {
			await this.spawnPlanningGroup(goalForPlanning);
			return; // Don't start execution groups in the same tick
		}

		// Find pending non-planning tasks (planning tasks are spawned directly, not via queue)
		const pendingTasks = await this.taskManager.listTasks({ status: 'pending' });
		const executableTasks = pendingTasks.filter((t) => (t.taskType ?? 'coding') !== 'planning');
		if (executableTasks.length === 0) return;

		// Sort by priority
		const sorted = sortTasksByPriority(executableTasks);

		// Spawn groups for available slots
		const toSpawn = sorted.slice(0, availableSlots);

		for (const task of toSpawn) {
			await this.spawnGroupForTask(task);
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
	 * Spawn a planning (Planner, Leader) group for a goal that has no tasks yet.
	 * Creates a planning task, increments planning_attempts, and starts the group.
	 */
	private async spawnPlanningGroup(goal: RoomGoal): Promise<void> {
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

		// Build create_draft_task callback for the Planner agent MCP tool
		const createDraftTask = async (
			params: PlannerCreateTaskParams
		): Promise<{ id: string; title: string }> => {
			const task = await this.taskManager.createTask({
				title: params.title,
				description: params.description,
				priority: params.priority,
				taskType: 'coding', // default for planning-created tasks
				status: 'draft',
				createdByTaskId: planningTask.id,
				assignedAgent: params.agent,
			});
			// Link the draft task to the goal so it appears in the room
			await this.goalManager.linkTaskToGoal(goal.id, task.id);
			log.info(`Planning created draft task: ${task.id} (${task.title})`);
			return { id: task.id, title: task.title };
		};

		// Build update/remove callbacks for plan polishing
		const updateDraftTask = async (
			taskId: string,
			updates: {
				title?: string;
				description?: string;
				priority?: TaskPriority;
				assignedAgent?: AgentType;
			}
		): Promise<{ id: string; title: string }> => {
			return this.taskManager.updateDraftTask(taskId, updates);
		};

		const removeDraftTask = async (taskId: string): Promise<boolean> => {
			return this.taskManager.removeDraftTask(taskId);
		};

		// Build WorkerConfig for the Planner agent
		const workerConfig: WorkerConfig = {
			role: 'planner',
			initFactory: (workerSessionId) =>
				createPlannerAgentInit({
					task: planningTask,
					goal,
					room: this.room,
					sessionId: workerSessionId,
					workspacePath: this.taskGroupManager.workspacePath,
					model: this.taskGroupManager.model,
					createDraftTask,
					updateDraftTask,
					removeDraftTask,
				}),
		};

		// Spawn the planning group directly (bypasses the tick queue)
		const group = await this.taskGroupManager.spawn(
			planningTask,
			goal,
			(groupId, state) => this.onWorkerTerminalState(groupId, state),
			(groupId, state) => this.onLeaderTerminalState(groupId, state),
			(groupId) => this.createLeaderCallbacks(groupId),
			workerConfig,
			'plan_review'
		);

		this.setupMirroring(group);

		log.info(
			`Spawned planning group for goal ${goal.id} (${goal.title}), attempt ${(goal.planning_attempts ?? 0) + 1}`
		);
	}

	/**
	 * Spawn an execution (Coder/General, Leader) group for a task.
	 * Reads task.assignedAgent to pick the appropriate worker factory.
	 */
	private async spawnGroupForTask(task: NeoTask): Promise<void> {
		// Find the goal linked to this task
		const goals = await this.goalManager.getGoalsForTask(task.id);
		const goal = goals[0] ?? (await this.goalManager.getNextGoal());
		if (!goal) return;

		// Get summaries of previously completed tasks for context
		const completedTasks = await this.taskManager.listTasks({ status: 'completed' });
		const goalLinkedIds = new Set(goal.linkedTaskIds ?? []);
		const previousTaskSummaries = completedTasks
			.filter((t) => goalLinkedIds.has(t.id) && t.id !== task.id)
			.map((t) => `${t.title}: ${t.result ?? 'completed'}`);

		// Determine worker config based on assigned agent type
		const agentType = task.assignedAgent ?? 'coder';
		let workerConfig: WorkerConfig;

		if (agentType === 'general') {
			workerConfig = {
				role: 'general',
				initFactory: (workerSessionId) =>
					createGeneralAgentInit({
						task,
						goal,
						room: this.room,
						sessionId: workerSessionId,
						workspacePath: this.taskGroupManager.workspacePath,
						model: this.taskGroupManager.model,
						previousTaskSummaries,
					}),
			};
		} else {
			// Default to coder
			workerConfig = {
				role: 'coder',
				initFactory: (workerSessionId) =>
					createCoderAgentInit({
						task,
						goal,
						room: this.room,
						sessionId: workerSessionId,
						workspacePath: this.taskGroupManager.workspacePath,
						model: this.taskGroupManager.model,
						previousTaskSummaries,
					}),
			};
		}

		const group = await this.taskGroupManager.spawn(
			task,
			goal,
			(groupId, state) => this.onWorkerTerminalState(groupId, state),
			(groupId, state) => this.onLeaderTerminalState(groupId, state),
			(groupId) => this.createLeaderCallbacks(groupId),
			workerConfig,
			'code_review'
		);

		this.setupMirroring(group);
	}

	// =========================================================================
	// Draft task promotion
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
