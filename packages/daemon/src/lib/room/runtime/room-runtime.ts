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
	type GlobalSettings,
	type FallbackModelEntry,
	MAX_CONCURRENT_GROUPS_LIMIT,
	MAX_REVIEW_ROUNDS_LIMIT,
} from '@neokai/shared';
import type {
	SessionGroupRepository,
	SessionGroup,
	RateLimitBackoff,
} from '../state/session-group-repository';
import type { TaskManager } from '../managers/task-manager';
import type { GoalManager } from '../managers/goal-manager';
import type { SessionObserver, TerminalState } from '../state/session-observer';
import type { SessionFactory, WorkerConfig } from './task-group-manager';
import { TaskGroupManager } from './task-group-manager';
import type { DaemonHub } from '../../daemon-hub';
import type { ModelSwitchResult } from '../../agent/model-switch-handler';
import type { LeaderToolCallbacks, LeaderToolResult } from '../agents/leader-agent';
import { createLeaderMcpServer } from '../agents/leader-agent';
import type {
	PlannerCreateTaskParams,
	ReplanContext,
	MetricReplanStatus,
} from '../agents/planner-agent';
import {
	createPlannerAgentInit,
	createPlannerMcpServer,
	buildPlannerTaskMessage,
} from '../agents/planner-agent';
import { getEffectiveMaxPlanningAttempts } from '../../../storage/repositories/goal-repository';
import { createCoderAgentInit, buildCoderTaskMessage } from '../agents/coder-agent';
import { createGeneralAgentInit, buildGeneralTaskMessage } from '../agents/general-agent';
import { buildLeaderTaskContext } from '../agents/leader-agent';
import {
	formatWorkerToLeaderEnvelope,
	formatPlanEnvelope,
	formatLeaderToWorkerFeedback,
	sortTasksByPriority,
} from './message-routing';
import { createRateLimitBackoff } from './rate-limit-utils';
import { classifyError } from './error-classifier';
import { Logger } from '../../logger';
import {
	runWorkerExitGate,
	runLeaderCompleteGate,
	runLeaderSubmitGate,
	closeStalePr,
	type HookOptions,
	type HookResult,
	type WorkerExitHookContext,
	type LeaderCompleteHookContext,
} from './lifecycle-hooks';
import { checkDeadLoop, DEFAULT_DEAD_LOOP_CONFIG, type DeadLoopConfig } from './dead-loop-detector';
import { getNextRunAt } from './cron-utils';
import { inferProviderForModel } from '../../providers/registry';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository';
import { enqueueRoomTick, cancelPendingTickJobs } from '../../job-handlers/room-tick.handler';

const log = new Logger('room-runtime');

export const DEFAULT_MAX_CONCURRENT_GROUPS = 1;
export const DEFAULT_MAX_FEEDBACK_ITERATIONS = 3;
/** Default when room config does not specify maxPlanningRetries (no auto-retry) */
const DEFAULT_MAX_PLANNING_RETRIES = 0;

/**
 * Task statuses that indicate a group is stale and should be auto-cleaned.
 * Groups whose tasks are in these terminal states but still marked active
 * consume concurrency slots and prevent new tasks from being picked up.
 */
const STALE_TASK_STATUSES = new Set<string>(['completed', 'cancelled', 'archived']);

export type { RuntimeState } from '@neokai/shared';

export interface WorkerMessage {
	/** DB row ID in sdk_messages — used to track last_forwarded_message_id */
	id: string;
	/** Extracted assistant text */
	text: string;
	/** Names of tools called (for envelope summary) */
	toolCallNames: string[];
}

/** Response from session.model.get RPC */
interface SessionModelGetResult {
	currentModel: string;
	modelInfo?: { provider?: string };
}

export interface RoomRuntimeConfig {
	room: Room;
	groupRepo: SessionGroupRepository;
	sessionObserver: SessionObserver;
	taskManager: TaskManager;
	goalManager: GoalManager;
	sessionFactory: SessionFactory;
	workspacePath: string;
	/** Leader model (agentModels.leader > room.defaultModel > global default) */
	model?: string;
	/** Worker model (agentModels.worker > room.defaultModel > global default) */
	workerModel?: string;
	/** Global default model for fallback when room doesn't specify one */
	defaultModel?: string;
	/** Max concurrent groups (default: 1 for MVP) */
	maxConcurrentGroups?: number;
	/** Max feedback iterations before auto-escalation (default: 3) */
	maxFeedbackIterations?: number;
	/**
	 * Job queue used to schedule and cancel room.tick jobs.
	 * When provided, scheduleTick() enqueues a room.tick job via enqueueRoomTick.
	 * When absent (e.g., in unit tests), tick scheduling is a no-op and tests
	 * drive ticks directly via runtime.tick().
	 */
	jobQueue?: JobQueueRepository;
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
	/** Dead loop detection config (overrides defaults) */
	deadLoopConfig?: Partial<DeadLoopConfig>;
	/** Fetch room from DB by ID (for lazy leader init with current config) */
	getRoom: (roomId: string) => Room | null;
	/** Fetch task from DB by ID (for lazy leader init with current data) */
	getTask: (taskId: string) => Promise<NeoTask | null>;
	/** Fetch goal from DB by ID (for lazy leader init with current data) */
	getGoal: (goalId: string) => Promise<RoomGoal | null>;
	/** Get current global settings including fallbackModels for auto-fallback on rate limits */
	getGlobalSettings: () => GlobalSettings;
}

function jsonResult(data: Record<string, unknown>): LeaderToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

export class RoomRuntime {
	private state: RuntimeState = 'paused';
	private readonly jobQueue: JobQueueRepository | null;

	private readonly roomId: string;
	private room: Room;
	private readonly groupRepo: SessionGroupRepository;
	private readonly observer: SessionObserver;
	private readonly taskManager: TaskManager;
	private readonly goalManager: GoalManager;
	private readonly sessionFactory: SessionFactory;
	private maxConcurrentGroups: number;
	private maxFeedbackIterations: number;
	private readonly getWorkerMessages: RoomRuntimeConfig['getWorkerMessages'];
	private readonly daemonHub?: DaemonHub;
	private readonly messageHub?: MessageHub;
	private readonly hookOptions?: HookOptions;
	private readonly deadLoopConfig: DeadLoopConfig;
	private readonly getRoomById: (roomId: string) => Room | null;
	private readonly defaultModel: string;
	private readonly getGlobalSettings: () => GlobalSettings;

	/** Mirroring unsub functions per group ID */
	private mirroringCleanups = new Map<string, () => void>();

	/**
	 * Group IDs whose stuck-worker recovery is currently in-flight.
	 * Guards against duplicate `onWorkerTerminalState` calls across successive ticks
	 * while the first fire-and-forget routing is still completing.
	 */
	private stuckWorkerRecoveryInFlight = new Set<string>();

	readonly taskGroupManager: TaskGroupManager;

	/**
	 * Emit a room.task.update event so the frontend UI updates in real time.
	 * Called after every task status change within the runtime path.
	 */
	private emitTaskUpdate(task: NeoTask): void {
		if (!this.daemonHub) return;
		void this.daemonHub.emit('room.task.update', {
			sessionId: `room:${this.roomId}`,
			roomId: this.roomId,
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
				sessionId: `room:${this.roomId}`,
				roomId: this.roomId,
				goalId: goal.id,
				progress: goal.progress,
			});
		}
	}

	/**
	 * Record a gate failure, check for a dead loop, and fail the group if one is detected.
	 *
	 * Call this at every bounce point before injecting the bounce message back to the agent.
	 * Returns true when a dead loop was detected and the group has been failed — the caller
	 * should return immediately without injecting the bounce message.
	 * Returns false when no loop detected — caller should proceed with the normal bounce.
	 */
	private async recordAndCheckDeadLoop(
		groupId: string,
		taskId: string,
		gateName: string,
		reason: string
	): Promise<boolean> {
		this.groupRepo.recordGateFailure(groupId, gateName, reason);
		const history = this.groupRepo.getGateFailureHistory(groupId);
		const loopStatus = checkDeadLoop(history, this.deadLoopConfig);
		if (loopStatus?.isDeadLoop) {
			const failureMsg =
				`Dead loop detected in ${gateName} gate: ${loopStatus.reason}\n\n` +
				`Failure pattern:\n` +
				`- ${loopStatus.failureCount} failures${loopStatus.timeWindowMs > 0 ? ` over ${Math.round(loopStatus.timeWindowMs / 60000)} minutes` : ''}\n` +
				`- Repeated reasons: ${loopStatus.topFailureReasons.join('; ')}\n\n` +
				`The task cannot make progress and is stuck in a retry loop. ` +
				`Please review the requirements and try again with clearer instructions.`;
			log.warn(`Dead loop detected for group ${groupId}: ${loopStatus.reason}`);
			await this.taskGroupManager.fail(groupId, failureMsg);
			this.cleanupMirroring(groupId, 'Dead loop detected.');
			await this.emitTaskUpdateById(taskId);
			await this.emitGoalProgressForTask(taskId);
			this.scheduleTick();
			return true;
		}
		return false;
	}

	constructor(config: RoomRuntimeConfig) {
		this.roomId = config.room.id;
		this.room = config.room;
		this.groupRepo = config.groupRepo;
		this.observer = config.sessionObserver;
		this.taskManager = config.taskManager;
		this.goalManager = config.goalManager;
		this.sessionFactory = config.sessionFactory;
		this.maxConcurrentGroups = config.maxConcurrentGroups ?? DEFAULT_MAX_CONCURRENT_GROUPS;
		this.maxFeedbackIterations = config.maxFeedbackIterations ?? DEFAULT_MAX_FEEDBACK_ITERATIONS;
		this.jobQueue = config.jobQueue ?? null;
		this.getWorkerMessages = config.getWorkerMessages;
		this.daemonHub = config.daemonHub;
		this.messageHub = config.messageHub;
		this.hookOptions = config.hookOptions;
		this.deadLoopConfig = { ...DEFAULT_DEAD_LOOP_CONFIG, ...config.deadLoopConfig };
		this.getRoomById = config.getRoom;
		this.defaultModel = config.defaultModel ?? 'sonnet';
		this.getGlobalSettings = config.getGlobalSettings;

		this.taskGroupManager = new TaskGroupManager({
			groupRepo: config.groupRepo,
			sessionObserver: config.sessionObserver,
			taskManager: config.taskManager,
			goalManager: config.goalManager,
			sessionFactory: config.sessionFactory,
			workspacePath: config.workspacePath,
			model: config.model,
			provider: config.model ? this.resolveProviderForModel(config.model) : undefined,
			workerModel: config.workerModel,
			workerProvider: config.workerModel
				? this.resolveProviderForModel(config.workerModel)
				: undefined,
			getRoom: config.getRoom,
			getTask: config.getTask,
			getGoal: config.getGoal,
			daemonHub: config.daemonHub,
		});

		// Keep test and direct-runtime usage predictable: when no explicit leader model
		// is provided, derive it from the initial room config.
		if (!config.model || config.model.trim() === '') {
			const leaderModel = this.resolveAgentModel(config.room, 'leader');
			this.taskGroupManager.updateModel(leaderModel, this.resolveProviderForModel(leaderModel));
		}
	}

	// =========================================================================
	// Fallback Model Switching (for rate limit handling)
	// =========================================================================

	/**
	 * Attempt to switch a session to a fallback model when a rate limit is detected.
	 * Returns true if a fallback was attempted, false if no fallback is available.
	 */
	private async trySwitchToFallbackModel(
		groupId: string,
		sessionId: string,
		sessionRole: 'worker' | 'leader'
	): Promise<boolean> {
		const settings = this.getGlobalSettings();
		const fallbackModels = settings.fallbackModels ?? [];

		if (fallbackModels.length === 0) {
			return false;
		}

		// Get current model info from the session
		let currentModel: string;
		let currentProvider: string;
		try {
			const modelInfo = (await this.messageHub?.request('session.model.get', { sessionId })) as
				| SessionModelGetResult
				| undefined;
			if (!modelInfo || !modelInfo.currentModel) {
				log.warn(`Could not get current model for session ${sessionId}`);
				return false;
			}
			currentModel = modelInfo.currentModel;
			currentProvider = modelInfo.modelInfo?.provider ?? 'anthropic';
		} catch (err) {
			log.warn(`Error getting current model for session ${sessionId}:`, err);
			return false;
		}

		// Find the index of the current model in the fallback chain
		const currentIndex = fallbackModels.findIndex(
			(f) => f.model === currentModel && f.provider === currentProvider
		);

		// Determine the next fallback model
		let fallback: FallbackModelEntry | undefined;
		if (currentIndex === -1) {
			// Current model is not in fallback chain, use the first fallback
			fallback = fallbackModels[0];
		} else {
			// Try the next one in the chain
			const nextIndex = currentIndex + 1;
			if (nextIndex < fallbackModels.length) {
				fallback = fallbackModels[nextIndex];
			}
			// If current is the last in chain and there's only one fallback, no point switching
			// to itself, so don't fall back
		}

		if (!fallback) {
			log.info(
				`No fallback model available for ${sessionRole} session ${sessionId} ` +
					`(current: ${currentProvider}/${currentModel}, chain exhausted)`
			);
			return false;
		}

		// Don't switch to the same model
		if (fallback.model === currentModel && fallback.provider === currentProvider) {
			return false;
		}

		try {
			const result = (await this.messageHub?.request('session.model.switch', {
				sessionId,
				model: fallback.model,
				provider: fallback.provider,
			})) as ModelSwitchResult | undefined;

			if (result?.success) {
				log.info(
					`Switched ${sessionRole} session ${sessionId} from ${currentProvider}/${currentModel} ` +
						`to ${fallback.provider}/${fallback.model} due to rate limit`
				);
				this.appendGroupEvent(groupId, 'model_fallback', {
					text: `Switched from ${currentModel} to ${fallback.model} due to rate limit`,
					fromModel: currentModel,
					fromProvider: currentProvider,
					toModel: fallback.model,
					toProvider: fallback.provider,
					sessionRole,
				});
				return true;
			} else {
				log.warn(
					`Fallback model switch failed for ${sessionRole} session ${sessionId}: ${result?.error ?? 'unknown error'}`
				);
			}
		} catch (err) {
			log.error(`Error switching ${sessionRole} session ${sessionId} to fallback model:`, err);
		}

		return false;
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	start(): void {
		this.state = 'running';
		this.scheduleTick();
	}

	pause(): void {
		this.state = 'paused';
		if (this.jobQueue) cancelPendingTickJobs(this.roomId, this.jobQueue);
	}

	resume(): void {
		this.state = 'running';
		this.scheduleTick();
	}

	stop(): void {
		this.state = 'stopped';
		if (this.jobQueue) cancelPendingTickJobs(this.roomId, this.jobQueue);
		// Clean up all mirroring subscriptions
		for (const cleanup of this.mirroringCleanups.values()) {
			cleanup();
		}
		this.mirroringCleanups.clear();
		this.observer.dispose();

		// Safety net: mark zombie groups (active groups for terminal tasks) as completed.
		// Runs synchronously at stop time — no session recovery, just DB consistency.
		const zombiesCleaned = this.groupRepo.cleanupZombieGroupsForRoom(this.roomId);
		if (zombiesCleaned > 0) {
			log.warn(
				`[stop] Room ${this.roomId}: cleaned up ${zombiesCleaned} zombie group(s) on runtime stop`
			);
		}
	}

	getState(): RuntimeState {
		return this.state;
	}

	/**
	 * Resolve model for a room agent role.
	 * Priority: room.config.agentModels[role] > room.defaultModel > global default.
	 */
	private resolveAgentModel(room: Room, role: 'leader' | 'planner' | 'coder' | 'general'): string {
		const config = (room.config ?? {}) as Record<string, unknown>;
		const agentModels = config.agentModels as Record<string, string> | undefined;
		const roleModel = agentModels?.[role];
		if (typeof roleModel === 'string' && roleModel.trim() !== '') {
			return roleModel;
		}
		if (typeof room.defaultModel === 'string' && room.defaultModel.trim() !== '') {
			return room.defaultModel;
		}
		return this.defaultModel;
	}

	/**
	 * Infer the provider for a given model ID using naming conventions.
	 * Delegates to the shared inferProviderForModel utility.
	 */
	private resolveProviderForModel(modelId: string): string {
		return inferProviderForModel(modelId);
	}

	/**
	 * Return the freshest room snapshot available to the runtime.
	 * Prefer newer snapshots by updatedAt so updateRoom() calls can take effect
	 * immediately even if an external room provider still returns stale data.
	 */
	private getCurrentRoom(): Room | null {
		const liveRoom = this.getRoomById(this.roomId);
		if (!liveRoom) return this.room;

		const liveUpdatedAt = liveRoom.updatedAt ?? 0;
		const snapshotUpdatedAt = this.room.updatedAt ?? 0;
		return liveUpdatedAt > snapshotUpdatedAt ? liveRoom : this.room;
	}

	/**
	 * Update runtime config from the latest room state.
	 * Called when room config changes so lifecycle hooks see current values.
	 */
	updateRoom(room: Room): void {
		if (room.id === this.roomId) {
			this.room = room;
		}

		const currentRoom = this.getCurrentRoom();
		if (!currentRoom) {
			log.warn(`Cannot refresh room runtime config: room not found (${this.roomId})`);
			return;
		}
		this.room = currentRoom;
		const config = (currentRoom.config ?? {}) as Record<string, unknown>;

		// Keep TaskGroupManager model aligned to the current Leader model.
		const updatedLeaderModel = this.resolveAgentModel(currentRoom, 'leader');
		this.taskGroupManager.updateModel(
			updatedLeaderModel,
			this.resolveProviderForModel(updatedLeaderModel)
		);

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
		const currentRoom = this.getCurrentRoom();
		const cfg = currentRoom?.config ?? {};
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
		log.debug(
			`[Worker→Leader] Group ${groupId}: worker reached terminal state '${terminalState.kind}'`
		);

		const group = this.groupRepo.getGroup(groupId);
		if (!group) {
			log.warn(`[Worker→Leader] Group ${groupId}: group not found in repository, skipping`);
			return;
		}

		const task = await this.taskManager.getTask(group.taskId);
		if (!task) {
			log.warn(`[Worker→Leader] Group ${groupId}: task ${group.taskId} not found, skipping`);
			return;
		}

		// Clear active session indicator — worker is no longer generating output
		if (task.activeSession === 'worker') {
			await this.taskManager.updateTaskStatus(task.id, task.status, { activeSession: null });
			await this.emitTaskUpdateById(task.id);
		}

		// Check if worker is waiting for user input (asked a question)
		// Pause routing to leader — task resumes when question is answered
		if (terminalState.kind === 'waiting_for_input') {
			log.info(`Worker ${group.workerSessionId} is waiting for user input - pausing task`);
			this.groupRepo.setWaitingForQuestion(groupId, true, 'worker');
			this.appendGroupEvent(groupId, 'status', {
				text: 'Worker asked a question. Waiting for human response.',
			});
			await this.emitTaskUpdateById(group.taskId);
			return;
		}

		// Clear waiting flag if it was set (worker resumed after question was answered)
		if (group.waitingForQuestion && group.waitingSession === 'worker') {
			this.groupRepo.setWaitingForQuestion(groupId, false, null);
		}

		// Check if generation was interrupted by human — skip routing to leader, await user input
		if (group.humanInterrupted) {
			this.groupRepo.setHumanInterrupted(groupId, false);
			log.info(`Worker reached terminal state after human interrupt — awaiting user input`);
			return;
		}

		// Check rate limit backoff (set by mirroring on each incoming message)
		if (this.groupRepo.isRateLimited(groupId)) {
			log.info(`[Worker→Leader] Group ${groupId}: rate limited — pausing routing to Leader`);
			this.scheduleTickAfterRateLimitReset(groupId);
			return;
		}

		// Collect Worker messages since last forwarded message.
		// Done early — before any bounce gate — so API errors in the output can be
		// detected and short-circuit the worktree / exit-gate bounces below.
		// (A worker that hit a 429 or 4xx should not be bounced back into another API call.)
		const workerMessages = this.getWorkerMessages
			? this.getWorkerMessages(group.workerSessionId, group.lastForwardedMessageId)
			: [];

		// Build worker output text once — used for error detection, bypass detection, and the
		// leader envelope.  For empty messages use a sentinel string (it won't match any error
		// pattern, so the classification below is a no-op for silent terminal exits).
		const workerOutputText =
			workerMessages.length > 0
				? workerMessages
						.map((m) => m.text)
						.filter(Boolean)
						.join('\n\n')
				: `[Worker session ${group.workerSessionId} reached terminal state: ${terminalState.kind}]`;

		// Classify any API errors in worker output BEFORE the worktree / exit-gate checks.
		//
		// Why here?  The rate-limit check above only catches errors that mirroring already
		// persisted to the group.  When the rate limit expires and recoverStuckWorkers
		// re-triggers this handler, the group-level flag is expired-but-non-null (the timer
		// intentionally does NOT clear it — the sentinel is only cleared in send_to_worker).
		// If the worker's output still contains a 429 (or a 4xx terminal error), running the
		// worktree gate next would bounce the worker straight back into another failing API
		// call — creating a rapid bounce loop.  Detecting the error first prevents that.
		//
		// terminal    → fail task immediately (4xx — unrecoverable, no point bouncing)
		// rate_limit  → set initial backoff and pause (only on first detection; re-triggers fall through)
		// usage_limit → immediately try fallback model; if none available, fall through to rate_limit behavior (backoff + pause)
		// recoverable / null → fall through to worktree check and exit gate
		{
			const errorClass = classifyError(workerOutputText);
			if (errorClass?.class === 'terminal') {
				log.info(`Terminal API error in worker output for group ${groupId}: ${errorClass.reason}`);
				this.appendGroupEvent(groupId, 'status', {
					text: `Terminal error: ${errorClass.reason}`,
				});
				await this.taskGroupManager.fail(groupId, errorClass.reason);
				this.cleanupMirroring(groupId, `Terminal API error: ${errorClass.reason}`);
				await this.emitTaskUpdateById(group.taskId);
				await this.emitGoalProgressForTask(group.taskId);
				this.scheduleTick();
				return;
			}
			if (errorClass?.class === 'rate_limit') {
				// Only set backoff on first detection (group.rateLimit is null).
				// After the initial backoff expires, recoverStuckWorkers re-triggers this handler
				// with the same old 429 message still in the worker output.  Skipping re-detection
				// here lets the worker fall through to the worktree check and attempt cleanup/retry.
				// If the retry hits a new 429, mirroring will re-establish the backoff.
				if (!group.rateLimit) {
					const rateLimitBackoff = errorClass.resetsAt
						? createRateLimitBackoff(workerOutputText, 'worker')
						: null;
					// For bare "API Error: 429" with no parseable reset time, apply a 1-minute
					// minimum backoff so the worker is not immediately bounced into another
					// failing API call.
					const backoff: RateLimitBackoff = rateLimitBackoff ?? {
						detectedAt: Date.now(),
						resetsAt: Date.now() + 60 * 1000,
						sessionRole: 'worker',
					};
					this.groupRepo.setRateLimit(groupId, backoff);
					log.info(
						`Rate limit detected in worker output for group ${groupId}. ` +
							`Backoff until ${new Date(backoff.resetsAt).toLocaleTimeString()}.`
					);
					this.appendGroupEvent(groupId, 'rate_limited', {
						text: `Rate limit detected. Pausing until ${new Date(backoff.resetsAt).toLocaleTimeString()}.`,
						resetsAt: backoff.resetsAt,
						sessionRole: 'worker',
					});
					this.scheduleTickAfterRateLimitReset(groupId);
					// Try to switch to a fallback model if configured
					await this.trySwitchToFallbackModel(groupId, group.workerSessionId, 'worker');
					return;
				}
				// group.rateLimit already set (even if expired): re-trigger after expiry.
				// Fall through to the worktree check so the worker can attempt cleanup/retry.
			}
			if (errorClass?.class === 'usage_limit') {
				// Usage limit (daily/weekly cap) — do NOT wait. Try fallback model immediately.
				// If no fallback is configured, fall through to rate_limit behavior (pause + backoff).
				log.info(
					`Usage limit detected in worker output for group ${groupId}: ${errorClass.reason}`
				);
				const switched = await this.trySwitchToFallbackModel(
					groupId,
					group.workerSessionId,
					'worker'
				);
				if (!switched) {
					// No fallback available — fall through to rate_limit behavior (backoff + pause)
					// Parse reset time from the usage limit message, or use 1-minute default
					const rateLimitBackoff = errorClass.resetsAt
						? createRateLimitBackoff(workerOutputText, 'worker')
						: null;
					const backoff: RateLimitBackoff = rateLimitBackoff ?? {
						detectedAt: Date.now(),
						resetsAt: Date.now() + 60 * 1000,
						sessionRole: 'worker',
					};
					this.groupRepo.setRateLimit(groupId, backoff);
					this.appendGroupEvent(groupId, 'rate_limited', {
						text: `Usage limit reached. Pausing until ${new Date(backoff.resetsAt).toLocaleTimeString()}.`,
						resetsAt: backoff.resetsAt,
						sessionRole: 'worker',
					});
					this.scheduleTickAfterRateLimitReset(groupId);
					return;
				}
				// Fall through to normal routing — fallback model switch event was already appended
				// in trySwitchToFallbackModel so the UI shows the switch clearly.
			}
		}

		// Worktree cleanliness gate: check for uncommitted changes before routing to leader.
		// Applies to all workers — planners create plan files under docs/plans/ and commit to branches.
		{
			const groupWorkspace = group.workspacePath ?? this.taskGroupManager.workspacePath;
			let dirty: boolean;
			try {
				dirty = await this.isWorktreeDirty(groupWorkspace);
			} catch (err) {
				log.warn(`[Worker→Leader] Group ${groupId}: worktree dirty check failed:`, err);
				dirty = false;
			}
			if (dirty) {
				log.info(
					`[Worker→Leader] Group ${groupId}: worktree dirty — bouncing worker back to clean up`
				);
				this.appendGroupEvent(groupId, 'status', {
					text: 'Worktree has uncommitted changes. Sending worker back to clean up.',
				});
				if (
					await this.recordAndCheckDeadLoop(
						groupId,
						group.taskId,
						'worktree_dirty',
						'Worktree has uncommitted changes or untracked files'
					)
				) {
					return;
				}
				await this.sessionFactory.injectMessage(
					group.workerSessionId,
					'Your worktree has uncommitted changes or untracked files. ' +
						'Make logical commits for changes you want to keep and clean up unused files. ' +
						'Run `git status` to see what needs attention, then commit or remove files as appropriate.'
				);
				return; // Keep worker turn active
			}
		}

		// Lifecycle hooks: Worker Exit Gate
		// Validates preconditions before routing to leader (branch/PR for coder/general, tasks for planners)
		{
			const groupWorkspace = group.workspacePath ?? this.taskGroupManager.workspacePath;
			const hookCtx: WorkerExitHookContext = {
				workspacePath: groupWorkspace,
				taskType: task.taskType ?? 'coding',
				workerRole: group.workerRole,
				taskId: group.taskId,
				groupId,
				approved: group.approved,
				// Check the last message for the bypass marker: workers put the marker at the start
				// of their final response, not in a joined concatenation of all messages.
				workerOutput: workerMessages.length > 0 ? (workerMessages.at(-1)?.text ?? '') : undefined,
			};
			if (group.workerRole === 'planner') {
				const draftTasks = await this.taskManager.getDraftTasksByCreator(group.taskId);
				hookCtx.draftTaskCount = draftTasks.length;
			}
			let gateResult: HookResult;
			try {
				gateResult = await runWorkerExitGate(hookCtx, this.hookOptions);
			} catch (err) {
				log.error(`[Worker→Leader] Group ${groupId}: worker exit gate threw an error:`, err);
				gateResult = { pass: true }; // Fail open so the worker doesn't get permanently stuck
			}
			if (!gateResult.pass) {
				log.info(`[Worker→Leader] Group ${groupId}: worker exit gate failed: ${gateResult.reason}`);
				this.appendGroupEvent(groupId, 'status', {
					text: `Worker exit gate: ${gateResult.reason}`,
				});

				if (
					await this.recordAndCheckDeadLoop(
						groupId,
						group.taskId,
						'worker_exit',
						gateResult.reason ?? 'Gate check failed'
					)
				) {
					return;
				}

				await this.sessionFactory.injectMessage(
					group.workerSessionId,
					gateResult.bounceMessage ?? gateResult.reason ?? 'Gate check failed'
				);
				return; // Keep worker turn active
			}
			log.debug(`[Worker→Leader] Group ${groupId}: worker exit gate passed`);

			// When a bypass marker is detected, pre-set submittedForReview so the task moves
			// to review status without requiring a PR. This prevents a dead loop where the leader
			// cannot call submit_for_review (no PR) and cannot call complete_task (submit required).
			// NOTE: approved is intentionally NOT set here — human approval is still required.
			// The leader will see "awaiting human review" and must wait for a human to approve.
			// Only applies to coder/general roles; planner bypass is unsupported (no system prompt
			// instructions added, and planner tasks require draft task creation).
			if (gateResult.bypassed) {
				this.appendGroupEvent(groupId, 'status', {
					text: `Worker bypassed git/PR gates: ${gateResult.reason}`,
				});
				if (group.workerRole === 'coder' || group.workerRole === 'general') {
					this.groupRepo.setSubmittedForReview(groupId, true);
					this.groupRepo.setWorkerBypassed(groupId, true);
					log.info(
						`Bypass detected for ${group.workerRole} group ${groupId} — pre-setting submittedForReview, human approval still required`
					);
				}
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
		this.appendGroupEvent(groupId, 'status', {
			text: `Worker (${group.workerRole}) finished (${terminalState.kind}). Routing to Leader for review.`,
		});

		// Route to Leader (room fetched from DB via getRoom)
		log.debug(
			`[Worker→Leader] Group ${groupId}: calling routeWorkerToLeader (review round ${reviewIteration})`
		);
		let routed: boolean;
		try {
			const result = await this.taskGroupManager.routeWorkerToLeader(groupId, envelope, (gId) =>
				this.createLeaderCallbacks(gId)
			);
			routed = result !== null;
			if (routed) {
				log.info(
					`[Worker→Leader] Group ${groupId}: successfully routed to Leader (review round ${reviewIteration})`
				);
			} else {
				log.warn(
					`[Worker→Leader] Group ${groupId}: routeWorkerToLeader returned null — group may have been failed`
				);
			}
		} catch (err) {
			log.error(`[Worker→Leader] Group ${groupId}: routeWorkerToLeader threw an error:`, err);
			this.appendGroupEvent(groupId, 'status', {
				text: `Failed to route worker output to Leader: ${err instanceof Error ? err.message : String(err)}`,
			});
			// Don't update task progress if routing failed
			return;
		}

		if (!routed) {
			// routeWorkerToLeader already called fail() internally; no progress update needed
			return;
		}

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
	 * No state checks - leader can finish without calling a tool.
	 */
	async onLeaderTerminalState(groupId: string, terminalState: TerminalState): Promise<void> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group) return;

		// Guard: leader hasn't received any work yet. This can happen if a spurious idle event
		// fires before the first worker→leader routing (e.g. a race during startup). Ignore it.
		// leaderHasWork is set to true by routeWorkerToLeader and resumeLeaderFromHuman before
		// calling injectMessage, so it is never reset and survives feedbackIteration resets.
		if (!group.leaderHasWork) {
			log.debug(
				`[onLeaderTerminalState] Group ${groupId}: ignoring terminal event ` +
					`(leaderHasWork=false) — leader hasn't received work yet`
			);
			return;
		}

		// Clear active session indicator — leader is no longer generating output
		const leaderTask = await this.taskManager.getTask(group.taskId);
		if (leaderTask?.activeSession === 'leader') {
			await this.taskManager.updateTaskStatus(leaderTask.id, leaderTask.status, {
				activeSession: null,
			});
			await this.emitTaskUpdateById(group.taskId);
		}

		// Check if leader is waiting for user input (asked a question)
		// Pause — task resumes when question is answered
		if (terminalState.kind === 'waiting_for_input') {
			log.info(`Leader ${group.leaderSessionId} is waiting for user input - pausing task`);
			this.groupRepo.setWaitingForQuestion(groupId, true, 'leader');
			this.appendGroupEvent(groupId, 'status', {
				text: 'Leader asked a question. Waiting for human response.',
			});
			await this.emitTaskUpdateById(group.taskId);
			return;
		}

		// Clear waiting flag if it was set (leader resumed after question was answered)
		if (group.waitingForQuestion && group.waitingSession === 'leader') {
			this.groupRepo.setWaitingForQuestion(groupId, false, null);
		}

		// Check rate limit backoff
		if (this.groupRepo.isRateLimited(groupId)) {
			log.info(`Leader reached terminal state while rate limited - pausing`);
			this.scheduleTickAfterRateLimitReset(groupId);
			return;
		}

		// Classify any API errors in leader output.
		// terminal    → fail task immediately (4xx, invalid model, etc. — won't fix on retry)
		// rate_limit  → mirroring sets the backoff for parseable-time 429s; for bare "API Error: 429"
		//               (no parseable reset time) mirroring skips setRateLimit, so we must apply a
		//               minimum backoff here to prevent the task stalling indefinitely.
		// usage_limit → immediately try fallback model; if none available, fall through to rate_limit behavior (backoff + pause)
		// recoverable / null → fall through (leader finished without calling a tool — that's fine)
		//
		// Note: fetching with afterMessageId=null returns all leader messages since session start.
		// Because terminal errors always fail the task immediately, earlier-iteration terminal errors
		// cannot persist to later iterations — so false-positive re-detection is not a concern here.
		{
			const leaderMessages = this.getWorkerMessages
				? this.getWorkerMessages(group.leaderSessionId, null)
				: [];
			const leaderOutputText =
				leaderMessages.length > 0
					? leaderMessages
							.map((m) => m.text)
							.filter(Boolean)
							.join('\n\n')
					: '';
			if (leaderOutputText) {
				const errorClass = classifyError(leaderOutputText);
				if (errorClass?.class === 'terminal') {
					log.info(
						`Terminal API error in leader output for group ${groupId}: ${errorClass.reason}`
					);
					this.appendGroupEvent(groupId, 'status', {
						text: `Terminal error in leader: ${errorClass.reason}`,
					});
					await this.taskGroupManager.fail(groupId, errorClass.reason);
					this.cleanupMirroring(groupId, `Terminal API error in leader: ${errorClass.reason}`);
					await this.emitTaskUpdateById(group.taskId);
					await this.emitGoalProgressForTask(group.taskId);
					this.scheduleTick();
					return;
				}
				// Only apply backoff on first detection.
				// Unlike the worker path (where recoverStuckWorkers re-triggers onWorkerTerminalState
				// after expiry), there is no recoverStuckLeaders mechanism that re-calls this handler.
				// The !group.rateLimit guard is a defensive check: it prevents the backoff from being
				// reset if this handler is somehow called again while a rate limit is already recorded.
				// A full leader retry after 429 would require re-injecting the worker message into the
				// leader session — tracked as a future improvement (out of scope for this fix).
				if (errorClass?.class === 'rate_limit' && !group.rateLimit) {
					const rateLimitBackoff = errorClass.resetsAt
						? createRateLimitBackoff(leaderOutputText, 'leader')
						: null;
					const backoff: RateLimitBackoff = rateLimitBackoff ?? {
						detectedAt: Date.now(),
						resetsAt: Date.now() + 60 * 1000,
						sessionRole: 'leader',
					};
					this.groupRepo.setRateLimit(groupId, backoff);
					log.info(
						`Rate limit detected in leader output for group ${groupId}. Backoff until ${new Date(backoff.resetsAt).toLocaleTimeString()}.`
					);
					this.appendGroupEvent(groupId, 'rate_limited', {
						text: `Rate limit detected in leader. Pausing until ${new Date(backoff.resetsAt).toLocaleTimeString()}.`,
						resetsAt: backoff.resetsAt,
						sessionRole: 'leader',
					});
					this.scheduleTickAfterRateLimitReset(groupId);
					// Try to switch to a fallback model if configured
					await this.trySwitchToFallbackModel(groupId, group.leaderSessionId, 'leader');
					return;
				}
				if (errorClass?.class === 'usage_limit') {
					// Usage limit (daily/weekly cap) — do NOT wait. Try fallback model immediately.
					// If no fallback is configured, fall through to rate_limit behavior (backoff + pause).
					log.info(
						`Usage limit detected in leader output for group ${groupId}: ${errorClass.reason}`
					);
					const switched = await this.trySwitchToFallbackModel(
						groupId,
						group.leaderSessionId,
						'leader'
					);
					if (!switched) {
						// No fallback available — fall through to rate_limit behavior (backoff + pause)
						const rateLimitBackoff = errorClass.resetsAt
							? createRateLimitBackoff(leaderOutputText, 'leader')
							: null;
						const backoff: RateLimitBackoff = rateLimitBackoff ?? {
							detectedAt: Date.now(),
							resetsAt: Date.now() + 60 * 1000,
							sessionRole: 'leader',
						};
						this.groupRepo.setRateLimit(groupId, backoff);
						this.appendGroupEvent(groupId, 'rate_limited', {
							text: `Usage limit reached in leader. Pausing until ${new Date(backoff.resetsAt).toLocaleTimeString()}.`,
							resetsAt: backoff.resetsAt,
							sessionRole: 'leader',
						});
						this.scheduleTickAfterRateLimitReset(groupId);
						return;
					}
					// Fall through to normal completion — fallback model switch event was already appended
				}
			}
		}

		// Leader can finish without calling a tool - that's fine.
		// No contract violation logic needed.
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
		params: {
			message?: string;
			mode?: 'steer' | 'queue';
			summary?: string;
			reason?: string;
			pr_url?: string;
			progress_summary?: string;
		}
	): Promise<LeaderToolResult> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group) {
			return jsonResult({ success: false, error: `Group not found: ${groupId}` });
		}

		// Persist and emit progress summary whenever the leader provides one
		if (params.progress_summary) {
			this.groupRepo.setLeaderProgressSummary(groupId, params.progress_summary);
			this.appendGroupEvent(groupId, 'leader_summary', {
				text: `[Turn Summary] ${params.progress_summary}`,
			});
		}

		// No state guard - tools always available

		switch (toolName) {
			case 'send_to_worker': {
				// Enforce max feedback iterations — runtime escalates to human review.
				// The reason is persisted in the group timeline by escalateToHumanReview().
				// Only apply this limit when the task is NOT in 'review' state.
				// When the task is in 'review' state (human review phase), there is no limit.
				// Null task (record deleted): conservatively enforce the limit; escalateToHumanReview
				// will throw in that case, which is acceptable as a defensive edge-case.
				const taskForCheck = await this.taskManager.getTask(group.taskId);
				const shouldEnforceLimit = !taskForCheck || taskForCheck.status !== 'review';
				if (shouldEnforceLimit && group.feedbackIteration >= this.maxFeedbackIterations) {
					const reason = `Max feedback iterations (${this.maxFeedbackIterations}) reached`;
					await this.taskGroupManager.escalateToHumanReview(groupId, reason);
					this.appendGroupEvent(groupId, 'status', {
						text: `Escalated for human review: ${reason}`,
					});
					await this.emitTaskUpdateById(group.taskId);
					await this.emitGoalProgressForTask(group.taskId);
					this.scheduleTick();
					return jsonResult({
						success: false,
						error: `Max feedback iterations reached. Task escalated for human review.`,
					});
				}
				const message = params.message ?? '';
				const mode = params.mode ?? 'queue';
				const deliveryMode = mode === 'queue' ? 'next_turn' : 'current_turn';
				// feedbackIteration is already 1-based (incremented in routeWorkerToLeader)
				const currentIteration = group.feedbackIteration;
				const feedback = formatLeaderToWorkerFeedback(message, currentIteration);

				// Clear any rate limit backoff since we're starting a new iteration
				this.groupRepo.clearRateLimit(groupId);

				// Insert status event into group timeline
				this.appendGroupEvent(groupId, 'status', {
					text: `Leader forwarded feedback to Worker (iteration ${currentIteration}, mode: ${mode}).`,
				});

				await this.taskGroupManager.routeLeaderToWorker(groupId, feedback, {
					deliveryMode,
					transitionState: false,
				});
				return jsonResult({
					success: true,
					message: 'Feedback sent to worker.',
				});
			}

			case 'complete_task': {
				const summary = params.summary ?? '';

				// State machine enforcement: PR/planning tasks require human approval before complete_task.
				// They follow a two-phase flow: work → submit_for_review → human approval → merge/create tasks → complete.
				// Human approval (approved=true) is set when a human calls reviewTask to approve the PR or plan.
				// Bypass marker tasks pre-set submittedForReview but still require human approval.
				if (
					(group.workerRole === 'coder' ||
						group.workerRole === 'general' ||
						group.workerRole === 'planner') &&
					!group.approved
				) {
					this.groupRepo.setLeaderCalledTool(groupId, false);
					return jsonResult({
						success: false,
						error: 'Human approval is required before completing this task.',
						action_required: group.submittedForReview
							? 'The task is awaiting human review. Wait for a human to approve the PR/plan before calling complete_task.'
							: 'Call submit_for_review with the PR URL first. After human approval, you can call complete_task.',
					});
				}

				// Lifecycle hooks: Leader Complete Gate
				// Validates preconditions before allowing task completion
				{
					const hookTask = await this.taskManager.getTask(group.taskId);
					if (hookTask) {
						const currentRoom = this.getCurrentRoom();
						const roomConfig = (currentRoom?.config ?? {}) as Record<string, unknown>;
						const agentSubs = roomConfig.agentSubagents as Record<string, unknown[]> | undefined;
						const hasReviewers = !!agentSubs?.leader?.length;

						const hookCtx: LeaderCompleteHookContext = {
							workspacePath: group.workspacePath ?? this.taskGroupManager.workspacePath,
							rootWorkspacePath: this.taskGroupManager.workspacePath,
							taskType: hookTask.taskType ?? 'coding',
							workerRole: group.workerRole,
							taskId: group.taskId,
							groupId,
							hasReviewers,
							approved: group.approved,
							workerBypassed: group.workerBypassed,
						};
						if (hookTask.taskType === 'planning') {
							const draftTasks = await this.taskManager.getDraftTasksByCreator(group.taskId);
							hookCtx.draftTaskCount = draftTasks.length;
						}
						const gateResult = await runLeaderCompleteGate(hookCtx, this.hookOptions);
						if (!gateResult.pass) {
							log.info(`Leader complete gate failed for group ${groupId}: ${gateResult.reason}`);
							this.appendGroupEvent(groupId, 'status', {
								text: `Leader complete gate: ${gateResult.reason}`,
							});

							if (
								await this.recordAndCheckDeadLoop(
									groupId,
									group.taskId,
									'leader_complete',
									gateResult.reason ?? 'Gate check failed'
								)
							) {
								return jsonResult({ success: false, error: 'Dead loop detected.' });
							}

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
				// Reset consecutive failures on success and emit auto_completed event if applicable.
				{
					// Tasks are linked to at most one goal in the current data model.
					const completeGoals = await this.goalManager.getGoalsForTask(group.taskId);
					const completeGoal = completeGoals[0] ?? null;
					if (completeGoal?.autonomyLevel === 'semi_autonomous') {
						// Reset failure counter on success.
						if ((completeGoal.consecutiveFailures ?? 0) > 0) {
							await this.goalManager.updateConsecutiveFailures(completeGoal.id, 0);
						}
						// Emit auto_completed notification if this was auto-approved.
						if (group.approvalSource === 'leader_semi_auto' && this.daemonHub) {
							const completedTask = await this.taskManager.getTask(group.taskId);
							void this.daemonHub.emit('goal.task.auto_completed', {
								sessionId: `room:${this.roomId}`,
								roomId: this.roomId,
								goalId: completeGoal.id,
								taskId: group.taskId,
								taskTitle: completedTask?.title ?? '',
								prUrl: completedTask?.prUrl ?? '',
								approvalSource: 'leader_semi_auto',
							});
						}
					}
				}
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
				// Escalation policy: track consecutive failures for semi-autonomous goals.
				// When consecutiveFailures reaches the max threshold, set goal to needs_human.
				{
					// Tasks are linked to at most one goal in the current data model.
					const failGoals = await this.goalManager.getGoalsForTask(group.taskId);
					const failGoal = failGoals[0] ?? null;
					if (failGoal?.autonomyLevel === 'semi_autonomous') {
						const newCount = (failGoal.consecutiveFailures ?? 0) + 1;
						await this.goalManager.updateConsecutiveFailures(failGoal.id, newCount);
						const maxFailures = failGoal.maxConsecutiveFailures ?? 3;
						if (newCount >= maxFailures) {
							log.info(
								`Goal ${failGoal.id} (${failGoal.title}) escalated to needs_human after ${newCount} consecutive failure(s)`
							);
							await this.goalManager.updateGoalStatus(failGoal.id, 'needs_human');
						}
					}
				}
				this.scheduleTick();
				return jsonResult({ success: true, message: 'Task marked as failed.' });
			}

			case 'replan_goal': {
				const reason = params.reason ?? '';
				return this.handleReplanGoal(group.taskId, groupId, reason);
			}

			case 'submit_for_review': {
				const prUrl = params.pr_url ?? '';

				// Lifecycle gate: validate PR exists for PR/planning tasks (and reviews if reviewers configured)
				{
					const hookTask = await this.taskManager.getTask(group.taskId);
					if (
						hookTask &&
						(group.workerRole === 'coder' ||
							group.workerRole === 'general' ||
							group.workerRole === 'planner')
					) {
						const currentRoom = this.getCurrentRoom();
						const roomConfig = (currentRoom?.config ?? {}) as Record<string, unknown>;
						const agentSubs = roomConfig.agentSubagents as Record<string, unknown[]> | undefined;
						const hasReviewers = !!agentSubs?.leader?.length;

						const hookCtx: LeaderCompleteHookContext = {
							workspacePath: group.workspacePath ?? this.taskGroupManager.workspacePath,
							rootWorkspacePath: this.taskGroupManager.workspacePath,
							taskType: hookTask.taskType ?? 'coding',
							workerRole: group.workerRole,
							taskId: group.taskId,
							groupId,
							hasReviewers,
							// approved and workerBypassed intentionally omitted: runLeaderSubmitGate
							// does not call checkLeaderRootRepoSynced (submit is pre-merge), so
							// these fields are not needed here. If a future hook in runLeaderSubmitGate
							// requires them, add them explicitly to avoid silent skips.
						};
						const gateResult = await runLeaderSubmitGate(hookCtx, this.hookOptions);
						if (!gateResult.pass) {
							log.info(`Leader submit gate failed for group ${groupId}: ${gateResult.reason}`);
							this.appendGroupEvent(groupId, 'status', {
								text: `Leader submit gate: ${gateResult.reason}`,
							});

							if (
								await this.recordAndCheckDeadLoop(
									groupId,
									group.taskId,
									'leader_submit',
									gateResult.reason ?? 'Gate check failed'
								)
							) {
								return jsonResult({ success: false, error: 'Dead loop detected.' });
							}

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

				// If the task already has a different PR URL (e.g., agent created a new PR
				// instead of updating the existing one), close the stale PR before proceeding.
				{
					const existingTask = await this.taskManager.getTask(group.taskId);
					if (existingTask?.prUrl && existingTask.prUrl !== prUrl) {
						const groupWorkspace = group.workspacePath ?? this.taskGroupManager.workspacePath;
						log.info(
							`submit_for_review: new PR ${prUrl} differs from existing ${existingTask.prUrl} — closing stale PR`
						);
						this.appendGroupEvent(groupId, 'status', {
							text: `Closing stale PR ${existingTask.prUrl}, superseded by ${prUrl}.`,
						});
						await closeStalePr(existingTask.prUrl, prUrl, groupWorkspace, this.hookOptions);
					}
				}

				// Mark that submit_for_review was called (gates complete_task state machine)
				this.groupRepo.setSubmittedForReview(groupId, true);

				await this.taskGroupManager.submitForReview(groupId, prUrl);
				await this.emitTaskUpdateById(group.taskId);
				await this.emitGoalProgressForTask(group.taskId);

				// Semi-autonomous mode: auto-approve coder/general tasks without human interaction.
				// Planner tasks always require human approval regardless of autonomy level.
				if (group.workerRole !== 'planner') {
					// Tasks are linked to at most one goal in the current data model.
					const semiAutoGoals = await this.goalManager.getGoalsForTask(group.taskId);
					const semiAutoGoal = semiAutoGoals[0] ?? null;
					if (semiAutoGoal?.autonomyLevel === 'semi_autonomous') {
						const capturedGroupId = groupId;
						const capturedTaskId = group.taskId;
						// Defer auto-approve until after this tool result has been fully committed.
						// Using setTimeout(0) ensures we do not call resumeWorkerFromHuman inline
						// from handleLeaderTool, avoiding reentrancy/ordering issues.
						setTimeout(() => {
							// Idempotency guard: skip if already approved (prevents duplicate resumes
							// on daemon restart or if this callback fires more than once).
							const currentGroup = this.groupRepo.getGroup(capturedGroupId);
							if (!currentGroup || currentGroup.approvalSource) return;
							// Persist approval source before calling resumeWorkerFromHuman so that
							// a restart during the resume sees the source and can skip re-processing.
							this.groupRepo.setApprovalSource(capturedGroupId, 'leader_semi_auto');
							void this.resumeWorkerFromHuman(
								capturedTaskId,
								'PR auto-approved under semi-autonomous mode. Proceed with merge and complete_task.',
								{ approved: true }
							)
								.then((ok) => {
									if (!ok) {
										// Resume returned false (e.g. group no longer submittedForReview
										// or leader session gone). Clear approvalSource so future retries
										// are not blocked by the idempotency guard.
										this.groupRepo.setApprovalSource(capturedGroupId, null);
									}
								})
								.catch((err) => {
									log.error(`[semi-auto] Failed to auto-approve task ${capturedTaskId}:`, err);
									// Clear approvalSource on throw so retries are not permanently blocked.
									this.groupRepo.setApprovalSource(capturedGroupId, null);
								});
						}, 0);
						return jsonResult({
							success: true,
							message: `PR submitted. Auto-approving under semi-autonomous mode.`,
						});
					}
				}

				// Do NOT call scheduleTick() — the group stays alive in submitted-for-review mode.
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
			sendToWorker: async (
				_groupId: string,
				message: string,
				mode?: 'steer' | 'queue',
				progressSummary?: string
			) => {
				return this.handleLeaderTool(groupId, 'send_to_worker', {
					message,
					mode,
					progress_summary: progressSummary,
				});
			},
			completeTask: async (_groupId: string, summary: string, progressSummary?: string) => {
				return this.handleLeaderTool(groupId, 'complete_task', {
					summary,
					progress_summary: progressSummary,
				});
			},
			failTask: async (_groupId: string, reason: string, progressSummary?: string) => {
				return this.handleLeaderTool(groupId, 'fail_task', {
					reason,
					progress_summary: progressSummary,
				});
			},
			replanGoal: async (_groupId: string, reason: string, progressSummary?: string) => {
				return this.handleLeaderTool(groupId, 'replan_goal', {
					reason,
					progress_summary: progressSummary,
				});
			},
			submitForReview: async (_groupId: string, prUrl: string, progressSummary?: string) => {
				return this.handleLeaderTool(groupId, 'submit_for_review', {
					pr_url: prUrl,
					progress_summary: progressSummary,
				});
			},
		};
	}

	/**
	 * Resume a submitted-for-review group by injecting a message into the appropriate session.
	 *
	 * Routing logic:
	 * - ALL approvals (planner, coder, general) → leader (merges PR + calls complete_task)
	 * - ALL rejections (planner, coder, general) → leader (forwards feedback to worker)
	 *
	 * Reuses the same worker and leader sessions — no new sessions are created.
	 */
	async resumeWorkerFromHuman(
		taskId: string,
		message: string,
		opts?: { approved?: boolean }
	): Promise<boolean> {
		const group = this.groupRepo.getGroupByTaskId(taskId);
		// Check group exists and is not completed/failed
		if (!group || group.completedAt !== null) return false;

		// Verify the task belongs to this runtime's room
		const task = await this.taskManager.getTask(taskId);
		if (!task) return false;

		// Determine if this is an approval
		const isApproval =
			opts?.approved === true || (group.workerRole === 'planner' && opts?.approved !== false);
		const previousStatus = task.status;
		const previousApproved = group.approved;
		const previousApprovalSource = group.approvalSource;

		if (isApproval && !previousApproved) {
			this.groupRepo.setApproved(group.id, true);
			// Record approval source for auditing. Only set to 'human' if not already set
			// (preserves 'leader_semi_auto' source set before this call in semi-autonomous mode).
			if (!group.approvalSource) {
				this.groupRepo.setApprovalSource(group.id, 'human');
			}
		}

		// For approvals, keep task in review status and let leader's complete_task
		// handle the final transition to completed. This prevents the task from
		// getting stuck in in_progress if the leader's complete_task fails.
		// For rejections, move task back to in_progress so worker can address feedback.
		if (!isApproval) {
			try {
				await this.taskManager.updateTaskStatus(group.taskId, 'in_progress');
			} catch (error) {
				log.error(`Failed to set task ${taskId} to in_progress before human resume:`, error);
				return false;
			}
		}

		// Route ALL messages (approval and rejection) to leader
		// Leader handles: approval → merge + complete_task
		// Leader handles: rejection → send_to_worker
		try {
			const updated = await this.taskGroupManager.resumeLeaderFromHuman(group.id, message);
			if (!updated) {
				await this.taskManager.updateTaskStatus(group.taskId, previousStatus);
				if (isApproval && !previousApproved) {
					this.groupRepo.setApproved(group.id, previousApproved);
					// Roll back approvalSource to prevent deadlock: if the deferred auto-approve
					// callback set approvalSource before this call, but the resume failed, the
					// idempotency guard would permanently block future retries without rollback.
					this.groupRepo.setApprovalSource(group.id, previousApprovalSource);
				}
				return false;
			}
		} catch (error) {
			try {
				await this.taskManager.updateTaskStatus(group.taskId, previousStatus);
			} catch (rollbackError) {
				log.warn(`Failed to rollback task ${taskId} status after resume error:`, rollbackError);
			}
			if (isApproval && !previousApproved) {
				this.groupRepo.setApproved(group.id, previousApproved);
				// Roll back approvalSource (see comment above).
				this.groupRepo.setApprovalSource(group.id, previousApprovalSource);
			}
			log.error(`Failed to resume from human for task ${taskId}:`, error);
			return false;
		}

		await this.emitTaskUpdateById(group.taskId);
		await this.emitGoalProgressForTask(group.taskId);
		this.scheduleTick();
		return true;
	}

	/**
	 * Revive the session group for a failed/cancelled task and inject a human message.
	 *
	 * The caller is responsible for transitioning the task status to 'review' before
	 * calling this method. This method handles the group-level work:
	 * - Clears the group's completedAt so it becomes active again
	 * - Restores agent sessions (they were stopped when the task failed)
	 * - Re-registers terminal-state observers so the runtime hears when agents finish
	 * - Injects the human message (leader first, worker as fallback)
	 *
	 * On failure, undoes the group revive (re-sets completedAt) so the group is not
	 * left in an orphaned active state without a running agent. The caller is
	 * responsible for rolling back the task status on failure.
	 *
	 * Returns true on success, false if the group cannot be found or sessions
	 * cannot be restored / injected.
	 */
	async reviveTaskForMessage(taskId: string, message: string): Promise<boolean> {
		const group = this.groupRepo.getGroupByTaskId(taskId);
		if (!group) return false;

		// If the group is still marked as terminated, revive it.
		// Track whether we cleared completedAt so we can undo it on failure.
		let didReviveGroup = false;
		if (group.completedAt !== null) {
			const revived = this.groupRepo.reviveGroup(group.id);
			if (!revived) return false;
			didReviveGroup = true;
		}

		// Mark as awaiting human so the runtime doesn't auto-inject a continuation
		// message if it happens to tick before we inject below.
		this.groupRepo.setSubmittedForReview(group.id, true);

		// Restore sessions that were stopped when the task failed.
		// restoreSession() is idempotent — if a session is already in cache it
		// returns true immediately without touching the running query.
		let leaderAvailable = this.sessionFactory.hasSession(group.leaderSessionId);
		if (!leaderAvailable) {
			leaderAvailable = await this.sessionFactory.restoreSession(group.leaderSessionId);
			if (leaderAvailable) {
				this.observer.observe(group.leaderSessionId, (state) => {
					void this.onLeaderTerminalState(group.id, state).catch((err) => {
						log.error(`[leader-observer] Group ${group.id}: terminal state handler threw:`, err);
					});
				});
			}
		}

		let workerAvailable = this.sessionFactory.hasSession(group.workerSessionId);
		if (!workerAvailable) {
			workerAvailable = await this.sessionFactory.restoreSession(group.workerSessionId);
			if (workerAvailable) {
				this.observer.observe(group.workerSessionId, (state) => {
					void this.onWorkerTerminalState(group.id, state).catch((err) => {
						log.error(`[worker-observer] Group ${group.id}: terminal state handler threw:`, err);
					});
				});
			}
		}

		// Restore MCP servers (non-serialisable, lost when sessions were stopped)
		if (leaderAvailable || workerAvailable) {
			await this.restoreMcpServersForGroup(group);
		}

		// Inject into leader first (preferred — leader orchestrates the workflow).
		// Fall back to worker if leader is unavailable.
		let injected = false;
		if (leaderAvailable) {
			try {
				// Set leaderHasWork before injecting so the terminal event is not dropped.
				this.groupRepo.setLeaderHasWork(group.id);
				await this.sessionFactory.injectMessage(group.leaderSessionId, message);
				injected = true;
			} catch (error) {
				log.warn(`reviveTaskForMessage: leader inject failed for ${taskId}:`, error);
			}
		}
		if (!injected && workerAvailable) {
			try {
				await this.sessionFactory.injectMessage(group.workerSessionId, message);
				injected = true;
			} catch (error) {
				log.warn(`reviveTaskForMessage: worker inject failed for ${taskId}:`, error);
			}
		}

		if (!injected) {
			// Neither session could accept the message. Re-terminate the group so it
			// doesn't appear active without a running agent.
			if (didReviveGroup) {
				const currentGroup = this.groupRepo.getGroup(group.id);
				if (currentGroup) {
					this.groupRepo.failGroup(currentGroup.id, currentGroup.version);
				}
			}
			log.error(
				`reviveTaskForMessage: no sessions available for task ${taskId}; group re-terminated`
			);
			return false;
		}

		// Message delivered — clear the review gate so agents can proceed
		this.groupRepo.setSubmittedForReview(group.id, false);

		await this.emitTaskUpdateById(group.taskId);
		await this.emitGoalProgressForTask(group.taskId);
		this.scheduleTick();
		return true;
	}

	/**
	 * Terminate the task's active group (if any) without changing task status.
	 *
	 * Used by task.setStatus paths that move tasks to terminal states other than
	 * cancelled. This ensures agent sessions and mirroring are cleaned up while
	 * preserving the caller's chosen task status transition.
	 */
	async terminateTaskGroup(taskId: string): Promise<boolean> {
		const group = this.groupRepo.getGroupByTaskId(taskId);
		if (!group) return true;

		const isActiveGroup = group.completedAt === null;
		if (isActiveGroup) {
			const terminated = await this.taskGroupManager.terminateGroup(group.id);
			if (!terminated) return false;
		}

		await this.terminateGroupSessions(group);
		this.cleanupMirroring(
			group.id,
			isActiveGroup ? 'Task group terminated by user status change.' : undefined
		);
		return true;
	}

	/**
	 * Archive a task group - terminate active sessions, cleanup worktree, and set archived status.
	 *
	 * Called when user archives a task via UI. This:
	 * 1. Terminates any active sessions and mirroring (if group is still active).
	 * 2. Cleans up the worktree to free disk space.
	 * 3. Sets the task status to 'archived' with archivedAt timestamp.
	 */
	async archiveTaskGroup(
		taskId: string,
		options?: { mode?: 'runtime' | 'manual' }
	): Promise<boolean> {
		const group = this.groupRepo.getGroupByTaskId(taskId);

		if (group) {
			// Terminate active sessions if group is still active.
			// If terminateGroup() fails (e.g., concurrent version conflict), we log and
			// continue rather than aborting — archive is destructive and non-reversible,
			// so the worktree and task must still be cleaned up regardless of group state.
			// This is a deliberate best-effort approach (distinct from terminateTaskGroup
			// which returns false on failure and lets the caller decide).
			const isActiveGroup = group.completedAt === null;
			if (isActiveGroup) {
				const terminated = await this.taskGroupManager.terminateGroup(group.id);
				if (!terminated) {
					log.warn(
						`archiveTaskGroup: failed to terminate active group ${group.id} for task ${taskId}`
					);
				}
			}
			await this.terminateGroupSessions(group);
			this.cleanupMirroring(group.id, isActiveGroup ? 'Task archived by user.' : undefined);

			// Cleanup worktree via TaskGroupManager
			await this.taskGroupManager.archiveGroup(group.id);
		}

		// Set archivedAt timestamp on task (transitions to 'archived' status)
		await this.taskManager.archiveTask(taskId, { mode: options?.mode });

		return true;
	}

	/**
	 * Cancel a task and terminate its active session group (if any).
	 *
	 * This is used by the Room Agent `cancel_task` tool. It ensures cancellation
	 * is not just a task-status change: active groups are transitioned to terminal
	 * state and their sessions are stopped so concurrency slots are freed.
	 *
	 * Returns all cancelled task IDs (root task + cascade-cancelled dependents).
	 */
	async cancelTask(taskId: string): Promise<{ success: boolean; cancelledTaskIds: string[] }> {
		const task = await this.taskManager.getTask(taskId);
		if (!task) {
			return { success: false, cancelledTaskIds: [] };
		}

		const cancelledTaskIds = new Set<string>();

		// 1) Ensure task status is cancelled (idempotent) and cascade to pending dependents.
		const cancelledTasks = await this.taskManager.cancelTaskCascade(taskId);
		for (const cancelledTask of cancelledTasks) {
			cancelledTaskIds.add(cancelledTask.id);
		}

		// 2) Clean up session group resources if a group exists.
		// Terminate is only needed for active groups, but session/
		// mirroring cleanup is safe and idempotent for any group.
		const group = this.groupRepo.getGroupByTaskId(taskId);
		const isActiveGroup = !!group && group.completedAt === null;
		if (group) {
			if (isActiveGroup) {
				const terminated = await this.taskGroupManager.terminateGroup(group.id);
				if (!terminated) {
					log.warn(`Failed to terminate active group ${group.id} during cancelTask(${taskId})`);
					return { success: false, cancelledTaskIds: [...cancelledTaskIds] };
				}
			}
			await this.terminateGroupSessions(group);
			this.cleanupMirroring(group.id, isActiveGroup ? 'Task cancelled by user.' : undefined);
			cancelledTaskIds.add(group.taskId);
		}

		for (const cancelledTaskId of cancelledTaskIds) {
			await this.emitTaskUpdateById(cancelledTaskId);
			await this.emitGoalProgressForTask(cancelledTaskId);
		}

		this.scheduleTick();
		return { success: true, cancelledTaskIds: [...cancelledTaskIds] };
	}

	/**
	 * Force-stop a session group by ID.
	 *
	 * Kills worker and leader sessions, marks the group as failed, and deletes the
	 * group record from the DB. Used for manual cleanup of stale or stuck groups
	 * via the `session_group.stop` RPC.
	 *
	 * Task status is NOT changed — the group is removed while leaving the task
	 * in its current state. Call task.cancel separately if needed.
	 *
	 * Returns { success: false } if the group doesn't exist or belongs to a
	 * different room (validated by checking the task via this room's TaskManager).
	 */
	async forceStopSessionGroup(groupId: string): Promise<{ success: boolean; error?: string }> {
		const group = this.groupRepo.getGroup(groupId);
		if (!group) {
			return { success: false, error: `Session group ${groupId} not found` };
		}

		// Validate the group belongs to this room by fetching the task via this
		// room's TaskManager (which is scoped to this.roomId).
		const task = await this.taskManager.getTask(group.taskId);
		if (!task) {
			// Task not in this room or doesn't exist. Refuse to act on foreign groups.
			return {
				success: false,
				error: `Group ${groupId} belongs to a different room or its task no longer exists`,
			};
		}

		// Stop the actual agent processes first (best-effort).
		await this.terminateGroupSessions(group);

		// Mark group as terminal in the DB (unobserves sessions too).
		if (group.completedAt === null) {
			const terminated = await this.taskGroupManager.terminateGroup(groupId);
			if (!terminated) {
				// Concurrent modification (optimistic lock conflict) — the group may have
				// already been terminated by another code path. Log and continue; the
				// deleteGroup() below will still free the concurrency slot.
				log.warn(
					`[forceStopSessionGroup] terminateGroup(${groupId}) returned null — ` +
						`possible concurrent modification; proceeding with delete`
				);
			}
		}

		// Clean up message mirroring subscriptions.
		this.cleanupMirroring(groupId, 'Force-stopped by user.');

		// Delete the group record from the DB (freeing the concurrency slot).
		this.groupRepo.deleteGroup(groupId);

		// Emit task update so the frontend reflects the removed group.
		// emitGoalProgressForTask is intentionally omitted: goal progress is derived
		// from task status, which forceStopSessionGroup deliberately leaves unchanged.
		// There is nothing for the goal progress bar to update.
		await this.emitTaskUpdateById(group.taskId);
		this.scheduleTick();

		log.info(`[forceStopSessionGroup] Group ${groupId} for task ${group.taskId} force-stopped`);
		return { success: true };
	}

	/**
	 * Interrupt the current agent session(s) for a task without changing task status.
	 *
	 * Unlike stopTaskSession() / cancelTask(), this:
	 * - Does NOT change task status (keeps it 'in_progress' or 'review')
	 * - Does NOT mark the group as terminal
	 * - Does NOT clean up the session (session stays in cache, can receive new messages)
	 * - Sets humanInterrupted flag to prevent automatic routing to leader
	 *
	 * Use this when a human wants to interrupt ongoing generation and immediately
	 * type new instructions — the session stays alive and ready for input.
	 */
	async interruptTaskSession(taskId: string): Promise<{ success: boolean }> {
		const task = await this.taskManager.getTask(taskId);
		if (!task) return { success: false };

		if (task.status !== 'in_progress' && task.status !== 'review') {
			return { success: false };
		}

		const group = this.groupRepo.getGroupByTaskId(taskId);
		if (!group || group.completedAt !== null) return { success: false };

		// Set flag first so onWorkerTerminalState skips routing to leader
		this.groupRepo.setHumanInterrupted(group.id, true);

		// Interrupt active sessions (lightweight: no cleanup, no cache removal)
		if (this.sessionFactory.interruptSession) {
			for (const sessionId of [group.workerSessionId, group.leaderSessionId]) {
				try {
					await this.sessionFactory.interruptSession(sessionId);
				} catch (error) {
					log.warn(`Failed to interrupt session ${sessionId}:`, error);
				}
			}
		}

		// Clear activeSession indicator — the agent is no longer generating output
		if (task.activeSession !== null) {
			await this.taskManager.updateTaskStatus(task.id, task.status, { activeSession: null });
			await this.emitTaskUpdateById(taskId);
		}

		this.appendGroupEvent(group.id, 'status', {
			text: 'Generation interrupted by user. Awaiting input.',
		});
		return { success: true };
	}

	/**
	 * Inject a human message directly into the worker session.
	 *
	 * Used when a human wants to provide additional context directly to the worker.
	 *
	 * Returns true on success, false if no group exists, the worker session is not
	 * currently available, or the injection fails.
	 */
	async injectMessageToWorker(taskId: string, message: string): Promise<boolean> {
		const group = this.groupRepo.getGroupByTaskId(taskId);
		if (!group) return false;
		if (!this.sessionFactory.hasSession(group.workerSessionId)) return false;

		// Clear humanInterrupted: the user is providing new input, so the next
		// worker completion should route to leader normally (not be suppressed).
		if (group.humanInterrupted) {
			this.groupRepo.setHumanInterrupted(group.id, false);
		}

		// Mark worker as active BEFORE injecting so the terminal-state handler always sees
		// and clears the value correctly, even if the session responds before the DB write.
		const injectTask = await this.taskManager.getTask(taskId);
		if (injectTask) {
			await this.taskManager.updateTaskStatus(injectTask.id, injectTask.status, {
				activeSession: 'worker',
			});
			await this.emitTaskUpdateById(taskId);
		}

		try {
			await this.sessionFactory.injectMessage(group.workerSessionId, message);
		} catch (error) {
			log.error(`Failed to inject message into worker session ${group.workerSessionId}:`, error);
			// Clear the indicator — the session never started working
			if (injectTask) {
				await this.taskManager.updateTaskStatus(injectTask.id, injectTask.status, {
					activeSession: null,
				});
				await this.emitTaskUpdateById(taskId);
			}
			return false;
		}

		return true;
	}

	/**
	 * Inject a human message directly into the leader session.
	 *
	 * Used when a human wants to provide guidance directly to the leader agent.
	 *
	 * Note: sessionFactory.injectMessage() writes to the SDK messages table only.
	 * Task timelines are reconstructed from SDK messages + task_group_events.
	 *
	 * Returns true on success, false if no group exists, the leader session is not
	 * currently available, or the injection fails.
	 */
	async injectMessageToLeader(taskId: string, message: string): Promise<boolean> {
		const group = this.groupRepo.getGroupByTaskId(taskId);
		if (!group) return false;
		if (!this.sessionFactory.hasSession(group.leaderSessionId)) return false;

		// Mark leader as active BEFORE injecting so the terminal-state handler always sees
		// and clears the value correctly, even if the session responds before the DB write.
		const injectLeaderTask = await this.taskManager.getTask(taskId);
		if (injectLeaderTask) {
			await this.taskManager.updateTaskStatus(injectLeaderTask.id, injectLeaderTask.status, {
				activeSession: 'leader',
			});
			await this.emitTaskUpdateById(taskId);
		}

		try {
			// Set leaderHasWork before injecting so the terminal event is not dropped.
			this.groupRepo.setLeaderHasWork(group.id);
			await this.sessionFactory.injectMessage(group.leaderSessionId, message);
		} catch (error) {
			log.error(`Failed to inject message into leader session ${group.leaderSessionId}:`, error);
			// Clear the indicator — the session never started working
			if (injectLeaderTask) {
				await this.taskManager.updateTaskStatus(injectLeaderTask.id, injectLeaderTask.status, {
					activeSession: null,
				});
				await this.emitTaskUpdateById(taskId);
			}
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
						// For recurring missions, use the atomic dual-write path so that
						// mission_executions.task_ids stays in sync after a daemon restart.
						const activeExecution =
							goal.missionType === 'recurring'
								? this.goalManager.getActiveExecution(goal.id)
								: null;
						if (activeExecution) {
							await this.goalManager.linkTaskToExecution(goal.id, activeExecution.id, newTask.id);
						} else {
							await this.goalManager.linkTaskToGoal(goal.id, newTask.id);
						}
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

				// Fetch fresh room for MCP server init (config may have changed)
				const currentRoom = this.getCurrentRoom();
				if (!currentRoom) {
					throw new Error(`Room not found while restoring planner MCP server: ${this.roomId}`);
				}
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
	 * Set up live message monitoring for a group's worker/leader sessions.
	 *
	 * Subscribes to DaemonHub sdk.message events, persists each enriched message
	 * to session_group_messages (for LiveQuery). Does NOT broadcast
	 * state.groupMessages.delta — message delivery to the frontend is handled
	 * by the LiveQuery subscription (sessionGroupMessages.byGroup).
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

					// Check for rate limit errors in real-time for both Worker and Leader sessions
					const messageContent = JSON.stringify(event.message);
					const msgErrorClass = classifyError(messageContent);
					if (msgErrorClass?.class === 'rate_limit') {
						const sessionRole = sessionId === group.workerSessionId ? 'worker' : 'leader';
						const rateLimitBackoff = createRateLimitBackoff(messageContent, sessionRole);
						if (rateLimitBackoff) {
							this.groupRepo.setRateLimit(group.id, rateLimitBackoff);
							log.info(
								`Rate limit detected in ${role} message for group ${group.id}. ` +
									`Backoff until ${new Date(rateLimitBackoff.resetsAt).toLocaleTimeString()}.`
							);
							this.appendGroupEvent(group.id, 'rate_limited', {
								text: `Rate limit detected in ${role} output. Pausing until ${new Date(rateLimitBackoff.resetsAt).toLocaleTimeString()}.`,
								resetsAt: rateLimitBackoff.resetsAt,
								sessionRole,
							});
						}
					}

					// Read current iteration from DB to stay accurate across feedback cycles
					const currentGroup = this.groupRepo.getGroup(group.id);
					const iteration = currentGroup?.feedbackIteration ?? group.feedbackIteration;
					const turnId = `turn_${group.id}_${iteration}_${shortSessionId}`;

					// Persist to session_group_messages so LiveQuery subscribers receive the event.
					const enrichedMessage = {
						...event.message,
						_taskMeta: {
							authorRole: role,
							authorSessionId: sessionId,
							turnId,
							iteration,
						},
					};
					const sdkNow = Date.now();
					const sdkMsgType =
						'type' in event.message && typeof event.message.type === 'string'
							? event.message.type
							: 'assistant';
					this.groupRepo.appendGroupMessage({
						groupId: group.id,
						sessionId,
						role,
						messageType: sdkMsgType,
						content: JSON.stringify(enrichedMessage),
						createdAt: sdkNow,
					});
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
	private appendGroupEvent(
		groupId: string,
		kind: string,
		payload?: { text?: string; [key: string]: unknown }
	): void {
		this.groupRepo.appendEvent({
			groupId,
			kind,
			payloadJson: payload ? JSON.stringify(payload) : undefined,
		});
		const now = Date.now();
		// Map event kinds to message types for the frontend.
		// 'leader_summary' is a special case (rendered as a distinct card).
		// 'rate_limited' and 'model_fallback' get their own type so the frontend
		// can render them as prominent notifications.
		const messageType =
			kind === 'leader_summary'
				? 'leader_summary'
				: kind === 'rate_limited'
					? 'rate_limited'
					: kind === 'model_fallback'
						? 'model_fallback'
						: 'status';

		// Persist to session_group_messages so LiveQuery subscribers receive the event.
		// For rich event types (rate_limited, model_fallback) store the full payload as
		// JSON so the frontend can render extra fields (resetsAt, sessionRole, etc.).
		// For simple status/leader_summary, store just the text.
		const content =
			messageType === 'rate_limited' || messageType === 'model_fallback'
				? JSON.stringify({ ...payload, type: messageType })
				: (payload?.text ?? kind);
		try {
			this.groupRepo.appendGroupMessage({
				groupId,
				sessionId: null,
				role: 'system',
				messageType,
				content,
				createdAt: now,
			});
		} catch (err) {
			log.warn(
				`appendGroupEvent: failed to persist group message for group ${groupId} (type=${messageType}, secondary write — ignored):`,
				err
			);
		}
	}

	private cleanupMirroring(groupId: string, statusText?: string): void {
		const cleanup = this.mirroringCleanups.get(groupId);
		if (cleanup) {
			cleanup();
			this.mirroringCleanups.delete(groupId);
		}

		if (statusText) {
			this.appendGroupEvent(groupId, 'status', { text: statusText });
		}
	}

	/**
	 * Stop and cleanup sessions for a group, if the session factory supports it.
	 * Used on explicit task cancellation to immediately terminate agent activity.
	 */
	private async terminateGroupSessions(group: SessionGroup): Promise<void> {
		if (!this.sessionFactory.stopSession) {
			return;
		}

		for (const sessionId of [group.workerSessionId, group.leaderSessionId]) {
			try {
				await this.sessionFactory.stopSession(sessionId);
			} catch (error) {
				log.warn(`Failed to stop session ${sessionId} for group ${group.id}:`, error);
			}
		}
	}

	// =========================================================================
	// Tick Logic
	// =========================================================================

	/**
	 * Main scheduling loop. Concurrency is managed by the job queue — at most one
	 * pending room.tick job exists per room, so concurrent calls are not expected
	 * in production. In unit tests, callers drive ticks directly and sequentially.
	 */
	async tick(): Promise<void> {
		if (this.state !== 'running') return;
		await this.executeTick();
	}

	/**
	 * Safety net: detect groups whose worker/leader sessions are missing from the
	 * in-memory cache. Returns zombie groups that need async restoration.
	 *
	 * Split into sync detection + async recovery to avoid unnecessary microtask
	 * checkpoints when there are no zombies (common case).
	 *
	 * Leader zombie detection rules:
	 * - A leader is "expected" if feedbackIteration > 0 (at least one review round completed),
	 *   OR deferredLeader is null (leader was previously live and may be missing after restart),
	 *   OR deferredLeader.eagerlyCreated is true (leader was created eagerly in spawn()).
	 * - Old lazy-init groups (eagerlyCreated unset, feedbackIteration == 0) have NOT created
	 *   the leader yet — missing leader is expected and must NOT be flagged as zombie.
	 */
	private findZombieGroups(): SessionGroup[] {
		const allActiveGroups = this.groupRepo.getActiveGroups(this.roomId);
		const zombies: SessionGroup[] = [];

		for (const group of allActiveGroups) {
			const workerMissing = !this.sessionFactory.hasSession(group.workerSessionId);
			// Leader is expected when:
			//   1. feedbackIteration > 0: at least one review round completed (leader was live)
			//   2. deferredLeader === null: no pending config means leader was previously live
			//   3. deferredLeader.eagerlyCreated === true: leader was created eagerly in spawn()
			// Old lazy-init groups (eagerlyCreated unset, feedbackIteration == 0) are NOT flagged:
			// the missing leader is expected there and routeWorkerToLeader will create it.
			const leaderExpected =
				group.feedbackIteration > 0 ||
				group.deferredLeader === null ||
				group.deferredLeader?.eagerlyCreated === true;
			const leaderMissing =
				leaderExpected && !this.sessionFactory.hasSession(group.leaderSessionId);

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
					`Zombie detected: group ${group.id} ` +
						`worker ${group.workerSessionId} not in cache. Attempting restore.`
				);
				const restored = await this.sessionFactory.restoreSession(group.workerSessionId);
				if (restored) {
					log.info(`Restored worker session ${group.workerSessionId} for group ${group.id}`);
					this.observer.observe(group.workerSessionId, (state) => {
						void this.onWorkerTerminalState(group.id, state).catch((err) => {
							log.error(`[worker-observer] Group ${group.id}: terminal state handler threw:`, err);
						});
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

			// Check leader session liveness
			let leaderRestored = false;
			if (!this.sessionFactory.hasSession(group.leaderSessionId)) {
				log.warn(
					`Zombie detected: group ${group.id} ` +
						`leader ${group.leaderSessionId} not in cache. Attempting restore.`
				);
				const restored = await this.sessionFactory.restoreSession(group.leaderSessionId);
				if (restored) {
					log.info(`Restored leader session ${group.leaderSessionId} for group ${group.id}`);
					this.observer.observe(group.leaderSessionId, (state) => {
						void this.onLeaderTerminalState(group.id, state).catch((err) => {
							log.error(`[leader-observer] Group ${group.id}: terminal state handler threw:`, err);
						});
					});
					leaderRestored = true;
				} else {
					// Leader restoration failure: group may have been created with old lazy-init
					// code (leader never persisted to DB), or the DB record was lost.
					// For new eager-init groups the leader was persisted at spawn() time, so this
					// indicates data loss; recovery falls back to recreating the leader from
					// deferredLeader config in routeWorkerToLeader() when the worker finishes.
					log.warn(
						`Could not restore leader ${group.leaderSessionId} for group ${group.id} - will be recreated when worker routes output.`
					);
				}
			}

			// Inject continuation message for restored sessions.
			// The SDK query is started lazily by injectMessage → ensureQueryStarted().
			// Groups awaiting human review don't need a message — human will provide one.
			if (group.submittedForReview) {
				continue; // Awaiting human - no continuation message needed
			}

			// Groups waiting for a question answer need special handling.
			// Injecting a regular continuation message would leave an orphaned user
			// message after the pending AskUserQuestion tool use (invalid conversation
			// state) and confuse the agent once it resumes.
			// Instead, just start the SDK query so the SDK re-encounters the pending
			// AskUserQuestion in its session file and re-calls canUseTool, which
			// re-establishes the pendingResolver so the user can submit their answer.
			if (group.waitingForQuestion) {
				try {
					const sessionId =
						group.waitingSession === 'leader' ? group.leaderSessionId : group.workerSessionId;
					const restored = group.waitingSession === 'leader' ? leaderRestored : workerRestored;
					if (restored) {
						await this.sessionFactory.startSession(sessionId);
						log.info(
							`[ZombieRecovery] Group ${group.id}: started SDK query for ` +
								`${group.waitingSession} session waiting for question answer`
						);
					}
				} catch (error) {
					log.error(
						`[ZombieRecovery] Group ${group.id}: failed to start session for waitingForQuestion:`,
						error
					);
				}
				continue; // Skip regular continuation message injection
			}

			try {
				if (workerRestored) {
					await this.sessionFactory.injectMessage(
						group.workerSessionId,
						'The system was restarted. Continue working on the task from where you left off.'
					);
				}
				if (leaderRestored) {
					// Only inject "continue reviewing" if the leader has already received work
					// (feedbackIteration > 0 means at least one worker→leader routing happened).
					// When feedbackIteration == 0 the leader was eagerly created in spawn() but
					// has not been given any worker output yet — it will receive work when the
					// worker finishes and routeWorkerToLeader() fires.
					if (group.feedbackIteration > 0) {
						// Set leaderHasWork before injecting so the terminal event is not
						// dropped by onLeaderTerminalState. Defensive: if leaderHasWork was
						// already true (normal case for feedbackIteration>0), this is a no-op.
						this.groupRepo.setLeaderHasWork(group.id);
						await this.sessionFactory.injectMessage(
							group.leaderSessionId,
							'The system was restarted. Continue reviewing from where you left off.'
						);
					} else {
						log.debug(
							`[recoverZombieGroups] Group ${group.id}: leader restored but feedbackIteration=0 ` +
								`— skipping "continue reviewing" inject; worker will route output on completion.`
						);
					}
				}
			} catch (error) {
				log.error(`Failed to inject continuation message for group ${group.id}:`, error);
			}
		}
	}

	/**
	 * Detect and recover workers that finished (reached terminal/idle state) but were never
	 * routed to the leader. This acts as a safety net for the following failure modes:
	 *
	 * 1. Observer callback fired but the routing threw an error (now logged, but still need recovery)
	 * 2. Observer callback was missed due to a race condition (extremely rare)
	 * 3. Any other silent failure in the worker→leader routing path
	 * 4. Worker paused by rate limit — when the backoff expires the timer fires scheduleTick()
	 *    which calls this function; the group is re-triggered regardless of feedbackIteration.
	 *
	 * Conditions for a "stuck worker":
	 * - feedbackIteration == 0: no review rounds have completed (worker → leader routing never
	 *   happened), OR the group has an expired rate limit that was set during a later iteration —
	 *   in that case the leader was never triggered (onWorkerTerminalState returned early after
	 *   detecting the rate limit) so recovery is still needed.
	 * - Worker session IS in the session factory (not a zombie)
	 * - Worker session processing state is terminal (idle or interrupted)
	 * - Leader session may or may not exist (with eager init, it always exists; with old lazy
	 *   init, it may not exist yet — both cases are handled by routeWorkerToLeader)
	 * - Group is NOT awaiting human review
	 * - Group is NOT actively rate-limited (resetsAt still in the future)
	 * - Group is NOT paused waiting for a question answer (waiting_for_input is intentional pause)
	 * - A recovery for this group is NOT already in-flight from a previous tick
	 */
	private recoverStuckWorkers(): void {
		if (!this.sessionFactory.getProcessingState) return; // getProcessingState is optional

		const now = Date.now();
		const activeGroups = this.groupRepo.getActiveGroups(this.roomId);
		for (const group of activeGroups) {
			// An expired rate limit means the worker was paused mid-iteration (feedbackIteration may
			// be > 0) and the leader was never triggered. Allow recovery in that case.
			// isRateLimited() already returns false for expired limits, so we check the raw field.
			const hasExpiredRateLimit = group.rateLimit !== null && now >= group.rateLimit.resetsAt;

			// Skip groups where the leader is actively working (feedbackIteration > 0 means the
			// worker→leader routing already happened at least once and the leader may still be
			// reviewing). The exception is an expired rate limit: in that case onWorkerTerminalState
			// returned early (before routing to the leader) so feedbackIteration was NOT incremented
			// for this iteration — the leader is idle and recovery is safe.
			if (group.feedbackIteration > 0 && !hasExpiredRateLimit) continue;
			// Skip groups awaiting human
			if (group.submittedForReview) continue;
			// Skip actively rate-limited groups (backoff not yet expired)
			if (this.groupRepo.isRateLimited(group.id)) continue;
			// Skip groups paused waiting for a question answer — waiting_for_input is an
			// intentional pause, not a stuck state; the task resumes when the user answers
			if (group.waitingForQuestion) continue;

			// Worker must be in the session factory (not a zombie)
			if (!this.sessionFactory.hasSession(group.workerSessionId)) continue;

			// Worker must be in a terminal state (idle or interrupted)
			// Note: waiting_for_input is excluded — it is handled separately as an intentional pause
			const workerState = this.sessionFactory.getProcessingState(group.workerSessionId);
			if (workerState !== 'idle' && workerState !== 'interrupted') continue;

			// Skip if the worker has no new messages since the last forwarding.
			// This prevents spurious re-routing when feedbackIteration was reset by
			// resumeLeaderFromHuman (or resumeWorkerFromHuman) but the worker has not
			// produced any new output yet — re-routing would inject a sentinel string
			// into the leader while it is already processing the human's message.
			// For the expired-rate-limit case this also acts as a safety net: if the LEADER
			// hit the rate limit (rateLimit.sessionRole === 'leader'), the worker messages were
			// already forwarded (lastForwardedMessageId updated) and this check skips re-routing.
			// When getWorkerMessages is absent (some test contexts), fall through to
			// preserve the original safety-net behavior.
			if (this.getWorkerMessages) {
				const newMessages = this.getWorkerMessages(
					group.workerSessionId,
					group.lastForwardedMessageId
				);
				if (newMessages.length === 0) continue;
			}

			// Guard against duplicate in-flight recovery: if a previous tick already
			// triggered routing for this group and it hasn't completed yet, skip it.
			// feedbackIteration is incremented only after routeWorkerToLeader succeeds,
			// so without this guard successive ticks would fire concurrent routing calls.
			if (this.stuckWorkerRecoveryInFlight.has(group.id)) {
				log.debug(`[StuckWorker] Group ${group.id}: recovery already in-flight, skipping`);
				continue;
			}

			const reason = hasExpiredRateLimit
				? `rate limit expired (feedbackIteration=${group.feedbackIteration})`
				: `feedbackIteration=0, waitingForQuestion=false`;
			log.warn(
				`[StuckWorker] Group ${group.id}: worker is '${workerState}' but routing to leader not yet ` +
					`completed (${reason}). Re-triggering worker→leader routing.`
			);
			this.appendGroupEvent(group.id, 'status', {
				text: `Worker found in ${workerState} state with routing not yet complete — re-triggering routing to Leader.`,
			});

			// Mark as in-flight before firing, clear when done (success or error)
			this.stuckWorkerRecoveryInFlight.add(group.id);
			void this.onWorkerTerminalState(group.id, {
				sessionId: group.workerSessionId,
				kind: workerState,
			})
				.catch((err) => {
					log.error(`[StuckWorker] Group ${group.id}: re-triggered routing threw:`, err);
				})
				.finally(() => {
					this.stuckWorkerRecoveryInFlight.delete(group.id);
				});
		}
	}

	/**
	 * Auto-clean stale session groups whose tasks have reached a terminal state.
	 *
	 * Groups become stale when a task transitions to completed/cancelled/archived
	 * while its group was still marked active (e.g., after a daemon crash or an
	 * external status change). Stale groups consume concurrency slots and prevent
	 * new tasks from being picked up.
	 *
	 * This runs at the start of every tick as a safety net. Stale groups are
	 * terminated (sessions stopped, group marked failed) so slots are freed.
	 */
	private async cleanStaleGroups(): Promise<void> {
		const activeGroups = this.groupRepo.getActiveGroups(this.roomId);
		if (activeGroups.length === 0) return;

		// NOTE: getActiveGroups() uses an INNER JOIN on tasks — groups whose tasks
		// were hard-deleted from the DB will not appear here. Those groups are handled
		// by the zombie recovery path (findZombieGroups / recoverZombieGroups).

		for (const group of activeGroups) {
			try {
				const task = await this.taskManager.getTask(group.taskId);
				const isStale = !task || STALE_TASK_STATUSES.has(task.status);
				if (!isStale) continue;

				log.warn(
					`[cleanStaleGroups] Group ${group.id} is stale ` +
						`(task ${group.taskId} status=${task?.status ?? 'not found'}) — auto-cleaning`
				);

				// Stop the actual agent processes (best-effort).
				await this.terminateGroupSessions(group);

				// Mark group as terminal (unobserves sessions); no-op if already terminal.
				if (group.completedAt === null) {
					await this.taskGroupManager.terminateGroup(group.id);
				}

				// Clean up mirroring subscriptions.
				this.cleanupMirroring(group.id, 'Stale group auto-cleaned by tick.');

				// Emit UI updates so the frontend reflects the cleaned-up state.
				await this.emitTaskUpdateById(group.taskId);
				await this.emitGoalProgressForTask(group.taskId);
			} catch (error) {
				log.error(`[cleanStaleGroups] Failed to clean stale group ${group.id} — skipping:`, error);
			}
		}
	}

	private async executeTick(): Promise<void> {
		// Safety net: clean up stale groups whose tasks have already reached a
		// terminal state. This frees concurrency slots blocked by orphaned groups.
		await this.cleanStaleGroups();

		// Safety net: detect and recover zombie groups (sessions missing from cache).
		// Ordering: zombie recovery runs BEFORE tickRecurringMissions so that any
		// in-flight execution from a prior restart is recovered first, preventing a
		// duplicate catch-up trigger from the scheduler.
		const zombies = this.findZombieGroups();
		if (zombies.length > 0) {
			await this.recoverZombieGroups(zombies);
		}

		// Safety net: detect workers stuck in terminal state without being routed to leader.
		// This recovers cases where the observer callback fired but the routing failed silently.
		// Note: synchronous scan, only fires async work as fire-and-forget if stuck workers are found.
		this.recoverStuckWorkers();

		// Recurring mission scheduler: check for due missions and trigger new executions.
		// Also checks for completed executions to advance next_run_at.
		// Runs only when runtime is in 'running' state (enforced by tick() guard above).
		// tickRecurringMissions() returns void (synchronously) when there are no recurring goals,
		// or Promise<void> when async work is needed — only await in the latter case to preserve
		// the microtask-ordering behaviour that existing tests depend on.
		const recurringWork = this.tickRecurringMissions();
		if (recurringWork !== undefined) {
			await recurringWork;
			// Bail out early if the runtime was stopped during the async recurring mission work.
			if (this.state !== 'running') return;
		}

		// Check capacity — groups awaiting human review don't consume slots
		const allActiveGroups = this.groupRepo.getActiveGroups(this.roomId);
		const workingGroups = allActiveGroups.filter((g) => !g.submittedForReview);
		const availableSlots = this.maxConcurrentGroups - workingGroups.length;

		if (availableSlots <= 0) return;

		// Planning takes priority over execution.
		// If a goal needs planning (no tasks, or all tasks failed), spawn a planning group first.
		const planningNeeded = await this.getNextGoalForPlanning();
		if (planningNeeded) {
			await this.spawnPlanningGroup(planningNeeded.goal, planningNeeded.replanContext);
			return; // Don't start execution groups in the same tick
		}

		// Find pending non-planning tasks (planning tasks are spawned directly, not via queue)
		const pendingTasks = await this.taskManager.listTasks({ status: 'pending' });
		const planningTasks = pendingTasks.filter((t) => (t.taskType ?? 'coding') === 'planning');
		if (planningTasks.length > 0) {
			// Debug-level: these tasks are handled (skipped), no operator action needed from runtime
			log.debug(
				`[executeTick] ${planningTasks.length} pending task(s) with reserved 'planning' type will be skipped: ` +
					planningTasks.map((t) => `${t.id} ("${t.title}")`).join(', ') +
					`. 'planning' type is reserved for internal use.`
			);
		}
		const executableTasks = pendingTasks.filter((t) => (t.taskType ?? 'coding') !== 'planning');
		if (executableTasks.length === 0) return;

		// Collect task IDs that already have an active (non-terminal) group.
		// Uses allActiveGroups (including submitted-for-review) to prevent spawning
		// a duplicate group while another is awaiting human review.
		// This prevents duplicate group spawning when concurrent ticks race
		// (the job queue processor runs up to maxConcurrent jobs in parallel,
		// so two ticks can both see a task as 'pending' before either transitions
		// it to 'in_progress').
		const activeGroupTaskIds = new Set(allActiveGroups.map((g) => g.taskId));

		// Filter to tasks whose dependencies are all completed
		const readyTasks: NeoTask[] = [];
		for (const task of executableTasks) {
			if (activeGroupTaskIds.has(task.id)) {
				log.debug(
					`[executeTick] Task ${task.id} ("${task.title}") skipped — active group already exists`
				);
				continue;
			}
			if (await this.taskManager.areDependenciesMet(task)) {
				readyTasks.push(task);
			} else {
				log.debug(
					`[executeTick] Task ${task.id} ("${task.title}") skipped — dependencies not yet completed`
				);
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
	 * Scheduler tick for recurring missions.
	 *
	 * Two phases per tick:
	 * Phase 1 — Completion check: for each recurring goal with a running execution,
	 *   check whether all of its tasks have reached a terminal state. If so, mark
	 *   the execution as completed and advance next_run_at.
	 * Phase 2 — Trigger check: for each recurring goal where next_run_at <= now
	 *   AND schedule_paused = false AND no active execution, start a new execution.
	 *
	 * Overlap prevention: enforced at two levels —
	 *   (1) DB partial unique index on mission_executions(goal_id) WHERE status='running'
	 *   (2) App-level check via getActiveExecution() before insert
	 *
	 * Catch-up: if next_run_at is in the past, fire once immediately, then
	 * advance from current time (skipping missed intervals).
	 *
	 * Precision: up to 30s jitter from tick interval (acceptable for @hourly+).
	 *
	 * Returns void synchronously when there are no recurring goals (to preserve microtask ordering),
	 * or a Promise<void> when async work is needed.
	 * Call site must conditionally await: `const p = this.tickRecurringMissions(); if (p) await p;`
	 */
	private tickRecurringMissions(): void | Promise<void> {
		// Synchronous pre-check — goalRepo.listGoals is a bun:sqlite synchronous call.
		// Avoids an extra microtask yield when there are no recurring goals.
		const recurringGoals = this.goalManager
			.listGoalsSync('active')
			.filter((g) => g.missionType === 'recurring');

		if (recurringGoals.length === 0) return; // synchronous return — no microtask added

		return this._doTickRecurringMissions(recurringGoals);
	}

	private async _doTickRecurringMissions(recurringGoals: RoomGoal[]): Promise<void> {
		const nowSec = Math.floor(Date.now() / 1000);

		// Phase 1: Complete finished executions
		for (const goal of recurringGoals) {
			const activeExecution = this.goalManager.getActiveExecution(goal.id);
			if (!activeExecution) continue;

			// Check if all tasks for this execution are in terminal state
			const taskIds = activeExecution.taskIds;
			if (taskIds.length === 0) {
				// Orphan guard: execution has been running with no tasks for > 5 minutes.
				// This happens if planning failed before any tasks were created (e.g. a crash
				// between startExecution and spawnPlanningGroup). Fail it so Phase 2 can fire again.
				const ORPHAN_THRESHOLD_SEC = 5 * 60; // 5 minutes
				if (nowSec - activeExecution.startedAt > ORPHAN_THRESHOLD_SEC) {
					log.warn(
						`Recurring mission ${goal.id}: orphan execution ${activeExecution.id} ` +
							`has no tasks after ${ORPHAN_THRESHOLD_SEC}s — failing it`
					);
					this.goalManager.failExecution(
						activeExecution.id,
						`Orphan: execution started but no tasks were created within ${ORPHAN_THRESHOLD_SEC}s.`
					);
				}
				continue;
			}

			const tasks = await Promise.all(taskIds.map((id) => this.taskManager.getTask(id)));
			const validTasks = tasks.filter(Boolean) as NonNullable<(typeof tasks)[number]>[];
			if (validTasks.length === 0) continue;

			const isTerminal = (status: string) =>
				status === 'completed' || status === 'needs_attention' || status === 'cancelled';
			const allTerminal = validTasks.every((t) => isTerminal(t.status));
			if (!allTerminal) continue;

			// All tasks are terminal: mark execution as completed (or failed)
			const anyCompleted = validTasks.some((t) => t.status === 'completed');
			const resultSummary = anyCompleted
				? `Execution ${activeExecution.executionNumber} completed: ${validTasks.filter((t) => t.status === 'completed').length}/${validTasks.length} tasks succeeded.`
				: `Execution ${activeExecution.executionNumber} failed: all tasks reached terminal state without completion.`;

			if (anyCompleted) {
				this.goalManager.completeExecution(activeExecution.id, resultSummary);
				log.info(
					`Recurring mission ${goal.id} execution ${activeExecution.executionNumber} completed`
				);
			} else {
				this.goalManager.failExecution(activeExecution.id, resultSummary);
				log.warn(
					`Recurring mission ${goal.id} execution ${activeExecution.executionNumber} failed`
				);
			}

			// Advance next_run_at from current time
			if (goal.schedule) {
				const tz = goal.schedule.timezone ?? 'UTC';
				const nextRunAt = getNextRunAt(goal.schedule.expression, tz);
				if (nextRunAt !== null) {
					await this.goalManager.updateNextRunAt(goal.id, nextRunAt);
					log.info(
						`Recurring mission ${goal.id} next run scheduled at ${new Date(nextRunAt * 1000).toISOString()}`
					);
				}
			}

			// Emit goal progress update
			if (this.daemonHub) {
				const updatedGoal = await this.goalManager.getGoal(goal.id);
				if (updatedGoal) {
					void this.daemonHub.emit('goal.progressUpdated', {
						sessionId: `room:${this.roomId}`,
						roomId: this.roomId,
						goalId: goal.id,
						progress: updatedGoal.progress,
					});
				}
			}
		}

		// Phase 2: Trigger new executions for due missions
		// Refresh goal list after Phase 1 mutations
		const refreshedGoals = (await this.goalManager.listGoals('active')).filter(
			(g) => g.missionType === 'recurring'
		);

		for (const goal of refreshedGoals) {
			if (goal.schedulePaused) continue;
			if (!goal.schedule) continue;
			if (goal.nextRunAt === undefined || goal.nextRunAt === null) continue;
			if (goal.nextRunAt > nowSec) continue; // not due yet

			// Calculate next_run_at BEFORE startExecution so it is written atomically
			// in the same transaction — prevents a crash leaving an execution running
			// with an expired next_run_at.
			const tz = goal.schedule.timezone ?? 'UTC';
			const nextRunAt = getNextRunAt(goal.schedule.expression, tz);

			// Check for active execution (overlap prevention — app level)
			const activeExecution = this.goalManager.getActiveExecution(goal.id);
			if (activeExecution) {
				// Overlap: execution still running but next_run_at is past
				// Advance next_run_at to prevent repeated log spam on every tick
				log.warn(
					`Recurring mission ${goal.id} (${goal.title}) due but execution ${activeExecution.id} still running — skipping trigger, advancing next_run_at`
				);
				if (nextRunAt !== null) {
					await this.goalManager.updateNextRunAt(goal.id, nextRunAt);
				}
				continue;
			}

			// Trigger a new execution — nextRunAt is set atomically in the same transaction.
			// try/catch handles the DB unique-constraint guard against concurrent inserts.
			let execution;
			try {
				execution = this.goalManager.startExecution(goal.id, nextRunAt ?? undefined);
				log.info(
					`Recurring mission ${goal.id} (${goal.title}) triggered execution ${execution.executionNumber}`
				);
			} catch (err) {
				// Unique constraint violation from DB index: another process already inserted a row.
				// Idempotent — log and skip.
				log.warn(
					`Recurring mission ${goal.id}: failed to start execution (possible race) — ${err}`
				);
				continue;
			}

			// Fetch previous execution result for context
			const prevExecutions = this.goalManager.listExecutions(goal.id, 2);
			const prevCompleted = prevExecutions.find(
				(e) => e.id !== execution.id && e.status === 'completed'
			);
			const previousResultSummary = prevCompleted?.resultSummary;

			// Spawn planning group with executionId
			await this.spawnPlanningGroup(goal, undefined, execution.id, previousResultSummary);
		}
	}

	/**
	 * Find the highest-priority active goal that needs planning.
	 *
	 * A goal needs planning when:
	 * - status is 'active'
	 * - has no linked tasks at all, OR all linked tasks need attention
	 * - has no pending/in_progress/draft/escalated tasks
	 * - planning_attempts < effective max planning attempts
	 *
	 * For measurable missions, an additional case is handled:
	 * - All execution tasks completed successfully but metric targets not met → replan with metric context
	 * - All metric targets met → complete the mission automatically
	 *
	 * Goals that exceed max planning attempts are transitioned to 'needs_human'.
	 */
	private async getNextGoalForPlanning(): Promise<{
		goal: RoomGoal;
		replanContext?: ReplanContext;
	} | null> {
		const activeGoals = await this.goalManager.listGoals('active');
		const currentRoom = this.getCurrentRoom();
		const roomConfig = (currentRoom?.config ?? {}) as Record<string, unknown>;

		for (const goal of activeGoals) {
			// Recurring missions are ONLY planned through the scheduler path (tickRecurringMissions).
			// Never let the standard selector pick them up.
			if (goal.missionType === 'recurring') continue;
			const linkedTaskIds = goal.linkedTaskIds ?? [];

			let needsPlanning = false;
			let replanContext: ReplanContext | undefined;

			if (linkedTaskIds.length === 0) {
				// No tasks at all: brand new goal
				needsPlanning = true;
			} else {
				// Check whether execution tasks need replanning.
				// A goal needs replanning when:
				// - No active (pending/in_progress/draft/escalated) tasks remain
				// - All execution tasks (non-planning) need attention
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
				const isTerminal = (status: string) =>
					status === 'needs_attention' || status === 'cancelled';
				const allExecutionFailed =
					executionTasks.length > 0 && executionTasks.every((t) => isTerminal(t.status));
				const allFailed = validTasks.length > 0 && validTasks.every((t) => isTerminal(t.status));

				// Re-plan if no active tasks and either all tasks reached a terminal state
				// (failed or cancelled) or all execution tasks reached a terminal state
				needsPlanning = !hasActiveTask && (allFailed || allExecutionFailed);

				// Measurable mission: check if all execution tasks completed (not failed)
				// and whether metric targets are met.
				if (
					!needsPlanning &&
					!hasActiveTask &&
					goal.missionType === 'measurable' &&
					goal.structuredMetrics &&
					goal.structuredMetrics.length > 0
				) {
					const allExecutionCompleted =
						executionTasks.length > 0 && executionTasks.every((t) => t.status === 'completed');

					if (allExecutionCompleted) {
						const targetsResult = await this.goalManager.checkMetricTargets(goal.id);

						if (targetsResult.allMet) {
							// All targets met — complete the mission automatically
							log.info(
								`Measurable mission ${goal.id} (${goal.title}): all metric targets met, completing.`
							);
							await this.goalManager.updateGoalStatus(goal.id, 'completed', { progress: 100 });
							if (this.daemonHub) {
								void this.daemonHub.emit('goal.progressUpdated', {
									sessionId: `room:${this.roomId}`,
									roomId: this.roomId,
									goalId: goal.id,
									progress: 100,
								});
							}
							continue; // Don't plan for this goal
						}

						// Targets not met — trigger replanning with metric context.
						// executionTasks is already filtered to taskType !== 'planning' and all have
						// status === 'completed' (allExecutionCompleted guard above).
						needsPlanning = true;
						const completedExecTasks = executionTasks.map((t) => ({
							title: t.title,
							result: t.result ?? 'completed',
						}));

						// Fetch recent history for each metric
						const metricStatuses: MetricReplanStatus[] = await Promise.all(
							targetsResult.results.map(async (r) => {
								const metric = goal.structuredMetrics!.find((m) => m.name === r.name);
								const history = await this.goalManager.getMetricHistory(goal.id, r.name);
								const recentHistory = history.slice(-5).map((h) => h.value);
								return {
									name: r.name,
									current: r.current,
									target: r.target,
									baseline: metric?.baseline,
									direction: metric?.direction,
									met: r.met,
									recentHistory,
								};
							})
						);

						const unmetNames = targetsResult.results
							.filter((r) => !r.met)
							.map((r) => r.name)
							.join(', ');

						replanContext = {
							completedTasks: completedExecTasks,
							failedTask: {
								title: 'Metric targets not met',
								error: `All tasks completed but metric targets not reached. Unmet metrics: ${unmetNames}`,
							},
							attempt: (goal.planning_attempts ?? 0) + 1,
							metricContext: { metrics: metricStatuses },
						};
					}
				}
			}

			if (!needsPlanning) continue;

			const effectiveMax = getEffectiveMaxPlanningAttempts(goal, roomConfig);
			const attempts = goal.planning_attempts ?? 0;

			if (attempts >= effectiveMax) {
				// Too many failed planning attempts: escalate to human
				log.warn(
					`Goal ${goal.id} (${goal.title}) exceeded max planning attempts (${effectiveMax}), marking needs_human`
				);
				await this.goalManager.updateGoalStatus(goal.id, 'needs_human');
				continue;
			}

			return { goal, replanContext };
		}

		return null;
	}

	/**
	 * Spawn a planning (Planner, Leader) group for a goal that has no tasks yet.
	 * Creates a planning task, increments planning_attempts, and starts the group.
	 *
	 * For recurring missions, pass executionId to correlate the group with the
	 * mission_executions row. Pass previousResultSummary for continuity context.
	 */
	private async spawnPlanningGroup(
		goal: RoomGoal,
		replanContext?: ReplanContext,
		executionId?: string,
		previousResultSummary?: string
	): Promise<void> {
		const isReplan = !!replanContext;
		const isRecurringExecution = !!executionId;

		// Create the planning task itself
		const planningTask = await this.taskManager.createTask({
			title: isReplan ? `Replan: ${goal.title}` : `Plan: ${goal.title}`,
			description: isReplan
				? `Replan the goal "${goal.title}" after task failure. Build on completed work.`
				: isRecurringExecution
					? `Scheduled execution of "${goal.title}".` +
						(previousResultSummary
							? ` Previous run result: ${previousResultSummary}`
							: ' (first execution)')
					: `Examine the codebase and break down the goal "${goal.title}" into concrete, executable tasks.`,
			taskType: 'planning',
			status: 'pending',
		});

		// Link planning task to the goal (or execution for recurring missions)
		if (isRecurringExecution) {
			await this.goalManager.linkTaskToExecution(goal.id, executionId, planningTask.id);
		} else {
			await this.goalManager.linkTaskToGoal(goal.id, planningTask.id);
		}

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
			// Link the draft task to the goal (or execution for recurring missions)
			if (isRecurringExecution) {
				await this.goalManager.linkTaskToExecution(goal.id, executionId, task.id);
			} else {
				await this.goalManager.linkTaskToGoal(goal.id, task.id);
			}
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

		// Fetch fresh room for worker/leader init (config may have changed)
		const currentRoom = this.getCurrentRoom();
		if (!currentRoom) {
			await this.taskManager.failTask(planningTask.id, `Room not found: ${this.roomId}`);
			await this.emitTaskUpdateById(planningTask.id);
			return;
		}
		const plannerModel = this.resolveAgentModel(currentRoom, 'planner');
		const leaderModel = this.resolveAgentModel(currentRoom, 'leader');
		const plannerProvider = this.resolveProviderForModel(plannerModel);
		const leaderProvider = this.resolveProviderForModel(leaderModel);

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
			model: plannerModel,
			provider: plannerProvider,
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
				model: leaderModel,
				provider: leaderProvider,
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
				(groupId, state) => {
					void this.onWorkerTerminalState(groupId, state).catch((err) => {
						log.error(`[worker-observer] Group ${groupId}: terminal state handler threw:`, err);
					});
				},
				(groupId, state) => {
					void this.onLeaderTerminalState(groupId, state).catch((err) => {
						log.error(`[leader-observer] Group ${groupId}: terminal state handler threw:`, err);
					});
				},
				(groupId) => this.createLeaderCallbacks(groupId),
				workerConfig,
				'plan_review'
			);
		} catch (err) {
			// spawn() calls failTask() only for worktree-creation failures (line ~241).
			// If session init throws after startTask(), the task stays in_progress.
			// The zombie/stuck-worker recovery will detect and re-trigger routing on the
			// next tick once the process stabilises.
			log.error(`Failed to spawn planning group for goal ${goal.id}: ${err}`);
			await this.emitTaskUpdateById(planningTask.id);
			return;
		}

		// Wire up the mutable ref so isPlanApproved can query the group
		spawnedGroupId = group.id;

		// For recurring missions, persist the execution ID in group metadata.
		// recoverZombieGroups() stores it for auditability; the actual execution state
		// is recovered via getActiveExecution() which reads mission_executions directly.
		if (isRecurringExecution) {
			this.groupRepo.setExecutionId(group.id, executionId);
		}

		// Notify UI: planning task is now in_progress
		await this.emitTaskUpdateById(planningTask.id);
		this.setupMirroring(group);

		log.info(
			`Spawned planning group for goal ${goal.id} (${goal.title}), attempt ${(goal.planning_attempts ?? 0) + 1}` +
				(isRecurringExecution ? ` [execution ${executionId}]` : '')
		);
	}

	/**
	 * Spawn an execution (Coder/General, Leader) group for a task.
	 * Reads task.assignedAgent to pick the appropriate worker factory.
	 */
	private async spawnGroupForTask(task: NeoTask): Promise<void> {
		// Defense-in-depth: verify no active group exists for this task right before spawning.
		// Catches races that slip past the executeTick() filter (e.g., concurrent ticks).
		// Check ALL active groups, not just the most recent — a stale older group with
		// completedAt === null would be missed by getGroupByTaskId() which returns only the latest.
		const allActiveGroups = this.groupRepo.getActiveGroupsForTask(task.id);
		if (allActiveGroups.length > 0) {
			log.warn(
				`[spawnGroupForTask] Task ${task.id} ("${task.title}") already has ${allActiveGroups.length} active group(s) (${allActiveGroups.map((g) => g.id).join(', ')}) — skipping duplicate spawn`
			);
			return;
		}

		// Find the goal linked to this task. Goal is optional — tasks without a goal still run.
		const goals = await this.goalManager.getGoalsForTask(task.id);
		const goal = goals[0] ?? null;
		if (!goal) {
			log.debug(
				`[spawnGroupForTask] Task ${task.id} ("${task.title}") has no linked goal — spawning without goal context`
			);
		}

		// Get summaries of previously completed tasks for context
		const completedTasks = await this.taskManager.listTasks({ status: 'completed' });
		const goalLinkedIds = new Set(goal?.linkedTaskIds ?? []);
		const previousTaskSummaries = completedTasks
			.filter((t) => goalLinkedIds.has(t.id) && t.id !== task.id)
			.map((t) => `${t.title}: ${t.result ?? 'completed'}`);

		// Fetch fresh room for worker/leader init (config may have changed)
		const currentRoom = this.getCurrentRoom();
		if (!currentRoom) {
			await this.taskManager.failTask(task.id, `Room not found: ${this.roomId}`);
			await this.emitTaskUpdateById(task.id);
			return;
		}

		// Determine worker config based on assigned agent type
		const agentType = task.assignedAgent ?? 'coder';
		const workerRole = agentType === 'general' ? 'general' : 'coder';
		const workerModel = this.resolveAgentModel(currentRoom, workerRole);
		const leaderModel = this.resolveAgentModel(currentRoom, 'leader');
		const workerProvider = this.resolveProviderForModel(workerModel);
		const leaderProvider = this.resolveProviderForModel(leaderModel);
		let workerConfig: WorkerConfig;

		// Shared leader context config (groupId not used by buildLeaderTaskContext)
		const leaderContextConfig = {
			task,
			goal,
			room: currentRoom,
			sessionId: '',
			workspacePath: this.taskGroupManager.workspacePath,
			groupId: '',
			model: leaderModel,
			provider: leaderProvider,
			reviewContext: 'code_review' as const,
		};

		if (agentType === 'general') {
			const generalConfig = {
				task,
				goal,
				room: currentRoom,
				sessionId: '', // placeholder — overwritten by initFactory
				workspacePath: this.taskGroupManager.workspacePath,
				model: workerModel,
				provider: workerProvider,
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
				model: workerModel,
				provider: workerProvider,
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
				(groupId, state) => {
					void this.onWorkerTerminalState(groupId, state).catch((err) => {
						log.error(`[worker-observer] Group ${groupId}: terminal state handler threw:`, err);
					});
				},
				(groupId, state) => {
					void this.onLeaderTerminalState(groupId, state).catch((err) => {
						log.error(`[leader-observer] Group ${groupId}: terminal state handler threw:`, err);
					});
				},
				(groupId) => this.createLeaderCallbacks(groupId),
				workerConfig,
				'code_review'
			);
		} catch (err) {
			// spawn() calls failTask() only for worktree-creation failures (line ~241).
			// If session init throws after startTask(), the task stays in_progress.
			// The zombie/stuck-worker recovery will detect and re-trigger routing on the
			// next tick once the process stabilises.
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
		// (and execution for recurring missions) as the planning task.
		// MCP server closures may have been lost on daemon restart, so the
		// link call may not have fired during the original planning session.
		const goals = await this.goalManager.getGoalsForTask(taskId);
		const goal = goals[0];
		if (goal) {
			// For recurring missions look up the active execution so that
			// mission_executions.task_ids is also populated (same as the primary path).
			const activeExecution =
				goal.missionType === 'recurring' ? this.goalManager.getActiveExecution(goal.id) : null;
			const drafts = await this.taskManager.getDraftTasksByCreator(taskId);
			const linked = new Set(goal.linkedTaskIds ?? []);
			for (const draft of drafts) {
				if (!linked.has(draft.id)) {
					if (activeExecution) {
						await this.goalManager.linkTaskToExecution(goal.id, activeExecution.id, draft.id);
					} else {
						await this.goalManager.linkTaskToGoal(goal.id, draft.id);
					}
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
		const effectiveMax = this.maxPlanningAttempts;
		if (attempts >= effectiveMax) {
			// Fail the task and escalate instead of replanning
			await this.taskGroupManager.fail(groupId, reason);
			this.cleanupMirroring(groupId, `Task failed: ${reason}`);
			await this.emitTaskUpdateById(taskId);
			await this.goalManager.updateGoalStatus(goal.id, 'needs_human');
			this.scheduleTick();
			return jsonResult({
				success: false,
				error: `Max planning retries (${effectiveMax - 1}) reached. Goal escalated to human.`,
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

		// For recurring missions, pass the active executionId so task-linking uses
		// linkTaskToExecution instead of linkTaskToGoal (execution identity preserved).
		const activeExecution =
			goal.missionType === 'recurring' ? this.goalManager.getActiveExecution(goal.id) : null;

		await this.spawnPlanningGroup(goal, replanContext, activeExecution?.id);
		this.scheduleTick();

		return jsonResult({
			success: true,
			message: `Replanning triggered for goal "${goal.title}" (attempt ${attempts + 1}). ${cancelledCount} pending tasks cancelled.`,
		});
	}

	private scheduleTick(): void {
		if (this.state !== 'running') return;
		if (this.jobQueue) enqueueRoomTick(this.roomId, this.jobQueue, 0);
	}

	/**
	 * Schedule a tick after rate limit reset time.
	 * Used to resume work after API rate limit backoff period expires.
	 *
	 * Do NOT clearRateLimit here. The expired (non-null) rateLimit object serves as the
	 * re-detection sentinel in onWorkerTerminalState / onLeaderTerminalState: the
	 * `!group.rateLimit` guard uses it to distinguish "first detection" from "re-trigger
	 * after expiry", preventing an infinite 60-second bounce loop.
	 * The rate limit is cleared in `send_to_worker` when a new worker iteration genuinely starts.
	 */
	private scheduleTickAfterRateLimitReset(groupId: string): void {
		const remainingMs = this.groupRepo.getRateLimitRemainingMs(groupId);
		const delayMs = remainingMs <= 0 ? 0 : remainingMs + 5000;

		if (delayMs > 0) {
			log.info(
				`Scheduling tick in ${Math.round(delayMs / 1000)}s for group ${groupId} ` +
					`(rate limit resets at ${new Date(Date.now() + remainingMs).toLocaleTimeString()})`
			);
		}

		if (this.jobQueue) enqueueRoomTick(this.roomId, this.jobQueue, delayMs);
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
