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
 * and report_result — SpaceRuntime no longer calls advance() directly.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type {
	CompletionAction,
	SpaceAutonomyLevel,
	SpaceTask,
	UpdateSpaceTaskParams,
	SpaceWorkflow,
	SpaceWorkflowRun,
	WorkflowChannel,
} from '@neokai/shared';
import { isAutonomousWithoutActions, resolveNodeAgents } from '@neokai/shared';
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
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository';
import { SDKMessageRepository } from '../../../storage/repositories/sdk-message-repository';
import { type NotificationSink, NullNotificationSink } from './notification-sink';
import { buildRestrictedEnv, collectWithMaxBuffer, MAX_BUFFER_BYTES } from './gate-script-executor';
import { CompletionDetector } from './completion-detector';
import type { SelectWorkflowWithLlm } from './llm-workflow-selector';
import {
	PostApprovalRouter,
	buildTaskApprovedEvent,
	isPostApprovalRoutingEnabled,
	type PostApprovalRouteContext,
	type PostApprovalRouteResult,
} from './post-approval-router';
import type { SpaceApprovalSource } from '@neokai/shared';
import {
	type CompletionActionExecutionResult,
	type InstructionActionExecutor,
	type McpToolExecutor,
	runMcpCallAction,
} from './completion-action-executors';
import {
	MAX_BLOCKED_RUN_RETRIES,
	MAX_TASK_AGENT_CRASH_RETRIES,
	resolveNodeTimeout,
} from './constants';

const log = new Logger('space-runtime');

/**
 * Build the human-readable pause reason stored on `SpaceTask.result` when a
 * task pauses at a completion action awaiting approval. Kept as a standalone
 * helper so tests can assert the exact wording without pulling in the full
 * runtime wiring.
 */
function buildAwaitingApprovalReason(
	action: CompletionAction,
	spaceLevel: SpaceAutonomyLevel
): string {
	return `Awaiting approval: ${action.name} (requires autonomy ${action.requiredLevel}, space is at ${spaceLevel})`;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SpaceRuntimeConfig {
	/** Raw Bun SQLite database — used to create per-space SpaceTaskManagers */
	db: BunDatabase;
	/**
	 * Optional absolute path to the SQLite database file.
	 *
	 * Threaded through from `SpaceRuntimeServiceConfig` so completion action
	 * scripts can query the live DB via the `sqlite3` CLI. Injected into the
	 * script env as `NEOKAI_DB_PATH` (after `buildRestrictedEnv` has stripped
	 * the `NEOKAI_*` prefix). When absent, completion actions that depend on
	 * DB access must detect the missing var and fail fast.
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
	 * Optional artifact repository for resolving completion action context.
	 * When provided, completion actions with `artifactType` can resolve
	 * artifact data from the workflow run for script env injection.
	 */
	artifactRepo?: WorkflowRunArtifactRepository;
	/**
	 * Optional SDK message repository used to emit synthetic SDK messages into
	 * a task's agent session (e.g. the `completion_action_executed` marker
	 * rendered by `SpaceTaskUnifiedThread`). Defaults to a repo constructed
	 * from `db` if not provided — tests can inject a stub to assert emissions.
	 */
	sdkMessageRepo?: SDKMessageRepository;
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
	/**
	 * Optional executor for `instruction` completion actions. Spawns an
	 * ephemeral agent session to verify an outcome. When not provided,
	 * instruction actions fail with a configuration error — the runtime
	 * refuses to silently skip a human-authored verification step.
	 */
	instructionActionExecutor?: InstructionActionExecutor;
	/**
	 * Optional executor for `mcp_call` completion actions. Invokes the named
	 * tool on the named MCP server. When not provided, mcp_call actions fail
	 * with a configuration error.
	 */
	mcpToolExecutor?: McpToolExecutor;
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

	constructor(private config: SpaceRuntimeConfig) {
		this.notificationSink = config.notificationSink ?? new NullNotificationSink();
		this.completionDetector = config.completionDetector ?? new CompletionDetector(config.taskRepo);
		this.sdkMessageRepo = config.sdkMessageRepo ?? null;
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
	 *     flagged the task ready to approve (via `reportedStatus='done'`), when
	 *     `NEOKAI_TASK_AGENT_POST_APPROVAL_ROUTING` is ON. In PR 2/5 the flag
	 *     defaults OFF so production runs continue through
	 *     `resolveCompletionWithActions`.
	 *   - `SpaceRuntimeService.dispatchPostApproval`, invoked from the
	 *     `spaceTask.approvePendingCompletion` RPC handler when a human approves
	 *     a task paused at a `task_completion` checkpoint.
	 *
	 * Contract:
	 *   1. If the task is not already `approved`, transition it there via
	 *      `SpaceTaskManager.setTaskStatus` (so the centralised transition
	 *      validator runs).
	 *   2. Emit a `[TASK_APPROVED]` awareness event into the Task Agent session
	 *      on a best-effort basis (missing session → log + continue).
	 *   3. Call `PostApprovalRouter.route()` — which handles the no-route,
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

		// 2. Emit [TASK_APPROVED] awareness event (informational; best-effort).
		const routeTarget = workflow?.postApproval?.targetAgent ?? null;
		const mode: 'spawning' | 'self' | 'none' =
			routeTarget === null || routeTarget === undefined
				? 'none'
				: routeTarget === 'task-agent'
					? 'self'
					: 'spawning';
		const awarenessBody = buildTaskApprovedEvent({
			task: approvedTask,
			workflow,
			approvalSource,
			mode,
		});
		const manager = this.config.taskAgentManager;
		if (manager) {
			const injected = await manager.injectIntoTaskAgent(taskId, awarenessBody);
			if (!injected.injected) {
				log.warn(
					`dispatchPostApproval: no Task Agent session for task ${taskId} — [TASK_APPROVED] not delivered`
				);
			}
		}

		// 3. Dispatch the actual post-approval step.
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
		const routeContext: PostApprovalRouteContext = {
			...(resolvedPrUrl ? { pr_url: resolvedPrUrl } : {}),
			...contextExtras,
			approvalSource,
			spaceId,
			autonomyLevel: space?.autonomyLevel,
			workspacePath: space?.workspacePath,
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

			// Resolve completion status via completion actions (if defined on end node)
			// or fall back to binary autonomy check.
			const space = await this.config.spaceManager.getSpace(run.spaceId);
			const spaceLevel = (space?.autonomyLevel ?? 1) as SpaceAutonomyLevel;

			// Skip tasks already at a terminal or paused state — matches the
			// active-tick guard (`taskAlreadyResolved`) at processRunTick.
			if (
				canonicalTask.status !== 'done' &&
				canonicalTask.status !== 'review' &&
				canonicalTask.status !== 'cancelled' &&
				canonicalTask.status !== 'approved'
			) {
				// PR 2/5 (flag-gated): when NEOKAI_TASK_AGENT_POST_APPROVAL_ROUTING
				// is ON, skip the legacy completion-action pipeline and dispatch
				// through PostApprovalRouter (transition → approved → route). When
				// the flag is OFF (default), keep the legacy completion-action path
				// intact so production behaviour is unchanged.
				if (isPostApprovalRoutingEnabled()) {
					// Preserve the computed result on the task before routing —
					// dispatchPostApproval handles the status transition itself.
					if (nextResult && canonicalTask.result !== nextResult) {
						await this.updateTaskAndEmit(run.spaceId, canonicalTask.id, { result: nextResult });
					}
					await this.dispatchPostApproval(canonicalTask.id, 'agent');
				} else {
					// The completion-action pipeline is the sole arbiter of terminal
					// status — we no longer read `reportedStatus` from the agent.
					const params = await this.resolveCompletionWithActions(
						run.spaceId,
						run.id,
						workflow,
						nextResult,
						spaceLevel,
						canonicalTask.id
					);
					await this.updateTaskAndEmit(run.spaceId, canonicalTask.id, params);
				}
			} else if (
				nextResult &&
				canonicalTask.result !== nextResult &&
				// Don't clobber the structured pause-reason surfaced on `result` when the
				// task is paused at a completion action — that string is what read
				// surfaces use to explain *why* the task is awaiting review. The
				// original agent output is still recoverable via `reportedSummary`, and
				// `resumeCompletionActions` restores `result` from there on resume.
				!(
					canonicalTask.status === 'review' &&
					canonicalTask.pendingCheckpointType === 'completion_action'
				)
			) {
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

	/**
	 * Resumes completion action execution for a task paused at a pending action.
	 *
	 * Called when a human approves a task that has `pendingCheckpointType === 'completion_action'`.
	 * Executes the pending action (which the human just approved) and continues with
	 * remaining actions. If a later action also requires higher autonomy, the task
	 * pauses again. If all remaining actions complete, the task transitions to 'done'.
	 *
	 * @param options.approvalReason Optional human-supplied rationale for the
	 *   approval. Persisted alongside `approvalSource='human'`/`approvedAt` on
	 *   the terminal `done` transition (stored in the `approval_reason` column).
	 *   Written only on the success path — intermediate re-pauses keep the
	 *   column unchanged so a prior cycle's reason does not leak forward.
	 *
	 * @returns The updated task, or null if the task wasn't in a resumable state.
	 */
	async resumeCompletionActions(
		spaceId: string,
		taskId: string,
		options?: { approvalReason?: string | null }
	): Promise<SpaceTask | null> {
		const task = this.config.taskRepo.getTask(taskId);
		if (!task) {
			log.warn(`SpaceRuntime.resumeCompletionActions: task ${taskId} not found`);
			return null;
		}
		if (task.pendingCheckpointType !== 'completion_action' || task.pendingActionIndex == null) {
			log.warn(
				`SpaceRuntime.resumeCompletionActions: task ${taskId} is not paused at a completion action`
			);
			return null;
		}
		if (!task.workflowRunId) {
			log.warn(`SpaceRuntime.resumeCompletionActions: task ${taskId} has no workflowRunId`);
			return null;
		}

		const run = this.config.workflowRunRepo.getRun(task.workflowRunId);
		if (!run) {
			log.warn(
				`SpaceRuntime.resumeCompletionActions: workflow run ${task.workflowRunId} not found`
			);
			return null;
		}

		// Idempotency guard: if this run's completion actions have already fired
		// once, do not re-execute on resume. This can only happen if the task was
		// reopened after a prior successful completion — completion actions are
		// side-effectful and fire at most once per run.
		if (run.completionActionsFiredAt != null) {
			return await this.finalizeResume(spaceId, taskId, {
				status: 'done',
				result: task.reportedSummary ?? null,
				completedAt: Date.now(),
				approvalSource: 'human',
				approvalReason: options?.approvalReason ?? null,
				approvedAt: Date.now(),
				pendingActionIndex: null,
				pendingCheckpointType: null,
			});
		}

		const workflow = this.config.spaceWorkflowManager.getWorkflow(run.workflowId);
		const endNode = workflow?.nodes.find((n) => n.id === workflow.endNodeId);
		const actions = endNode?.completionActions;
		if (!actions || actions.length === 0) {
			log.warn(`SpaceRuntime.resumeCompletionActions: no completion actions on end node`);
			return null;
		}

		const space = await this.config.spaceManager.getSpace(spaceId);
		if (!space?.workspacePath) {
			log.warn(
				`SpaceRuntime.resumeCompletionActions: space ${spaceId} not found or has no workspacePath`
			);
			return null;
		}

		// Validate that the task belongs to this space
		if (task.spaceId !== spaceId) {
			log.warn(
				`SpaceRuntime.resumeCompletionActions: task ${taskId} belongs to space ${task.spaceId}, not ${spaceId}`
			);
			return null;
		}

		const spaceLevel = (space.autonomyLevel ?? 1) as SpaceAutonomyLevel;
		const startIndex = task.pendingActionIndex;

		// Guard against workflow edits that removed actions between pause and resume
		if (startIndex >= actions.length) {
			log.warn(
				`SpaceRuntime.resumeCompletionActions: pendingActionIndex ${startIndex} >= actions.length ${actions.length} (workflow edited?)`
			);
			return null;
		}

		// Execute the approved action and continue with remaining
		for (let i = startIndex; i < actions.length; i++) {
			const action = actions[i];
			if (i === startIndex || spaceLevel >= action.requiredLevel) {
				// First action was human-approved; subsequent ones auto-execute if autonomy permits
				const result = await this.executeCompletionAction(
					action,
					spaceId,
					run.id,
					space.workspacePath
				);
				if (!result.success) {
					return await this.finalizeResume(spaceId, taskId, {
						status: 'blocked',
						result: result.reason ?? `Completion action "${action.name}" failed`,
					});
				}
				// Emit audit-trail event for each successfully executed action. This
				// covers both the human-approved resume (i === startIndex) and any
				// subsequent auto-executed actions. The human-approved entry is the
				// one most useful to surface in the task thread; downstream renderers
				// can filter by `approvedBy === 'human'` if they want.
				const approvedBy = i === startIndex ? 'human' : 'auto_policy';
				const approvalReason = i === startIndex ? (options?.approvalReason ?? null) : null;
				const executedAt = new Date().toISOString();
				await this.safeNotify({
					kind: 'completion_action_executed',
					spaceId,
					taskId,
					runId: run.id,
					actionId: action.id,
					actionName: action.name,
					approvedBy,
					approvalReason,
					executedAt,
					timestamp: executedAt,
				});
				// Also surface the event in the task's own message stream so
				// SpaceTaskUnifiedThread can render it inline in the timeline. This
				// writes a synthetic SDK system message into the task agent's
				// session (if one exists). No-op when the task never had a Task
				// Agent session — node-agent standalone tasks still get the
				// notification-sink entry above.
				const latestTask = this.config.taskRepo.getTask(taskId);
				if (latestTask?.taskAgentSessionId) {
					this.emitTaskThreadEvent(latestTask.taskAgentSessionId, 'completion_action_executed', {
						spaceId,
						taskId,
						runId: run.id,
						actionId: action.id,
						actionName: action.name,
						approvedBy,
						approvalReason,
						executedAt,
					});
				}
			} else {
				// Pause at this action — clear stale approvedAt from previous cycle and
				// surface a structured pause reason + fresh awaiting-approval event so
				// the Space Agent and UI learn about this new gate.
				const pauseReason = buildAwaitingApprovalReason(action, spaceLevel);
				await this.emitTaskAwaitingApproval(spaceId, taskId, action, spaceLevel);
				return await this.finalizeResume(spaceId, taskId, {
					status: 'review',
					result: pauseReason,
					pendingActionIndex: i,
					pendingCheckpointType: 'completion_action',
					approvedAt: null,
				});
			}
		}

		// All remaining actions executed — task is done. Restore `result` to the
		// original agent summary (the pause-reason string was only relevant while
		// the task was awaiting approval) and persist the human-supplied approval
		// reason (when given) so the audit trail records *why* this task was
		// approved, not just *that* it was.
		// Stamp the run so a future reopen of this workflow run does NOT re-fire
		// completion actions — they are side-effectful and must run at most once.
		this.config.workflowRunRepo.updateRun(run.id, { completionActionsFiredAt: Date.now() });
		return await this.finalizeResume(spaceId, taskId, {
			status: 'done',
			result: task.reportedSummary ?? null,
			completedAt: Date.now(),
			approvalSource: 'human',
			approvalReason: options?.approvalReason ?? null,
			approvedAt: Date.now(),
			pendingActionIndex: null,
			pendingCheckpointType: null,
		});
	}

	/**
	 * Closes the race window between `resumeCompletionActions` and concurrent
	 * tick processing: re-reads the task right before writing and aborts the
	 * write if another caller has already moved it out of the resumable state
	 * (e.g. tick saw a script timeout and flipped the task to `blocked`).
	 *
	 * Without this guard a long-running completion action (scripts can run for
	 * up to two minutes) could finish, see stale state, and overwrite a
	 * legitimate intervening transition.
	 */
	private async finalizeResume(
		spaceId: string,
		taskId: string,
		params: UpdateSpaceTaskParams
	): Promise<SpaceTask | null> {
		const fresh = this.config.taskRepo.getTask(taskId);
		if (!fresh) return null;
		if (fresh.status !== 'review' || fresh.pendingCheckpointType !== 'completion_action') {
			log.warn(
				`SpaceRuntime.finalizeResume: task ${taskId} state changed mid-resume ` +
					`(now status=${fresh.status}, checkpoint=${fresh.pendingCheckpointType}); aborting write`
			);
			return fresh;
		}
		return await this.updateTaskAndEmit(spaceId, taskId, params);
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
	 * Agents drive workflow progression themselves via send_message and report_result.
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
		// awaiting_approval entries are keyed per (task, action); clear them when the
		// task is no longer paused at a completion action so a future pause — even on
		// the same action — can fire a fresh event.
		if (
			canonicalTask.status !== 'review' ||
			canonicalTask.pendingCheckpointType !== 'completion_action'
		) {
			const awaitingPrefix = `${canonicalTask.id}:awaiting_approval:`;
			for (const key of this.notifiedTaskSet) {
				if (key.startsWith(awaitingPrefix)) {
					this.notifiedTaskSet.delete(key);
				}
			}
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
		// themselves via send_message and report_result — SpaceRuntime never calls advance().
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
						blockReason: 'agent_crashed',
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

			// Step 1.5: Auto-complete alive agents that have exceeded their timeout.
			// Transitions to 'idle' — the same state as a naturally completing session.
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

			nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);

			// Step 1.6: Completion detection.
			//
			// Reuses the `runIsComplete` snapshot from above — neither `task.status`
			// nor `reportedStatus` is mutated between the two checks (the recovery
			// branches that could change them all `return` before reaching here).
			//
			// In the reported-but-not-yet-resolved case, we resolve the final task
			// status here through `resolveCompletionWithActions` — which respects
			// the supervised-mode review gate. This is why `report_result` no
			// longer calls `setTaskStatus` directly.
			if (runIsComplete) {
				await this.transitionRunStatusAndEmit(runId, 'done');
				const summary = this.resolveCompletionSummary(runId, meta.workflow);
				const reportedSummary = canonicalTask.reportedSummary ?? null;
				const nextTaskResult = summary ?? reportedSummary ?? canonicalTask.result ?? null;

				const spaceLevel = (space?.autonomyLevel ?? 1) as SpaceAutonomyLevel;

				// Skip re-resolution when the task is already at a non-`open`/non-`in_progress`
				// status — `done`/`cancelled` are terminal; `review` means we've already paused
				// at a completion-action gate and are awaiting human approval; `approved`
				// means PostApprovalRouter already ran once (PR 2/5).
				const taskAlreadyResolved =
					canonicalTask.status === 'done' ||
					canonicalTask.status === 'review' ||
					canonicalTask.status === 'cancelled' ||
					canonicalTask.status === 'approved';

				// Final status drives sibling cancellation. We only kill siblings when
				// the task reached a true terminal state (`done`/`cancelled`); `review`
				// means we're still waiting for human approval and siblings may yet
				// produce useful output if the human rejects completion.
				let finalTaskStatus: SpaceTask['status'] = canonicalTask.status;

				if (!taskAlreadyResolved) {
					// PR 2/5 (flag-gated): when NEOKAI_TASK_AGENT_POST_APPROVAL_ROUTING
					// is ON, dispatch through PostApprovalRouter; otherwise fall back
					// to the legacy completion-action pipeline (unchanged).
					if (isPostApprovalRoutingEnabled()) {
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
					} else {
						// The completion-action pipeline is the sole arbiter of terminal
						// status. The agent's `report_result` only records a summary +
						// optional evidence on `reportedSummary`; terminal status is
						// decided entirely by the outcome of the actions below.
						const params = await this.resolveCompletionWithActions(
							meta.spaceId,
							runId,
							meta.workflow,
							nextTaskResult,
							spaceLevel,
							canonicalTask.id
						);
						await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, params);
						finalTaskStatus = params.status ?? canonicalTask.status;
					}
				} else if (summary && canonicalTask.result !== summary) {
					await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, { result: summary });
				}

				// Sibling NodeExecution quiescing: interrupt siblings still in_progress
				// when the canonical task reaches a terminal status, transitioning them
				// to `idle` so they remain reachable via send_message. The end-node
				// execution itself is excluded so its session can finish writing back
				// to the agent (it produced the report_result that triggered this
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

			nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);
			const pendingExecutions = nodeExecutions.filter(
				(execution) => execution.status === 'pending' && !execution.agentSessionId
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

			// Agents drive workflow progression via send_message and report_result.
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
				execution.status === 'idle' &&
				execution.result
			) {
				return execution.result;
			}
		}

		return undefined;
	}

	// ---------------------------------------------------------------------------
	// Completion Action Execution
	// ---------------------------------------------------------------------------

	/**
	 * Resolve the task completion status, executing completion actions if the
	 * end node defines them.
	 *
	 * The completion-action pipeline is the **sole arbiter** of terminal task
	 * status. The agent's `report_result` only records a summary + optional
	 * evidence; whether the task ends `done` / `needs_attention` / `blocked`
	 * is decided entirely by the outcomes of the actions below.
	 *
	 * Flow:
	 * 1. If the end node has no completionActions → fall back to binary autonomy check.
	 * 2. For each action in definition order:
	 *    - If `space.autonomyLevel >= action.requiredLevel` → execute immediately.
	 *    - Otherwise → pause the task at this action (status='review',
	 *      pendingActionIndex, pendingCheckpointType='completion_action').
	 * 3. If all actions executed → task status = 'done'.
	 *
	 * Returns the params to use for updateTaskAndEmit, or null if the task
	 * was already paused at a completion action (caller should skip the update).
	 */
	private async resolveCompletionWithActions(
		spaceId: string,
		runId: string,
		workflow: SpaceWorkflow | null,
		taskResult: string | null,
		spaceLevel: SpaceAutonomyLevel,
		taskId: string
	): Promise<UpdateSpaceTaskParams> {
		// Find end node's completion actions
		const endNode = workflow?.nodes.find((n) => n.id === workflow.endNodeId);
		const actions = endNode?.completionActions;

		if (!actions || actions.length === 0) {
			// No completion actions — use shared autonomy threshold.
			// `isAutonomousWithoutActions` is also consumed by the web UI so the
			// two surfaces cannot drift.
			const autonomous = isAutonomousWithoutActions(spaceLevel);
			const completionStatus = autonomous ? 'done' : 'review';
			return {
				status: completionStatus,
				result: taskResult,
				completedAt: autonomous ? Date.now() : null,
				...(autonomous ? { approvalSource: 'auto_policy' as const, approvedAt: Date.now() } : {}),
			};
		}

		// Idempotency guard: if this run's completion actions have already fired
		// once (initial completion succeeded → run was reopened → now completing
		// again), skip re-execution. Completion actions are side-effectful
		// (script runs, MCP calls, etc.) and must not re-fire on a reopened run.
		const runRecord = this.config.workflowRunRepo.getRun(runId);
		if (runRecord?.completionActionsFiredAt != null) {
			return {
				status: 'done' as const,
				result: taskResult,
				completedAt: Date.now(),
				approvalSource: 'auto_policy' as const,
				approvedAt: Date.now(),
				pendingActionIndex: null,
				pendingCheckpointType: null,
			};
		}

		// Resolve workspace path once for all actions
		const space = await this.config.spaceManager.getSpace(spaceId);
		if (!space?.workspacePath) {
			log.warn(
				`SpaceRuntime: cannot execute completion actions — space ${spaceId} not found or has no workspacePath`
			);
			// Fall through to shared autonomy threshold
			const autonomous = isAutonomousWithoutActions(spaceLevel);
			const completionStatus = autonomous ? 'done' : 'review';
			return {
				status: completionStatus,
				result: taskResult,
				completedAt: autonomous ? Date.now() : null,
				...(autonomous ? { approvalSource: 'auto_policy' as const, approvedAt: Date.now() } : {}),
			};
		}
		const workspacePath = space.workspacePath;

		// Execute completion actions in order
		for (let i = 0; i < actions.length; i++) {
			const action = actions[i];
			if (spaceLevel >= action.requiredLevel) {
				// Auto-execute
				const result = await this.executeCompletionAction(action, spaceId, runId, workspacePath);
				if (!result.success) {
					return {
						status: 'blocked' as const,
						result: result.reason ?? `Completion action "${action.name}" failed`,
					};
				}
				// Emit audit-trail event for the auto-executed action. Mirrors the
				// resume path so every successfully-run action is visible in the
				// space-agent notification stream and — when the task has a task
				// agent session — in the task's own thread.
				const executedAt = new Date().toISOString();
				await this.safeNotify({
					kind: 'completion_action_executed',
					spaceId,
					taskId,
					runId,
					actionId: action.id,
					actionName: action.name,
					approvedBy: 'auto_policy',
					approvalReason: null,
					executedAt,
					timestamp: executedAt,
				});
				// Thread-event emission targets the task's own agent session so
				// SpaceTaskUnifiedThread can render it inline.
				const owningTask = this.config.taskRepo.getTask(taskId);
				if (owningTask?.taskAgentSessionId) {
					this.emitTaskThreadEvent(owningTask.taskAgentSessionId, 'completion_action_executed', {
						spaceId,
						taskId: owningTask.id,
						runId,
						actionId: action.id,
						actionName: action.name,
						approvedBy: 'auto_policy',
						approvalReason: null,
						executedAt,
					});
				}
			} else {
				// Pause at this action — task goes to 'review' with pending action metadata.
				// Populate `result` with a structured pause reason so surfaces can explain
				// *why* the task is awaiting review. The original agent output is preserved
				// on the separate `reportedSummary` field.
				const pauseReason = buildAwaitingApprovalReason(action, spaceLevel);
				await this.emitTaskAwaitingApproval(spaceId, taskId, action, spaceLevel);
				return {
					status: 'review' as const,
					result: pauseReason,
					pendingActionIndex: i,
					pendingCheckpointType: 'completion_action' as const,
				};
			}
		}

		// All actions executed — task is done. Stamp the run so a future reopen
		// of this workflow run does NOT re-execute the same side-effectful
		// actions. See the guard at the top of this method.
		this.config.workflowRunRepo.updateRun(runId, { completionActionsFiredAt: Date.now() });
		return {
			status: 'done' as const,
			result: taskResult,
			completedAt: Date.now(),
			approvalSource: 'auto_policy' as const,
			approvedAt: Date.now(),
			pendingActionIndex: null,
			pendingCheckpointType: null,
		};
	}

	/**
	 * Emit a `task_awaiting_approval` event for a task that just paused at a
	 * completion action. Deduplicated by `${taskId}:awaiting_approval:${actionId}`
	 * so we don't re-fire for the same pause across ticks — each distinct pending
	 * action gets exactly one event per pause.
	 *
	 * Callers must ensure the dedup set is cleared when the task leaves the
	 * paused state — this cleanup runs at the top of `processRunTick`, which
	 * strips all `${taskId}:awaiting_approval:*` entries once the task is no
	 * longer at `review` + `completion_action`.
	 */
	private async emitTaskAwaitingApproval(
		spaceId: string,
		taskId: string,
		action: CompletionAction,
		spaceLevel: SpaceAutonomyLevel
	): Promise<void> {
		const dedupKey = `${taskId}:awaiting_approval:${action.id}`;
		if (this.notifiedTaskSet.has(dedupKey)) return;
		this.notifiedTaskSet.add(dedupKey);
		await this.safeNotify({
			kind: 'task_awaiting_approval',
			spaceId,
			taskId,
			actionId: action.id,
			actionName: action.name,
			actionDescription: action.description,
			actionType: action.type,
			requiredLevel: action.requiredLevel,
			spaceLevel,
			autonomyLevel: spaceLevel,
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * Execute a single completion action.
	 *
	 * Dispatches by `action.type`:
	 *   - `script`       → inline bash executor
	 *   - `instruction`  → `config.instructionActionExecutor` (injected)
	 *   - `mcp_call`     → `config.mcpToolExecutor` (injected) + `expect` assertion
	 *
	 * The `switch` is exhaustive — adding a new `CompletionAction` variant to
	 * the shared type without a case here is a compile-time error (the
	 * `never` check at the bottom of the switch guarantees this).
	 *
	 * Every path returns a `CompletionActionExecutionResult` — failures carry
	 * a human-readable `reason` so the task's `result` field is descriptive.
	 */
	private async executeCompletionAction(
		action: CompletionAction,
		spaceId: string,
		runId: string,
		workspacePath: string
	): Promise<CompletionActionExecutionResult> {
		const artifactData = this.resolveArtifactData(action, runId);

		switch (action.type) {
			case 'script':
				return this.executeScriptCompletionAction(
					action,
					spaceId,
					runId,
					workspacePath,
					artifactData
				);
			case 'instruction': {
				const executor = this.config.instructionActionExecutor;
				if (!executor) {
					const reason =
						'instruction completion action is not supported: no instructionActionExecutor configured';
					log.warn(`SpaceRuntime: ${reason} (action: ${action.id}, space: ${spaceId})`);
					return { success: false, reason };
				}
				try {
					log.info(
						`SpaceRuntime: executing instruction completion action "${action.name}" (${action.id}) ` +
							`for space ${spaceId}, run ${runId} → agent "${action.agentName}"`
					);
					const result = await executor(action, {
						spaceId,
						runId,
						workspacePath,
						artifactData,
					});
					if (!result.success) {
						log.warn(
							`SpaceRuntime: instruction action "${action.name}" verification failed: ` +
								`${result.reason ?? '(no reason provided)'}`
						);
					}
					return result;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					log.warn(`SpaceRuntime: instruction action "${action.name}" threw: ${message}`);
					return { success: false, reason: `instruction executor threw: ${message}` };
				}
			}
			case 'mcp_call': {
				const executor = this.config.mcpToolExecutor;
				if (!executor) {
					const reason =
						'mcp_call completion action is not supported: no mcpToolExecutor configured';
					log.warn(`SpaceRuntime: ${reason} (action: ${action.id}, space: ${spaceId})`);
					return { success: false, reason };
				}
				log.info(
					`SpaceRuntime: executing mcp_call completion action "${action.name}" (${action.id}) ` +
						`for space ${spaceId}, run ${runId} → ${action.server}.${action.tool}`
				);
				return await runMcpCallAction(
					action,
					{ spaceId, runId, workspacePath, artifactData },
					executor
				);
			}
			default: {
				// Exhaustiveness guard — adding a new variant to CompletionAction
				// without a case here is a type error. `void _never` silences the
				// unused-var lint without changing runtime behavior.
				const _never: never = action;
				void _never;
				return {
					success: false,
					reason: `unknown completion action type: ${String((action as { type?: string }).type)}`,
				};
			}
		}
	}

	/**
	 * Resolve artifact data for a completion action. Shared by all action
	 * types so `instruction` and `mcp_call` executors can template-interpolate
	 * against the same artifact shape that `script` actions consume via env.
	 */
	private resolveArtifactData(action: CompletionAction, runId: string): Record<string, unknown> {
		if (!action.artifactType || !this.config.artifactRepo) return {};
		const artifacts = this.config.artifactRepo.listByRun(runId, {
			artifactType: action.artifactType,
		});
		if (action.artifactKey) {
			const match = artifacts.find((a) => a.artifactKey === action.artifactKey);
			return match?.data ?? {};
		}
		return artifacts[0]?.data ?? {};
	}

	/**
	 * Execute a `script` completion action: spawn bash with a restricted env,
	 * stream stdout/stderr with a maxBuffer, and honor a 2-minute SIGKILL timeout.
	 */
	private async executeScriptCompletionAction(
		action: Extract<CompletionAction, { type: 'script' }>,
		spaceId: string,
		runId: string,
		workspacePath: string,
		artifactData: Record<string, unknown>
	): Promise<CompletionActionExecutionResult> {
		// Reuse gate script executor's restricted env builder.
		// Pass a synthetic gateId — buildRestrictedEnv sets NEOKAI_GATE_ID from it,
		// which we immediately override with the correct action-specific var.
		const env = buildRestrictedEnv({
			workspacePath,
			gateId: '',
			runId,
			gateData: artifactData,
		});
		delete env['NEOKAI_GATE_ID'];
		env['NEOKAI_COMPLETION_ACTION_ID'] = action.id;
		env['NEOKAI_SPACE_ID'] = spaceId;
		if (this.config.dbPath) {
			env['NEOKAI_DB_PATH'] = this.config.dbPath;
		}
		// Resolve the run's start time so scripts can scope DB queries to work
		// performed during THIS run (e.g. tasks created after the run began).
		const runRecord = this.config.workflowRunRepo.getRun(runId);
		if (runRecord) {
			const startIso = new Date(runRecord.createdAt).toISOString();
			env['NEOKAI_WORKFLOW_START_ISO'] = startIso;
		}
		try {
			env['NEOKAI_ARTIFACT_DATA_JSON'] = JSON.stringify(artifactData);
		} catch {
			env['NEOKAI_ARTIFACT_DATA_JSON'] = '{}';
		}

		log.info(
			`SpaceRuntime: executing script completion action "${action.name}" (${action.id}) ` +
				`for space ${spaceId}, run ${runId}`
		);

		const COMPLETION_ACTION_TIMEOUT_MS = 120_000; // 2 minutes
		try {
			const proc = Bun.spawn(['bash', '-c', action.script], {
				cwd: workspacePath,
				env,
				stdout: 'pipe',
				stderr: 'pipe',
			});

			const [_stdout, stderrResult, exitResult] = await Promise.all([
				collectWithMaxBuffer(proc.stdout, MAX_BUFFER_BYTES),
				collectWithMaxBuffer(proc.stderr, MAX_BUFFER_BYTES),
				(async () => {
					let killed = false;
					const killTimer = setTimeout(() => {
						killed = true;
						proc.kill('SIGKILL');
					}, COMPLETION_ACTION_TIMEOUT_MS);
					const code = await proc.exited;
					clearTimeout(killTimer);
					return { code, timedOut: killed };
				})(),
			]);

			if (exitResult.timedOut) {
				const reason = `script timed out after ${COMPLETION_ACTION_TIMEOUT_MS}ms`;
				log.warn(`SpaceRuntime: completion action "${action.name}" ${reason}`);
				return { success: false, reason: `${action.name}: ${reason}` };
			}
			if (exitResult.code !== 0) {
				const stderrSnippet = stderrResult.text.trim().slice(0, 500);
				log.warn(
					`SpaceRuntime: completion action "${action.name}" failed ` +
						`(exit ${exitResult.code}): ${stderrSnippet}`
				);
				return {
					success: false,
					reason: `${action.name}: script exited ${exitResult.code}${stderrSnippet ? ` — ${stderrSnippet}` : ''}`,
				};
			}
			return { success: true };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.warn(`SpaceRuntime: completion action "${action.name}" error: ${message}`);
			return { success: false, reason: `${action.name}: ${message}` };
		}
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
