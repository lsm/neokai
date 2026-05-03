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
 * and `task.reportedStatus` — SpaceRuntime no longer calls advance() directly.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type {
	NodeExecution,
	Space,
	SpaceApprovalSource,
	SpaceTask,
	SpaceWorkflow,
	SpaceWorkflowRun,
	UpdateSpaceTaskParams,
	WorkflowChannel,
} from '@neokai/shared';
import { computeGateDefaults, isChannelCyclic, resolveNodeAgents } from '@neokai/shared';
import type { ReactiveDatabase } from '../../../storage/reactive-database';
import { ChannelCycleRepository } from '../../../storage/repositories/channel-cycle-repository';
import { GateDataRepository } from '../../../storage/repositories/gate-data-repository';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { PendingAgentMessageRepository } from '../../../storage/repositories/pending-agent-message-repository';
import { SDKMessageRepository } from '../../../storage/repositories/sdk-message-repository';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import { ToolContinuationRecoveryRepository } from '../../../storage/repositories/tool-continuation-recovery-repository';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository';
import { Logger } from '../../logger';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import type { SpaceManager } from '../managers/space-manager';
import { isValidSpaceTaskTransition, SpaceTaskManager } from '../managers/space-task-manager';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import { getBuiltInGateScript } from '../workflows/built-in-workflows';
import { CompletionDetector } from './completion-detector';
import {
	DEFAULT_NODE_TIMEOUT_MS,
	MAX_BLOCKED_RUN_RETRIES,
	MAX_TASK_AGENT_CRASH_RETRIES,
} from './constants';
import { evaluateGate } from './gate-evaluator';
import { extractPrContext, GatePollManager, type PollScriptContext } from './gate-poll-manager';
import { executeGateScript } from './gate-script-executor';
import { classifyLastMessageForIdleAgent } from './last-message-classifier';
import type { SelectWorkflowWithLlm } from './llm-workflow-selector';
import { type NotificationSink, NullNotificationSink } from './notification-sink';
import {
	type PostApprovalRouteContext,
	type PostApprovalRouteResult,
	PostApprovalRouter,
} from './post-approval-router';
import { resolveTimeoutForExecution } from './resolve-node-timeout';
import type { TaskAgentManager } from './task-agent-manager';
import { WorkflowExecutor } from './workflow-executor';
import { isPermanentSpawnError } from './workflow-node-execution-validation';
import { selectWorkflow } from './workflow-selector';

const log = new Logger('space-runtime');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SpaceRuntimeConfig {
	/** Raw Bun SQLite database — used to create per-space SpaceTaskManagers */
	db: BunDatabase;
	/**
	 * Optional absolute path to the SQLite database file.
	 *
	 * Threaded through from `SpaceRuntimeServiceConfig`; retained for callers
	 * that need DB access from injected helpers.
	 */
	dbPath?: string;
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
	 * Completion detector — inspects the canonical `SpaceTask` to decide whether
	 * a workflow run is complete or ready for runtime resolution.
	 *
	 * Defaults to `new CompletionDetector(taskRepo)` when not provided.
	 */
	completionDetector?: CompletionDetector;
	/**
	 * Optional artifact repository used by `dispatchPostApproval` to resolve
	 * PR URLs (and other structured end-node artifacts) into the template
	 * interpolation context for post-approval sessions.
	 */
	artifactRepo?: WorkflowRunArtifactRepository;
	/**
	 * Optional SDK message repository used to emit synthetic SDK messages into
	 * a task's agent session. Defaults to a repo constructed from `db` if not
	 * provided — tests can inject a stub to assert emissions.
	 */
	sdkMessageRepo?: SDKMessageRepository;
	/**
	 * Persistent queue for workflow agent handoff messages. SpaceRuntime sweeps
	 * this queue every tick so queued node-to-node handoffs are retried and either
	 * delivered or escalated instead of waiting indefinitely for a Task Agent wakeup.
	 */
	pendingMessageRepo?: PendingAgentMessageRepository;
	/**
	 * Optional callback emitted when runtime mutates a SpaceTask internally.
	 * Used to fan out `space.task.updated` events for UI synchronization.
	 */
	onTaskUpdated?: (payload: {
		spaceId: string;
		task: SpaceTask;
		archiveSource?: 'user' | 'system_reconcile';
	}) => Promise<void> | void;
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
	/**
	 * Optional LLM-backed workflow selector used when a standalone task has no
	 * `preferredWorkflowId` and multiple workflows are available. Should return
	 * one of the provided workflow ids, or `null` to fall back to the
	 * deterministic tag-based tiebreak (`default` → `v2` → most recently updated).
	 *
	 * Dependency-injected so tests can provide a deterministic stub without
	 * touching the provider SDK. In production, wire this to
	 * `selectWorkflowWithLlmDefault` from `./llm-workflow-selector`.
	 */
	selectWorkflowWithLlm?: SelectWorkflowWithLlm;
}

interface StartWorkflowRunOptions {
	/**
	 * Optional canonical parent task for this workflow run.
	 * When provided, runtime-created node tasks are marked with this parent
	 * so user-facing views can keep a one-task-per-run list.
	 */
	parentTaskId?: string;
}

type WorkflowTaskRecoveryTargetStatus = 'open' | 'in_progress';

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
	 * Lazy-initialized SDK message repository used for thread-event emission.
	 * Sourced from `config.sdkMessageRepo` when provided, otherwise constructed
	 * on first use from `config.db`.
	 */
	private sdkMessageRepo: SDKMessageRepository | null = null;

	/**
	 * Completion detector — inspects canonical `SpaceTask` to decide completion.
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

	/**
	 * Tracks idle executions whose last SDK message was non-terminal.
	 *
	 * The counter is intentionally in-memory like crash recovery: transient idle
	 * ambiguity gets one automatic re-spawn, then escalates if it repeats.
	 */
	private nonTerminalIdleCounts = new Map<string, number>();
	private readonly toolContinuationRepo: ToolContinuationRecoveryRepository;

	/**
	 * Manages gate poll timers for periodic script execution and message injection.
	 * Lazy-initialized when taskAgentManager is available.
	 */
	private pollManager: GatePollManager | null = null;

	constructor(private config: SpaceRuntimeConfig) {
		this.notificationSink = config.notificationSink ?? new NullNotificationSink();
		this.completionDetector = config.completionDetector ?? new CompletionDetector(config.taskRepo);
		this.sdkMessageRepo = config.sdkMessageRepo ?? null;
		this.toolContinuationRepo = new ToolContinuationRecoveryRepository(config.db);
		if (hasSqlExec(config.db)) {
			this.toolContinuationRepo.ensureSchema();
		}
	}

	/**
	 * Lazy accessor for the SDK message repository. Constructed from `config.db`
	 * on first use when the caller did not inject one. Centralized here so
	 * emission sites can stay one-liners and tests can inject a stub via config.
	 */
	private getSdkMessageRepo(): SDKMessageRepository {
		if (!this.sdkMessageRepo) {
			this.sdkMessageRepo = new SDKMessageRepository(this.config.db);
		}
		return this.sdkMessageRepo;
	}

	/**
	 * Persist a synthetic SDK `system` message into the target session so it
	 * surfaces in `SpaceTaskUnifiedThread`. Failures are logged and swallowed —
	 * thread-event emission must never block a resume or fail a task.
	 *
	 * @internal — public for testing only.
	 */
	emitTaskThreadEvent(sessionId: string, subtype: string, payload: Record<string, unknown>): void {
		try {
			// Shape mirrors the SDK system message contract expected by the web
			// thread renderer (`isSDKSystemMessage` + subtype switch in
			// `space-task-thread-events.ts`). Unknown subtypes degrade gracefully
			// to a generic "system" event, so consumers without the new subtype
			// branch still show something meaningful.
			const message = {
				type: 'system',
				subtype,
				session_id: sessionId,
				uuid: `${subtype}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
				...payload,
			} as unknown as Parameters<SDKMessageRepository['saveSDKMessage']>[1];
			this.getSdkMessageRepo().saveSDKMessage(sessionId, message);
		} catch (err) {
			log.warn(
				`[SpaceRuntime] Failed to emit thread event ${subtype} on session ${sessionId}: ` +
					`${err instanceof Error ? err.message : String(err)}`
			);
		}
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
	 * Returns the currently-configured NotificationSink.
	 *
	 * Exposed so collaborators that construct their own `ChannelRouter` instances
	 * (e.g. `SpaceRuntimeService.notifyGateDataChanged` or the per-run router
	 * created inside `TaskAgentManager`) can plumb the same sink through,
	 * ensuring `workflow_run_reopened` events reach the Space Agent session
	 * regardless of which code path triggered the reopen.
	 */
	getNotificationSink(): NotificationSink {
		return this.notificationSink;
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
		manager.attachToolContinuationRepo?.(this.toolContinuationRepo);
		// Initialize the poll manager now that taskAgentManager is available
		if (!this.pollManager) {
			this.pollManager = new GatePollManager(
				{
					injectSubSessionMessage: (sessionId, message, isSynthetic) =>
						manager.injectSubSessionMessage(sessionId, message, isSynthetic),
				},
				{
					getActiveSessionForNode: (runId, nodeId) => {
						const executions = this.config.nodeExecutionRepo.listByNode(runId, nodeId);
						const active = executions.find(
							(e) => e.status !== 'cancelled' && e.status !== 'idle' && e.agentSessionId !== null
						);
						return active?.agentSessionId ?? null;
					},
				}
			);
		}
	}

	/**
	 * Cached `PostApprovalRouter` instance (PR 2/5 of the
	 * task-agent-as-post-approval-executor refactor). Built lazily on first use
	 * because it depends on `taskAgentManager`, which is injected after
	 * `SpaceRuntime` is constructed.
	 */
	private postApprovalRouter: PostApprovalRouter | null = null;

	/**
	 * Lazy-construct the `PostApprovalRouter` once `taskAgentManager` is
	 * available. Returns `null` when the manager has not yet been injected —
	 * the only expected scenario is very early startup before the daemon has
	 * finished wiring, in which case we fall through to the legacy path.
	 */
	private getPostApprovalRouter(): PostApprovalRouter | null {
		if (this.postApprovalRouter) return this.postApprovalRouter;
		const manager = this.config.taskAgentManager;
		if (!manager) return null;
		this.postApprovalRouter = new PostApprovalRouter({
			taskRepo: this.config.taskRepo,
			taskAgent: {
				injectIntoTaskAgent: (taskId, message) => manager.injectIntoTaskAgent(taskId, message),
			},
			spawner: {
				spawnPostApprovalSubSession: (args) => manager.spawnPostApprovalSubSession(args),
			},
			livenessProbe: {
				isSessionAlive: (sessionId) => manager.isSessionAlive(sessionId),
			},
		});
		return this.postApprovalRouter;
	}

	/**
	 * Public entry point — transition a task into `approved` and dispatch the
	 * post-approval step via `PostApprovalRouter`.
	 *
	 * Called by:
	 *   - The `space-runtime.ts` tick loop once an end-node `approve_task` has
	 *     flagged the task ready to approve (via `reportedStatus='done'`).
	 *   - `SpaceRuntimeService.dispatchPostApproval`, invoked from the
	 *     `spaceTask.approvePendingCompletion` RPC handler when a human approves
	 *     a task paused at a `task_completion` checkpoint.
	 *
	 * Contract:
	 *   1. If the task is not already `approved`, transition it there via
	 *      `SpaceTaskManager.setTaskStatus` (so the centralised transition
	 *      validator runs).
	 *   2. Call `PostApprovalRouter.route()` — which handles the no-route,
	 *      inline (Task Agent), spawn, already-routed, and skip branches.
	 *
	 * Returns the `PostApprovalRouteResult` from the router (or a `skipped`
	 * result when the router is not yet wired / the task is missing).
	 */
	async dispatchPostApproval(
		taskId: string,
		approvalSource: SpaceApprovalSource,
		contextExtras: Omit<PostApprovalRouteContext, 'approvalSource'> = {}
	): Promise<PostApprovalRouteResult> {
		const router = this.getPostApprovalRouter();
		if (!router) {
			const reason = `PostApprovalRouter not wired yet (taskAgentManager missing); task=${taskId}`;
			log.warn(`dispatchPostApproval: ${reason}`);
			return { mode: 'skipped', reason };
		}

		const current = this.config.taskRepo.getTask(taskId);
		if (!current) {
			const reason = `task ${taskId} not found`;
			log.warn(`dispatchPostApproval: ${reason}`);
			return { mode: 'skipped', reason };
		}

		const spaceId = current.spaceId;
		const space = await this.config.spaceManager.getSpace(spaceId);
		// Workflow lookup goes via the run (tasks reference workflowRunId, runs
		// reference workflowId). Standalone tasks have no run → no workflow → the
		// router takes the no-route branch.
		const run = current.workflowRunId
			? this.config.workflowRunRepo.getRun(current.workflowRunId)
			: null;
		const workflow = run
			? (this.config.spaceWorkflowManager.getWorkflow(run.workflowId) ?? null)
			: null;

		// 1. Ensure the task is in `approved` before routing. Uses the space's
		//    task manager so the transition validator runs (rejects illegal
		//    transitions with a structured error).
		//
		//    `approvalReason` must be forwarded from `contextExtras` (the RPC
		//    handler passes the operator's rejection/approval note) — otherwise
		//    `SpaceTaskManager.setTaskStatus` would stamp `null` and overwrite
		//    the value the caller may have already written via `updateTask`.
		//    We distinguish missing (undefined) from explicit null so an
		//    explicit clear still wins.
		const resolvedApprovalReason =
			typeof contextExtras.approvalReason === 'string'
				? contextExtras.approvalReason
				: contextExtras.approvalReason === null
					? null
					: undefined;
		let approvedTask: SpaceTask = current;
		if (current.status !== 'approved') {
			const taskManager = this.getOrCreateTaskManager(spaceId);
			approvedTask = await taskManager.setTaskStatus(taskId, 'approved', {
				approvalSource,
				approvalReason: resolvedApprovalReason,
			});
			await this.safeOnTaskUpdated(spaceId, approvedTask);
			log.info(
				`task.status-transition: taskId=${taskId} from=${current.status} to=approved source=${approvalSource}`
			);
		}

		// 2. Dispatch the actual post-approval step.
		//
		// `{{pr_url}}` in the merge template is sourced from the most recent
		// `workflow_run_artifacts` row whose `data` carries `prUrl` / `pr_url`.
		// The end-node reviewer persists the URL via
		// `save_artifact({ type: 'result', data: { prUrl } })` immediately
		// before calling `approve_task()`, so by the time we reach this branch
		// the artifact row exists. We deliberately do NOT read from
		// `SpaceTask`: migration 84 dropped `pr_url`/`pr_number` columns from
		// `space_tasks` and moved PR metadata to the artifact store.
		//
		// Callers may still override by passing `pr_url` in `contextExtras`
		// (RPC paths forward operator-supplied values) — their value wins
		// because the spread order below places `contextExtras` after the
		// artifact-resolved default.
		let resolvedPrUrl: string | undefined;
		if (this.config.artifactRepo && approvedTask.workflowRunId) {
			try {
				const artifacts = this.config.artifactRepo.listByRun(approvedTask.workflowRunId);
				// `listByRun` orders ASC by created_at; walk in reverse so the
				// most recent `prUrl`/`pr_url` wins (later reviewer cycles
				// supersede earlier ones).
				for (let i = artifacts.length - 1; i >= 0; i--) {
					const data = artifacts[i]?.data;
					if (!data) continue;
					const candidate =
						(typeof data.prUrl === 'string' && data.prUrl) ||
						(typeof data.pr_url === 'string' && data.pr_url);
					if (candidate) {
						resolvedPrUrl = candidate;
						break;
					}
				}
			} catch (err) {
				log.warn(
					`dispatchPostApproval: artifact lookup failed for run ${approvedTask.workflowRunId}: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		}
		// The template interpolator (see `post-approval-template.ts`) resolves
		// tokens by raw identifier match — `{{autonomy_level}}` looks up the
		// key `autonomy_level`, not `autonomyLevel`. `PostApprovalRouteContext`
		// declares camelCase for the runtime-facing fields, so we MUST also
		// supply snake_case aliases so every merge-template token documented in
		// `POST_APPROVAL_TEMPLATE_KEYS` actually interpolates. Without these
		// aliases the autonomy-gate step in the merge template ("If
		// autonomy_level < 4 …") reads as a literal placeholder, which the
		// reviewer sub-session cannot compare to a number — effectively
		// disabling the gate or triggering spurious human-input requests.
		const routeContext: PostApprovalRouteContext = {
			...(resolvedPrUrl ? { pr_url: resolvedPrUrl } : {}),
			...contextExtras,
			approvalSource,
			approval_source: approvalSource,
			spaceId,
			space_id: spaceId,
			autonomyLevel: space?.autonomyLevel,
			autonomy_level: space?.autonomyLevel,
			workspacePath: space?.workspacePath,
			workspace_path: space?.workspacePath,
		};
		const routeResult = await router.route(approvedTask, workflow, routeContext);

		// 4. Re-read and emit so UI listeners see the post-dispatch task state
		//    (no-route → `done`, inline → `approvalReason` stamped, spawn →
		//    `postApprovalSessionId` stamped). The router performs its own
		//    `taskRepo.updateTask` writes without emitting; without this the
		//    end-node tick path would leave the UI waiting until the next poll.
		//    The RPC path also emits via `daemonHub` after this returns — the
		//    double emit is benign (idempotent UI refresh).
		if (routeResult.mode !== 'skipped') {
			const final = this.config.taskRepo.getTask(taskId);
			if (final) await this.safeOnTaskUpdated(spaceId, final);
		}
		return routeResult;
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

	private async safeOnTaskUpdated(
		spaceId: string,
		task: SpaceTask,
		opts?: { archiveSource?: 'user' | 'system_reconcile' }
	): Promise<void> {
		const handler = this.config.onTaskUpdated;
		if (!handler) return;
		try {
			await handler({ spaceId, task, archiveSource: opts?.archiveSource });
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

	/**
	 * Returns active, non-paused, non-stopped spaces.
	 * Used by tick-loop methods to skip paused and stopped spaces.
	 */
	private async listActiveSpaces(): Promise<import('@neokai/shared').Space[]> {
		const spaces = await this.config.spaceManager.listSpaces(false);
		return spaces.filter((s) => !s.paused && !s.stopped);
	}

	private async updateTaskAndEmit(
		spaceId: string,
		taskId: string,
		params: UpdateSpaceTaskParams,
		opts?: { archiveSource?: 'user' | 'system_reconcile' }
	): Promise<SpaceTask | null> {
		const updated = this.config.taskRepo.updateTask(taskId, params);
		if (updated) {
			await this.safeOnTaskUpdated(spaceId, updated, opts);

			// Cascade dependency_failed to open tasks that depend on this one
			if (params.status === 'blocked' || params.status === 'cancelled') {
				const taskManager = this.getOrCreateTaskManager(spaceId);
				const cascaded = await taskManager.blockDependentTasks(taskId);
				for (const blocked of cascaded) {
					await this.safeOnTaskUpdated(spaceId, blocked);
				}
			}
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

			// Task #85: duplicate-run reconciliation marks tasks `archived` in DB
			// so the UI stops showing them as active, but this path is NOT a user
			// archive. Tag the event with `archiveSource: 'system_reconcile'` so
			// `TaskAgentManager.subscribeToTaskArchiveEvents` skips the cleanup
			// cascade (worktree removal + SDK .jsonl archival). The UI still
			// receives the `space.task.updated` event for the status change.
			await this.updateTaskAndEmit(
				spaceId,
				duplicate.id,
				{
					status: 'archived',
					archivedAt: duplicate.archivedAt ?? now,
					completedAt: duplicate.completedAt ?? now,
					workflowRunId: null,
					taskAgentSessionId: null,
				},
				{ archiveSource: 'system_reconcile' }
			);

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
			const reportedSummary = canonicalTask.reportedSummary ?? null;
			const nextResult =
				summaryFromWorkflow ??
				reportedSummary ??
				canonicalTask.result ??
				summaryFromSibling ??
				null;

			// Skip tasks already at a terminal or paused state — matches the
			// active-tick guard (`taskAlreadyResolved`) at processRunTick.
			if (
				canonicalTask.status !== 'done' &&
				canonicalTask.status !== 'review' &&
				canonicalTask.status !== 'cancelled' &&
				canonicalTask.status !== 'approved'
			) {
				// Preserve the computed result on the task before routing —
				// dispatchPostApproval handles the status transition itself.
				if (nextResult && canonicalTask.result !== nextResult) {
					await this.updateTaskAndEmit(run.spaceId, canonicalTask.id, { result: nextResult });
				}
				await this.dispatchPostApproval(canonicalTask.id, 'agent');
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
		const spaces = await this.listActiveSpaces();
		for (const space of spaces) {
			const terminalRuns = this.config.workflowRunRepo
				.listBySpace(space.id)
				.filter((run) => run.status === 'done' || run.status === 'cancelled');
			for (const run of terminalRuns) {
				if (this.executors.has(run.id)) continue;
				// Ensure polls are stopped for terminal runs discovered outside
				// the executor map (e.g. daemon restart after run completed).
				this.pollManager?.stopPolls(run.id);
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
		// Stop all gate poll timers
		this.pollManager?.stopAll();
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
			if (hasSqlExec(this.config.db)) {
				this.toolContinuationRepo.markExpired();
			}

			if (!this.rehydrated) {
				await this.rehydrateExecutors();
				// Run a stalled-run recovery pass right after rehydrate so the
				// first tick that processes runs already sees a clean slate
				// (orphan in_progress executions reset to pending, terminally
				// stalled runs flagged blocked). Idempotent — `recoverStalledRuns`
				// guards itself with `recoveryDone`. SpaceRuntimeService.start()
				// also invokes it after `provisionExistingSpaces`; whichever
				// fires first wins, the other becomes a no-op.
				await this.recoverStalledRuns();
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
		const startNode = workflow.nodes.find((s) => s.id === workflow.startNodeId);
		if (!startNode) {
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

			startAgents = resolveNodeAgents(startNode);
			for (const agentEntry of startAgents) {
				this.config.nodeExecutionRepo.createOrIgnore({
					workflowRunId: run.id,
					workflowNodeId: startNode.id,
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

		// Start gate polls for this workflow run
		if (this.pollManager && canonicalTask) {
			const pollContext = this.buildPollScriptContext(canonicalTask, run, spaceId);
			if (pollContext) {
				this.pollManager.startPolls(run.id, workflow, space.workspacePath, spaceId, pollContext);
			}
		}

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
	 * Reopen or resume a workflow-backed task as one lifecycle operation.
	 *
	 * A bare SpaceTask status update is not enough for workflow tasks: terminal
	 * workflow runs are reconciled back to their run status on the next tick, and
	 * terminal node executions need either a live session reattached or a pending
	 * row for the tick loop to spawn. This method updates the task, run, and the
	 * current node execution rows together, then ensures the executor map is ready.
	 */
	async recoverWorkflowBackedTask(
		spaceId: string,
		taskId: string,
		targetStatus: WorkflowTaskRecoveryTargetStatus
	): Promise<{ task: SpaceTask; run: SpaceWorkflowRun }> {
		if (targetStatus !== 'open' && targetStatus !== 'in_progress') {
			throw new Error(
				`Workflow task recovery only supports active target statuses: open, in_progress`
			);
		}

		// Clear stale expired/failed queued handoffs and reset in-memory counters
		// so the next tick does not immediately re-block the run based on stale
		// pending message state from the previous failed cycle.
		//
		// Guarded on both task AND run ownership so a wrong-space caller (or a
		// task whose workflowRunId points to a foreign run) cannot delete messages
		// or reset retry counters. The transaction below also validates and throws
		// on mismatch, but these side-effects run outside the transaction.
		const preTxTask = this.config.taskRepo.getTask(taskId);
		const preTxRunId = preTxTask?.workflowRunId;
		const preTxRun = preTxRunId ? this.config.workflowRunRepo.getRun(preTxRunId) : null;
		if (preTxRunId && preTxTask.spaceId === spaceId && preTxRun?.spaceId === spaceId) {
			if (this.config.pendingMessageRepo) {
				this.config.pendingMessageRepo.clearTerminalForRun(preTxRunId);
			}
			this.blockedRetryCounts.delete(preTxRunId);
			// Clear non-terminal idle retry counters so a manually recovered run
			// starts with a fresh retry budget instead of re-blocking immediately.
			for (const key of this.nonTerminalIdleCounts.keys()) {
				if (key.startsWith(preTxRunId + ':')) {
					this.nonTerminalIdleCounts.delete(key);
				}
			}
		}

		const liveSessionIds = new Set<string>();
		const recoverTx = this.config.db.transaction(() => {
			const task = this.config.taskRepo.getTask(taskId);
			if (!task) throw new Error(`Task not found: ${taskId}`);
			if (task.spaceId !== spaceId) throw new Error(`Task not found: ${taskId}`);
			if (!task.workflowRunId) {
				throw new Error(`Task ${taskId} is not backed by a workflow run`);
			}
			if (task.status !== targetStatus && !isValidSpaceTaskTransition(task.status, targetStatus)) {
				throw new Error(`Invalid status transition from '${task.status}' to '${targetStatus}'.`);
			}

			const run = this.config.workflowRunRepo.getRun(task.workflowRunId);
			if (!run) throw new Error(`WorkflowRun not found: ${task.workflowRunId}`);
			if (run.spaceId !== spaceId) throw new Error(`WorkflowRun not found: ${task.workflowRunId}`);

			let updatedRun =
				run.status === 'in_progress'
					? run
					: this.config.workflowRunRepo.transitionStatus(run.id, 'in_progress');
			updatedRun =
				this.config.workflowRunRepo.updateRun(run.id, {
					failureReason: null,
					completedAt: null,
				}) ?? updatedRun;

			const updatedTask = this.config.taskRepo.updateTask(task.id, {
				status: targetStatus,
				completedAt: null,
				result: null,
				blockReason: null,
				approvalSource: null,
				approvalReason: null,
				approvedAt: null,
				pendingCheckpointType: null,
				pendingCompletionSubmittedByNodeId: null,
				pendingCompletionSubmittedAt: null,
				pendingCompletionReason: null,
				postApprovalSessionId: null,
				postApprovalStartedAt: null,
				postApprovalBlockedReason: null,
				reportedStatus: null,
				reportedSummary: null,
			});
			if (!updatedTask) throw new Error(`Failed to update task: ${task.id}`);

			let executions = this.config.nodeExecutionRepo.listByWorkflowRun(run.id);
			if (executions.length === 0) {
				const workflow = this.config.spaceWorkflowManager.getWorkflow(run.workflowId);
				if (!workflow) throw new Error(`Workflow not found: ${run.workflowId}`);
				const startNode = workflow.nodes.find((node) => node.id === workflow.startNodeId);
				if (!startNode) {
					throw new Error(
						`Start node "${workflow.startNodeId}" not found in workflow "${workflow.id}"`
					);
				}
				for (const agentEntry of resolveNodeAgents(startNode)) {
					this.config.nodeExecutionRepo.createOrIgnore({
						workflowRunId: run.id,
						workflowNodeId: startNode.id,
						agentName: agentEntry.name,
						agentId: agentEntry.agentId ?? null,
						status: 'pending',
					});
				}
				executions = this.config.nodeExecutionRepo.listByWorkflowRun(run.id);
			}

			const currentExecution = [...executions].sort((a, b) => {
				const aTime = a.updatedAt ?? a.startedAt ?? a.createdAt;
				const bTime = b.updatedAt ?? b.startedAt ?? b.createdAt;
				if (aTime !== bTime) return bTime - aTime;
				return b.id.localeCompare(a.id);
			})[0];
			const currentNodeExecutions = currentExecution
				? executions.filter(
						(execution) => execution.workflowNodeId === currentExecution.workflowNodeId
					)
				: [];

			for (const execution of currentNodeExecutions) {
				const sessionId = execution.agentSessionId;
				const hasLiveSession =
					!!sessionId && (this.config.taskAgentManager?.isSessionAlive(sessionId) ?? false);

				if (hasLiveSession && sessionId) {
					this.config.nodeExecutionRepo.update(execution.id, {
						status: 'in_progress',
						completedAt: null,
					});
					liveSessionIds.add(sessionId);
				} else {
					this.config.nodeExecutionRepo.update(execution.id, {
						status: 'pending',
						result: null,
						data: null,
						startedAt: null,
						completedAt: null,
					});
				}
			}

			return { task: updatedTask, run: updatedRun };
		});

		const recovered = recoverTx();
		await this.ensureExecutorRegistered(recovered.run);
		for (const sessionId of liveSessionIds) {
			const prepared =
				(await this.config.taskAgentManager?.prepareSubSessionForWorkflowResume(sessionId)) ?? true;
			if (!prepared) {
				log.warn(
					`Workflow resume could not prepare MCP tools for live node-agent session ${sessionId}`
				);
			}
		}
		await this.safeOnWorkflowRunUpdated(
			spaceId,
			this.config.workflowRunRepo.getRun(recovered.run.id)!
		);
		await this.safeOnTaskUpdated(spaceId, this.config.taskRepo.getTask(recovered.task.id)!);
		return {
			run: this.config.workflowRunRepo.getRun(recovered.run.id) ?? recovered.run,
			task: this.config.taskRepo.getTask(recovered.task.id) ?? recovered.task,
		};
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

	private async ensureExecutorRegistered(
		run: SpaceWorkflowRun,
		knownSpace?: Space
	): Promise<boolean> {
		if (this.executors.has(run.id)) return true;

		const workflow = this.config.spaceWorkflowManager.getWorkflow(run.workflowId);
		if (!workflow) return false;

		const space = knownSpace ?? (await this.config.spaceManager.getSpace(run.spaceId));
		if (!space) return false;

		const meta: ExecutorMeta = {
			workflow,
			spaceId: space.id,
			workspacePath: space.workspacePath,
		};
		this.executorMeta.set(run.id, meta);
		this.executors.set(run.id, this.buildExecutor(workflow, run, space.id, space.workspacePath));
		return true;
	}

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
				await this.ensureExecutorRegistered(run, space);
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
	// Recovery — stalled in_progress runs after daemon restart
	// -------------------------------------------------------------------------

	/** Idempotency guard: ensures recovery runs at most once per process. */
	private recoveryDone = false;

	/**
	 * Scan every active space for `in_progress` workflow runs whose in-flight
	 * state was orphaned by a daemon restart, and re-drive them so the tick loop
	 * can finalize the run on its next pass.
	 *
	 * Two outcomes (the third — `'skipped'` — covers runs that still have
	 * driveable executions, which the tick loop owns):
	 *
	 *   1. **Stalled-with-completion-signal** — every node execution is terminal
	 *      (`idle`/`cancelled`) and the canonical task is either already terminal
	 *      or has a non-null `reportedStatus`. The next tick will see
	 *      `CompletionDetector.isComplete()` return true and finalize via the
	 *      existing pathway — this method only logs and skips.
	 *
	 *   2. **Stalled-with-no-signal** — every node execution is terminal but no
	 *      completion signal was recorded. No agent is going to drive further
	 *      progress, so the run is marked `blocked` with `block_reason =
	 *      execution_failed` and a clear, restart-aware result message. Note:
	 *      `attemptBlockedRunRecovery` early-returns when no executions are in
	 *      `blocked` status — and a recovery-blocked run has all-idle/cancelled
	 *      executions — so neither the Tier-1 retry nor Tier-2 escalation path
	 *      will fire. The run sits `blocked` until human attention (or a future
	 *      cleanup teaches `attemptBlockedRunRecovery` to also recover from
	 *      idle/cancelled executions). This matches the spec requirement to
	 *      flag ambiguous-recovery runs with a clear reason.
	 *
	 * Note: orphan in-progress executions whose agent sessions died across the
	 * restart are NOT handled here — `processRunTick` already detects dead
	 * sessions and runs the proper crash-retry pathway (with counting) on the
	 * next tick. Duplicating that logic here would silently consume retries.
	 *
	 * Idempotent — guarded by `recoveryDone`. The first caller wins; subsequent
	 * callers (e.g. the first `executeTick()` after `rehydrateExecutors()`) are
	 * no-ops. Both `SpaceRuntimeService.start()` and `executeTick()` invoke this,
	 * so the order in which they fire does not matter.
	 *
	 * Must be called *after* `rehydrateExecutors()` so executor metadata is
	 * available for any run we might transition.
	 */
	async recoverStalledRuns(): Promise<void> {
		if (this.recoveryDone) return;
		this.recoveryDone = true;

		const spaces = await this.config.spaceManager.listSpaces(false);
		let blockedCount = 0;
		let completionPendingCount = 0;

		for (const space of spaces) {
			const inProgressRuns = this.config.workflowRunRepo.getActiveRuns(space.id);
			for (const run of inProgressRuns) {
				try {
					const outcome = await this.recoverSingleRun(run);
					if (outcome === 'blocked') blockedCount++;
					else if (outcome === 'completion-pending') completionPendingCount++;
				} catch (err) {
					log.error(
						`SpaceRuntime.recoverStalledRuns: failed to recover run ${run.id} (space ${space.id}):`,
						err
					);
				}
			}
		}

		if (blockedCount + completionPendingCount > 0) {
			log.info(
				`SpaceRuntime.recoverStalledRuns: blocked=${blockedCount} completion-pending=${completionPendingCount}`
			);
		}
	}

	/**
	 * Recover a single in_progress run after daemon restart.
	 *
	 * Returns the recovery outcome so the caller can aggregate counts:
	 *   - `'completion-pending'` — all executions terminal AND completion signal
	 *                              recorded; tick will finalize via CompletionDetector.
	 *   - `'blocked'`           — all executions terminal AND no completion signal;
	 *                              run forced to `blocked` for human/auto-recovery.
	 *   - `'skipped'`           — nothing to do (e.g. has pending/in_progress/blocked
	 *                              executions that the tick loop already drives,
	 *                              or no executions at all).
	 *
	 * Orphan in_progress executions (whose agent sessions died at restart) are
	 * intentionally left for `processRunTick` to handle — it already detects
	 * dead sessions and applies the proper crash-retry-with-counting flow.
	 */
	private async recoverSingleRun(
		run: SpaceWorkflowRun
	): Promise<'completion-pending' | 'blocked' | 'skipped'> {
		const workflow = this.config.spaceWorkflowManager.getWorkflow(run.workflowId);
		const executions = this.config.nodeExecutionRepo.listByWorkflowRun(run.id);
		if (!workflow) {
			await this.blockRunWithMissingWorkflow(run, executions);
			return 'blocked';
		}
		if (executions.length === 0) return 'skipped';

		// If the tick loop has any work it can drive — `pending` (about
		// to spawn), `in_progress` (alive or crashed agent → existing
		// liveness path resets/blocks), or `blocked` (existing
		// `attemptBlockedRunRecovery` will retry/escalate) — leave the run
		// alone. Recovery only intervenes when the runtime has nothing it
		// can act on (every execution is `idle` or `cancelled`).
		const hasDriveableExecution = executions.some(
			(ex) =>
				ex.status === 'pending' ||
				ex.status === 'in_progress' ||
				ex.status === 'waiting_rebind' ||
				ex.status === 'blocked'
		);
		const hasQueuedNodeHandoff =
			this.config.pendingMessageRepo
				?.listPendingForRun(run.id)
				.some((row) => row.targetKind === 'node_agent') ?? false;
		if (hasDriveableExecution || hasQueuedNodeHandoff) return 'skipped';

		// Every execution is `idle` or `cancelled` (true terminal at the
		// node level — no agent is going to drive further state). Branch on
		// whether a completion signal was recorded on the canonical task.
		const tasks = this.config.taskRepo.listByWorkflowRun(run.id);
		const canonicalTask = this.pickCanonicalTaskForRun(run, tasks);

		// A canonical task is "at rest" — i.e. NOT a stalled run that needs
		// daemon-restart intervention — when it is in any of these states:
		//
		//   - `done` / `cancelled`  → terminal; the tick loop's
		//                             CompletionDetector will pick it up and
		//                             finalize the run.
		//   - `review`              → end-node agent finished and the workflow
		//                             is paused awaiting human approval (e.g.
		//                             via `submit_for_approval`). All node
		//                             executions are correctly `idle` while we
		//                             wait for the human; this is not a stall.
		//   - `approved`            → human (or auto_policy) approved; a
		//                             post-approval executor (e.g. PR merge)
		//                             may still be in flight, leaving prior
		//                             node executions `idle`.
		//   - `reportedStatus !== null` → end-node agent reported a result;
		//                                 the next tick will route through the
		//                                 completion path.
		//
		// In all of these cases a daemon restart must NOT alter task status.
		// Only when none of these hold is the run genuinely stalled and
		// eligible to be flagged `blocked`.
		const completionSignalled =
			canonicalTask !== null &&
			(canonicalTask.status === 'done' ||
				canonicalTask.status === 'cancelled' ||
				canonicalTask.status === 'review' ||
				canonicalTask.status === 'approved' ||
				canonicalTask.reportedStatus !== null);

		if (!completionSignalled && canonicalTask) {
			const nonTerminalIdleOutcome = await this.handleNonTerminalIdleExecutions(
				run.id,
				run.spaceId,
				canonicalTask
			);
			if (nonTerminalIdleOutcome === 'blocked') return 'blocked';
			if (nonTerminalIdleOutcome === 'retried') return 'skipped';
		}

		if (completionSignalled) {
			// Tick loop's CompletionDetector + processRunTick will fire on the
			// next pass and transition the run to `done` (or pick up the
			// cancelled task), or the run will remain paused awaiting the
			// human / post-approval executor that owns it. Nothing to do
			// here — the run is at rest, not stalled.
			return 'completion-pending';
		}

		const activated = await this.activateRestartRecoveryDownstreamNodes(run, executions);
		if (activated) return 'skipped';

		// Genuinely stalled with no completion signal — flag the run
		// as blocked so the user-facing task surfaces in the "Needs Attention"
		// group rather than appearing in_progress forever.
		//
		// We use `execution_failed` as the block reason (the most accurate of
		// the existing `SpaceBlockReason` values for "node terminated without
		// reaching completion") and a dedicated, restart-aware `result`
		// message so operators can distinguish this from the in-tick blocked
		// path.
		await this.transitionRunStatusAndEmit(run.id, 'blocked');
		if (canonicalTask) {
			const result =
				'Workflow run stalled across daemon restart: all node executions ' +
				'terminated (idle/cancelled) without a completion signal. The run ' +
				'will auto-retry or escalate for human attention.';
			await this.updateTaskAndEmit(run.spaceId, canonicalTask.id, {
				status: 'blocked',
				blockReason: 'execution_failed',
				result,
				completedAt: null,
			});
			await this.safeNotify({
				kind: 'task_blocked',
				spaceId: run.spaceId,
				taskId: canonicalTask.id,
				reason: result,
				timestamp: new Date().toISOString(),
			});
		}
		await this.safeNotify({
			kind: 'workflow_run_blocked',
			spaceId: run.spaceId,
			runId: run.id,
			reason: 'Daemon restart left workflow run stalled with no completion signal',
			timestamp: new Date().toISOString(),
		});
		log.warn(
			`SpaceRuntime.recoverStalledRuns: run ${run.id} (space ${run.spaceId}) was in_progress ` +
				`with all node executions idle/cancelled and no completion signal — flagged blocked`
		);
		return 'blocked';
	}

	private async blockRunWithMissingWorkflow(
		run: SpaceWorkflowRun,
		executions: NodeExecution[]
	): Promise<void> {
		const reason = `Workflow ${run.workflowId} no longer exists; workflow run cannot continue`;
		const now = Date.now();
		for (const execution of executions) {
			if (execution.status === 'cancelled') continue;
			if (execution.agentSessionId) {
				this.config.taskAgentManager?.cancelBySessionId(execution.agentSessionId);
			}
			this.config.nodeExecutionRepo.update(execution.id, {
				status: 'cancelled',
				result: reason,
				completedAt: now,
			});
		}
		await this.transitionRunStatusAndEmit(run.id, 'blocked');
		const canonicalTask = this.pickCanonicalTaskForRun(
			run,
			this.config.taskRepo.listByWorkflowRun(run.id)
		);
		if (canonicalTask) {
			await this.updateTaskAndEmit(run.spaceId, canonicalTask.id, {
				status: 'blocked',
				blockReason: 'workflow_invalid',
				result: reason,
				completedAt: null,
			});
			await this.safeNotify({
				kind: 'task_blocked',
				spaceId: run.spaceId,
				taskId: canonicalTask.id,
				reason,
				timestamp: new Date().toISOString(),
			});
		}
		await this.safeNotify({
			kind: 'workflow_run_blocked',
			spaceId: run.spaceId,
			runId: run.id,
			reason,
			timestamp: new Date().toISOString(),
		});
		log.warn(`SpaceRuntime.recoverStalledRuns: blocked run ${run.id}: ${reason}`);
	}

	private async activateRestartRecoveryDownstreamNodes(
		run: SpaceWorkflowRun,
		executions: NodeExecution[]
	): Promise<boolean> {
		const workflow = this.config.spaceWorkflowManager.getWorkflow(run.workflowId);
		if (!workflow) return false;
		const channels = workflow.channels ?? [];
		if (channels.length === 0) return false;

		const nodeByName = new Map(workflow.nodes.map((node) => [node.name, node]));
		const idleExecutions = executions.filter((execution) => execution.status === 'idle');
		const stalledTransitions: Array<{
			sourceExecution: NodeExecution;
			sourceNode: SpaceWorkflow['nodes'][number];
			channel: WorkflowChannel;
			channelIndex: number;
			targetNames: string[];
		}> = [];
		for (const execution of idleExecutions) {
			const node = workflow.nodes.find((candidate) => candidate.id === execution.workflowNodeId);
			if (!node) continue;
			for (const [channelIndex, channel] of channels.entries()) {
				if (!this.matchesRestartRecoveryChannelSource(channel, node, execution.agentName)) continue;
				const targetNames = this.resolveRestartRecoveryTargetNames(channel, workflow).filter(
					(targetName) => {
						const targetNode = nodeByName.get(targetName);
						return (
							!targetNode ||
							this.shouldRecoverRestartRecoveryTarget(targetNode, executions, workflow.endNodeId)
						);
					}
				);
				if (targetNames.length === 0) continue;
				stalledTransitions.push({
					sourceExecution: execution,
					sourceNode: node,
					channel,
					channelIndex,
					targetNames,
				});
			}
		}
		const createdOrReset: string[] = [];
		const blockedGateReasons: string[] = [];

		for (const {
			sourceExecution,
			sourceNode,
			channel,
			channelIndex,
			targetNames,
		} of stalledTransitions) {
			const cycleResult = this.evaluateRestartRecoveryCycle(
				run.id,
				workflow,
				channel,
				channelIndex
			);
			if (!cycleResult.open) {
				blockedGateReasons.push(cycleResult.reason);
				continue;
			}
			let activatedOnChannel = false;
			for (const targetName of targetNames) {
				const targetNode = nodeByName.get(targetName);
				if (!targetNode || targetNode.id === sourceNode.id) continue;

				const gateResult = await this.evaluateRestartRecoveryChannelGate(run.id, workflow, channel);
				if (!gateResult.open) {
					blockedGateReasons.push(
						gateResult.reason ?? `Gate ${channel.gateId ?? 'unknown'} blocked channel ${channel.id}`
					);
					continue;
				}

				let activatedForTarget = false;
				let resetExistingTarget = false;
				for (const agentEntry of resolveNodeAgents(targetNode)) {
					const existing = this.config.nodeExecutionRepo
						.listByNode(run.id, targetNode.id)
						.find((execution) => execution.agentName === agentEntry.name);
					if (existing) {
						if (existing.status === 'idle' || existing.status === 'cancelled') {
							this.config.nodeExecutionRepo.update(existing.id, {
								status: 'pending',
								result: null,
								startedAt: null,
								completedAt: null,
							});
							activatedForTarget = true;
							resetExistingTarget = true;
						}
						continue;
					}
					this.config.nodeExecutionRepo.createOrIgnore({
						workflowRunId: run.id,
						workflowNodeId: targetNode.id,
						agentName: agentEntry.name,
						agentId: agentEntry.agentId ?? null,
						status: 'pending',
					});
					activatedForTarget = true;
				}
				if (activatedForTarget) {
					createdOrReset.push(targetNode.name);
					activatedOnChannel = true;
					this.enqueueRestartRecoveryMessage(
						run,
						sourceExecution.agentName,
						targetNode,
						resetExistingTarget
					);
				}
			}
			if (activatedOnChannel) {
				this.recordRestartRecoveryCycleTraversal(run.id, workflow, channel, channelIndex);
			}
		}

		if (createdOrReset.length > 0) {
			log.warn(
				`SpaceRuntime.recoverStalledRuns: recovered run ${run.id} by activating downstream node(s): ${[
					...new Set(createdOrReset),
				].join(', ')}`
			);
			return true;
		}
		if (blockedGateReasons.length > 0) {
			log.warn(
				`SpaceRuntime.recoverStalledRuns: run ${run.id} has downstream transition(s) but gate(s) are closed: ${[
					...new Set(blockedGateReasons),
				].join('; ')}`
			);
		}
		return false;
	}

	private evaluateRestartRecoveryCycle(
		runId: string,
		workflow: SpaceWorkflow,
		channel: WorkflowChannel,
		channelIndex: number
	): { open: true } | { open: false; reason: string } {
		if (!isChannelCyclic(channelIndex, workflow.channels ?? [], workflow.nodes)) {
			return { open: true };
		}
		const maxCycles = channel.maxCycles ?? 5;
		const cycleRepo = new ChannelCycleRepository(this.config.db);
		const record = cycleRepo.get(runId, channelIndex);
		if (record && record.count >= maxCycles) {
			return {
				open: false,
				reason: `Cyclic channel "${channel.id ?? channelIndex}" has reached the maximum cycle count (${maxCycles}). Increase maxCycles to allow more cycles.`,
			};
		}
		return { open: true };
	}

	private recordRestartRecoveryCycleTraversal(
		runId: string,
		workflow: SpaceWorkflow,
		channel: WorkflowChannel,
		channelIndex: number
	): void {
		if (!isChannelCyclic(channelIndex, workflow.channels ?? [], workflow.nodes)) return;
		const maxCycles = channel.maxCycles ?? 5;
		const cycleRepo = new ChannelCycleRepository(this.config.db);
		const gateDataRepo = new GateDataRepository(this.config.db);
		const cyclicGates = (workflow.gates ?? []).filter((gate) => gate.resetOnCycle);
		const increment = () => {
			for (const gate of cyclicGates) {
				gateDataRepo.reset(runId, gate.id, computeGateDefaults(gate.fields ?? []));
			}
			return cycleRepo.incrementCycleCount(runId, channelIndex, maxCycles);
		};
		const incremented =
			cyclicGates.length > 0 ? this.config.db.transaction(increment)() : increment();
		if (!incremented) {
			log.warn(
				`SpaceRuntime.recoverStalledRuns: cyclic channel "${channel.id ?? channelIndex}" reached maxCycles during recovery activation`
			);
		}
	}

	private matchesRestartRecoveryChannelSource(
		channel: WorkflowChannel,
		sourceNode: SpaceWorkflow['nodes'][number],
		sourceAgentName: string
	): boolean {
		return (
			channel.from === '*' || channel.from === sourceNode.name || channel.from === sourceAgentName
		);
	}

	private shouldRecoverRestartRecoveryTarget(
		targetNode: SpaceWorkflow['nodes'][number],
		executions: NodeExecution[],
		endNodeId?: string
	): boolean {
		if (targetNode.id === endNodeId) return true;
		const executionsByAgent = new Map(
			executions
				.filter((execution) => execution.workflowNodeId === targetNode.id)
				.map((execution) => [execution.agentName, execution])
		);
		return resolveNodeAgents(targetNode).some((agentEntry) => {
			const execution = executionsByAgent.get(agentEntry.name);
			return !execution || execution.status !== 'idle';
		});
	}

	private resolveRestartRecoveryTargetNames(
		channel: WorkflowChannel,
		workflow: SpaceWorkflow
	): string[] {
		const rawTargets = Array.isArray(channel.to) ? channel.to : [channel.to];
		const resolvedTargets = new Set<string>();
		for (const rawTarget of rawTargets) {
			const targetNode = workflow.nodes.find(
				(node) =>
					node.name === rawTarget ||
					node.id === rawTarget ||
					resolveNodeAgents(node).some((agent) => agent.name === rawTarget)
			);
			resolvedTargets.add(targetNode?.name ?? rawTarget);
		}
		return [...resolvedTargets];
	}

	private async evaluateRestartRecoveryChannelGate(
		runId: string,
		workflow: SpaceWorkflow,
		channel: WorkflowChannel
	): Promise<{ open: boolean; reason?: string }> {
		if (!channel.gateId) return { open: true };
		const storedGate = (workflow.gates ?? []).find((candidate) => candidate.id === channel.gateId);
		if (!storedGate) {
			return {
				open: false,
				reason: `Gate "${channel.gateId}" not found — channel "${channel.id}" is closed (misconfiguration)`,
			};
		}
		let gate = storedGate;
		if (workflow.templateName && storedGate.script) {
			const liveScript = getBuiltInGateScript(workflow.templateName, storedGate.id);
			if (liveScript) gate = { ...storedGate, script: liveScript };
		}
		const gateDataRepo = new GateDataRepository(this.config.db);
		const runtimeData =
			gateDataRepo.get(runId, gate.id)?.data ?? computeGateDefaults(gate.fields ?? []);
		const run = this.config.workflowRunRepo.getRun(runId);
		const space = await this.config.spaceManager.getSpace(workflow.spaceId);
		const result = await evaluateGate(gate, runtimeData, executeGateScript, {
			workspacePath: space?.workspacePath ?? process.cwd(),
			gateId: gate.id,
			runId,
			gateData: runtimeData,
			workflowStartIso: run ? new Date(run.createdAt).toISOString() : undefined,
		});
		return { open: result.open, reason: result.reason };
	}

	private enqueueRestartRecoveryMessage(
		run: SpaceWorkflowRun,
		lastAgentName: string,
		targetNode: SpaceWorkflow['nodes'][number],
		resetExistingTarget: boolean
	): void {
		const repo = this.config.pendingMessageRepo;
		if (!repo) return;
		const tasks = this.config.taskRepo.listByWorkflowRun(run.id);
		const task = this.pickCanonicalTaskForRun(run, tasks);
		const message = resetExistingTarget
			? `[Daemon restart recovery] The ${targetNode.name} node's previous session ended before completing the workflow. Please check the PR and review status, then continue.`
			: `[Daemon restart recovery] The previous agent (${lastAgentName}) completed but the handoff message was not delivered. Please check the PR and review status, then continue.`;
		for (const agentEntry of resolveNodeAgents(targetNode)) {
			repo.enqueue({
				workflowRunId: run.id,
				spaceId: run.spaceId,
				taskId: task?.id ?? null,
				sourceAgentName: lastAgentName,
				targetKind: 'node_agent',
				targetAgentName: agentEntry.name,
				message,
				idempotencyKey: `daemon-restart-recovery:${targetNode.id}:${agentEntry.name}`,
			});
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
	 * Agents drive workflow progression themselves via send_message and
	 * `task.reportedStatus`. This method never calls advance() directly.
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
	private resetWorkflowNodeExecutionForSpawnRetry(
		runId: string,
		execution: NodeExecution,
		reason: string,
		sessionId: string | null = execution.agentSessionId
	): boolean {
		const crashKey = `${runId}:${execution.id}`;
		const crashCount = (this.taskCrashCounts.get(crashKey) ?? 0) + 1;
		this.taskCrashCounts.set(crashKey, crashCount);
		const exhausted = crashCount > MAX_TASK_AGENT_CRASH_RETRIES;
		if (exhausted) {
			log.warn(
				`SpaceRuntime: workflow node agent spawn/retry failed for execution ${execution.id} ` +
					`(session ${sessionId ?? 'none'}); marking blocked after ${crashCount} failures ` +
					`(limit: ${MAX_TASK_AGENT_CRASH_RETRIES}): ${reason}`
			);
			this.config.nodeExecutionRepo.update(execution.id, {
				startedAt: null,
				status: 'blocked',
				result: `Agent session failed to spawn or crashed ${crashCount} times consecutively: ${reason}`,
			});
			return true;
		}

		log.warn(
			`SpaceRuntime: workflow node agent spawn/retry failed for execution ${execution.id} ` +
				`(session ${sessionId ?? 'none'}); resetting execution to pending ` +
				`(failure ${crashCount}/${MAX_TASK_AGENT_CRASH_RETRIES}): ${reason}`
		);
		this.config.nodeExecutionRepo.update(execution.id, {
			startedAt: null,
			status: 'pending',
			result: null,
			completedAt: null,
		});
		return false;
	}

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
					blockReason: 'workflow_invalid',
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

		// ─── Completion bypass ───────────────────────────────────────────────
		// If the canonical task is either already terminal or the end-node agent
		// has reported a result, skip blocked/timeout notifications for sibling
		// nodes and proceed directly to completion handling. This prevents
		// spurious "task_blocked" notifications for sibling nodes that are still
		// running when the end node finishes first.
		//
		// Cached for reuse below at the completion-detection branch — neither
		// `task.status` nor `reportedStatus` changes between here and there.
		const endNodeId = meta.workflow.endNodeId;
		const runIsComplete = this.completionDetector.isComplete({ workflowRunId: runId });

		// Detect execution-level blocked BEFORE the all-completed guard.
		// When the run is already complete, skip blocked notifications for
		// siblings — the run will be completed imminently.
		if (!runIsComplete && nodeExecutions.some((execution) => execution.status === 'blocked')) {
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
					blockReason: 'execution_failed',
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
		// Skip when the run is already complete — it's about to finalize.
		const space = await this.config.spaceManager.getSpace(meta.spaceId);
		if (!runIsComplete) {
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
		// themselves via send_message and `task.reportedStatus` — SpaceRuntime
		// never calls advance().
		if (this.config.taskAgentManager) {
			const tam = this.config.taskAgentManager;
			let blockedByCrash = false;

			// Snapshot which executions were already pending before this tick's
			// liveness/auto-complete processing. The repair loop below uses this
			// to avoid re-elevating executions that were just force-idled and
			// then reset to pending within the same tick.
			const preTickPendingIds = new Set(
				nodeExecutions.filter((e) => e.status === 'pending').map((e) => e.id)
			);

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

				// Part C (task #138): if the dead session was sitting in
				// `waiting_for_input`, the persisted AskUserQuestion card is now
				// unanswerable. Try to flip it to `cancelled` (cancelReason
				// `agent_session_terminated`) so the UI removes the dead-end
				// rather than rendering a permanently-frozen card. Best-effort:
				// the AgentSession instance may already be gone from every map.
				try {
					const liveSession = tam.getAgentSessionById(execution.agentSessionId);
					if (liveSession) {
						await liveSession.markPendingQuestionOrphaned('agent_session_terminated');
					}
				} catch (err) {
					log.warn(
						`SpaceRuntime: failed to clean up pending question for crashed session ${execution.agentSessionId}:`,
						err
					);
				}

				const exhausted = this.resetWorkflowNodeExecutionForSpawnRetry(
					runId,
					execution,
					'agent session is no longer alive',
					execution.agentSessionId
				);
				if (exhausted) {
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
				await this.blockRunForAgentCrash(runId, meta.spaceId, canonicalTask, nodeExecutions);
				return;
			}

			const stoppedAfterWaitingRebind = await this.handleWaitingRebindExecutions(
				runId,
				run,
				meta.spaceId,
				canonicalTask
			);
			if (stoppedAfterWaitingRebind) {
				return;
			}
			nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);

			// Step 1.5: Auto-complete alive agents that have exceeded their timeout.
			// Transitions to 'idle' — the same state as a naturally completing session.
			//
			// Part D (task #138): a session in `waiting_for_input` is *legitimately*
			// blocked on a human, not stuck. Force-completing it here turns the
			// pending AskUserQuestion card into a dead-end (Submit/Skip have no
			// resolver to wake) and confuses the user. Skip those sessions; the
			// long-term fix (Tier 0) removes Step 1.5 entirely.
			let autoCompleted = 0;
			let skippedWaitingForInput = 0;
			const now = Date.now();
			for (const execution of nodeExecutions) {
				if (execution.status !== 'in_progress' || !execution.agentSessionId) continue;
				if (!tam.isSessionAlive(execution.agentSessionId)) continue;

				const timeoutMs =
					resolveTimeoutForExecution(execution, meta.workflow) ?? DEFAULT_NODE_TIMEOUT_MS;
				const referenceTime = execution.startedAt ?? execution.createdAt;
				const elapsedMs = now - referenceTime;
				if (elapsedMs <= timeoutMs) continue;
				const toolGraceMs = Math.min(timeoutMs, 60_000);
				if (this.toolContinuationRepo.hasActiveToolUseForExecution(execution.id, toolGraceMs)) {
					const reason =
						`Agent exceeded timeout with an in-flight tool call; moved to waiting_rebind ` +
						`for ${Math.round(toolGraceMs / 1000)}s continuation recovery grace`;
					this.toolContinuationRepo.markExecutionWaitingRebind(execution.id, reason);
					continue;
				}

				// Part D guard: spare sessions waiting for user input. The agent is
				// not stuck — a human is.
				const liveSession = tam.getAgentSessionById(execution.agentSessionId);
				if (liveSession?.getProcessingState().status === 'waiting_for_input') {
					skippedWaitingForInput++;
					continue;
				}

				const timeoutMinutes = Math.round(timeoutMs / 60_000);

				// Defensive Part C call: the Part D guard above already skips
				// `waiting_for_input` sessions, so by construction this code only
				// runs for sessions that are NOT in `waiting_for_input` — and
				// `markPendingQuestionOrphaned` is a no-op (returns false) for
				// those. We keep the call as belt-and-braces against a future
				// refactor that loosens the guard or introduces an `await`
				// between the guard and this point. Best-effort: never let
				// cleanup failure block the auto-complete.
				if (liveSession) {
					try {
						await liveSession.markPendingQuestionOrphaned('agent_session_terminated');
					} catch (err) {
						log.warn(
							`SpaceRuntime: failed to clean up pending question for session ${execution.agentSessionId}:`,
							err
						);
					}
				}

				this.config.nodeExecutionRepo.update(execution.id, {
					status: 'idle',
					result: `Auto-completed: agent timed out after ${timeoutMinutes} minutes`,
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
			if (skippedWaitingForInput > 0) {
				log.info(
					`SpaceRuntime: spared ${skippedWaitingForInput} node agent(s) blocked on waiting_for_input for run ${runId}`
				);
			}

			nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);

			const nonTerminalIdleOutcome = await this.handleNonTerminalIdleExecutions(
				runId,
				meta.spaceId,
				canonicalTask
			);
			if (nonTerminalIdleOutcome === 'blocked') {
				return;
			}
			nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);

			if (
				canonicalTask.status === 'done' ||
				canonicalTask.status === 'cancelled' ||
				canonicalTask.status === 'archived'
			) {
				const stoppedAfterTerminalHandoffCleanup = await this.repairQueuedWorkflowNodeHandoffs(
					runId,
					run,
					meta,
					canonicalTask,
					space ?? null
				);
				if (stoppedAfterTerminalHandoffCleanup) {
					return;
				}
			}

			// Step 1.6: Completion detection.
			//
			// Reuses the `runIsComplete` snapshot from above — neither `task.status`
			// nor `reportedStatus` is mutated between the two checks (the recovery
			// branches that could change them all `return` before reaching here).
			//
			// In the reported-but-not-yet-resolved case, dispatch through the
			// PostApprovalRouter (PR 2/5). The router handles the terminal
			// transition — `approved`→(inline/spawn/already-routed) or directly
			// to `done` when no route is defined. End-node agents signal
			// completion by setting `task.reportedStatus`, not by calling
			// `setTaskStatus` directly.
			if (runIsComplete) {
				await this.transitionRunStatusAndEmit(runId, 'done');
				const summary = this.resolveCompletionSummary(runId, meta.workflow);
				const reportedSummary = canonicalTask.reportedSummary ?? null;
				const nextTaskResult = summary ?? reportedSummary ?? canonicalTask.result ?? null;

				// Skip re-resolution when the task is already at a non-`open`/non-`in_progress`
				// status — `done`/`cancelled` are terminal; `approved` means
				// PostApprovalRouter already ran once. `review` can only occur via
				// gate-type checkpoints now that completion actions are removed.
				const taskAlreadyResolved =
					canonicalTask.status === 'done' ||
					canonicalTask.status === 'review' ||
					canonicalTask.status === 'cancelled' ||
					canonicalTask.status === 'approved';

				// Final status drives sibling cancellation. We only kill siblings when
				// the task reached a true terminal state (`done`/`cancelled`).
				let finalTaskStatus: SpaceTask['status'] = canonicalTask.status;

				if (!taskAlreadyResolved) {
					if (nextTaskResult && canonicalTask.result !== nextTaskResult) {
						await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, {
							result: nextTaskResult,
						});
					}
					const result = await this.dispatchPostApproval(canonicalTask.id, 'agent');
					// Resolve the final status from the router result. 'no-route'
					// moved directly to done; 'inline' / 'spawn' / 'already-routed'
					// parked at approved awaiting mark_complete.
					finalTaskStatus =
						result.mode === 'no-route'
							? 'done'
							: result.mode === 'skipped'
								? canonicalTask.status
								: 'approved';
				} else if (summary && canonicalTask.result !== summary) {
					await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, { result: summary });
				}

				// Sibling NodeExecution quiescing: interrupt siblings still in_progress
				// when the canonical task reaches a terminal status, transitioning them
				// to `idle` so they remain reachable via send_message. The end-node
				// execution itself is excluded so its session can finish writing back
				// to the agent (it set `task.reportedStatus`, which triggered this
				// completion path). Skipped when the task is paused at `review` —
				// the human may yet reject the completion, in which case sibling
				// progress is still relevant.
				//
				// Sessions are deliberately NOT deleted here — they are only destroyed
				// when the task transitions to `archived` (the true non-recoverable
				// terminal state). This allows post-completion cross-node messaging,
				// e.g. a reviewer sending follow-up feedback to a coder whose node
				// already finished while the PR is still being merged.
				const taskTerminal = finalTaskStatus === 'done' || finalTaskStatus === 'cancelled';
				if (taskTerminal) {
					const siblingsToQuiesce = this.config.nodeExecutionRepo
						.listByWorkflowRun(runId)
						.filter(
							(e) =>
								e.status === 'in_progress' &&
								e.agentSessionId &&
								(!endNodeId || e.workflowNodeId !== endNodeId)
						);
					for (const sibling of siblingsToQuiesce) {
						this.config.nodeExecutionRepo.updateStatus(sibling.id, 'idle');
						if (this.config.taskAgentManager) {
							void this.config.taskAgentManager
								.interruptBySessionId(sibling.agentSessionId!)
								.catch((err) => {
									log.warn(
										`SpaceRuntime: failed to interrupt sibling session ${sibling.agentSessionId}:`,
										err
									);
								});
						}
						log.info(
							`SpaceRuntime: quiesced sibling node execution ${sibling.id} ` +
								`(node ${sibling.workflowNodeId}, agent ${sibling.agentName}) ` +
								`to idle for completed run ${runId}; session kept alive for post-completion messaging`
						);
					}
				}

				return;
			}

			// Step 2: Spawn workflow node agents for pending executions without sessions.
			// Skip spawning for paused or stopped spaces — completion/timeout/crash detection above
			// still runs so in-flight agents are monitored, but no new agents are started.
			if (space?.paused || space?.stopped) return;

			const hasQueuedNodeHandoff =
				this.config.pendingMessageRepo
					?.listPendingForRun(runId)
					.some((row) => row.targetKind === 'node_agent') ?? false;
			if (!space && !hasQueuedNodeHandoff) return;

			const stoppedAfterQueuedHandoffRepair = await this.repairQueuedWorkflowNodeHandoffs(
				runId,
				run,
				meta,
				canonicalTask,
				space ?? null
			);
			if (stoppedAfterQueuedHandoffRepair) {
				return;
			}

			nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);
			for (const execution of nodeExecutions) {
				if (execution.status !== 'pending') continue;
				if (!execution.agentSessionId) continue;
				if (!preTickPendingIds.has(execution.id)) continue;
				if (tam.isSessionAlive(execution.agentSessionId)) {
					log.warn(
						`SpaceRuntime: repaired pending execution ${execution.id} with live session ${execution.agentSessionId}`
					);
					this.config.nodeExecutionRepo.update(execution.id, {
						status: 'in_progress',
						agentSessionId: execution.agentSessionId,
						startedAt: execution.startedAt ?? Date.now(),
						completedAt: null,
					});
				}
				// Dead session on a pending execution: spawn will overwrite the
			}
			nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);
			const pendingExecutions = nodeExecutions.filter(
				(execution) => execution.status === 'pending'
			);

			// Skip spawning when the canonical task is terminal (done/cancelled/archived).
			// The task was externally resolved while the run was in_progress — spawning new
			// agent sub-sessions would conflict with the caller's intent and disturb tests
			// that mark the task done to prevent agent interference.
			const canonicalTaskIsTerminal =
				canonicalTask.status === 'done' ||
				canonicalTask.status === 'cancelled' ||
				canonicalTask.status === 'archived';

			if (pendingExecutions.length > 0 && canonicalTaskIsTerminal) {
				log.info(
					`SpaceRuntime: skipping agent spawn for run ${runId} — canonical task ${canonicalTask.id} is terminal (${canonicalTask.status})`
				);
			} else if (pendingExecutions.length > 0) {
				if (!space) {
					log.warn(
						`SpaceRuntime: cannot spawn workflow node agents for run ${runId} — space ${meta.spaceId} not found`
					);
				} else {
					let permanentSpawnFailureReason: string | null = null;
					for (const execution of pendingExecutions) {
						if (tam.isExecutionSpawning(execution.id)) continue;
						try {
							await tam.spawnWorkflowNodeAgentForExecution(
								canonicalTask,
								space,
								meta.workflow,
								run,
								execution,
								{
									kickoff: true,
								}
							);
						} catch (err) {
							if (this.cancelExecutionForPermanentSpawnError(execution, err)) {
								permanentSpawnFailureReason = err instanceof Error ? err.message : String(err);
								continue;
							}
							const stale = this.config.nodeExecutionRepo.getById(execution.id) ?? execution;
							if (
								stale.status === 'cancelled' ||
								stale.status === 'blocked' ||
								stale.status === 'idle'
							) {
								log.warn(
									`SpaceRuntime: preserving terminal execution ${execution.id} (${stale.status}) after spawn failure: ${err instanceof Error ? err.message : String(err)}`
								);
								continue;
							}
							if (stale.agentSessionId) {
								tam.cancelBySessionId(stale.agentSessionId);
							}
							if (
								this.resetWorkflowNodeExecutionForSpawnRetry(
									runId,
									stale,
									err instanceof Error ? err.message : String(err),
									stale.agentSessionId
								)
							) {
								blockedByCrash = true;
							}
							log.warn(
								`SpaceRuntime: transient spawn failure for workflow node execution ${execution.id}: ${err instanceof Error ? err.message : String(err)}`
							);
						}
					}
					if (permanentSpawnFailureReason) {
						const refreshedExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);
						const hasDriveableExecution = refreshedExecutions.some(
							(execution) =>
								execution.status === 'pending' ||
								execution.status === 'in_progress' ||
								execution.status === 'waiting_rebind' ||
								execution.status === 'blocked'
						);
						if (!hasDriveableExecution) {
							await this.blockRunForPermanentSpawnFailure(
								runId,
								meta.spaceId,
								canonicalTask,
								permanentSpawnFailureReason
							);
							return;
						}
					}
					if (blockedByCrash) {
						nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);
						await this.blockRunForAgentCrash(runId, meta.spaceId, canonicalTask, nodeExecutions);
						return;
					}
					if (
						canonicalTask.status === 'open' ||
						(canonicalTask.status === 'review' && canonicalTask.pendingCheckpointType === 'gate')
					) {
						const nowTs = Date.now();
						await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, {
							status: 'in_progress',
							startedAt: canonicalTask.startedAt ?? nowTs,
							completedAt: null,
							pendingCheckpointType: null,
						});
					}
				}
			}

			// Agents drive workflow progression via send_message and
			// `task.reportedStatus`.
			return;
		}
	}

	private async blockRunForPermanentSpawnFailure(
		runId: string,
		spaceId: string,
		canonicalTask: SpaceTask,
		reason: string
	): Promise<void> {
		await this.transitionRunStatusAndEmit(runId, 'blocked');
		await this.updateTaskAndEmit(spaceId, canonicalTask.id, {
			status: 'blocked',
			result: reason,
			blockReason: 'workflow_invalid',
			completedAt: null,
		});
		await this.safeNotify({
			kind: 'workflow_run_blocked',
			spaceId,
			runId,
			reason,
			timestamp: new Date().toISOString(),
		});
	}

	private cancelExecutionForPermanentSpawnError(execution: NodeExecution, err: unknown): boolean {
		if (!isPermanentSpawnError(err)) return false;
		this.config.nodeExecutionRepo.update(execution.id, {
			status: 'cancelled',
			result: err.message,
			completedAt: Date.now(),
		});
		log.warn(
			`SpaceRuntime: cancelled workflow node execution ${execution.id} after permanent spawn failure: ${err.message}`
		);
		return true;
	}

	private async repairQueuedWorkflowNodeHandoffs(
		runId: string,
		run: SpaceWorkflowRun,
		meta: ExecutorMeta,
		canonicalTask: SpaceTask,
		space: Space | null
	): Promise<boolean> {
		const repo = this.config.pendingMessageRepo;
		const tam = this.config.taskAgentManager;
		if (!repo || !tam) return false;

		repo.expireStale(runId);
		const pending = repo.listPendingForRun(runId).filter((row) => row.targetKind === 'node_agent');
		const isTerminalTask =
			canonicalTask.status === 'done' ||
			canonicalTask.status === 'cancelled' ||
			canonicalTask.status === 'archived';

		if (isTerminalTask) {
			const expiredNodeHandoffs = repo
				.listByRunAndStatus(runId, 'expired')
				.filter((row) => row.targetKind === 'node_agent');
			const reason = `Queued workflow handoff cannot be delivered because task ${canonicalTask.id} is terminal (${canonicalTask.status})`;
			for (const row of pending) repo.markFailed(row.id, reason);
			if (pending.length > 0 || expiredNodeHandoffs.length > 0) {
				log.warn(
					`SpaceRuntime: ignored ${pending.length + expiredNodeHandoffs.length} queued handoff(s) for terminal task: ${reason}`
				);
			}
			return false;
		}

		const expiredNodeHandoffs = repo
			.listByRunAndStatus(runId, 'expired')
			.filter((row) => row.targetKind === 'node_agent');
		if (expiredNodeHandoffs.length > 0) {
			const first = expiredNodeHandoffs[0];
			const reason = `Queued workflow handoff to ${first.targetAgentName} expired before delivery after ${first.attempts} attempt(s)`;
			await this.blockRunForQueuedHandoffFailure(runId, meta.spaceId, canonicalTask, reason);
			return true;
		}

		if (pending.length === 0) return false;

		if (!space) {
			let blockedReason: string | null = null;
			const reason = `Cannot activate queued handoff target: space ${meta.spaceId} not found`;
			for (const row of pending) {
				const updated = repo.markAttemptFailed(row.id, reason);
				if (updated?.status === 'failed') {
					blockedReason = `Queued workflow handoff to ${updated.targetAgentName} failed after ${updated.attempts} attempt(s): ${reason}`;
				}
			}
			if (blockedReason) {
				await this.blockRunForQueuedHandoffFailure(
					runId,
					meta.spaceId,
					canonicalTask,
					blockedReason
				);
				return true;
			}
			return false;
		}

		let blockedReason: string | null = null;
		const targets = [...new Set(pending.map((row) => row.targetAgentName))];
		const recordBlockedFlushFailure = (
			targetAgentName: string,
			rowsForCurrentAttempt: typeof pending
		): void => {
			const first = rowsForCurrentAttempt
				.map((row) => repo.getById(row.id))
				.find((row) => row?.status === 'failed');
			if (!first) return;
			blockedReason = `Queued workflow handoff to ${targetAgentName} failed after ${first.attempts} attempt(s): ${first.lastError ?? 'delivery failed'}`;
		};

		for (const targetAgentName of targets) {
			const rowsForTarget = pending.filter((row) => row.targetAgentName === targetAgentName);
			try {
				let execution = this.resolveQueuedHandoffExecution(runId, meta.workflow, targetAgentName);

				if (!execution) {
					const resolved = this.resolveQueuedHandoffTarget(meta.workflow, targetAgentName);
					if (!resolved) {
						throw new Error(
							`Queued workflow handoff target "${targetAgentName}" is not declared in workflow "${meta.workflow.id}"`
						);
					}
					execution = this.config.nodeExecutionRepo.createOrIgnore({
						workflowRunId: runId,
						workflowNodeId: resolved.nodeId,
						agentName: resolved.agentName,
						agentId: resolved.agentId,
						status: 'pending',
					});
				}

				if (execution.status === 'waiting_rebind') {
					continue;
				}

				await tam.tryResumeNodeAgentSession(runId, execution.agentName);
				execution = this.config.nodeExecutionRepo.getById(execution.id) ?? execution;
				if (execution.status === 'waiting_rebind') {
					continue;
				}

				if (execution.agentSessionId && tam.isSessionAlive(execution.agentSessionId)) {
					await tam.flushPendingMessagesForTarget(
						runId,
						execution.agentName,
						execution.agentSessionId
					);
					recordBlockedFlushFailure(targetAgentName, rowsForTarget);
					continue;
				}

				if (execution.agentSessionId && !tam.isSessionAlive(execution.agentSessionId)) {
					this.resetWorkflowNodeExecutionForSpawnRetry(
						runId,
						execution,
						'queued handoff execution referenced a dead session before spawn',
						execution.agentSessionId
					);
					execution = this.config.nodeExecutionRepo.getById(execution.id) ?? execution;
					if (execution.status === 'blocked') {
						blockedReason = execution.result ?? 'Queued workflow handoff target failed to spawn';
						continue;
					}
				}

				if (execution.status === 'blocked') {
					this.config.nodeExecutionRepo.update(execution.id, {
						status: 'pending',
						result: null,
						completedAt: null,
					});
					execution = this.config.nodeExecutionRepo.getById(execution.id) ?? execution;
				}

				if (tam.isExecutionSpawning(execution.id)) {
					continue;
				}

				const sessionId = await tam.spawnWorkflowNodeAgentForExecution(
					canonicalTask,
					space,
					meta.workflow,
					run,
					execution,
					{ kickoff: true }
				);
				await tam.flushPendingMessagesForTarget(runId, execution.agentName, sessionId);
				recordBlockedFlushFailure(targetAgentName, rowsForTarget);
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				if (isPermanentSpawnError(err)) {
					log.warn(
						`SpaceRuntime: queued workflow handoff target ${targetAgentName} has permanent spawn failure: ${errMsg}`
					);
				} else {
					log.warn(
						`SpaceRuntime: queued workflow handoff repair failed for target ${targetAgentName}: ${errMsg}`
					);
				}
				const maybeExecution = this.resolveQueuedHandoffExecution(
					runId,
					meta.workflow,
					targetAgentName
				);
				if (maybeExecution) this.cancelExecutionForPermanentSpawnError(maybeExecution, err);
				for (const row of rowsForTarget) {
					const updated = repo.markAttemptFailed(row.id, errMsg);
					if (updated?.status === 'failed') {
						blockedReason = `Queued workflow handoff to ${targetAgentName} failed after ${updated.attempts} attempt(s): ${errMsg}`;
					}
				}
			}
		}

		if (blockedReason) {
			await this.blockRunForQueuedHandoffFailure(runId, meta.spaceId, canonicalTask, blockedReason);
			return true;
		}

		return false;
	}

	private resolveQueuedHandoffExecution(
		runId: string,
		workflow: SpaceWorkflow,
		targetAgentName: string
	): NodeExecution | undefined {
		const resolved = this.resolveQueuedHandoffTarget(workflow, targetAgentName);
		if (resolved) {
			const nodeExecution = this.config.nodeExecutionRepo
				.listByNode(runId, resolved.nodeId)
				.filter((candidate) => candidate.agentName === resolved.agentName)
				.at(-1);
			if (nodeExecution) return nodeExecution;
		}

		return this.config.nodeExecutionRepo
			.listByWorkflowRun(runId)
			.filter((candidate) => candidate.agentName === targetAgentName)
			.at(-1);
	}

	private resolveQueuedHandoffTarget(
		workflow: SpaceWorkflow,
		targetAgentName: string
	): { nodeId: string; agentName: string; agentId: string | null } | null {
		for (const node of workflow.nodes) {
			const slots = resolveNodeAgents(node);
			const nodeNameMatch = node.name === targetAgentName || node.id === targetAgentName;
			const direct = slots.find(
				(slot) => slot.name === targetAgentName || (nodeNameMatch && slot.name === node.name)
			);
			if (direct)
				return { nodeId: node.id, agentName: direct.name, agentId: direct.agentId ?? null };
			if (nodeNameMatch && slots[0]) {
				return { nodeId: node.id, agentName: slots[0].name, agentId: slots[0].agentId ?? null };
			}
			if (nodeNameMatch) {
				return { nodeId: node.id, agentName: targetAgentName, agentId: null };
			}
		}
		return null;
	}

	private async blockRunForAgentCrash(
		runId: string,
		spaceId: string,
		canonicalTask: SpaceTask,
		nodeExecutions: NodeExecution[]
	): Promise<void> {
		const blockedReason =
			nodeExecutions.find((execution) => execution.status === 'blocked')?.result ??
			'One or more workflow agents are blocked';
		const dedupKey = `${canonicalTask.id}:blocked`;
		if (!this.notifiedTaskSet.has(dedupKey)) {
			this.notifiedTaskSet.add(dedupKey);
			await this.safeNotify({
				kind: 'task_blocked',
				spaceId,
				taskId: canonicalTask.id,
				reason: blockedReason,
				timestamp: new Date().toISOString(),
			});
		}
		await this.transitionRunStatusAndEmit(runId, 'blocked');
		if (canonicalTask.status !== 'blocked') {
			await this.updateTaskAndEmit(spaceId, canonicalTask.id, {
				status: 'blocked',
				result: blockedReason,
				blockReason: 'agent_crashed',
				completedAt: null,
			});
		}
		await this.safeNotify({
			kind: 'workflow_run_blocked',
			spaceId,
			runId,
			reason: 'One or more tasks require attention',
			timestamp: new Date().toISOString(),
		});
	}

	private async blockRunForQueuedHandoffFailure(
		runId: string,
		spaceId: string,
		canonicalTask: SpaceTask,
		reason: string
	): Promise<void> {
		await this.transitionRunStatusAndEmit(runId, 'blocked');
		await this.updateTaskAndEmit(spaceId, canonicalTask.id, {
			status: 'blocked',
			result: reason,
			blockReason: 'execution_failed',
			completedAt: null,
		});
		await this.safeNotify({
			kind: 'workflow_run_blocked',
			spaceId,
			runId,
			reason,
			timestamp: new Date().toISOString(),
		});
	}

	private async handleNonTerminalIdleExecutions(
		runId: string,
		spaceId: string,
		canonicalTask: SpaceTask
	): Promise<'none' | 'retried' | 'blocked'> {
		// Explicit task completion or pause signals are authoritative. A final tool
		// call may have set reportedStatus or parked the task for human/post-approval
		// review even if the SDK result row has not been persisted yet, so never
		// retry/block when the task already carries one of those lifecycle signals.
		if (
			canonicalTask.reportedStatus !== null ||
			canonicalTask.status === 'review' ||
			canonicalTask.status === 'approved' ||
			canonicalTask.status === 'done' ||
			canonicalTask.status === 'cancelled' ||
			canonicalTask.status === 'archived'
		) {
			return 'none';
		}

		const idleExecutions = this.config.nodeExecutionRepo
			.listByWorkflowRun(runId)
			.filter(
				(execution) =>
					execution.status === 'idle' &&
					execution.agentSessionId &&
					!execution.result?.startsWith('Auto-completed:')
			);
		for (const execution of idleExecutions) {
			const sessionId = execution.agentSessionId;
			if (!sessionId) continue;
			const lastMessage = this.getSdkMessageRepo().getLastSDKMessage(sessionId);
			const classification = classifyLastMessageForIdleAgent(lastMessage);
			if (classification.terminal) {
				this.nonTerminalIdleCounts.delete(`${runId}:${execution.id}`);
				continue;
			}

			const key = `${runId}:${execution.id}`;
			const retryCount = (this.nonTerminalIdleCounts.get(key) ?? 0) + 1;
			this.nonTerminalIdleCounts.set(key, retryCount);
			const reason = `Agent went idle without completing — non-terminal last message (${classification.reason})`;
			log.warn(
				`Node ${execution.workflowNodeId} went idle with non-terminal last message, not advancing: ` +
					`execution=${execution.id} agent=${execution.agentName} session=${sessionId} reason=${classification.reason}`
			);
			await this.safeNotify({
				kind: 'agent_idle_non_terminal',
				spaceId,
				taskId: canonicalTask.id,
				runId,
				executionId: execution.id,
				nodeId: execution.workflowNodeId,
				agentName: execution.agentName,
				reason,
				timestamp: new Date().toISOString(),
			});

			if (retryCount <= MAX_TASK_AGENT_CRASH_RETRIES) {
				this.config.nodeExecutionRepo.update(execution.id, {
					status: 'pending',
					result: reason,
					completedAt: null,
					startedAt: null,
				});
				await this.safeNotify({
					kind: 'task_retry',
					spaceId,
					taskId: canonicalTask.id,
					runId,
					originalReason: reason,
					attemptNumber: retryCount,
					maxAttempts: MAX_TASK_AGENT_CRASH_RETRIES,
					timestamp: new Date().toISOString(),
				});
				return 'retried';
			}

			this.config.nodeExecutionRepo.update(execution.id, {
				status: 'blocked',
				result: reason,
			});
			await this.transitionRunStatusAndEmit(runId, 'blocked');
			await this.updateTaskAndEmit(spaceId, canonicalTask.id, {
				status: 'blocked',
				result: reason,
				blockReason: 'execution_failed',
				completedAt: null,
			});
			await this.safeNotify({
				kind: 'task_blocked',
				spaceId,
				taskId: canonicalTask.id,
				reason,
				timestamp: new Date().toISOString(),
			});
			await this.safeNotify({
				kind: 'workflow_run_blocked',
				spaceId,
				runId,
				reason,
				timestamp: new Date().toISOString(),
			});
			await this.safeNotify({
				kind: 'workflow_run_needs_attention',
				spaceId,
				runId,
				taskId: canonicalTask.id,
				reason,
				retriesExhausted: retryCount - 1,
				timestamp: new Date().toISOString(),
			});
			// Exhaust the blocked-run auto-retry budget so attemptBlockedRunRecovery
			// escalates immediately instead of re-spawning the agent.
			this.blockedRetryCounts.set(runId, MAX_BLOCKED_RUN_RETRIES);
			return 'blocked';
		}
		return 'none';
	}

	private async handleWaitingRebindExecutions(
		runId: string,
		run: SpaceWorkflowRun,
		spaceId: string,
		canonicalTask: SpaceTask
	): Promise<boolean> {
		const waitingExecutions = this.config.nodeExecutionRepo
			.listByWorkflowRun(runId)
			.filter((execution) => execution.status === 'waiting_rebind');
		if (waitingExecutions.length === 0) return false;

		const recoveryStates = waitingExecutions.map((execution) => {
			const data = parseNodeExecutionData(execution.data);
			const recoveryData = isRecord(data.orphanedToolContinuation)
				? data.orphanedToolContinuation
				: {};
			const retryCount = typeof recoveryData.retryCount === 'number' ? recoveryData.retryCount : 0;
			const pendingInbox = this.toolContinuationRepo.listPendingInboxForExecution(execution.id);
			const hasActiveTool = this.toolContinuationRepo.hasActiveToolUseForExecution(execution.id);
			const hasLiveSession = execution.agentSessionId
				? (this.config.taskAgentManager?.isSessionAlive(execution.agentSessionId) ?? false)
				: false;
			return {
				execution,
				data,
				recoveryData,
				retryCount,
				pendingInbox,
				hasActiveTool,
				hasLiveSession,
			};
		});

		for (const state of recoveryStates) {
			const {
				execution,
				data,
				recoveryData,
				retryCount,
				pendingInbox,
				hasActiveTool,
				hasLiveSession,
			} = state;
			if (hasActiveTool || hasLiveSession) {
				continue;
			}

			if (pendingInbox.length > 0 && retryCount < 1) {
				continue;
			}

			const reason =
				retryCount >= 1
					? 'orphaned tool_result recovery exhausted its single automatic retry'
					: 'orphaned tool_result recovery expired before a continuation arrived';
			data.orphanedToolContinuation = {
				...recoveryData,
				state: 'failed',
				retryCount,
				reason,
				updatedAt: Date.now(),
			};
			this.config.nodeExecutionRepo.update(execution.id, {
				status: 'blocked',
				result: reason,
				data,
				completedAt: Date.now(),
			});
			await this.transitionRunStatusAndEmit(run.id, 'blocked');
			await this.updateTaskAndEmit(spaceId, canonicalTask.id, {
				status: 'blocked',
				result: reason,
				blockReason: 'execution_failed',
				completedAt: null,
			});
			await this.safeNotify({
				kind: 'workflow_run_blocked',
				spaceId,
				runId,
				reason,
				timestamp: new Date().toISOString(),
			});
			log.warn(
				`SpaceRuntime: failed orphaned tool_result recovery for execution ${execution.id}: ${reason}`
			);
			return true;
		}

		for (const state of recoveryStates) {
			const { execution, data, recoveryData, retryCount, pendingInbox, hasLiveSession } = state;
			if (hasLiveSession || pendingInbox.length === 0 || retryCount >= 1) {
				continue;
			}

			const reason =
				pendingInbox[0]?.recoveryReason ??
				'orphaned tool_result continuation queued for deterministic retry';
			data.orphanedToolContinuation = {
				...recoveryData,
				state: 'rebound',
				retryCount: retryCount + 1,
				reason,
				queuedContinuations: pendingInbox.length,
				updatedAt: Date.now(),
			};
			this.toolContinuationRepo.markInboxReboundForExecution(
				execution.id,
				'queued orphaned tool_result rebound by restarting workflow node execution'
			);
			this.config.nodeExecutionRepo.update(execution.id, {
				status: 'pending',
				result: null,
				data,
				startedAt: null,
				completedAt: null,
			});
			if (run.status !== 'in_progress') {
				await this.transitionRunStatusAndEmit(run.id, 'in_progress');
			}
			if (canonicalTask.status === 'blocked' || canonicalTask.status === 'open') {
				await this.updateTaskAndEmit(spaceId, canonicalTask.id, {
					status: 'in_progress',
					completedAt: null,
					result: null,
					blockReason: null,
				});
			}
			await this.safeNotify({
				kind: 'task_retry',
				spaceId,
				taskId: canonicalTask.id,
				runId,
				originalReason: reason,
				attemptNumber: retryCount + 1,
				maxAttempts: 1,
				timestamp: new Date().toISOString(),
			});
			log.info(
				`SpaceRuntime: rebound orphaned tool_result continuation for execution ${execution.id}; ` +
					`reset to pending for retry ${retryCount + 1}/1`
			);
		}
		return false;
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

	/**
	 * Build the poll script context for a workflow run.
	 *
	 * Resolves task metadata and PR URL from artifacts for injection as
	 * environment variables into poll scripts.
	 *
	 * @returns PollScriptContext, or null when the task is missing
	 */
	private buildPollScriptContext(
		task: SpaceTask,
		run: SpaceWorkflowRun,
		spaceId: string
	): PollScriptContext | null {
		// Resolve PR URL from artifacts (same pattern as dispatchPostApproval)
		let prUrl = '';
		if (this.config.artifactRepo) {
			try {
				const artifacts = this.config.artifactRepo.listByRun(run.id);
				for (let i = artifacts.length - 1; i >= 0; i--) {
					const data = artifacts[i]?.data;
					if (!data) continue;
					const candidate =
						(typeof data.prUrl === 'string' && data.prUrl) ||
						(typeof data.pr_url === 'string' && data.pr_url);
					if (candidate) {
						prUrl = candidate;
						break;
					}
				}
			} catch {
				// Swallow — PR URL is best-effort for polls
			}
		}

		const prCtx = extractPrContext(prUrl);

		return {
			TASK_ID: task.id,
			TASK_TITLE: task.title,
			SPACE_ID: spaceId,
			PR_URL: prUrl,
			PR_NUMBER: prCtx.PR_NUMBER,
			REPO_OWNER: prCtx.REPO_OWNER,
			REPO_NAME: prCtx.REPO_NAME,
			WORKFLOW_RUN_ID: run.id,
		};
	}

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
				execution.status === 'idle' &&
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
			if (!run || run.status === 'done' || run.status === 'cancelled' || run.status === 'blocked') {
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
				// Stop gate polls for this terminal run
				this.pollManager?.stopPolls(runId);
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
		const spaces = await this.listActiveSpaces();

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
	 * 1. Select a workflow for the task (LLM-driven, with deterministic fallback)
	 * 2. Start a workflow run
	 * 3. Attach the original task to the run and mark it in_progress
	 *
	 * Selection work runs in parallel across tasks so a slow LLM call on one
	 * task does not delay the rest of the tick.
	 */
	private async attachStandaloneTasksToWorkflows(): Promise<void> {
		const spaces = await this.listActiveSpaces();

		for (const space of spaces) {
			const workflows = this.config.spaceWorkflowManager.listWorkflows(space.id);
			if (workflows.length === 0) continue;

			const standaloneOpenTasks = this.config.taskRepo
				.listStandaloneBySpace(space.id, false)
				.filter((task) => task.status === 'open');

			const taskManager = this.getOrCreateTaskManager(space.id);

			// Phase 1 — pick a workflow for every eligible task in parallel. LLM
			// calls dominate the cost, so running them concurrently keeps the
			// tick responsive when a space has many standalone tasks queued.
			const candidates = await Promise.all(
				standaloneOpenTasks.map(async (task) => {
					const fresh = this.config.taskRepo.getTask(task.id);
					if (!fresh || fresh.workflowRunId) return null;
					if (fresh.status !== 'open') return null;
					if (!(await taskManager.areDependenciesMet(fresh))) return null;

					const selected = await this.selectWorkflowForStandaloneTask(fresh, workflows);
					if (!selected) return null;
					return { fresh, selected };
				})
			);

			// Phase 2 — apply the attachments sequentially so repo writes and
			// event emission stay in a predictable order per space.
			for (const candidate of candidates) {
				if (!candidate) continue;
				const { fresh, selected } = candidate;

				// Re-read once more to defend against concurrent updates between
				// phase 1 and phase 2 (e.g. another actor attached the task).
				const current = this.config.taskRepo.getTask(fresh.id);
				if (!current || current.workflowRunId) continue;
				if (current.status !== 'open') continue;

				try {
					const { run } = await this.startWorkflowRun(
						space.id,
						selected.id,
						current.title,
						current.description,
						{ parentTaskId: current.id }
					);

					await this.updateTaskAndEmit(space.id, current.id, {
						workflowRunId: run.id,
						status: 'in_progress',
						startedAt: current.startedAt ?? Date.now(),
						completedAt: null,
					});
				} catch (err) {
					log.warn(
						`SpaceRuntime: failed to attach standalone task ${current.id} to workflow ${selected.id}:`,
						err
					);
				}
			}
		}
	}

	/**
	 * Pick the workflow to run for a standalone task.
	 *
	 * Order of precedence:
	 * 1. `task.preferredWorkflowId` when it resolves to an existing workflow.
	 * 2. The LLM selector (`SpaceRuntimeConfig.selectWorkflowWithLlm`) when
	 *    provided and it returns an id that exists in the candidate list.
	 *    Unknown ids, `null` returns, and thrown errors all fall through.
	 * 3. Deterministic fallback: the first workflow tagged `default`, else the
	 *    first tagged `v2`, else the most recently updated workflow.
	 *
	 * The old substring/keyword scorer was retired in favour of LLM-based
	 * selection because it mis-routed tasks whose descriptions happened to
	 * share words with workflow metadata (e.g. a "review feedback" task
	 * hijacking a "review" workflow even when "coding" was the right fit).
	 */
	private async selectWorkflowForStandaloneTask(
		task: SpaceTask,
		workflows: SpaceWorkflow[]
	): Promise<SpaceWorkflow | null> {
		if (workflows.length === 0) return null;

		// Caller-specified preferred workflow wins over both LLM and deterministic
		// fallback. Fall through if the id doesn't resolve (e.g. workflow was
		// deleted between task creation and attachment).
		if (task.preferredWorkflowId) {
			const explicit = this.config.spaceWorkflowManager.getWorkflow(task.preferredWorkflowId);
			if (explicit) return explicit;
			log.warn(
				`SpaceRuntime: preferred_workflow_id "${task.preferredWorkflowId}" not found for task ${task.id}; selecting a workflow automatically`
			);
		}

		if (workflows.length === 1) return workflows[0];

		const llmSelector = this.config.selectWorkflowWithLlm;
		if (llmSelector) {
			let llmResult: string | null = null;
			try {
				llmResult = await llmSelector(task, workflows);
			} catch (err) {
				log.warn(
					`SpaceRuntime: LLM workflow selector threw for task ${task.id}; using deterministic fallback:`,
					err
				);
				llmResult = null;
			}

			if (llmResult) {
				const hit = workflows.find((w) => w.id === llmResult);
				if (hit) return hit;
				log.warn(
					`SpaceRuntime: LLM workflow selector returned unknown id "${llmResult}" for task ${task.id}; using deterministic fallback`
				);
			}
		}

		return this.selectDeterministicWorkflowFallback(workflows);
	}

	/**
	 * Tiebreak selection when no LLM/preferred workflow is available.
	 *
	 * Preference order:
	 * 1. `default` tag
	 * 2. `v2` tag
	 * 3. Most recently updated workflow
	 */
	private selectDeterministicWorkflowFallback(workflows: SpaceWorkflow[]): SpaceWorkflow | null {
		if (workflows.length === 0) return null;
		if (workflows.length === 1) return workflows[0];

		const scored = workflows.map((workflow) => {
			const tags = workflow.tags ?? [];
			return {
				workflow,
				isDefault: tags.includes('default') ? 1 : 0,
				isV2: tags.includes('v2') ? 1 : 0,
			};
		});

		scored.sort((a, b) => {
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

function parseNodeExecutionData(value: unknown): Record<string, unknown> {
	if (!value) return {};
	if (isRecord(value)) return { ...value };
	if (typeof value !== 'string') return {};
	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasSqlExec(value: unknown): value is { exec: (sql: string) => void } {
	return isRecord(value) && typeof value.exec === 'function';
}
