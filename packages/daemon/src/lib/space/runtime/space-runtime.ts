/**
 * SpaceRuntime
 *
 * Agent-centric orchestration engine for Spaces.
 * Manages workflow run lifecycles and standalone task queuing
 * using Space tables exclusively (not Room tables).
 *
 * Responsibilities:
 * - Maintain a Map<runId, WorkflowExecutor> for active workflow runs
 * - Rehydrate executors from DB on first executeTick() call
 * - Start new workflow runs (creates run record + executor + first node task)
 * - Spawn Task Agent sessions for pending tasks
 * - Monitor agent liveness and recover from crashes
 * - Resolve task types from agent roles (planner → planning, coder/general → coding, etc.)
 * - Filter and expose workflow rules applicable to a given node
 * - Clean up executors when runs reach terminal states
 *
 * In the agent-centric model, agents drive workflow progression via send_message
 * and report_done — SpaceRuntime no longer calls advance() directly.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type {
	SpaceTask,
	UpdateSpaceTaskParams,
	SpaceWorkflow,
	SpaceWorkflowRun,
	WorkflowChannel,
} from '@neokai/shared';
import { resolveNodeAgents } from '@neokai/shared';
import type { SpaceManager } from '../managers/space-manager';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { ReactiveDatabase } from '../../../storage/reactive-database';
import type { TaskAgentManager } from './task-agent-manager';
import { SpaceTaskManager } from '../managers/space-task-manager';
import { WorkflowExecutor } from './workflow-executor';
import { selectWorkflow } from './workflow-selector';
import { Logger } from '../../logger';
import { type NotificationSink, NullNotificationSink } from './notification-sink';
import { CompletionDetector } from './completion-detector';
import { TERMINAL_NODE_EXECUTION_STATUSES } from '../managers/node-execution-manager';
import {
	MAX_BLOCKED_RUN_RETRIES,
	MAX_TASK_AGENT_CRASH_RETRIES,
	resolveNodeTimeout,
} from './constants';

const log = new Logger('space-runtime');

const WORKFLOW_SELECTION_STOP_WORDS = new Set([
	'the',
	'and',
	'for',
	'are',
	'but',
	'not',
	'you',
	'all',
	'can',
	'was',
	'one',
	'our',
	'out',
	'day',
	'get',
	'has',
	'him',
	'his',
	'how',
	'its',
	'may',
	'new',
	'now',
	'old',
	'see',
	'two',
	'use',
	'way',
	'who',
	'did',
	'let',
	'put',
	'say',
	'she',
	'too',
	'had',
	'any',
	'via',
]);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SpaceRuntimeConfig {
	/** Raw Bun SQLite database — used to create per-space SpaceTaskManagers */
	db: BunDatabase;
	/** Space manager for listing spaces and fetching workspace paths */
	spaceManager: SpaceManager;
	/** Agent manager for resolving agents */
	spaceAgentManager: SpaceAgentManager;
	/** Workflow manager for loading workflow definitions */
	spaceWorkflowManager: SpaceWorkflowManager;
	/** Workflow run repository for run CRUD and status updates */
	workflowRunRepo: SpaceWorkflowRunRepository;
	/** Task repository for querying tasks by run/node */
	taskRepo: SpaceTaskRepository;
	/** Node execution repository for workflow-internal execution state */
	nodeExecutionRepo: NodeExecutionRepository;
	/** Optional reactive DB invalidation hooks for task LiveQuery surfaces */
	reactiveDb?: ReactiveDatabase;
	/**
	 * Optional TaskAgentManager for Task Agent mode.
	 *
	 * SpaceRuntime uses TaskAgentManager for node-agent session lifecycle
	 * (spawn/liveness/cancel) and optional Task Agent messaging sessions.
	 */
	taskAgentManager?: TaskAgentManager;
	/**
	 * Interval between executeTick() calls in milliseconds.
	 * Used by start(). Default: 5000 (5 seconds).
	 */
	tickIntervalMs?: number;
	/**
	 * Sink for structured notification events emitted after mechanical processing.
	 * Defaults to NullNotificationSink (no-op). Use setNotificationSink() to wire
	 * in a real sink after construction (e.g. once the Space Agent session exists).
	 */
	notificationSink?: NotificationSink;
	/**
	 * Completion detector for the all-agents-done completion model.
	 *
	 * When provided (or defaulted from taskRepo), used in processRunTick() to
	 * detect when all agents in a workflow run have reached a terminal status and
	 * mark the run as completed. Replaces the old terminal-node detection model.
	 *
	 * Defaults to `new CompletionDetector(nodeExecutionRepo)` if not provided.
	 */
	completionDetector?: CompletionDetector;
	/**
	 * Optional callback emitted when runtime mutates a SpaceTask internally.
	 * Used to fan out `space.task.updated` events for UI synchronization.
	 */
	onTaskUpdated?: (payload: { spaceId: string; task: SpaceTask }) => Promise<void> | void;
	/**
	 * Optional callback emitted when runtime creates a workflow run internally.
	 * Used to fan out `space.workflowRun.created` events for UI synchronization.
	 */
	onWorkflowRunCreated?: (payload: {
		spaceId: string;
		run: SpaceWorkflowRun;
	}) => Promise<void> | void;
	/**
	 * Optional callback emitted when runtime updates workflow run status internally.
	 * Used to fan out `space.workflowRun.updated` events for UI synchronization.
	 */
	onWorkflowRunUpdated?: (payload: {
		spaceId: string;
		run: SpaceWorkflowRun;
	}) => Promise<void> | void;
}

interface StartWorkflowRunOptions {
	/**
	 * Optional canonical parent task for this workflow run.
	 * When provided, runtime-created node tasks are marked with this parent
	 * so user-facing views can keep a one-task-per-run list.
	 */
	parentTaskId?: string;
}

// ---------------------------------------------------------------------------
// SpaceRuntime
// ---------------------------------------------------------------------------

/** Metadata stored alongside each executor to allow recreation with fresh state */
interface ExecutorMeta {
	workflow: SpaceWorkflow;
	spaceId: string;
	workspacePath: string;
}

export class SpaceRuntime {
	/** Map from workflowRunId → WorkflowExecutor for all active runs */
	private executors = new Map<string, WorkflowExecutor>();

	/**
	 * Metadata stored per run so the executor can be recreated with fresh DB
	 * state when the run has been externally modified (e.g. status reset after
	 * a human gate approval).
	 */
	private executorMeta = new Map<string, ExecutorMeta>();

	/**
	 * Per-space SpaceTaskManager instances, cached to avoid creating a new
	 * manager + repository on every executor build.
	 */
	private taskManagers = new Map<string, SpaceTaskManager>();

	/**
	 * Set to true after the first executeTick() call, after rehydrateExecutors()
	 * has loaded in-progress runs from the DB. Prevents repeated rehydration.
	 */
	private rehydrated = false;

	/** Handle returned by setInterval when the tick loop is running */
	private tickTimer: ReturnType<typeof setInterval> | null = null;
	/** Single-flight guard to prevent overlapping executeTick() runs. */
	private tickInFlight = false;

	/** Active notification sink — replaced at runtime via setNotificationSink() */
	private notificationSink: NotificationSink;

	/**
	 * Completion detector for the all-agents-done model.
	 * Initialized from config or defaulted to `new CompletionDetector(taskRepo)`.
	 */
	private completionDetector: CompletionDetector;

	/**
	 * Deduplication set for notifications keyed by `taskId:status` (e.g. `task-1:blocked`
	 * or `task-1:timeout`). Prevents re-notifying for the same task+status across ticks.
	 * Entries are cleared when the task leaves the flagged state.
	 *
	 * Restart contract: this set is in-memory only and starts empty on every daemon restart.
	 * Tasks already in `blocked` at restart time will be re-notified once on the first
	 * tick. This is intentional: the Space Agent session is also new after restart and needs to
	 * learn about outstanding issues. No DB persistence for dedup state is required.
	 */
	private notifiedTaskSet = new Set<string>();

	/**
	 * In-memory crash counter per execution key (`${runId}:${nodeExecutionId}`).
	 *
	 * Tracks how many times a workflow node agent session has been detected dead.
	 * When the count reaches MAX_TASK_AGENT_CRASH_RETRIES, the node execution is
	 * escalated to `blocked`. Below the limit, execution is reset to `pending` for
	 * re-spawn to tolerate transient startup failures.
	 *
	 * Reset contract: this map is in-memory only and starts empty on every daemon restart.
	 */
	private taskCrashCounts = new Map<string, number>();

	/**
	 * In-memory retry counter per workflow run ID.
	 *
	 * Tracks how many times a blocked run has been automatically recovered by
	 * resetting its blocked executions to `pending`. When the count reaches
	 * MAX_BLOCKED_RUN_RETRIES, the run stays blocked and a
	 * `workflow_run_needs_attention` event is emitted instead.
	 *
	 * Reset contract: in-memory only, starts empty on every daemon restart.
	 */
	private blockedRetryCounts = new Map<string, number>();

	/** In-memory store of resolved channels per run ID. Replaces run.config._resolvedChannels. */
	private workflowChannelsMap = new Map<string, WorkflowChannel[]>();

	constructor(private config: SpaceRuntimeConfig) {
		this.notificationSink = config.notificationSink ?? new NullNotificationSink();
		this.completionDetector =
			config.completionDetector ?? new CompletionDetector(config.nodeExecutionRepo);
	}

	/**
	 * Returns the current dedup set snapshot for testing purposes.
	 *
	 * The returned Set is a copy — mutations have no effect on SpaceRuntime's
	 * internal state.  Call this before and after a tick to verify that dedup
	 * entries are added / removed as expected.
	 *
	 * @internal — exposed only for unit tests in the same package.
	 */
	getNotifiedTaskSet(): ReadonlySet<string> {
		return new Set(this.notifiedTaskSet);
	}

	/**
	 * Replace the notification sink at runtime.
	 *
	 * Called after construction once the Space Agent session has been provisioned,
	 * since SpaceRuntimeService is instantiated before the global agent session exists.
	 */
	setNotificationSink(sink: NotificationSink): void {
		this.notificationSink = sink;
		// Clear the dedup set so tasks that fired on NullNotificationSink before the real
		// sink was wired (e.g. ticks that ran before provisioning completed at daemon startup)
		// get a chance to re-notify on the next tick.
		this.notifiedTaskSet.clear();
	}

	/**
	 * Wire a TaskAgentManager into the runtime after construction.
	 *
	 * Called after construction to resolve the circular dependency:
	 * SpaceRuntimeService is created first (so TaskAgentManager can reference it),
	 * then TaskAgentManager is created, then it is injected back here.
	 */
	setTaskAgentManager(manager: TaskAgentManager): void {
		this.config.taskAgentManager = manager;
	}

	/**
	 * Safely calls notificationSink.notify(), catching and logging any errors.
	 *
	 * By interface contract, NotificationSink implementations should handle their
	 * own errors internally (see SessionNotificationSink). However, to prevent a
	 * poorly-written or custom sink from crashing the tick loop, SpaceRuntime
	 * wraps all notify() calls in this guard.
	 *
	 * Errors are logged at warn level and the tick continues normally.
	 */
	private async safeNotify(event: Parameters<NotificationSink['notify']>[0]): Promise<void> {
		try {
			await this.notificationSink.notify(event);
		} catch (err) {
			log.warn(
				`[SpaceRuntime] NotificationSink.notify() threw for event "${event.kind}": ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	private async safeOnTaskUpdated(spaceId: string, task: SpaceTask): Promise<void> {
		const handler = this.config.onTaskUpdated;
		if (!handler) return;
		try {
			await handler({ spaceId, task });
		} catch (err) {
			log.warn(
				`[SpaceRuntime] onTaskUpdated threw for task "${task.id}": ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	private async safeOnWorkflowRunCreated(spaceId: string, run: SpaceWorkflowRun): Promise<void> {
		const handler = this.config.onWorkflowRunCreated;
		if (!handler) return;
		try {
			await handler({ spaceId, run });
		} catch (err) {
			log.warn(
				`[SpaceRuntime] onWorkflowRunCreated threw for run "${run.id}": ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	private async safeOnWorkflowRunUpdated(spaceId: string, run: SpaceWorkflowRun): Promise<void> {
		const handler = this.config.onWorkflowRunUpdated;
		if (!handler) return;
		try {
			await handler({ spaceId, run });
		} catch (err) {
			log.warn(
				`[SpaceRuntime] onWorkflowRunUpdated threw for run "${run.id}": ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	private async updateTaskAndEmit(
		spaceId: string,
		taskId: string,
		params: UpdateSpaceTaskParams
	): Promise<SpaceTask | null> {
		const updated = this.config.taskRepo.updateTask(taskId, params);
		if (updated) {
			await this.safeOnTaskUpdated(spaceId, updated);
		}
		return updated;
	}

	private async transitionRunStatusAndEmit(
		runId: string,
		nextStatus: SpaceWorkflowRun['status']
	): Promise<SpaceWorkflowRun> {
		const updated = this.config.workflowRunRepo.transitionStatus(runId, nextStatus);
		await this.safeOnWorkflowRunUpdated(updated.spaceId, updated);
		return updated;
	}

	/**
	 * Choose the canonical task for a workflow run in one-task-per-run mode.
	 *
	 * Preference:
	 * 1. Title exactly matches run title (case-insensitive, trimmed)
	 * 2. Lowest task number
	 * 3. Earliest created_at
	 */
	private pickCanonicalTaskForRun(run: SpaceWorkflowRun, runTasks: SpaceTask[]): SpaceTask | null {
		if (runTasks.length === 0) return null;

		const normalize = (value: string | null | undefined): string =>
			(value ?? '').trim().toLowerCase();
		const runTitle = normalize(run.title);
		const titleMatches = runTasks.filter((task) => normalize(task.title) === runTitle);
		const pool = titleMatches.length > 0 ? titleMatches : runTasks;

		const sorted = [...pool].sort((a, b) => {
			if (a.taskNumber !== b.taskNumber) return a.taskNumber - b.taskNumber;
			if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
			return a.id.localeCompare(b.id);
		});

		return sorted[0] ?? null;
	}

	/**
	 * Archive non-canonical run tasks and detach them from the run.
	 *
	 * This is a strict one-task-per-run repair path that removes legacy/duplicate
	 * per-node tasks from active workflow state.
	 */
	private async archiveDuplicateRunTasks(
		spaceId: string,
		run: SpaceWorkflowRun,
		canonicalTask: SpaceTask,
		runTasks: SpaceTask[],
		reason: 'active_run' | 'terminal_reconcile'
	): Promise<void> {
		const duplicates = runTasks.filter((task) => task.id !== canonicalTask.id);
		if (duplicates.length === 0) return;

		log.warn(
			`SpaceRuntime: run ${run.id} has ${runTasks.length} tasks; archiving ${duplicates.length} duplicate task(s) in ${reason} repair`
		);

		const now = Date.now();
		for (const duplicate of duplicates) {
			if (duplicate.taskAgentSessionId && this.config.taskAgentManager) {
				this.config.taskAgentManager.cancelBySessionId(duplicate.taskAgentSessionId);
			}

			await this.updateTaskAndEmit(spaceId, duplicate.id, {
				status: 'archived',
				archivedAt: duplicate.archivedAt ?? now,
				completedAt: duplicate.completedAt ?? now,
				workflowRunId: null,
				taskAgentSessionId: null,
			});

			this.notifiedTaskSet.delete(`${duplicate.id}:blocked`);
			this.notifiedTaskSet.delete(`${duplicate.id}:timeout`);
		}
	}

	/**
	 * Reconcile task state for a terminal workflow run.
	 *
	 * Ensures:
	 * - exactly one canonical task remains attached to the run
	 * - canonical task status mirrors run status
	 */
	private async reconcileTerminalRunTasks(run: SpaceWorkflowRun): Promise<void> {
		const runTasks = this.config.taskRepo.listByWorkflowRun(run.id);
		if (runTasks.length === 0) return;

		const canonicalTask = this.pickCanonicalTaskForRun(run, runTasks);
		if (!canonicalTask) return;

		if (runTasks.length > 1) {
			await this.archiveDuplicateRunTasks(
				run.spaceId,
				run,
				canonicalTask,
				runTasks,
				'terminal_reconcile'
			);
		}

		if (run.status === 'done') {
			const workflow =
				this.executorMeta.get(run.id)?.workflow ??
				this.config.spaceWorkflowManager.getWorkflow(run.workflowId) ??
				null;
			const summaryFromWorkflow = workflow
				? this.resolveCompletionSummary(run.id, workflow)
				: undefined;
			const summaryFromSibling = runTasks
				.filter((task) => task.id !== canonicalTask.id)
				.find((task) => !!task.result)?.result;
			const nextResult = summaryFromWorkflow ?? canonicalTask.result ?? summaryFromSibling ?? null;

			// In supervised mode, the task should land in 'review' (not 'done')
			// so a human can approve. Skip if already in 'review' or 'done'.
			const space = await this.config.spaceManager.getSpace(run.spaceId);
			const isSupervised = !space?.autonomyLevel || space.autonomyLevel === 'supervised';
			const completionStatus = isSupervised ? 'review' : 'done';

			if (canonicalTask.status !== 'done' && canonicalTask.status !== 'review') {
				await this.updateTaskAndEmit(run.spaceId, canonicalTask.id, {
					status: completionStatus,
					result: nextResult,
					completedAt: isSupervised
						? null
						: (canonicalTask.completedAt ?? run.completedAt ?? Date.now()),
				});
			} else if (nextResult && canonicalTask.result !== nextResult) {
				await this.updateTaskAndEmit(run.spaceId, canonicalTask.id, { result: nextResult });
			}
			return;
		}

		if (run.status === 'cancelled' && canonicalTask.status !== 'cancelled') {
			await this.updateTaskAndEmit(run.spaceId, canonicalTask.id, {
				status: 'cancelled',
				completedAt: canonicalTask.completedAt ?? run.completedAt ?? Date.now(),
			});
		}
	}

	/**
	 * Reconcile terminal runs that are not in the executor map (already cleaned up).
	 *
	 * This keeps task state consistent after daemon restarts and repairs legacy runs
	 * where external paths marked the run terminal but left task state inconsistent.
	 */
	private async reconcileTerminalRunsWithoutExecutors(): Promise<void> {
		const spaces = await this.config.spaceManager.listSpaces(false);
		for (const space of spaces) {
			const terminalRuns = this.config.workflowRunRepo
				.listBySpace(space.id)
				.filter((run) => run.status === 'done' || run.status === 'cancelled');
			for (const run of terminalRuns) {
				if (this.executors.has(run.id)) continue;
				await this.reconcileTerminalRunTasks(run);
			}
		}
	}

	// -------------------------------------------------------------------------
	// Lifecycle — start / stop
	// -------------------------------------------------------------------------

	/**
	 * Starts the periodic tick loop.
	 * Calls executeTick() immediately and then every `tickIntervalMs` ms.
	 * Errors from executeTick() are caught and logged so the loop keeps running.
	 */
	start(): void {
		if (this.tickTimer !== null) return; // already running

		const interval = this.config.tickIntervalMs ?? 5_000;

		// Kick off the first tick immediately, then schedule the loop.
		this.executeTick().catch((err: unknown) => {
			log.error('SpaceRuntime: initial tick failed:', err);
		});

		this.tickTimer = setInterval(() => {
			this.executeTick().catch((err: unknown) => {
				log.error('SpaceRuntime: tick failed:', err);
			});
		}, interval);
	}

	/**
	 * Stops the periodic tick loop and waits for any in-flight tick to complete.
	 *
	 * This prevents race conditions during shutdown where an in-flight tick
	 * continues to perform DB operations after the database has been closed.
	 *
	 * Does not affect in-progress executors — they remain in the map and can
	 * be resumed by calling start() again.
	 */
	async stop(): Promise<void> {
		if (this.tickTimer !== null) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		// Wait for any in-flight executeTick() to finish so that all DB
		// reads/writes and DaemonHub event emissions complete before the
		// caller proceeds to close the database.
		if (this.tickInFlight) {
			const MAX_TICK_DRAIN_MS = 30_000;
			const start = Date.now();
			await new Promise<void>((resolve) => {
				const check = () => {
					if (!this.tickInFlight) {
						resolve();
					} else if (Date.now() - start > MAX_TICK_DRAIN_MS) {
						log.warn(
							`SpaceRuntime: timed out waiting for in-flight tick after ${MAX_TICK_DRAIN_MS}ms — proceeding with shutdown`
						);
						resolve();
					} else {
						// 10 ms balances low latency (fast shutdown) against
						// CPU churn (no busy-spin) during the drain window.
						setTimeout(check, 10);
					}
				};
				check();
			});
		}
	}

	// -------------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------------

	/**
	 * Main tick method — call on a regular interval.
	 *
	 * On the first call, rehydrateExecutors() loads all in-progress workflow
	 * runs from the DB into the executors map.
	 *
	 * On every call:
	 * 1. Processes completed tasks and advances their workflows
	 * 2. Cleans up executors for runs that have reached a terminal state
	 * 3. Checks standalone tasks (no workflowRunId) for blocked and timeout
	 */
	async executeTick(): Promise<void> {
		if (this.tickInFlight) return;
		this.tickInFlight = true;
		try {
			if (!this.rehydrated) {
				await this.rehydrateExecutors();
				this.rehydrated = true;
			}

			await this.attachStandaloneTasksToWorkflows();
			await this.processCompletedTasks();
			await this.cleanupTerminalExecutors();
			await this.reconcileTerminalRunsWithoutExecutors();
			await this.checkStandaloneTasks();
		} finally {
			this.tickInFlight = false;
		}
	}

	/**
	 * Start a new workflow run for the given space and workflow.
	 *
	 * Flow:
	 * 1. Load the workflow definition
	 * 2. Create a SpaceWorkflowRun record (status: in_progress)
	 * 3. Create a WorkflowExecutor and register it in the executors map
	 * 4. Ensure one canonical SpaceTask exists for the run
	 * 5. Create pending node_execution rows for the start node
	 *
	 * Returns the created run and its canonical task.
	 * Cleans up maps if task/execution creation fails to prevent orphaned executor entries.
	 */
	async startWorkflowRun(
		spaceId: string,
		workflowId: string,
		title: string,
		description?: string,
		options: StartWorkflowRunOptions = {}
	): Promise<{ run: SpaceWorkflowRun; tasks: SpaceTask[] }> {
		const workflow = this.config.spaceWorkflowManager.getWorkflow(workflowId);
		if (!workflow) {
			throw new Error(`Workflow not found: ${workflowId}`);
		}
		if (!workflow.endNodeId) {
			throw new Error(`Workflow "${workflowId}" is missing endNodeId and cannot be executed.`);
		}

		const space = await this.config.spaceManager.getSpace(spaceId);
		if (!space) {
			throw new Error(`Space not found: ${spaceId}`);
		}

		// Create the run record — starts as 'pending', immediately promoted to 'in_progress'
		const pendingRun = this.config.workflowRunRepo.createRun({
			spaceId,
			workflowId,
			title,
			description,
		});

		const run = this.config.workflowRunRepo.transitionStatus(pendingRun.id, 'in_progress');
		await this.safeOnWorkflowRunCreated(spaceId, run);

		// Register executor and meta. If a later step fails, we must clean these up.
		const meta: ExecutorMeta = { workflow, spaceId, workspacePath: space.workspacePath };
		this.executorMeta.set(run.id, meta);
		const executor = this.buildExecutor(workflow, run, spaceId, space.workspacePath);
		this.executors.set(run.id, executor);

		// Find start node and ensure canonical run task. Roll back map entries if this fails.
		const startStep = workflow.nodes.find((s) => s.id === workflow.startNodeId);
		if (!startStep) {
			this.executors.delete(run.id);
			this.executorMeta.delete(run.id);
			await this.transitionRunStatusAndEmit(run.id, 'cancelled');
			throw new Error(`Start node "${workflow.startNodeId}" not found in workflow "${workflowId}"`);
		}

		const taskManager = this.getOrCreateTaskManager(spaceId);
		let canonicalTask: SpaceTask | null = null;
		let startAgents: ReturnType<typeof resolveNodeAgents>;
		try {
			// One run == one task. Reuse a provided parent task when available,
			// otherwise create a new canonical task for this run.
			if (options.parentTaskId) {
				const parent = this.config.taskRepo.getTask(options.parentTaskId);
				if (!parent) {
					throw new Error(`Parent task not found: ${options.parentTaskId}`);
				}
				if (parent.spaceId !== spaceId) {
					throw new Error(
						`Parent task ${options.parentTaskId} belongs to a different space (${parent.spaceId})`
					);
				}
				canonicalTask = await this.updateTaskAndEmit(spaceId, parent.id, {
					workflowRunId: run.id,
				});
			} else {
				canonicalTask = await taskManager.createTask({
					title,
					description: description ?? '',
					workflowRunId: run.id,
					status: 'open',
				});
			}
			if (!canonicalTask) {
				throw new Error(`Failed to initialize canonical task for run ${run.id}`);
			}
			await this.safeOnTaskUpdated(spaceId, canonicalTask);

			startAgents = resolveNodeAgents(startStep);
			for (const agentEntry of startAgents) {
				this.config.nodeExecutionRepo.createOrIgnore({
					workflowRunId: run.id,
					workflowNodeId: startStep.id,
					agentName: agentEntry.name,
					agentId: agentEntry.agentId ?? null,
					status: 'pending',
				});
			}
		} catch (err) {
			// Clean up the executor/meta entries so the run is not orphaned in the map.
			this.executors.delete(run.id);
			this.executorMeta.delete(run.id);
			// Cancel the DB run record so rehydrateExecutors() does not silently loop
			// over it on next server restart (an in_progress run with no tasks would
			// sit in the executor map indefinitely, never advancing and never erroring).
			await this.transitionRunStatusAndEmit(run.id, 'cancelled');
			throw err;
		}

		// Resolve channel topology for the start node and store in run config.
		// TODO: Milestone 6: pass resolvedChannels to session group creation in
		// TaskAgentManager.spawnTaskAgent() rather than storing in run config.
		this.storeWorkflowChannels(run.id, workflow.channels ?? []);

		return { run, tasks: canonicalTask ? [canonicalTask] : [] };
	}

	/**
	 * Resolve a workflow for a new run from an explicit workflowId.
	 *
	 * Returns the workflow if found in this space's workflows, or null when:
	 *   - No workflowId is provided (LLM agent must call list_workflows first)
	 *   - The provided workflowId is not found in this space
	 *
	 * This is a thin integration point: it loads the space's workflows from the
	 * DB and delegates to the pure `selectWorkflow()` function.
	 */
	resolveWorkflowForRun(spaceId: string, workflowId?: string): SpaceWorkflow | null {
		const availableWorkflows = this.config.spaceWorkflowManager.listWorkflows(spaceId);
		return selectWorkflow({ spaceId, availableWorkflows, workflowId });
	}

	/**
	 * Returns the WorkflowExecutor for a given run ID, or undefined if not tracked.
	 * Useful for testing and external inspection.
	 */
	getExecutor(runId: string): WorkflowExecutor | undefined {
		return this.executors.get(runId);
	}

	/**
	 * Returns the number of executors currently tracked (active runs).
	 */
	get executorCount(): number {
		return this.executors.size;
	}

	// -------------------------------------------------------------------------
	// Private — rehydration
	// -------------------------------------------------------------------------

	/**
	 * Rehydrates WorkflowExecutors from the DB for all in-progress workflow runs,
	 * then rehydrates Task Agent sessions if a TaskAgentManager is configured.
	 *
	 * Called once at the start of the first executeTick(). Reconstructs
	 * executors with the run's persisted currentNodeId so the tick loop can
	 * resume advancement from where it left off.
	 *
	 * Executor rehydration runs first so that SpaceRuntimeService executors are
	 * ready when Task Agents try to use them via their MCP tools.
	 *
	 * Runs that reference a missing workflow are skipped silently.
	 */
	async rehydrateExecutors(): Promise<void> {
		const spaces = await this.config.spaceManager.listSpaces(false);

		for (const space of spaces) {
			// getRehydratableRuns returns 'in_progress' AND 'blocked' runs.
			// 'pending' is still excluded — it's transient (task creation may have failed).
			// 'blocked' runs are included so a human-gate-blocked run gets its
			// executor reloaded on restart, allowing it to advance once the gate is resolved.
			const activeRuns = this.config.workflowRunRepo.getRehydratableRuns(space.id);

			for (const run of activeRuns) {
				// Skip if executor already registered (e.g. called twice)
				if (this.executors.has(run.id)) continue;

				const workflow = this.config.spaceWorkflowManager.getWorkflow(run.workflowId);
				if (!workflow) {
					// Workflow was deleted while a run was in-progress — skip silently.
					// The run will remain in_progress in the DB; it will need manual cleanup.
					continue;
				}

				const meta: ExecutorMeta = {
					workflow,
					spaceId: space.id,
					workspacePath: space.workspacePath,
				};
				this.executorMeta.set(run.id, meta);

				const executor = this.buildExecutor(workflow, run, space.id, space.workspacePath);
				this.executors.set(run.id, executor);
			}
		}

		// Rehydrate Task Agent sessions after executors are ready.
		// Executors must be loaded first so Task Agents can use MCP tools
		// that rely on the SpaceRuntimeService executor map.
		if (this.config.taskAgentManager) {
			await this.config.taskAgentManager.rehydrate();
		}
	}

	// -------------------------------------------------------------------------
	// Private — tick helpers
	// -------------------------------------------------------------------------

	/**
	 * For each active executor, processes the current node's tasks:
	 * - Detects blocked and timeout conditions
	 * - Spawns Task Agent sessions for pending tasks
	 * - Monitors agent liveness and resets dead agents
	 *
	 * Agents drive workflow progression themselves via send_message and report_done.
	 * This method never calls advance() directly.
	 *
	 * Errors from individual runs are caught and re-thrown after all runs have
	 * been processed, so a single bad run cannot starve subsequent ones.
	 */
	private async processCompletedTasks(): Promise<void> {
		let firstError: unknown = null;

		for (const [runId] of this.executors) {
			try {
				await this.processRunTick(runId);
			} catch (err) {
				// Capture first unexpected error; continue processing remaining runs.
				if (firstError === null) firstError = err;
			}
		}

		// Re-throw after all runs processed so callers see the error.
		if (firstError !== null) throw firstError;
	}

	/**
	 * Process a single workflow run tick: re-read from DB, recreate executor
	 * with fresh state, detect issues, and spawn/monitor Task Agent sessions.
	 */
	private async processRunTick(runId: string): Promise<void> {
		// Always re-read run from DB to pick up external status changes (e.g. human
		// approval reset, external cancellation).
		const run = this.config.workflowRunRepo.getRun(runId);
		if (!run) return;
		if (run.status === 'cancelled' || run.status === 'done') {
			return;
		}

		// Blocked run recovery: attempt bounded automatic retry before giving up.
		if (run.status === 'blocked') {
			await this.attemptBlockedRunRecovery(runId, run);
			return;
		}

		// In the agent-centric model, agents activate nodes themselves via activateNode().
		// The tick loop processes node_executions for the run while keeping exactly
		// one canonical task as the user-facing envelope.
		const meta = this.executorMeta.get(runId);
		if (!meta) return;

		// One run should have exactly one canonical task.
		const allRunTasks = this.config.taskRepo.listByWorkflowRun(runId);
		if (allRunTasks.length === 0) return;

		let canonicalTask = this.pickCanonicalTaskForRun(run, allRunTasks);
		if (!canonicalTask) return;
		if (allRunTasks.length > 1) {
			await this.archiveDuplicateRunTasks(
				meta.spaceId,
				run,
				canonicalTask,
				allRunTasks,
				'active_run'
			);
		}
		if (canonicalTask.workflowRunId !== runId) {
			const refreshed = await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, {
				workflowRunId: runId,
			});
			canonicalTask = refreshed ?? canonicalTask;
		}

		if (!meta.workflow.endNodeId) {
			await this.transitionRunStatusAndEmit(runId, 'blocked');
			if (canonicalTask.status !== 'blocked') {
				await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, {
					status: 'blocked',
					result: 'Workflow is missing endNodeId and cannot be executed safely.',
					completedAt: null,
				});
			}
			await this.safeNotify({
				kind: 'workflow_run_blocked',
				spaceId: meta.spaceId,
				runId,
				reason: 'Workflow is missing endNodeId',
				timestamp: new Date().toISOString(),
			});
			return;
		}

		let nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);
		if (nodeExecutions.length === 0) return;

		// Refresh dedup entries for this run's canonical task.
		if (canonicalTask.status !== 'blocked') {
			this.notifiedTaskSet.delete(`${canonicalTask.id}:blocked`);
		}
		if (canonicalTask.status !== 'in_progress') {
			this.notifiedTaskSet.delete(`${canonicalTask.id}:timeout`);
		}

		// ─── End-node bypass ─────────────────────────────────────────────────
		// When the workflow has an endNodeId and the end node's execution is
		// terminal (done/cancelled), skip blocked/timeout notifications for
		// sibling nodes and proceed directly to completion handling.
		// This prevents spurious "task_blocked" notifications for nodes that
		// are still running when the end node finishes first.
		const endNodeId = meta.workflow.endNodeId;
		let endNodeBypass = false;
		if (endNodeId) {
			const endNodeExecs = nodeExecutions.filter((e) => e.workflowNodeId === endNodeId);
			if (
				endNodeExecs.length > 0 &&
				endNodeExecs.every((e) => TERMINAL_NODE_EXECUTION_STATUSES.has(e.status))
			) {
				endNodeBypass = true;
			}
		}

		// Detect execution-level blocked BEFORE the all-completed guard.
		// When end-node bypass fires, skip blocked notifications for siblings
		// — the run will be completed imminently.
		if (!endNodeBypass && nodeExecutions.some((execution) => execution.status === 'blocked')) {
			const blockedReason =
				nodeExecutions.find((execution) => execution.status === 'blocked')?.result ??
				'One or more workflow agents are blocked';
			const dedupKey = `${canonicalTask.id}:blocked`;
			if (!this.notifiedTaskSet.has(dedupKey)) {
				this.notifiedTaskSet.add(dedupKey);
				await this.safeNotify({
					kind: 'task_blocked',
					spaceId: meta.spaceId,
					taskId: canonicalTask.id,
					reason: blockedReason,
					timestamp: new Date().toISOString(),
				});
			}

			await this.transitionRunStatusAndEmit(runId, 'blocked');
			if (canonicalTask.status !== 'blocked') {
				await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, {
					status: 'blocked',
					result: blockedReason,
					completedAt: null,
				});
			}
			await this.safeNotify({
				kind: 'workflow_run_blocked',
				spaceId: meta.spaceId,
				runId,
				reason: 'One or more tasks require attention',
				timestamp: new Date().toISOString(),
			});

			return;
		}

		// Timeout detection: check in_progress tasks against Space.config.taskTimeoutMs.
		// Skip when end-node bypass is active — the run is completing imminently.
		const space = await this.config.spaceManager.getSpace(meta.spaceId);
		if (!endNodeBypass) {
			const taskTimeoutMs = space?.config?.taskTimeoutMs;
			if (taskTimeoutMs !== undefined) {
				const now = Date.now();
				const timedOutExecutions = nodeExecutions.filter((execution) => {
					if (execution.status !== 'in_progress' || !execution.startedAt) return false;
					return now - execution.startedAt > taskTimeoutMs;
				});
				const dedupKey = `${canonicalTask.id}:timeout`;
				if (timedOutExecutions.length === 0) {
					this.notifiedTaskSet.delete(dedupKey);
				} else if (!this.notifiedTaskSet.has(dedupKey)) {
					const elapsedMs = Math.max(
						...timedOutExecutions.map((execution) => now - (execution.startedAt ?? now))
					);
					this.notifiedTaskSet.add(dedupKey);
					await this.safeNotify({
						kind: 'task_timeout',
						spaceId: meta.spaceId,
						taskId: canonicalTask.id,
						elapsedMs,
						timestamp: new Date().toISOString(),
					});
				}
			}
		}

		// ─── Task Agent integration ───────────────────────────────────────────────
		// When a TaskAgentManager is configured, Task Agents drive the workflow.
		// SpaceRuntime's role here is lifecycle management only: spawn for pending
		// tasks, check liveness, and recover from crashes. Agents drive progression
		// themselves via send_message and report_done — SpaceRuntime never calls advance().
		if (this.config.taskAgentManager) {
			const tam = this.config.taskAgentManager;
			let blockedByCrash = false;

			// Step 1: Check workflow-node agent liveness by NodeExecution.sessionId.
			for (const execution of nodeExecutions) {
				if (
					!execution.agentSessionId ||
					(execution.status !== 'in_progress' && execution.status !== 'pending')
				) {
					continue;
				}

				if (tam.isSessionAlive(execution.agentSessionId)) {
					continue;
				}

				const crashKey = `${runId}:${execution.id}`;
				const crashCount = (this.taskCrashCounts.get(crashKey) ?? 0) + 1;
				this.taskCrashCounts.set(crashKey, crashCount);

				if (crashCount <= MAX_TASK_AGENT_CRASH_RETRIES) {
					log.warn(
						`SpaceRuntime: workflow node agent crashed for execution ${execution.id} ` +
							`(session ${execution.agentSessionId}); resetting execution to pending ` +
							`(crash ${crashCount}/${MAX_TASK_AGENT_CRASH_RETRIES})`
					);
					this.config.nodeExecutionRepo.update(execution.id, {
						agentSessionId: null,
						status: 'pending',
					});
				} else {
					log.warn(
						`SpaceRuntime: workflow node agent crashed for execution ${execution.id} ` +
							`(session ${execution.agentSessionId}); marking blocked ` +
							`after ${crashCount} crashes (limit: ${MAX_TASK_AGENT_CRASH_RETRIES})`
					);
					this.config.nodeExecutionRepo.update(execution.id, {
						agentSessionId: null,
						status: 'blocked',
						result: `Agent session crashed ${crashCount} times consecutively`,
					});
					blockedByCrash = true;
					await this.safeNotify({
						kind: 'agent_crash',
						spaceId: meta.spaceId,
						taskId: canonicalTask.id,
						timestamp: new Date().toISOString(),
					});
				}
			}

			nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);

			if (blockedByCrash) {
				const blockedReason =
					nodeExecutions.find((execution) => execution.status === 'blocked')?.result ??
					'One or more workflow agents are blocked';
				const dedupKey = `${canonicalTask.id}:blocked`;
				if (!this.notifiedTaskSet.has(dedupKey)) {
					this.notifiedTaskSet.add(dedupKey);
					await this.safeNotify({
						kind: 'task_blocked',
						spaceId: meta.spaceId,
						taskId: canonicalTask.id,
						reason: blockedReason,
						timestamp: new Date().toISOString(),
					});
				}
				await this.transitionRunStatusAndEmit(runId, 'blocked');
				if (canonicalTask.status !== 'blocked') {
					await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, {
						status: 'blocked',
						result: blockedReason,
						completedAt: null,
					});
				}
				await this.safeNotify({
					kind: 'workflow_run_blocked',
					spaceId: meta.spaceId,
					runId,
					reason: 'One or more tasks require attention',
					timestamp: new Date().toISOString(),
				});
				return;
			}

			// Step 1.5: Auto-complete alive agents that never call report_done.
			let autoCompleted = 0;
			const now = Date.now();
			for (const execution of nodeExecutions) {
				if (execution.status !== 'in_progress' || !execution.agentSessionId) continue;
				if (!tam.isSessionAlive(execution.agentSessionId)) continue;

				const timeoutMs = resolveNodeTimeout(execution.agentName ?? 'general');
				const referenceTime = execution.startedAt ?? execution.createdAt;
				const elapsedMs = now - referenceTime;
				if (elapsedMs <= timeoutMs) continue;

				const timeoutMinutes = Math.round(timeoutMs / 60_000);
				this.config.nodeExecutionRepo.update(execution.id, {
					status: 'done',
					result: `Auto-completed: agent did not call report_done within ${timeoutMinutes} minutes`,
				});
				await this.safeNotify({
					kind: 'agent_auto_completed',
					spaceId: meta.spaceId,
					taskId: canonicalTask.id,
					elapsedMs,
					timestamp: new Date().toISOString(),
				});
				autoCompleted++;
			}
			if (autoCompleted > 0) {
				log.warn(
					`SpaceRuntime: auto-completed ${autoCompleted} stuck node agent(s) for run ${runId}`
				);
			}

			nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);

			// Step 1.6: Completion detection.
			if (
				this.completionDetector.isComplete({
					workflowRunId: runId,
					endNodeId: meta.workflow.endNodeId,
				})
			) {
				await this.transitionRunStatusAndEmit(runId, 'done');
				const summary = this.resolveCompletionSummary(runId, meta.workflow);
				const nextTaskResult = summary ?? canonicalTask.result ?? null;

				// In supervised mode, transition the task to 'review' so a human
				// can approve the output before it's marked done. In
				// semi_autonomous mode, go directly to 'done'.
				const isSupervised = !space?.autonomyLevel || space.autonomyLevel === 'supervised';
				const completionStatus = isSupervised ? 'review' : 'done';

				if (canonicalTask.status !== 'done' && canonicalTask.status !== 'review') {
					await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, {
						status: completionStatus,
						result: nextTaskResult,
						completedAt: isSupervised ? null : Date.now(),
					});
				} else if (summary && canonicalTask.result !== summary) {
					await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, { result: summary });
				}

				// Sibling NodeExecution cleanup: cancel siblings still in_progress
				// when the run completes via end-node short-circuit. For each
				// in_progress node execution with an agentSessionId, cancel the
				// corresponding agent session via TaskAgentManager.
				const siblingsToCancel = this.config.nodeExecutionRepo
					.listByWorkflowRun(runId)
					.filter(
						(e) =>
							e.status === 'in_progress' &&
							e.agentSessionId &&
							(!endNodeId || e.workflowNodeId !== endNodeId)
					);
				for (const sibling of siblingsToCancel) {
					this.config.nodeExecutionRepo.updateStatus(sibling.id, 'cancelled');
					if (this.config.taskAgentManager) {
						this.config.taskAgentManager.cancelBySessionId(sibling.agentSessionId!);
					}
					log.info(
						`SpaceRuntime: cancelled sibling node execution ${sibling.id} ` +
							`(node ${sibling.workflowNodeId}, agent ${sibling.agentName}) ` +
							`for completed run ${runId}`
					);
				}

				return;
			}

			// Step 2: Spawn workflow node agents for pending executions without sessions.
			nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);
			const pendingExecutions = nodeExecutions.filter(
				(execution) => execution.status === 'pending' && !execution.agentSessionId
			);

			if (pendingExecutions.length > 0) {
				if (!space) {
					log.warn(
						`SpaceRuntime: cannot spawn workflow node agents for run ${runId} — space ${meta.spaceId} not found`
					);
				} else {
					for (const execution of pendingExecutions) {
						if (tam.isExecutionSpawning(execution.id)) continue;
						try {
							const sessionId = await tam.spawnWorkflowNodeAgentForExecution(
								canonicalTask,
								space,
								meta.workflow,
								run,
								execution,
								{
									kickoff: true,
								}
							);
							this.config.nodeExecutionRepo.update(execution.id, {
								status: 'in_progress',
								agentSessionId: sessionId,
							});
						} catch (err) {
							const stale = this.config.nodeExecutionRepo.getById(execution.id);
							if (stale?.agentSessionId) {
								tam.cancelBySessionId(stale.agentSessionId);
								this.config.nodeExecutionRepo.update(execution.id, {
									agentSessionId: null,
									status: 'pending',
									result: null,
								});
							}
							log.error(
								`SpaceRuntime: failed to spawn workflow node agent for execution ${execution.id}:`,
								err
							);
						}
					}
					if (canonicalTask.status === 'open') {
						const nowTs = Date.now();
						await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, {
							status: 'in_progress',
							startedAt: canonicalTask.startedAt ?? nowTs,
							completedAt: null,
						});
					}
				}
			}

			// Agents drive workflow progression via send_message and report_done.
			return;
		}
	}

	/**
	 * Attempt automatic recovery for a blocked workflow run.
	 *
	 * Tier 1 — Re-trigger: Reset blocked node executions to `pending` and
	 * transition the run back to `in_progress` so the runtime re-spawns
	 * agents on the next tick.
	 *
	 * Tier 2 — Escalate: When retries are exhausted, emit a
	 * `workflow_run_needs_attention` event to the Space Agent for
	 * human/agent escalation.
	 */
	private async attemptBlockedRunRecovery(runId: string, run: SpaceWorkflowRun): Promise<void> {
		const meta = this.executorMeta.get(runId);
		if (!meta) return;

		const allRunTasks = this.config.taskRepo.listByWorkflowRun(runId);
		if (allRunTasks.length === 0) return;
		const canonicalTask = this.pickCanonicalTaskForRun(run, allRunTasks);
		if (!canonicalTask) return;

		const retryCount = this.blockedRetryCounts.get(runId) ?? 0;
		const blockedExecutions = this.config.nodeExecutionRepo
			.listByWorkflowRun(runId)
			.filter((e) => e.status === 'blocked');

		if (blockedExecutions.length === 0) return;

		const blockedReason = blockedExecutions[0].result ?? 'Unknown blocked reason';

		if (retryCount < MAX_BLOCKED_RUN_RETRIES) {
			// Tier 1: Reset blocked executions and resume the run.
			for (const execution of blockedExecutions) {
				this.config.nodeExecutionRepo.update(execution.id, {
					agentSessionId: null,
					status: 'pending',
					result: null,
				});
			}
			this.blockedRetryCounts.set(runId, retryCount + 1);

			// Transition run back to in_progress for the next tick to pick up.
			await this.transitionRunStatusAndEmit(runId, 'in_progress');
			if (canonicalTask.status === 'blocked') {
				await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, {
					status: 'in_progress',
					completedAt: null,
				});
			}

			// Clear dedup so a re-block can be notified again.
			this.notifiedTaskSet.delete(`${canonicalTask.id}:blocked`);

			await this.safeNotify({
				kind: 'task_retry',
				spaceId: meta.spaceId,
				taskId: canonicalTask.id,
				runId,
				originalReason: blockedReason,
				attemptNumber: retryCount + 1,
				maxAttempts: MAX_BLOCKED_RUN_RETRIES,
				timestamp: new Date().toISOString(),
			});
			log.info(
				`SpaceRuntime: auto-retrying blocked run ${runId} ` +
					`(attempt ${retryCount + 1}/${MAX_BLOCKED_RUN_RETRIES})`
			);
		} else {
			// Tier 2: Retries exhausted — escalate to Space Agent.
			await this.safeNotify({
				kind: 'workflow_run_needs_attention',
				spaceId: meta.spaceId,
				runId,
				taskId: canonicalTask.id,
				reason: blockedReason,
				retriesExhausted: retryCount,
				timestamp: new Date().toISOString(),
			});
			log.warn(
				`SpaceRuntime: blocked run ${runId} exhausted ${retryCount} retries, ` +
					`emitted workflow_run_needs_attention`
			);
		}
	}

	/**
	 * Finds a completion summary from terminal node executions in a completed run.
	 *
	 * Strategy:
	 * 1. Find terminal node IDs — workflow nodes with no outbound channel.
	 * 2. Scan node_executions for those nodes.
	 * 3. Return the first non-empty execution result.
	 */
	private resolveCompletionSummary(runId: string, workflow: SpaceWorkflow): string | undefined {
		const channels = workflow.channels ?? [];
		const nodes = workflow.nodes;

		// Build name → nodeId map: node names and per-node agent slot names both resolve
		// to the containing node's UUID.
		const nameToNodeId = new Map<string, string>();
		for (const node of nodes) {
			nameToNodeId.set(node.name, node.id);
			if (node.agents) {
				for (const agent of node.agents) {
					nameToNodeId.set(agent.name, node.id);
				}
			}
		}

		// Resolve a channel endpoint reference to a node UUID.
		// Handles: plain names (node/agent-slot), cross-node "nodeId/agentName", '*' wildcard.
		const resolveRef = (ref: string): string | undefined => {
			if (ref === '*') return undefined;
			const slashIdx = ref.indexOf('/');
			if (slashIdx !== -1) {
				// Cross-node format — the part before the slash is the node UUID
				return ref.slice(0, slashIdx);
			}
			return nameToNodeId.get(ref);
		};

		// Collect node IDs that appear as channel sources (have outbound channels).
		// Each channel is one-way; a node has outbound if it appears in channel.from.
		const nodesWithOutbound = new Set<string>();
		for (const ch of channels) {
			const fromId = resolveRef(ch.from);
			if (fromId) nodesWithOutbound.add(fromId);
		}

		// Terminal nodes are those with no outbound channels
		const terminalNodeIds = new Set<string>();
		for (const node of nodes) {
			if (!nodesWithOutbound.has(node.id)) {
				terminalNodeIds.add(node.id);
			}
		}

		if (terminalNodeIds.size === 0) return undefined;

		// Look up completed node executions for terminal nodes and return the first result
		const executions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);
		for (const execution of executions) {
			if (
				terminalNodeIds.has(execution.workflowNodeId) &&
				execution.status === 'done' &&
				execution.result
			) {
				return execution.result;
			}
		}

		return undefined;
	}

	/**
	 * Removes from the executors map any executor whose run has reached a
	 * terminal state (completed or cancelled).
	 *
	 * Reads run status from DB rather than relying on the executor's cached
	 * this.run, so external status changes (e.g. cancellation via API) are
	 * picked up without requiring executor recreation.
	 *
	 * Emits a `workflow_run_completed` notification for runs that reached the
	 * `completed` state (set by the CompletionDetector or external cancellation).
	 * Includes the Done node agent's result summary (if available) so the
	 * Space Chat Agent can surface it to the human.
	 */
	private async cleanupTerminalExecutors(): Promise<void> {
		for (const [runId] of this.executors) {
			const run = this.config.workflowRunRepo.getRun(runId);
			if (!run || run.status === 'done' || run.status === 'cancelled') {
				if (run?.status === 'done') {
					const meta = this.executorMeta.get(runId);
					if (meta) {
						const summary = this.resolveCompletionSummary(runId, meta.workflow);
						await this.safeNotify({
							kind: 'workflow_run_completed',
							spaceId: meta.spaceId,
							runId,
							status: 'done',
							summary,
							timestamp: new Date().toISOString(),
						});
					}
				}
				if (run) {
					await this.reconcileTerminalRunTasks(run);
				}
				// Prune dedup entries for all tasks in this run so the set doesn't
				// grow unboundedly. Once a run is terminal its tasks will never
				// reappear in nodeTasks, so the normal per-tick pruning loop
				// (processRunTick) would never clear them otherwise.
				for (const task of this.config.taskRepo.listByWorkflowRun(runId)) {
					this.notifiedTaskSet.delete(`${task.id}:blocked`);
					this.notifiedTaskSet.delete(`${task.id}:timeout`);
				}
				this.executors.delete(runId);
				this.executorMeta.delete(runId);
			}
		}
	}

	/**
	 * Returns the cached SpaceTaskManager for a given space.
	 * Public so that tool handlers (e.g. global-spaces-tools) can retry/cancel/reassign tasks.
	 */
	getTaskManagerForSpace(spaceId: string): SpaceTaskManager {
		return this.getOrCreateTaskManager(spaceId);
	}

	/**
	 * Checks standalone tasks (tasks without a workflowRunId) across all spaces for:
	 *   - `blocked` status → emit `task_blocked` notification
	 *   - `in_progress` timeout    → emit `task_timeout` notification
	 *
	 * Uses the shared `notifiedTaskSet` for deduplication so the same task+status pair
	 * is never notified twice in a row. Dedup keys are cleared when the task leaves the
	 * flagged state, allowing re-notification if the task cycles back into it.
	 *
	 * Dedup cleanup includes archived tasks (fetched via includeArchived=true) to prevent
	 * notifiedTaskSet from accumulating stale keys for tasks that were archived while in
	 * a flagged state. Archived tasks can never re-enter blocked or in_progress,
	 * so their dedup keys are always safe to remove.
	 *
	 * Restart contract: because `notifiedTaskSet` is in-memory only, tasks already in
	 * `blocked` at daemon startup will re-notify once on the first tick. This is
	 * intentional — the Space Agent session is new after restart and needs to be informed
	 * of outstanding issues. See the `notifiedTaskSet` field comment for details.
	 */
	private async checkStandaloneTasks(): Promise<void> {
		const spaces = await this.config.spaceManager.listSpaces(false);

		for (const space of spaces) {
			// Fetch all standalone tasks including archived ones for the dedup cleanup pass.
			// Using listStandaloneBySpace pushes workflow_run_id IS NULL into SQL so only
			// standalone tasks are returned — no JS-side filtering needed.
			// includeArchived=true ensures archived tasks have their dedup keys cleared and
			// do not accumulate as stale entries in notifiedTaskSet indefinitely.
			const allStandalone = this.config.taskRepo.listStandaloneBySpace(space.id, true);
			const activeStandalone = allStandalone.filter((t) => !t.archivedAt);

			// Dedup cleanup: clear keys for tasks that have left their flagged state.
			// Archived tasks always get their keys cleared — they can never re-enter a
			// flagged state, so keeping their keys would be a permanent memory leak.
			for (const task of allStandalone) {
				const archived = !!task.archivedAt;
				if (archived || task.status !== 'blocked') {
					this.notifiedTaskSet.delete(`${task.id}:blocked`);
				}
				if (archived || task.status !== 'in_progress') {
					this.notifiedTaskSet.delete(`${task.id}:timeout`);
				}
			}

			// Emit task_blocked for active standalone tasks in blocked state.
			for (const task of activeStandalone) {
				if (task.status !== 'blocked') continue;
				const dedupKey = `${task.id}:blocked`;
				if (!this.notifiedTaskSet.has(dedupKey)) {
					this.notifiedTaskSet.add(dedupKey);
					await this.safeNotify({
						kind: 'task_blocked',
						spaceId: space.id,
						taskId: task.id,
						reason: 'Task requires attention',
						timestamp: new Date().toISOString(),
					});
				}
			}

			// Timeout detection for active standalone in_progress tasks.
			const taskTimeoutMs = space.config?.taskTimeoutMs;
			if (taskTimeoutMs !== undefined) {
				const now = Date.now();
				for (const task of activeStandalone) {
					if (task.status !== 'in_progress' || !task.startedAt) continue;
					const elapsedMs = now - task.startedAt;
					if (elapsedMs > taskTimeoutMs) {
						const dedupKey = `${task.id}:timeout`;
						if (!this.notifiedTaskSet.has(dedupKey)) {
							this.notifiedTaskSet.add(dedupKey);
							await this.safeNotify({
								kind: 'task_timeout',
								spaceId: space.id,
								taskId: task.id,
								elapsedMs,
								timestamp: new Date().toISOString(),
							});
						}
					}
				}
			}
		}
	}

	/**
	 * Attach a workflow run to open standalone tasks so workflow execution is driven
	 * by the runtime tick (not by Task Agent session creation).
	 *
	 * For each open standalone task:
	 * 1. Select a fallback workflow for the task
	 * 2. Start a workflow run
	 * 3. Attach the original task to the run and mark it in_progress
	 */
	private async attachStandaloneTasksToWorkflows(): Promise<void> {
		const spaces = await this.config.spaceManager.listSpaces(false);

		for (const space of spaces) {
			const workflows = this.config.spaceWorkflowManager.listWorkflows(space.id);
			if (workflows.length === 0) continue;

			const standaloneOpenTasks = this.config.taskRepo
				.listStandaloneBySpace(space.id, false)
				.filter((task) => task.status === 'open');

			for (const task of standaloneOpenTasks) {
				// Re-read to avoid racing with external updates between list and attach.
				const fresh = this.config.taskRepo.getTask(task.id);
				if (!fresh || fresh.workflowRunId) continue;
				if (fresh.status !== 'open') continue;

				const selectedWorkflow = this.selectFallbackWorkflowForStandaloneTask(fresh, workflows);
				if (!selectedWorkflow) continue;

				try {
					const { run } = await this.startWorkflowRun(
						space.id,
						selectedWorkflow.id,
						fresh.title,
						fresh.description,
						{ parentTaskId: fresh.id }
					);

					await this.updateTaskAndEmit(space.id, fresh.id, {
						workflowRunId: run.id,
						status: 'in_progress',
						startedAt: fresh.startedAt ?? Date.now(),
						completedAt: null,
					});
				} catch (err) {
					log.warn(
						`SpaceRuntime: failed to attach standalone task ${fresh.id} to workflow ${selectedWorkflow.id}:`,
						err
					);
				}
			}
		}
	}

	/**
	 * Deterministically select a fallback workflow for a standalone task.
	 *
	 * Preference order:
	 * 1. Highest keyword overlap with task title/description
	 * 2. `default` tag
	 * 3. `v2` tag
	 * 4. Most recently updated workflow
	 */
	private selectFallbackWorkflowForStandaloneTask(
		task: SpaceTask,
		workflows: SpaceWorkflow[]
	): SpaceWorkflow | null {
		if (workflows.length === 0) return null;
		if (workflows.length === 1) return workflows[0];

		const keywords = `${task.title} ${task.description}`
			.toLowerCase()
			.split(/\W+/)
			.filter((word) => word.length >= 3 && !WORKFLOW_SELECTION_STOP_WORDS.has(word));

		const scored = workflows.map((workflow) => {
			const haystack = [workflow.name, workflow.description ?? '', ...(workflow.tags ?? [])]
				.join(' ')
				.toLowerCase();
			const hits =
				keywords.length === 0 ? 0 : keywords.filter((keyword) => haystack.includes(keyword)).length;
			const tags = workflow.tags ?? [];
			return {
				workflow,
				hits,
				isDefault: tags.includes('default') ? 1 : 0,
				isV2: tags.includes('v2') ? 1 : 0,
			};
		});

		scored.sort((a, b) => {
			if (b.hits !== a.hits) return b.hits - a.hits;
			if (b.isDefault !== a.isDefault) return b.isDefault - a.isDefault;
			if (b.isV2 !== a.isV2) return b.isV2 - a.isV2;
			return b.workflow.updatedAt - a.workflow.updatedAt;
		});

		return scored[0]?.workflow ?? null;
	}

	/**
	 * Returns the cached SpaceTaskManager for a space, creating it if needed.
	 * Caching avoids creating a new manager + repository on every executor build.
	 */
	private getOrCreateTaskManager(spaceId: string): SpaceTaskManager {
		let manager = this.taskManagers.get(spaceId);
		if (!manager) {
			manager = new SpaceTaskManager(this.config.db, spaceId, this.config.reactiveDb);
			this.taskManagers.set(spaceId, manager);
		}
		return manager;
	}

	/**
	 * Builds a WorkflowExecutor for the given run with fresh state.
	 * Used for graph navigation (getCurrentNode, isComplete) and condition evaluation.
	 */
	private buildExecutor(
		workflow: SpaceWorkflow,
		run: SpaceWorkflowRun,
		_spaceId: string,
		_workspacePath: string
	): WorkflowExecutor {
		return new WorkflowExecutor(workflow, run);
	}

	/**
	 * Resolves the channel topology for a workflow node and stores it in the run's
	 * config for use by session group creation (Milestone 6).
	 *
	 * Resolves channel topology using `WorkflowNodeAgent.name` entries from the node
	 * and the workflow-level channels array.
	 * Stores the result under `run.config._resolvedChannels`.
	 *
	 * TODO Milestone 6: pass resolvedChannels to session group metadata in
	 * TaskAgentManager.spawnTaskAgent() instead of storing in run config.
	 *
	 * Note: Task Agent channels are persisted as WorkflowChannel entries in the
	 * workflow channels array. This function only resolves and stores user-declared
	 * channels — no runtime auto-generation.
	 */
	/**
	 * Stores the workflow channels for a run in memory.
	 * Channels are node-to-node (WorkflowNode.name) and need no slot-level resolution.
	 */
	storeWorkflowChannels(runId: string, channels: WorkflowChannel[]): void {
		this.workflowChannelsMap.set(runId, channels);
	}

	/**
	 * Returns the channels for the given run ID.
	 */
	getRunWorkflowChannels(runId: string): WorkflowChannel[] {
		return this.workflowChannelsMap.get(runId) ?? [];
	}

	/**
	 * Returns the channels array for the workflow associated with the given run.
	 */
	getWorkflowChannels(runId: string): WorkflowChannel[] {
		const run = this.config.workflowRunRepo.getRun(runId);
		if (!run) return [];
		const workflow = this.config.spaceWorkflowManager.getWorkflow(run.workflowId);
		return workflow?.channels ?? [];
	}
}
