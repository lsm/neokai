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

import {
	type Room,
	type NeoTask,
	type RoomGoal,
	type MessageHub,
	type TaskPriority,
	type AgentType,
	type RuntimeState,
	MAX_CONCURRENT_GROUPS_LIMIT,
	MAX_REVIEW_ROUNDS_LIMIT,
} from '@neokai/shared';
import type { SessionGroupRepository, SessionGroup } from '../state/session-group-repository';
import type { TaskManager } from '../managers/task-manager';
import type { GoalManager } from '../managers/goal-manager';
import type { SessionObserver, TerminalState } from '../state/session-observer';
import type { SessionFactory, WorkerConfig } from './task-group-manager';
import { TaskGroupManager } from './task-group-manager';
import type { DaemonHub } from '../../daemon-hub';
import type { LeaderToolCallbacks, LeaderToolResult } from '../agents/leader-agent';
import { createLeaderMcpServer } from '../agents/leader-agent';
import type { PlannerCreateTaskParams, ReplanContext } from '../agents/planner-agent';
import {
	createPlannerAgentInit,
	createPlannerMcpServer,
	buildPlannerTaskMessage,
} from '../agents/planner-agent';
import { createCoderAgentInit, buildCoderTaskMessage } from '../agents/coder-agent';
import { createGeneralAgentInit, buildGeneralTaskMessage } from '../agents/general-agent';
import { buildLeaderTaskContext } from '../agents/leader-agent';
import {
	formatWorkerToLeaderEnvelope,
	formatPlanEnvelope,
	formatLeaderToWorkerFeedback,
	formatLeaderContractNudge,
	sortTasksByPriority,
} from './message-routing';
import { isRateLimitError, createRateLimitBackoff } from './rate-limit-utils';
import { Logger } from '../../logger';
import {
	runWorkerExitGate,
	runLeaderCompleteGate,
	runLeaderSubmitGate,
	type HookOptions,
	type WorkerExitHookContext,
	type LeaderCompleteHookContext,
} from './lifecycle-hooks';

const log = new Logger('room-runtime');

export const DEFAULT_MAX_CONCURRENT_GROUPS = 1;
export const DEFAULT_MAX_FEEDBACK_ITERATIONS = 3;
/** Default when room config does not specify maxPlanningRetries (no auto-retry) */
const DEFAULT_MAX_PLANNING_RETRIES = 0;

export type { RuntimeState } from '@neokai/shared';

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
	/** Max feedback iterations before auto-escalation (default: 3) */
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
	/** Hook options for lifecycle gates (test injection point) */
	hookOptions?: HookOptions;
	/** Fetch room from DB by ID (for lazy leader init with current config) */
	getRoom: (roomId: string) => Room | null;
	/** Fetch task from DB by ID (for lazy leader init with current data) */
	getTask: (taskId: string) => Promise<NeoTask | null>;
	/** Fetch goal from DB by ID (for lazy leader init with current data) */
	getGoal: (goalId: string) => Promise<RoomGoal | null>;
}

function jsonResult(data: Record<string, unknown>): LeaderToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

export class RoomRuntime {
	private state: RuntimeState = 'paused';
	private tickLocked = false;
	private tickQueued = false;
	private tickTimer: ReturnType<typeof setInterval> | null = null;

	private room: Room;
	private readonly groupRepo: SessionGroupRepository;
	private readonly observer: SessionObserver;
	private readonly taskManager: TaskManager;
	private readonly goalManager: GoalManager;
	private readonly sessionFactory: SessionFactory;
	private maxConcurrentGroups: number;
	private maxFeedbackIterations: number;
	private readonly tickInterval: number;
	private readonly getWorkerMessages: RoomRuntimeConfig['getWorkerMessages'];
	private readonly daemonHub?: DaemonHub;
	private readonly messageHub?: MessageHub;
	private readonly hookOptions?: HookOptions;
	private readonly getRoomById: (roomId: string) => Room | null;

	/** Mirroring unsub functions per group ID */
	private mirroringCleanups = new Map<string, () => void>();

	readonly taskGroupManager: TaskGroupManager;

	/**
	 * Emit a room.task.update event so the frontend UI updates in real time.
	 * Called after every task status change within the runtime path.
	 */
	private emitTaskUpdate(task: NeoTask): void {
		if (!this.daemonHub) return;
		void this.daemonHub.emit('room.task.update', {
			sessionId: `room:${this.room.id}`,
			roomId: this.room.id,
			task,
		});
	}

	/**
	 * Fetch a task by ID and emit its update event.
	 */
	private async emitTaskUpdateById(taskId: string): Promise<void> {
		const task = await this.taskManager.getTask(taskId);
		if (task) this.emitTaskUpdate(task);
	}

	/**
	 * Recalculate progress for all goals linked to a task and emit goal.progressUpdated events.
	 * Called after task status or progress changes.
	 */
	private async emitGoalProgressForTask(taskId: string): Promise<void> {
		await this.goalManager.updateGoalsForTask(taskId);
		if (!this.daemonHub) return;
		const goals = await this.goalManager.getGoalsForTask(taskId);
		for (const goal of goals) {
			void this.daemonHub.emit('goal.progressUpdated', {
				sessionId: `room:${this.room.id}`,
				roomId: this.room.id,
				goalId: goal.id,
				progress: goal.progress,
			});
		}
	}

	constructor(config: RoomRuntimeConfig) {
		this.room = config.room;
		this.groupRepo = config.groupRepo;
		this.observer = config.sessionObserver;
		this.taskManager = config.taskManager;
		this.goalManager = config.goalManager;
		this.sessionFactory = config.sessionFactory;
		this.maxConcurrentGroups = config.maxConcurrentGroups ?? DEFAULT_MAX_CONCURRENT_GROUPS;
		this.maxFeedbackIterations = config.maxFeedbackIterations ?? DEFAULT_MAX_FEEDBACK_ITERATIONS;
		this.tickInterval = config.tickInterval ?? 30_000;
		this.getWorkerMessages = config.getWorkerMessages;
		this.daemonHub = config.daemonHub;
		this.messageHub = config.messageHub;
		this.hookOptions = config.hookOptions;
		this.getRoomById = config.getRoom;

		this.taskGroupManager = new TaskGroupManager({
			groupRepo: config.groupRepo,
			sessionObserver: config.sessionObserver,
			taskManager: config.taskManager,
			goalManager: config.goalManager,
			sessionFactory: config.sessionFactory,
			workspacePath: config.workspacePath,
			model: config.model,
			getRoom: config.getRoom,
			getTask: config.getTask,
			getGoal: config.getGoal,
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

	/**
	 * Update the room reference with the latest data.
	 * Called when room config changes so lifecycle hooks see the current config.
	 * Also picks up new maxConcurrentGroups and maxReviewRounds values reactively.
	 * Stale or removed config keys fall back to their documented defaults.
	 */
	updateRoom(room: Room): void {
		this.room = room;
		const config = (room.config ?? {}) as Record<string, unknown>;
		const rawGroups = config.maxConcurrentGroups;
		this.maxConcurrentGroups =
			typeof rawGroups === 'number' && rawGroups >= 1
				? Math.min(Math.floor(rawGroups), MAX_CONCURRENT_GROUPS_LIMIT)
				: DEFAULT_MAX_CONCURRENT_GROUPS;
		const rawRounds = config.maxReviewRounds;
		this.maxFeedbackIterations =
			typeof rawRounds === 'number' && rawRounds >= 1
				? Math.min(Math.floor(rawRounds), MAX_REVIEW_ROUNDS_LIMIT)
				: DEFAULT_MAX_FEEDBACK_ITERATIONS;
	}

	/**
	 * Maximum planning attempts for this room.
	 * Reads from room.config.maxPlanningRetries (default: 0 = no auto-retry).
	 * Fetches fresh room from DB to get current config.
	 */
	private get maxPlanningAttempts(): number {
		const currentRoom = this.getRoomById(this.room.id);
		const cfg = currentRoom?.config ?? this.room.config ?? {};
		const value = (cfg as Record<string, unknown>)['maxPlanningRetries'];
		if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
			// maxPlanningRetries is "how many retries after first failure":
			// 0 = only 1 attempt (no retries), N = N+1 total attempts
			return value + 1;
		}
		return DEFAULT_MAX_PLANNING_RETRIES + 1;
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
	 * Checks worktree cleanliness, then collects Worker output and routes to Leader.
	 */
	async onWorkerTerminalState(groupId: string, terminalState: TerminalState): Promise<void> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group || group.state !== 'awaiting_worker') return;

		const task = await this.taskManager.getTask(group.taskId);
		if (!task) return;

		// Check rate limit backoff
		if (this.groupRepo.isRateLimited(groupId)) {
			log.info(`Worker reached terminal state while rate limited - pausing routing to Leader`);
			this.scheduleTickAfterRateLimitReset(groupId);
			return;
		}

		// Worktree cleanliness gate: check for uncommitted changes before routing to leader.
		// Applies to all workers — planners create plan files under docs/plans/ and commit to branches.
		{
			const groupWorkspace = group.workspacePath ?? this.taskGroupManager.workspacePath;
			const dirty = await this.isWorktreeDirty(groupWorkspace);
			if (dirty) {
				log.info(`Worktree dirty for group ${groupId} — sending worker back to clean up.`);
				this.groupRepo.appendEvent({
					groupId,
					kind: 'status',
					payloadJson: JSON.stringify({
						text: 'Worktree has uncommitted changes. Sending worker back to clean up.',
					}),
				});
				await this.sessionFactory.injectMessage(
					group.workerSessionId,
					'Your worktree has uncommitted changes or untracked files. ' +
						'Make logical commits for changes you want to keep and clean up unused files. ' +
						'Run `git status` to see what needs attention, then commit or remove files as appropriate.'
				);
				return; // Stay in awaiting_worker state
			}
		}

		// Lifecycle hooks: Worker Exit Gate
		// Validates preconditions before routing to leader (branch/PR for coders, tasks for planners)
		{
			const groupWorkspace = group.workspacePath ?? this.taskGroupManager.workspacePath;
			const hookCtx: WorkerExitHookContext = {
				workspacePath: groupWorkspace,
				taskType: task.taskType ?? 'coding',
				workerRole: group.workerRole,
				taskId: group.taskId,
				groupId,
				approved: group.approved,
			};
			if (group.workerRole === 'planner') {
				const draftTasks = await this.taskManager.getDraftTasksByCreator(group.taskId);
				hookCtx.draftTaskCount = draftTasks.length;
			}
			const gateResult = await runWorkerExitGate(hookCtx, this.hookOptions);
			if (!gateResult.pass) {
				log.info(`Worker exit gate failed for group ${groupId}: ${gateResult.reason}`);
				this.groupRepo.appendEvent({
					groupId,
					kind: 'status',
					payloadJson: JSON.stringify({ text: `Worker exit gate: ${gateResult.reason}` }),
				});
				await this.sessionFactory.injectMessage(
					group.workerSessionId,
					gateResult.bounceMessage ?? gateResult.reason ?? 'Gate check failed'
				);
				return; // Stay in awaiting_worker state
			}
		}

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

		// Check for rate limit errors in worker output
		if (isRateLimitError(workerOutputText)) {
			const rateLimitBackoff = createRateLimitBackoff(workerOutputText, 'worker');
			if (rateLimitBackoff) {
				this.groupRepo.setRateLimit(groupId, rateLimitBackoff);
				log.info(
					`Rate limit detected in worker output for group ${groupId}. ` +
						`Backoff until ${new Date(rateLimitBackoff.resetsAt).toLocaleTimeString()}.`
				);
				this.groupRepo.appendEvent({
					groupId,
					kind: 'rate_limited',
					payloadJson: JSON.stringify({
						text: `Rate limit detected. Pausing until ${new Date(rateLimitBackoff.resetsAt).toLocaleTimeString()}.`,
						resetsAt: rateLimitBackoff.resetsAt,
						sessionRole: 'worker',
					}),
				});
				this.scheduleTickAfterRateLimitReset(groupId);
				return;
			}
		}

		// Collect tool call summaries across all messages
		const toolCallNames = workerMessages.flatMap((m) => m.toolCallNames);

		// Format output envelope for Leader review
		// Use plan envelope for planning groups, standard envelope for others
		// Iteration is 1-based: feedbackIteration + 1 = the review round about to start
		// (routeWorkerToLeader will persist this increment in DB)
		const reviewIteration = group.feedbackIteration + 1;
		let envelope: string;
		if (group.workerRole === 'planner') {
			const draftTasks = await this.taskManager.getDraftTasksByCreator(group.taskId);
			const goal = (await this.goalManager.getGoalsForTask(group.taskId))[0];
			envelope = formatPlanEnvelope({
				iteration: reviewIteration,
				goalTitle: goal?.title ?? task.title,
				terminalState: terminalState.kind,
				workerOutput: workerOutputText,
				draftTasks,
				approved: group.approved,
			});
		} else {
			envelope = formatWorkerToLeaderEnvelope({
				iteration: reviewIteration,
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

		// Insert status event into group timeline
		this.groupRepo.appendEvent({
			groupId,
			kind: 'status',
			payloadJson: JSON.stringify({
				text: `Worker (${group.workerRole}) finished (${terminalState.kind}). Routing to Leader for review.`,
			}),
		});

		// Route to Leader (room fetched from DB via getRoom)
		await this.taskGroupManager.routeWorkerToLeader(groupId, envelope, (groupId) =>
			this.createLeaderCallbacks(groupId)
		);

		// Update task progress based on review iteration
		// Formula: iteration 1 → 20%, then +60%/maxRounds per subsequent round, capped at 80%
		const progress = Math.min(
			80,
			Math.round(20 + Math.max(0, reviewIteration - 1) * (60 / this.maxFeedbackIterations))
		);
		await this.taskManager.updateTaskProgress(task.id, progress);
		await this.emitTaskUpdateById(task.id);
		await this.emitGoalProgressForTask(task.id);
	}

	/**
	 * Called when Leader reaches a terminal state.
	 * Validates Leader tool contract (retry-then-fail).
	 */
	async onLeaderTerminalState(groupId: string, _terminalState: TerminalState): Promise<void> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group || group.state !== 'awaiting_leader') return;

		// Check rate limit backoff
		if (this.groupRepo.isRateLimited(groupId)) {
			log.info(`Leader reached terminal state while rate limited - pausing nudge`);
			this.scheduleTickAfterRateLimitReset(groupId);
			return;
		}

		// Check if Leader called a tool (persisted in DB metadata)
		const calledTool = group.leaderCalledTool;

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
			// Second+ violation: fail the group
			await this.taskGroupManager.fail(groupId, 'Leader failed to call required tool after nudge');
			this.cleanupMirroring(groupId, 'Leader contract violation — task failed.');
			await this.emitTaskUpdateById(group.taskId);
			this.scheduleTick();
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
		params: { message?: string; summary?: string; reason?: string; pr_url?: string }
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

		// Mark that Leader called a tool (persisted immediately for restart safety)
		this.groupRepo.setLeaderCalledTool(groupId, true);

		switch (toolName) {
			case 'send_to_worker': {
				// Enforce max feedback iterations — runtime escalates to human review.
				// Like submit_for_review, this transitions to awaiting_human so we deliberately
				// do NOT call cleanupMirroring (keeps mirroring running, consistent behaviour).
				// The reason is persisted in the group timeline by escalateToHumanReview().
				if (group.feedbackIteration >= this.maxFeedbackIterations) {
					await this.taskGroupManager.escalateToHumanReview(
						groupId,
						`Max feedback iterations (${this.maxFeedbackIterations}) reached`
					);
					await this.emitTaskUpdateById(group.taskId);
					await this.emitGoalProgressForTask(group.taskId);
					this.scheduleTick();
					return jsonResult({
						success: false,
						error: `Max feedback iterations reached. Task escalated for human review.`,
					});
				}
				const message = params.message ?? '';
				// feedbackIteration is already 1-based (incremented in routeWorkerToLeader)
				const currentIteration = group.feedbackIteration;
				const feedback = formatLeaderToWorkerFeedback(message, currentIteration);

				// Clear any rate limit backoff since we're starting a new iteration
				this.groupRepo.clearRateLimit(groupId);

				// Insert status event into group timeline
				this.groupRepo.appendEvent({
					groupId,
					kind: 'status',
					payloadJson: JSON.stringify({
						text: `Leader sent feedback to Worker (iteration ${currentIteration}).`,
					}),
				});

				await this.taskGroupManager.routeLeaderToWorker(groupId, feedback);
				return jsonResult({
					success: true,
					message: 'Feedback sent to Worker. Waiting for next iteration.',
				});
			}

			case 'complete_task': {
				const summary = params.summary ?? '';

				// State machine enforcement: coding and planning tasks must go through submit_for_review first.
				// Both follow a two-phase flow: work → review → human approval → merge/create tasks → complete.
				// Exception: approved=true means human already approved (PR or plan).
				if (
					(group.workerRole === 'coder' || group.workerRole === 'planner') &&
					!group.submittedForReview &&
					!group.approved
				) {
					this.groupRepo.setLeaderCalledTool(groupId, false);
					return jsonResult({
						success: false,
						error: 'Tasks must go through submit_for_review before complete_task.',
						action_required:
							'Call submit_for_review with the PR URL first. After human approval, you can call complete_task.',
					});
				}

				// Lifecycle hooks: Leader Complete Gate
				// Validates preconditions before allowing task completion
				{
					const hookTask = await this.taskManager.getTask(group.taskId);
					if (hookTask) {
						const currentRoom = this.getRoomById(this.room.id);
						const roomConfig = (currentRoom?.config ?? {}) as Record<string, unknown>;
						const agentSubs = roomConfig.agentSubagents as Record<string, unknown[]> | undefined;
						const hasReviewers = !!agentSubs?.leader?.length;

						const hookCtx: LeaderCompleteHookContext = {
							workspacePath: group.workspacePath ?? this.taskGroupManager.workspacePath,
							taskType: hookTask.taskType ?? 'coding',
							workerRole: group.workerRole,
							taskId: group.taskId,
							groupId,
							hasReviewers,
							approved: group.approved,
						};
						if (hookTask.taskType === 'planning') {
							const draftTasks = await this.taskManager.getDraftTasksByCreator(group.taskId);
							hookCtx.draftTaskCount = draftTasks.length;
						}
						const gateResult = await runLeaderCompleteGate(hookCtx, this.hookOptions);
						if (!gateResult.pass) {
							log.info(`Leader complete gate failed for group ${groupId}: ${gateResult.reason}`);
							this.groupRepo.appendEvent({
								groupId,
								kind: 'status',
								payloadJson: JSON.stringify({ text: `Leader complete gate: ${gateResult.reason}` }),
							});
							// Reset leaderCalledTool so leader can try again
							this.groupRepo.setLeaderCalledTool(groupId, false);
							return jsonResult({
								success: false,
								error: gateResult.reason ?? 'Precondition not met.',
								action_required: gateResult.bounceMessage,
							});
						}
					}
				}

				await this.taskGroupManager.complete(groupId, summary);
				this.cleanupMirroring(groupId, 'Task completed.');
				await this.emitTaskUpdateById(group.taskId);
				await this.emitGoalProgressForTask(group.taskId);
				// If this was a planning task, promote its draft children to pending
				await this.promoteDraftTasksIfPlanning(group.taskId);
				this.scheduleTick();
				return jsonResult({ success: true, message: 'Task completed successfully.' });
			}

			case 'fail_task': {
				const reason = params.reason ?? '';
				await this.taskGroupManager.fail(groupId, reason);
				this.cleanupMirroring(groupId, `Task failed: ${reason}`);
				await this.emitTaskUpdateById(group.taskId);
				await this.emitGoalProgressForTask(group.taskId);
				this.scheduleTick();
				return jsonResult({ success: true, message: 'Task marked as failed.' });
			}

			case 'replan_goal': {
				const reason = params.reason ?? '';
				return this.handleReplanGoal(group.taskId, groupId, reason);
			}

			case 'submit_for_review': {
				const prUrl = params.pr_url ?? '';

				// Lifecycle gate: validate PR exists for coding/planning tasks (and reviews if reviewers configured)
				{
					const hookTask = await this.taskManager.getTask(group.taskId);
					if (hookTask && (group.workerRole === 'coder' || group.workerRole === 'planner')) {
						const currentRoom = this.getRoomById(this.room.id);
						const roomConfig = (currentRoom?.config ?? {}) as Record<string, unknown>;
						const agentSubs = roomConfig.agentSubagents as Record<string, unknown[]> | undefined;
						const hasReviewers = !!agentSubs?.leader?.length;

						const hookCtx: LeaderCompleteHookContext = {
							workspacePath: group.workspacePath ?? this.taskGroupManager.workspacePath,
							taskType: hookTask.taskType ?? 'coding',
							workerRole: group.workerRole,
							taskId: group.taskId,
							groupId,
							hasReviewers,
						};
						const gateResult = await runLeaderSubmitGate(hookCtx, this.hookOptions);
						if (!gateResult.pass) {
							log.info(`Leader submit gate failed for group ${groupId}: ${gateResult.reason}`);
							this.groupRepo.appendEvent({
								groupId,
								kind: 'status',
								payloadJson: JSON.stringify({ text: `Leader submit gate: ${gateResult.reason}` }),
							});
							// Reset leaderCalledTool so leader can try again
							this.groupRepo.setLeaderCalledTool(groupId, false);
							return jsonResult({
								success: false,
								error: gateResult.reason ?? 'Precondition not met.',
								action_required: gateResult.bounceMessage,
							});
						}
					}
				}

				// Mark that submit_for_review was called (gates complete_task state machine)
				this.groupRepo.setSubmittedForReview(groupId, true);

				await this.taskGroupManager.submitForReview(groupId, prUrl);
				await this.emitTaskUpdateById(group.taskId);
				await this.emitGoalProgressForTask(group.taskId);
				// Do NOT call scheduleTick() — the group stays alive in awaiting_human.
				// The slot is excluded from the active count in executeTick().
				return jsonResult({
					success: true,
					message: `Task submitted for human review. PR: ${prUrl}. Waiting for human approval before completing.`,
				});
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
			replanGoal: async (_groupId: string, reason: string) => {
				return this.handleLeaderTool(groupId, 'replan_goal', { reason });
			},
			submitForReview: async (_groupId: string, prUrl: string) => {
				return this.handleLeaderTool(groupId, 'submit_for_review', { pr_url: prUrl });
			},
		};
	}

	/**
	 * Resume a group from awaiting_human by injecting a message into the existing worker.
	 *
	 * Used for all task types (planning, coding, general):
	 * - Approve: sets approved=true → worker merges PR (planner also creates tasks)
	 * - Reject: no flag set, submittedForReview reset → worker addresses feedback
	 *
	 * Reuses the same worker and leader sessions — no new sessions are created.
	 */
	async resumeWorkerFromHuman(
		taskId: string,
		message: string,
		opts?: { approved?: boolean }
	): Promise<boolean> {
		const group = this.groupRepo.getGroupByTaskId(taskId);
		if (!group || group.state !== 'awaiting_human') return false;

		// Verify the task belongs to this runtime's room
		const task = await this.taskManager.getTask(taskId);
		if (!task) return false;

		// Set approved when:
		// - explicitly requested via opts.approved === true, OR
		// - resuming a planner (always treated as an approval) UNLESS explicitly denied
		const shouldApprove =
			opts?.approved === true || (group.workerRole === 'planner' && opts?.approved !== false);
		if (shouldApprove) {
			this.groupRepo.setApproved(group.id, true);
		}

		// Move task back to in_progress
		await this.taskManager.updateTaskStatus(group.taskId, 'in_progress');

		// Delegate to TaskGroupManager (injects message into existing worker).
		// If injection fails, TaskGroupManager rolls back group state. We also
		// revert the task status so the task stays in review for retry.
		try {
			const updated = await this.taskGroupManager.resumeWorkerFromHuman(group.id, message);
			if (!updated) return false;
		} catch (error) {
			await this.taskManager.reviewTask(group.taskId);
			log.error(`Failed to resume worker from human for task ${taskId}:`, error);
			return false;
		}

		await this.emitTaskUpdateById(group.taskId);
		await this.emitGoalProgressForTask(group.taskId);
		this.scheduleTick();
		return true;
	}

	/**
	 * Inject a human message directly into the leader session.
	 *
	 * Used when the group is awaiting_leader and a human wants to provide
	 * guidance or additional context to the leader agent.
	 *
	 * Note: sessionFactory.injectMessage() writes to the SDK messages table only.
	 * Task timelines are reconstructed from SDK messages + task_group_events.
	 *
	 * Returns true on success, false if the group is not in awaiting_leader state
	 * or if the injection fails.
	 */
	async injectMessageToLeader(taskId: string, message: string): Promise<boolean> {
		const group = this.groupRepo.getGroupByTaskId(taskId);
		if (!group || group.state !== 'awaiting_leader') return false;

		const formattedMessage = `[Human intervention]\n\n${message}`;
		try {
			await this.sessionFactory.injectMessage(group.leaderSessionId, formattedMessage);
		} catch (error) {
			log.error(`Failed to inject message into leader session ${group.leaderSessionId}:`, error);
			return false;
		}
		return true;
	}

	/**
	 * Restore MCP servers for a session group after daemon restart.
	 *
	 * MCP servers are runtime-only (non-serializable) and NOT persisted to DB.
	 * Without this, restored planner sessions lose the create_task tool and
	 * restored leader sessions lose send_to_worker/complete_task/etc.
	 */
	async restoreMcpServersForGroup(group: SessionGroup): Promise<void> {
		// Restore planner MCP server (worker)
		if (group.workerRole === 'planner') {
			const task = await this.taskManager.getTask(group.taskId);
			if (task) {
				const isPlanApproved = () => {
					return this.groupRepo.getGroup(group.id)?.approved ?? false;
				};
				const createDraftTask = async (
					params: PlannerCreateTaskParams
				): Promise<{ id: string; title: string }> => {
					const goal = await this.goalManager.getGoalsForTask(task.id).then((g) => g[0] ?? null);
					const newTask = await this.taskManager.createTask({
						title: params.title,
						description: params.description,
						priority: params.priority,
						dependsOn: params.dependsOn,
						taskType: 'coding',
						status: 'draft',
						createdByTaskId: task.id,
						assignedAgent: params.agent,
					});
					if (goal) {
						await this.goalManager.linkTaskToGoal(goal.id, newTask.id);
					}
					log.info(`Planning (restored) created draft task: ${newTask.id} (${newTask.title})`);
					return { id: newTask.id, title: newTask.title };
				};
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

				// Fetch fresh room from DB for MCP server init (config may have changed)
				const currentRoom = this.getRoomById(this.room.id) ?? this.room;
				const goal = await this.goalManager.getGoalsForTask(task.id).then((g) => g[0] ?? null);
				const mcpServer = createPlannerMcpServer({
					task,
					goal: goal!,
					room: currentRoom,
					sessionId: group.workerSessionId,
					workspacePath: group.workspacePath ?? this.taskGroupManager.workspacePath,
					createDraftTask,
					updateDraftTask,
					removeDraftTask,
					isPlanApproved,
				});
				this.sessionFactory.setSessionMcpServers(group.workerSessionId, {
					'planner-tools': mcpServer,
				});
				log.info(`Restored planner MCP server for group ${group.id}`);
			}
		}

		// Restore leader MCP server
		if (this.sessionFactory.hasSession(group.leaderSessionId)) {
			const callbacks = this.createLeaderCallbacks(group.id);
			const leaderMcpServer = createLeaderMcpServer(group.id, callbacks);
			this.sessionFactory.setSessionMcpServers(group.leaderSessionId, {
				'leader-agent-tools': leaderMcpServer,
			});
			log.info(`Restored leader MCP server for group ${group.id}`);
		}
	}

	// =========================================================================
	// Message Mirroring
	// =========================================================================

	/**
	 * Set up live message forwarding for a group's worker/leader sessions.
	 *
	 * Subscribes to DaemonHub sdk.message events and broadcasts enriched deltas
	 * on state.groupMessages.delta for TaskConversationRenderer.
	 *
	 * IMPORTANT: We intentionally do NOT mirror worker/leader SDK messages into
	 * any group message table anymore. Task view history is reconstructed from each
	 * session's sdk_messages stream via task.getGroupMessages.
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

					// Check for rate limit errors in the message content
					// This detects rate limits in real-time for both Worker and Leader sessions
					const messageContent = JSON.stringify(event.message);
					if (isRateLimitError(messageContent)) {
						const sessionRole = sessionId === group.workerSessionId ? 'worker' : 'leader';
						const rateLimitBackoff = createRateLimitBackoff(messageContent, sessionRole);
						if (rateLimitBackoff) {
							this.groupRepo.setRateLimit(group.id, rateLimitBackoff);
							log.info(
								`Rate limit detected in ${role} message for group ${group.id}. ` +
									`Backoff until ${new Date(rateLimitBackoff.resetsAt).toLocaleTimeString()}.`
							);
							this.groupRepo.appendEvent({
								groupId: group.id,
								kind: 'rate_limited',
								payloadJson: JSON.stringify({
									text: `Rate limit detected in ${role} output. Pausing until ${new Date(rateLimitBackoff.resetsAt).toLocaleTimeString()}.`,
									resetsAt: rateLimitBackoff.resetsAt,
									sessionRole,
								}),
							});
						}
					}

					// Read current iteration from DB to stay accurate across feedback cycles
					const currentGroup = this.groupRepo.getGroup(group.id);
					const iteration = currentGroup?.feedbackIteration ?? group.feedbackIteration;
					const turnId = `turn_${group.id}_${iteration}_${shortSessionId}`;

					// Broadcast enriched delta to subscribed frontends.
					if (this.messageHub) {
						const enrichedMessage = {
							...event.message,
							_taskMeta: {
								authorRole: role,
								authorSessionId: sessionId,
								turnId,
								iteration,
							},
						};
						this.messageHub.event(
							'state.groupMessages.delta',
							{ added: [{ ...enrichedMessage, timestamp: Date.now() }], timestamp: Date.now() },
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
			this.groupRepo.appendEvent({
				groupId,
				kind: 'status',
				payloadJson: JSON.stringify({ text: statusText }),
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

	/**
	 * Safety net: detect groups whose worker/leader sessions are missing from the
	 * in-memory cache. Returns zombie groups that need async restoration.
	 *
	 * Split into sync detection + async recovery to avoid unnecessary microtask
	 * checkpoints when there are no zombies (common case).
	 */
	private findZombieGroups(): SessionGroup[] {
		const allActiveGroups = this.groupRepo.getActiveGroups(this.room.id);
		const zombies: SessionGroup[] = [];

		for (const group of allActiveGroups) {
			const workerMissing = !this.sessionFactory.hasSession(group.workerSessionId);
			const leaderMissing =
				group.state === 'awaiting_leader' && !this.sessionFactory.hasSession(group.leaderSessionId);

			if (workerMissing || leaderMissing) {
				zombies.push(group);
			}
		}

		return zombies;
	}

	/**
	 * Attempt to restore zombie groups. Called only when findZombieGroups()
	 * returns non-empty results.
	 */
	private async recoverZombieGroups(zombies: SessionGroup[]): Promise<void> {
		for (const group of zombies) {
			// Check worker session liveness
			let workerRestored = false;
			if (!this.sessionFactory.hasSession(group.workerSessionId)) {
				log.warn(
					`Zombie detected: group ${group.id} (state=${group.state}) ` +
						`worker ${group.workerSessionId} not in cache. Attempting restore.`
				);
				const restored = await this.sessionFactory.restoreSession(group.workerSessionId);
				if (restored) {
					log.info(`Restored worker session ${group.workerSessionId} for group ${group.id}`);
					this.observer.observe(group.workerSessionId, (state) => {
						this.onWorkerTerminalState(group.id, state);
					});
					workerRestored = true;
				} else {
					log.error(
						`Failed to restore worker ${group.workerSessionId}. Failing group ${group.id}.`
					);
					await this.taskGroupManager.fail(
						group.id,
						'Worker session lost and could not be restored'
					);
					this.cleanupMirroring(group.id, 'Worker session lost — could not be restored.');
					await this.emitTaskUpdateById(group.taskId);
					continue;
				}
			}

			// Check leader session liveness (only when leader is the active actor)
			let leaderRestored = false;
			if (
				group.state === 'awaiting_leader' &&
				!this.sessionFactory.hasSession(group.leaderSessionId)
			) {
				log.warn(
					`Zombie detected: group ${group.id} (state=awaiting_leader) ` +
						`leader ${group.leaderSessionId} not in cache. Attempting restore.`
				);
				const restored = await this.sessionFactory.restoreSession(group.leaderSessionId);
				if (restored) {
					log.info(`Restored leader session ${group.leaderSessionId} for group ${group.id}`);
					this.observer.observe(group.leaderSessionId, (state) => {
						this.onLeaderTerminalState(group.id, state);
					});
					leaderRestored = true;
				} else {
					log.error(
						`Failed to restore leader ${group.leaderSessionId}. Failing group ${group.id}.`
					);
					await this.taskGroupManager.fail(
						group.id,
						'Leader session lost and could not be restored'
					);
					this.cleanupMirroring(group.id, 'Leader session lost — could not be restored.');
					await this.emitTaskUpdateById(group.taskId);
				}
			}

			// Inject continuation message for restored sessions that need to resume work.
			// The SDK query is started lazily by injectMessage → ensureQueryStarted().
			// Sessions in awaiting_human don't need a message — human will provide one.
			try {
				if (workerRestored && group.state === 'awaiting_worker') {
					await this.sessionFactory.injectMessage(
						group.workerSessionId,
						'The system was restarted. Continue working on the task from where you left off.'
					);
				}
				if (leaderRestored && group.state === 'awaiting_leader') {
					await this.sessionFactory.injectMessage(
						group.leaderSessionId,
						'The system was restarted. Continue reviewing from where you left off.'
					);
				}
			} catch (error) {
				log.error(`Failed to inject continuation message for group ${group.id}:`, error);
			}
		}
	}

	private async executeTick(): Promise<void> {
		// Safety net: detect and recover zombie groups (sessions missing from cache).
		// Sync detection avoids unnecessary microtask checkpoints in the common case.
		const zombies = this.findZombieGroups();
		if (zombies.length > 0) {
			await this.recoverZombieGroups(zombies);
		}

		// Check capacity — awaiting_human groups are paused and don't consume slots
		const activeGroups = this.groupRepo
			.getActiveGroups(this.room.id)
			.filter((g) => g.state !== 'awaiting_human');
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

		// Filter to tasks whose dependencies are all completed
		const readyTasks: NeoTask[] = [];
		for (const task of executableTasks) {
			if (await this.taskManager.areDependenciesMet(task)) {
				readyTasks.push(task);
			}
		}
		if (readyTasks.length === 0) return;

		// Sort by priority
		const sorted = sortTasksByPriority(readyTasks);

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
	 * - planning_attempts < this.maxPlanningAttempts
	 *
	 * Goals that exceed maxPlanningAttempts are transitioned to 'needs_human'.
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
				// Check whether execution tasks need replanning.
				// A goal needs replanning when:
				// - No active (pending/in_progress/draft/escalated) tasks remain
				// - All execution tasks (non-planning) are failed
				// This handles both "all tasks failed" and "planning succeeded but
				// all execution tasks failed" scenarios.
				const linkedTasks = await Promise.all(
					linkedTaskIds.map((id) => this.taskManager.getTask(id))
				);
				const validTasks = linkedTasks.filter(Boolean) as NonNullable<
					(typeof linkedTasks)[number]
				>[];
				const hasActiveTask = validTasks.some((t) =>
					(['pending', 'in_progress', 'draft', 'review'] as const).includes(
						t.status as 'pending' | 'in_progress' | 'draft' | 'review'
					)
				);
				const executionTasks = validTasks.filter((t) => t.taskType !== 'planning');
				const isTerminal = (status: string) => status === 'failed' || status === 'cancelled';
				const allExecutionFailed =
					executionTasks.length > 0 && executionTasks.every((t) => isTerminal(t.status));
				const allFailed = validTasks.length > 0 && validTasks.every((t) => isTerminal(t.status));

				// Re-plan if no active tasks and either all tasks reached a terminal state
				// (failed or cancelled) or all execution tasks reached a terminal state
				needsPlanning = !hasActiveTask && (allFailed || allExecutionFailed);
			}

			if (!needsPlanning) continue;

			const attempts = goal.planning_attempts ?? 0;

			if (attempts >= this.maxPlanningAttempts) {
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
	private async spawnPlanningGroup(goal: RoomGoal, replanContext?: ReplanContext): Promise<void> {
		const isReplan = !!replanContext;
		// Create the planning task itself
		const planningTask = await this.taskManager.createTask({
			title: isReplan ? `Replan: ${goal.title}` : `Plan: ${goal.title}`,
			description: isReplan
				? `Replan the goal "${goal.title}" after task failure. Build on completed work.`
				: `Examine the codebase and break down the goal "${goal.title}" into concrete, executable tasks.`,
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
				dependsOn: params.dependsOn,
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

		// Fetch fresh room from DB for worker/leader init (config may have changed)
		const currentRoom = this.getRoomById(this.room.id) ?? this.room;

		// Build WorkerConfig for the Planner agent
		// isPlanApproved uses a mutable ref — groupId is set after spawn() returns
		let spawnedGroupId: string | null = null;
		const isPlanApproved = () => {
			if (!spawnedGroupId) return false;
			return this.groupRepo.getGroup(spawnedGroupId)?.approved ?? false;
		};
		const plannerConfig = {
			task: planningTask,
			goal,
			room: currentRoom,
			sessionId: '', // placeholder — overwritten by initFactory
			workspacePath: this.taskGroupManager.workspacePath,
			model: this.taskGroupManager.model,
			createDraftTask,
			updateDraftTask,
			removeDraftTask,
			replanContext,
			isPlanApproved,
		};
		const workerConfig: WorkerConfig = {
			role: 'planner',
			initFactory: (workerSessionId) =>
				createPlannerAgentInit({ ...plannerConfig, sessionId: workerSessionId }),
			taskMessage: buildPlannerTaskMessage(plannerConfig),
			leaderTaskContext: buildLeaderTaskContext({
				task: planningTask,
				goal,
				room: currentRoom,
				sessionId: '', // not used by buildLeaderTaskContext
				workspacePath: this.taskGroupManager.workspacePath,
				groupId: '', // not used by buildLeaderTaskContext
				model: this.taskGroupManager.model,
				reviewContext: 'plan_review',
			}),
		};

		// Notify UI: planning task created
		this.emitTaskUpdate(planningTask);

		// Spawn the planning group directly (bypasses the tick queue)
		let group;
		try {
			group = await this.taskGroupManager.spawn(
				currentRoom,
				planningTask,
				goal,
				(groupId, state) => this.onWorkerTerminalState(groupId, state),
				(groupId, state) => this.onLeaderTerminalState(groupId, state),
				(groupId) => this.createLeaderCallbacks(groupId),
				workerConfig,
				'plan_review'
			);
		} catch (err) {
			// spawn() already called failTask() before throwing — log and continue
			log.error(`Failed to spawn planning group for goal ${goal.id}: ${err}`);
			await this.emitTaskUpdateById(planningTask.id);
			return;
		}

		// Wire up the mutable ref so isPlanApproved can query the group
		spawnedGroupId = group.id;

		// Notify UI: planning task is now in_progress
		await this.emitTaskUpdateById(planningTask.id);
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

		// Fetch fresh room from DB for worker/leader init (config may have changed)
		const currentRoom = this.getRoomById(this.room.id) ?? this.room;

		// Determine worker config based on assigned agent type
		const agentType = task.assignedAgent ?? 'coder';
		let workerConfig: WorkerConfig;

		// Shared leader context config (groupId not used by buildLeaderTaskContext)
		const leaderContextConfig = {
			task,
			goal,
			room: currentRoom,
			sessionId: '',
			workspacePath: this.taskGroupManager.workspacePath,
			groupId: '',
			model: this.taskGroupManager.model,
			reviewContext: 'code_review' as const,
		};

		if (agentType === 'general') {
			const generalConfig = {
				task,
				goal,
				room: currentRoom,
				sessionId: '', // placeholder — overwritten by initFactory
				workspacePath: this.taskGroupManager.workspacePath,
				model: this.taskGroupManager.model,
				previousTaskSummaries,
			};
			workerConfig = {
				role: 'general',
				initFactory: (workerSessionId) =>
					createGeneralAgentInit({ ...generalConfig, sessionId: workerSessionId }),
				taskMessage: buildGeneralTaskMessage(generalConfig),
				leaderTaskContext: buildLeaderTaskContext(leaderContextConfig),
			};
		} else {
			// Default to coder
			const coderConfig = {
				task,
				goal,
				room: currentRoom,
				sessionId: '', // placeholder — overwritten by initFactory
				workspacePath: this.taskGroupManager.workspacePath,
				model: this.taskGroupManager.model,
				previousTaskSummaries,
			};
			workerConfig = {
				role: 'coder',
				initFactory: (workerSessionId) =>
					createCoderAgentInit({ ...coderConfig, sessionId: workerSessionId }),
				taskMessage: buildCoderTaskMessage(coderConfig),
				leaderTaskContext: buildLeaderTaskContext(leaderContextConfig),
			};
		}

		let group;
		try {
			group = await this.taskGroupManager.spawn(
				currentRoom,
				task,
				goal,
				(groupId, state) => this.onWorkerTerminalState(groupId, state),
				(groupId, state) => this.onLeaderTerminalState(groupId, state),
				(groupId) => this.createLeaderCallbacks(groupId),
				workerConfig,
				'code_review'
			);
		} catch (err) {
			// spawn() already called failTask() before throwing — log and continue to next task
			log.error(`Failed to spawn group for task ${task.id}: ${err}`);
			await this.emitTaskUpdateById(task.id);
			return;
		}

		// Notify UI: task is now in_progress
		await this.emitTaskUpdateById(task.id);
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

		// Safety net: ensure all draft children are linked to the same goal
		// as the planning task. MCP server closures may have been lost on
		// daemon restart, so linkTaskToGoal may not have been called.
		const goals = await this.goalManager.getGoalsForTask(taskId);
		const goal = goals[0];
		if (goal) {
			const drafts = await this.taskManager.getDraftTasksByCreator(taskId);
			const linked = new Set(goal.linkedTaskIds ?? []);
			for (const draft of drafts) {
				if (!linked.has(draft.id)) {
					await this.goalManager.linkTaskToGoal(goal.id, draft.id);
					log.info(`Linked draft task ${draft.id} to goal ${goal.id} (safety net)`);
				}
			}
		}

		const promoted = await this.taskManager.promoteDraftTasks(taskId);
		if (promoted > 0) {
			log.info(
				`Promoted ${promoted} draft task(s) to pending after planning task ${taskId} completed`
			);
			// Notify UI about all newly promoted tasks
			const pendingTasks = await this.taskManager.listTasks({ status: 'pending' });
			for (const t of pendingTasks) {
				this.emitTaskUpdate(t);
			}
			// Recalculate goal progress now that draft tasks are pending
			await this.emitGoalProgressForTask(taskId);
		}
	}

	/**
	 * Handle the replan_goal leader tool.
	 *
	 * Fails the current task, cancels remaining pending sibling tasks,
	 * and spawns a new planning group with context about what was tried.
	 *
	 * Guards:
	 * - Task must be an execution task (not planning)
	 * - Goal must be active with remaining pending tasks
	 * - planning_attempts < this.maxPlanningAttempts
	 */
	private async handleReplanGoal(
		taskId: string,
		groupId: string,
		reason: string
	): Promise<LeaderToolResult> {
		const task = await this.taskManager.getTask(taskId);
		if (!task) {
			return jsonResult({ success: false, error: `Task not found: ${taskId}` });
		}

		if (task.taskType === 'planning') {
			return jsonResult({
				success: false,
				error: 'Cannot replan from a planning task. Use fail_task instead.',
			});
		}

		const goals = await this.goalManager.getGoalsForTask(taskId);
		if (goals.length === 0) {
			return jsonResult({ success: false, error: 'No goal linked to this task.' });
		}

		const goal = goals[0];
		if (goal.status !== 'active') {
			return jsonResult({
				success: false,
				error: `Goal is not active (status: ${goal.status}).`,
			});
		}

		const attempts = goal.planning_attempts ?? 0;
		if (attempts >= this.maxPlanningAttempts) {
			// Fail the task and escalate instead of replanning
			await this.taskGroupManager.fail(groupId, reason);
			this.cleanupMirroring(groupId, `Task failed: ${reason}`);
			await this.emitTaskUpdateById(taskId);
			await this.goalManager.updateGoalStatus(goal.id, 'needs_human');
			this.scheduleTick();
			return jsonResult({
				success: false,
				error: `Max planning retries (${this.maxPlanningAttempts - 1}) reached. Goal escalated to human.`,
			});
		}

		// Fail the current task
		await this.taskGroupManager.fail(groupId, reason);
		this.cleanupMirroring(groupId, `Task failed (replanning): ${reason}`);
		await this.emitTaskUpdateById(taskId);

		// Cancel remaining pending sibling tasks
		const linkedTaskIds = goal.linkedTaskIds ?? [];
		const linkedTasks = await Promise.all(linkedTaskIds.map((id) => this.taskManager.getTask(id)));
		const validTasks = linkedTasks.filter(Boolean) as NeoTask[];
		const pendingTasks = validTasks.filter((t) => t.status === 'pending');

		const cancelledCount = await this.taskManager.cancelPendingTasks(pendingTasks.map((t) => t.id));
		// Notify UI about all linked tasks — emit for every linked task ID so that
		// cascade-cancelled dependents (which may be in linkedTaskIds but not in
		// the explicit pendingTasks filter) also get a UI update.
		for (const id of linkedTaskIds) {
			await this.emitTaskUpdateById(id);
		}
		log.info(
			`Replan: cancelled ${cancelledCount} pending tasks for goal ${goal.id} (attempt ${attempts + 1})`
		);

		// Gather context for the replanner (exclude planning tasks from completed list)
		const completedTasks = validTasks
			.filter((t) => t.status === 'completed' && t.taskType !== 'planning')
			.map((t) => ({ title: t.title, result: t.result ?? 'completed' }));

		const replanContext: ReplanContext = {
			completedTasks,
			failedTask: { title: task.title, error: reason },
			attempt: attempts + 1,
		};

		await this.spawnPlanningGroup(goal, replanContext);
		this.scheduleTick();

		return jsonResult({
			success: true,
			message: `Replanning triggered for goal "${goal.title}" (attempt ${attempts + 1}). ${cancelledCount} pending tasks cancelled.`,
		});
	}

	private scheduleTick(): void {
		if (this.state !== 'running') return;
		// Use queueMicrotask for non-blocking tick scheduling
		queueMicrotask(() => this.tick());
	}

	/**
	 * Schedule a tick after rate limit reset time.
	 * Used to resume work after API rate limit backoff period expires.
	 */
	private scheduleTickAfterRateLimitReset(groupId: string): void {
		const remainingMs = this.groupRepo.getRateLimitRemainingMs(groupId);
		if (remainingMs <= 0) {
			// Rate limit already expired, schedule immediate tick
			this.scheduleTick();
			return;
		}

		// Add a small buffer (5 seconds) to ensure rate limit has fully reset
		const delayMs = remainingMs + 5000;

		log.info(
			`Scheduling tick in ${Math.round(delayMs / 1000)}s for group ${groupId} ` +
				`(rate limit resets at ${new Date(Date.now() + remainingMs).toLocaleTimeString()})`
		);

		setTimeout(() => {
			// Clear the rate limit backoff since it should be expired now
			this.groupRepo.clearRateLimit(groupId);
			this.scheduleTick();
		}, delayMs);
	}

	/**
	 * Check if a worktree has uncommitted changes or untracked files.
	 * Returns true if dirty (has changes), false if clean.
	 */
	private async isWorktreeDirty(workspacePath: string): Promise<boolean> {
		try {
			const proc = Bun.spawn(['git', 'status', '--porcelain'], {
				cwd: workspacePath,
				stdout: 'pipe',
				stderr: 'pipe',
			});
			const output = await new Response(proc.stdout).text();
			await proc.exited;
			return output.trim().length > 0;
		} catch {
			// If git status fails (e.g., not a git repo), treat as clean
			return false;
		}
	}
}
