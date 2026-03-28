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
 * - Start new workflow runs (creates run record + executor + first step task)
 * - Spawn Task Agent sessions for pending tasks
 * - Monitor agent liveness and recover from crashes
 * - Resolve task types from agent roles (planner → planning, coder/general → coding, etc.)
 * - Filter and expose workflow rules applicable to a given step
 * - Clean up executors when runs reach terminal states
 *
 * In the agent-centric model, agents drive workflow progression via send_message
 * and report_done — SpaceRuntime no longer calls advance() directly.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type {
	SpaceTask,
	SpaceTaskType,
	SpaceWorkflow,
	SpaceWorkflowRun,
	WorkflowRule,
	WorkflowNode,
	WorkflowChannel,
} from '@neokai/shared';
import { resolveNodeAgents, resolveNodeChannels } from '@neokai/shared';
import type { SpaceManager } from '../managers/space-manager';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { TaskAgentManager } from './task-agent-manager';
import { SpaceTaskManager } from '../managers/space-task-manager';
import { WorkflowExecutor } from './workflow-executor';
import { selectWorkflow } from './workflow-selector';
import { Logger } from '../../logger';
import { type NotificationSink, NullNotificationSink } from './notification-sink';
import { autoCompleteStuckAgents, resolveNodeTimeout } from './agent-liveness';
import { CompletionDetector } from './completion-detector';
import { MAX_TASK_AGENT_CRASH_RETRIES } from './constants';

const log = new Logger('space-runtime');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SpaceRuntimeConfig {
	/** Raw Bun SQLite database — used to create per-space SpaceTaskManagers */
	db: BunDatabase;
	/** Space manager for listing spaces and fetching workspace paths */
	spaceManager: SpaceManager;
	/** Agent manager for resolving agent roles in resolveTaskTypeForStep() */
	spaceAgentManager: SpaceAgentManager;
	/** Workflow manager for loading workflow definitions */
	spaceWorkflowManager: SpaceWorkflowManager;
	/** Workflow run repository for run CRUD and status updates */
	workflowRunRepo: SpaceWorkflowRunRepository;
	/** Task repository for querying tasks by run/step */
	taskRepo: SpaceTaskRepository;
	/**
	 * Optional TaskAgentManager for Task Agent mode.
	 *
	 * When provided, SpaceRuntime spawns Task Agent sessions for pending tasks
	 * instead of calling advance() directly. Task Agents drive the workflow
	 * via their MCP tools. When absent, the original direct-advance behavior
	 * is preserved for backward compatibility.
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
	 * Defaults to `new CompletionDetector(taskRepo)` if not provided.
	 */
	completionDetector?: CompletionDetector;
}

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

/** Result of resolveTaskTypeForStep(): taskType + optional customAgentId */
export interface ResolvedTaskType {
	/**
	 * SpaceTaskType derived from the agent's role:
	 *   planner → 'planning'
	 *   coder | general → 'coding'
	 *   custom role → 'coding'
	 */
	taskType: SpaceTaskType;
	/**
	 * Set for custom-role agents (non-preset) so that the executor knows
	 * exactly which SpaceAgent to use. Undefined for planner/coder/general
	 * roles where the step's agentId is the authoritative reference.
	 */
	customAgentId: string | undefined;
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

	/** Active notification sink — replaced at runtime via setNotificationSink() */
	private notificationSink: NotificationSink;

	/**
	 * Completion detector for the all-agents-done model.
	 * Initialized from config or defaulted to `new CompletionDetector(taskRepo)`.
	 */
	private completionDetector: CompletionDetector;

	/**
	 * Deduplication set for notifications keyed by `taskId:status` (e.g. `task-1:needs_attention`
	 * or `task-1:timeout`). Prevents re-notifying for the same task+status across ticks.
	 * Entries are cleared when the task leaves the flagged state.
	 *
	 * Restart contract: this set is in-memory only and starts empty on every daemon restart.
	 * Tasks already in `needs_attention` at restart time will be re-notified once on the first
	 * tick. This is intentional: the Space Agent session is also new after restart and needs to
	 * learn about outstanding issues. No DB persistence for dedup state is required.
	 */
	private notifiedTaskSet = new Set<string>();

	/**
	 * In-memory crash counter per task ID.
	 *
	 * Tracks how many times a task's agent session has been detected as dead.
	 * When the count reaches MAX_TASK_AGENT_CRASH_RETRIES, the task is escalated
	 * to `needs_attention` so a human can investigate. Below the limit, the task
	 * is reset to `pending` for re-spawn to tolerate transient startup failures.
	 *
	 * Reset contract: this map is in-memory only and starts empty on every daemon
	 * restart. On restart, if a task is still `in_progress` with a dead session,
	 * the crash counter begins from 0 again — giving the task a fresh set of
	 * retries before escalation.
	 */
	private taskCrashCounts = new Map<string, number>();

	constructor(private config: SpaceRuntimeConfig) {
		this.notificationSink = config.notificationSink ?? new NullNotificationSink();
		this.completionDetector = config.completionDetector ?? new CompletionDetector(config.taskRepo);
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
	 * Stops the periodic tick loop.
	 * Does not affect in-progress executors — they remain in the map and can
	 * be resumed by calling start() again.
	 */
	stop(): void {
		if (this.tickTimer !== null) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
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
	 * 3. Checks standalone tasks (no workflowRunId) for needs_attention and timeout
	 */
	async executeTick(): Promise<void> {
		if (!this.rehydrated) {
			await this.rehydrateExecutors();
			this.rehydrated = true;
		}

		await this.processCompletedTasks();
		await this.cleanupTerminalExecutors();
		await this.checkStandaloneTasks();
	}

	/**
	 * Start a new workflow run for the given space and workflow.
	 *
	 * Flow:
	 * 1. Load the workflow definition
	 * 2. Create a SpaceWorkflowRun record (status: in_progress)
	 * 3. Create a WorkflowExecutor and register it in the executors map
	 * 4. Create a pending SpaceTask for the workflow's start step
	 *
	 * Returns the created run and the initial task(s).
	 * Cleans up maps if task creation fails to prevent orphaned executor entries.
	 */
	async startWorkflowRun(
		spaceId: string,
		workflowId: string,
		title: string,
		description?: string,
		goalId?: string
	): Promise<{ run: SpaceWorkflowRun; tasks: SpaceTask[] }> {
		const workflow = this.config.spaceWorkflowManager.getWorkflow(workflowId);
		if (!workflow) {
			throw new Error(`Workflow not found: ${workflowId}`);
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
			goalId,
			maxIterations: workflow.maxIterations,
		});

		const run = this.config.workflowRunRepo.transitionStatus(pendingRun.id, 'in_progress');

		// Register executor and meta. If a later step fails, we must clean these up.
		const meta: ExecutorMeta = { workflow, spaceId, workspacePath: space.workspacePath };
		this.executorMeta.set(run.id, meta);
		const executor = this.buildExecutor(workflow, run, spaceId, space.workspacePath);
		this.executors.set(run.id, executor);

		// Find the start step and create the initial task. Roll back map entries if this fails.
		const startStep = workflow.nodes.find((s) => s.id === workflow.startNodeId);
		if (!startStep) {
			this.executors.delete(run.id);
			this.executorMeta.delete(run.id);
			this.config.workflowRunRepo.transitionStatus(run.id, 'cancelled');
			throw new Error(`Start step "${workflow.startNodeId}" not found in workflow "${workflowId}"`);
		}

		const taskManager = this.getOrCreateTaskManager(spaceId);
		// Multi-agent start steps: create one SpaceTask per agent.
		// resolveNodeAgents() normalises agentId vs agents[] for backward compatibility.
		// Keep inside the try block so a malformed step (neither agentId nor agents)
		// triggers the rollback path and does not leave the executor/run orphaned.
		const tasks: SpaceTask[] = [];
		try {
			const startAgents = resolveNodeAgents(startStep);
			for (const agentEntry of startAgents) {
				const resolved = this.resolveTaskTypeForAgent(agentEntry.agentId);
				const task = await taskManager.createTask({
					title: startStep.name,
					description: agentEntry.instructions ?? startStep.instructions ?? '',
					workflowRunId: run.id,
					workflowNodeId: startStep.id,
					taskType: resolved.taskType,
					customAgentId: resolved.customAgentId,
					agentName: agentEntry.name,
					status: 'pending',
					goalId: run.goalId,
				});
				tasks.push(task);
			}
		} catch (err) {
			// Clean up the executor/meta entries so the run is not orphaned in the map.
			this.executors.delete(run.id);
			this.executorMeta.delete(run.id);
			// Cancel the DB run record so rehydrateExecutors() does not silently loop
			// over it on next server restart (an in_progress run with no tasks would
			// sit in the executor map indefinitely, never advancing and never erroring).
			this.config.workflowRunRepo.transitionStatus(run.id, 'cancelled');
			throw err;
		}

		// Resolve channel topology for the start step and store in run config.
		// TODO: Milestone 6: pass resolvedChannels to session group creation in
		// TaskAgentManager.spawnTaskAgent() rather than storing in run config.
		this.resolveAndStoreChannels(run.id, space.id, startStep, workflow.channels ?? []);

		return { run, tasks };
	}

	/**
	 * Resolve the appropriate SpaceTaskType (and optional customAgentId) for a specific
	 * agent ID. This is the canonical per-agent resolver used by the TaskTypeResolver
	 * callback injected into WorkflowExecutor.
	 *
	 * Mapping rules:
	 *   agent.role === 'planner'          → taskType: 'planning',  customAgentId: undefined
	 *   agent.role === 'coder'|'general'  → taskType: 'coding',    customAgentId: undefined
	 *   any other role (custom)           → taskType: 'coding',    customAgentId: agentId
	 *   agent not found                   → taskType: 'coding',    customAgentId: agentId
	 */
	resolveTaskTypeForAgent(agentId: string): ResolvedTaskType {
		const agent = this.config.spaceAgentManager.getById(agentId);

		if (!agent) {
			// Unknown agent → treat as custom coding agent
			return { taskType: 'coding', customAgentId: agentId };
		}

		if (agent.role === 'planner') {
			return { taskType: 'planning', customAgentId: undefined };
		}

		if (agent.role === 'coder' || agent.role === 'general') {
			return { taskType: 'coding', customAgentId: undefined };
		}

		// Custom role
		return { taskType: 'coding', customAgentId: agentId };
	}

	/**
	 * Resolve per-agent task types for a workflow step.
	 *
	 * Returns one `ResolvedTaskType` per agent entry in the step (in order).
	 * For single-agent steps (agentId shorthand), returns a one-element array.
	 *
	 * Mapping rules per agent:
	 *   agent.role === 'planner'          → taskType: 'planning',  customAgentId: undefined
	 *   agent.role === 'coder'|'general'  → taskType: 'coding',    customAgentId: undefined
	 *   any other role (custom)           → taskType: 'coding',    customAgentId: agentId
	 *   agent not found                   → taskType: 'coding',    customAgentId: agentId
	 */
	resolveTaskTypesForStep(step: WorkflowNode): ResolvedTaskType[] {
		const nodeAgents = resolveNodeAgents(step);
		return nodeAgents.map((sa) => this.resolveTaskTypeForAgent(sa.agentId));
	}

	/**
	 * Resolve the appropriate SpaceTaskType (and optional customAgentId) for
	 * a workflow step, based on the primary agent's role.
	 *
	 * For backward compatibility: delegates to `resolveTaskTypesForStep()` and
	 * returns the first entry (primary agent).
	 *
	 * For multi-agent steps (agents[] format), use `resolveTaskTypesForStep()`
	 * to get per-agent results.
	 */
	resolveTaskTypeForStep(step: WorkflowNode): ResolvedTaskType {
		return this.resolveTaskTypesForStep(step)[0];
	}

	/**
	 * Returns workflow rules applicable to a given workflow step.
	 *
	 * A rule applies to a step when:
	 *   - rule.appliesTo is empty/undefined (applies to ALL steps), OR
	 *   - rule.appliesTo includes stepId
	 */
	getRulesForStep(workflowId: string, stepId: string): WorkflowRule[] {
		const workflow = this.config.spaceWorkflowManager.getWorkflow(workflowId);
		if (!workflow) return [];

		return workflow.rules.filter(
			(r) => !r.appliesTo || r.appliesTo.length === 0 || r.appliesTo.includes(stepId)
		);
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
			// getRehydratableRuns returns 'in_progress' AND 'needs_attention' runs.
			// 'pending' is still excluded — it's transient (task creation may have failed).
			// 'needs_attention' runs are included so a human-gate-blocked run gets its
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
	 * For each active executor, processes the current step's tasks:
	 * - Detects needs_attention and timeout conditions
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
		if (
			run.status === 'needs_attention' ||
			run.status === 'cancelled' ||
			run.status === 'completed'
		) {
			return;
		}

		// In the agent-centric model, agents activate nodes themselves via activateNode().
		// The tick loop processes ALL active tasks across all nodes — not just one "current step".
		const meta = this.executorMeta.get(runId);
		if (!meta) return;

		// Get ALL tasks for this run. Each task may belong to a different workflow node.
		const allRunTasks = this.config.taskRepo.listByWorkflowRun(runId);
		if (allRunTasks.length === 0) return;

		// Refresh dedup entries: clear keys for tasks that have left their flagged state.
		for (const task of allRunTasks) {
			if (task.status !== 'needs_attention') {
				this.notifiedTaskSet.delete(`${task.id}:needs_attention`);
			}
			if (task.status !== 'in_progress') {
				this.notifiedTaskSet.delete(`${task.id}:timeout`);
			}
		}

		// Detect task-level needs_attention BEFORE the all-completed guard.
		// This is an explicit check — not inferred from WorkflowTransitionError.
		if (allRunTasks.some((t) => t.status === 'needs_attention')) {
			for (const task of allRunTasks) {
				if (task.status !== 'needs_attention') continue;
				const dedupKey = `${task.id}:needs_attention`;
				if (!this.notifiedTaskSet.has(dedupKey)) {
					this.notifiedTaskSet.add(dedupKey);
					await this.safeNotify({
						kind: 'task_needs_attention',
						spaceId: meta.spaceId,
						taskId: task.id,
						reason: task.error ?? 'Task requires attention',
						timestamp: new Date().toISOString(),
					});
				}
			}

			// Escalate the run to needs_attention for multi-agent steps when ALL tasks are terminal.
			// Single-task steps: only task_needs_attention is emitted (backward compat).
			if (allRunTasks.length > 1 && this.areAllStepTasksTerminal(allRunTasks)) {
				this.config.workflowRunRepo.transitionStatus(runId, 'needs_attention');
				await this.safeNotify({
					kind: 'workflow_run_needs_attention',
					spaceId: meta.spaceId,
					runId,
					reason: 'One or more tasks require attention',
					timestamp: new Date().toISOString(),
				});
			}

			return;
		}

		// Timeout detection: check in_progress tasks against Space.config.taskTimeoutMs.
		const space = await this.config.spaceManager.getSpace(meta.spaceId);
		const taskTimeoutMs = space?.config?.taskTimeoutMs;
		if (taskTimeoutMs !== undefined) {
			const now = Date.now();
			for (const task of allRunTasks) {
				if (task.status !== 'in_progress' || !task.startedAt) continue;
				const elapsedMs = now - task.startedAt;
				if (elapsedMs > taskTimeoutMs) {
					const dedupKey = `${task.id}:timeout`;
					if (!this.notifiedTaskSet.has(dedupKey)) {
						this.notifiedTaskSet.add(dedupKey);
						await this.safeNotify({
							kind: 'task_timeout',
							spaceId: meta.spaceId,
							taskId: task.id,
							elapsedMs,
							timestamp: new Date().toISOString(),
						});
					}
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

			// Step 1: Check tasks that already have a Task Agent session (in_progress).
			// Full loop always completes so that crashed-agent handling is applied to ALL
			// tasks before deciding whether to skip.
			//
			// NOTE: we intentionally do NOT return early when alive agents are found.
			// Some tasks may have alive agents while siblings are still pending (e.g. a
			// spawn failure on a prior tick). An early return here would permanently skip
			// spawning those unspawned tasks.
			for (const task of allRunTasks) {
				if (!task.taskAgentSessionId) continue;

				if (tam.isTaskAgentAlive(task.id)) {
					continue; // still check remaining tasks for dead agents
				}

				// Task Agent session is dead. Apply crash-retry logic:
				//   - Below MAX_TASK_AGENT_CRASH_RETRIES: reset to pending for re-spawn
				//     (tolerates transient startup failures, e.g. dev-proxy timing in CI).
				//   - At or above limit: escalate to needs_attention so a human can
				//     investigate before further retries are attempted.
				const crashCount = (this.taskCrashCounts.get(task.id) ?? 0) + 1;
				this.taskCrashCounts.set(task.id, crashCount);

				if (crashCount <= MAX_TASK_AGENT_CRASH_RETRIES) {
					log.warn(
						`SpaceRuntime: task agent for task ${task.id} crashed ` +
							`(session ${task.taskAgentSessionId}); resetting to pending for re-spawn ` +
							`(crash ${crashCount}/${MAX_TASK_AGENT_CRASH_RETRIES})`
					);
					this.config.taskRepo.updateTask(task.id, {
						taskAgentSessionId: null,
						status: 'pending',
					});
				} else {
					log.warn(
						`SpaceRuntime: task agent for task ${task.id} crashed ` +
							`(session ${task.taskAgentSessionId}); marking needs_attention ` +
							`after ${crashCount} crashes (limit: ${MAX_TASK_AGENT_CRASH_RETRIES})`
					);
					this.config.taskRepo.updateTask(task.id, {
						taskAgentSessionId: null,
						status: 'needs_attention',
						error: `Agent session crashed ${crashCount} times consecutively`,
					});
					await this.safeNotify({
						kind: 'agent_crash',
						spaceId: meta.spaceId,
						taskId: task.id,
						timestamp: new Date().toISOString(),
					});
				}
			}

			// Step 1.5: Auto-complete stuck agents — alive but never called report_done.
			// Must run after dead-agent resets (Step 1) so we only process truly alive agents.
			// Re-reads tasks from DB to pick up any status resets from Step 1.
			const freshRunTasksForLiveness = this.config.taskRepo.listByWorkflowRun(runId);
			const autoCompleted = await autoCompleteStuckAgents(
				freshRunTasksForLiveness,
				meta.spaceId,
				this.config.taskRepo,
				tam,
				this.safeNotify.bind(this),
				undefined,
				(task) => resolveNodeTimeout(task.agentName ?? 'general')
			);
			if (autoCompleted.length > 0) {
				log.warn(
					`SpaceRuntime: auto-completed ${autoCompleted.length} stuck agent(s) for run ${runId}`
				);
			}

			// Step 1.6: All-agents-done completion detection.
			// After liveness checks and auto-completion, inspect whether every task
			// in the run has reached a terminal status. If so, mark the run as
			// completed — cleanupTerminalExecutors() will emit the notification and
			// remove the executor on the same tick.
			if (
				this.completionDetector.isComplete(runId, meta.workflow.channels ?? [], meta.workflow.nodes)
			) {
				this.config.workflowRunRepo.transitionStatus(runId, 'completed');
				return;
			}

			// Step 2: Spawn Task Agents for pending tasks without an agent session.
			// Re-read from DB to pick up status resets applied in Step 1.
			const pendingTasksNeedingAgent = this.config.taskRepo
				.listByWorkflowRun(runId)
				.filter((t) => t.status === 'pending' && !t.taskAgentSessionId);

			if (pendingTasksNeedingAgent.length > 0) {
				if (!space) {
					// Space was deleted while the run was in progress — log and wait.
					// The run will remain stuck until the space is restored or cancelled.
					log.warn(
						`SpaceRuntime: cannot spawn task agents for run ${runId} — space ${meta.spaceId} not found`
					);
				} else {
					for (const task of pendingTasksNeedingAgent) {
						if (tam.isSpawning(task.id)) continue; // spawn already in progress
						try {
							// spawnTaskAgent writes taskAgentSessionId to the DB as a side effect.
							// SpaceRuntime owns the status transition to 'in_progress' after spawn.
							await tam.spawnTaskAgent(task, space, meta.workflow, run);
							this.config.taskRepo.updateTask(task.id, { status: 'in_progress' });
						} catch (err) {
							log.error(`SpaceRuntime: failed to spawn task agent for task ${task.id}:`, err);
						}
					}
				}
			}

			// Agents drive workflow progression via send_message and report_done.
			return;
		}
	}

	/**
	 * Finds the result summary from the terminal (Done) node agent task for a
	 * completed workflow run. Used to populate the `workflow_run_completed`
	 * notification summary so the Space Chat Agent can surface it to the human.
	 *
	 * Strategy:
	 * 1. Find terminal node IDs — workflow nodes that do not appear as the
	 *    `from` source in any channel (no outbound channels).
	 * 2. Look up completed tasks for those node IDs.
	 * 3. Return the first non-empty result string found.
	 *
	 * Channel `from`/`to` values are agent slot names or node names (NOT node UUIDs).
	 * Cross-node format `"nodeId/agentName"` encodes the node UUID before the slash.
	 * We resolve all references to node UUIDs before comparing against `node.id`.
	 *
	 * Falls back to `undefined` when no terminal task result is available
	 * (e.g. the Done node hasn't run yet, or the result field was not set).
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
		// Bidirectional channels flow both ways, so both endpoints are non-terminal.
		const nodesWithOutbound = new Set<string>();
		for (const ch of channels) {
			const fromId = resolveRef(ch.from);
			if (fromId) nodesWithOutbound.add(fromId);
			if (ch.direction === 'bidirectional') {
				const targets = Array.isArray(ch.to) ? ch.to : [ch.to];
				for (const target of targets) {
					const toId = resolveRef(target);
					if (toId) nodesWithOutbound.add(toId);
				}
			}
		}

		// Terminal nodes are those with no outbound channels
		const terminalNodeIds = new Set<string>();
		for (const node of nodes) {
			if (!nodesWithOutbound.has(node.id)) {
				terminalNodeIds.add(node.id);
			}
		}

		if (terminalNodeIds.size === 0) return undefined;

		// Look up completed tasks for terminal nodes and return the first result
		const runTasks = this.config.taskRepo.listByWorkflowRun(runId);
		for (const task of runTasks) {
			if (task.workflowNodeId != null && terminalNodeIds.has(task.workflowNodeId) && task.result) {
				return task.result;
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
			if (!run || run.status === 'completed' || run.status === 'cancelled') {
				if (run?.status === 'completed') {
					const meta = this.executorMeta.get(runId);
					if (meta) {
						const summary = this.resolveCompletionSummary(runId, meta.workflow);
						await this.safeNotify({
							kind: 'workflow_run_completed',
							spaceId: meta.spaceId,
							runId,
							status: 'completed',
							summary,
							timestamp: new Date().toISOString(),
						});
					}
				}
				// Prune dedup entries for all tasks in this run so the set doesn't
				// grow unboundedly. Once a run is terminal its tasks will never
				// reappear in stepTasks, so the normal per-tick pruning loop
				// (processRunTick) would never clear them otherwise.
				for (const task of this.config.taskRepo.listByWorkflowRun(runId)) {
					this.notifiedTaskSet.delete(`${task.id}:needs_attention`);
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
	 *   - `needs_attention` status → emit `task_needs_attention` notification
	 *   - `in_progress` timeout    → emit `task_timeout` notification
	 *
	 * Uses the shared `notifiedTaskSet` for deduplication so the same task+status pair
	 * is never notified twice in a row. Dedup keys are cleared when the task leaves the
	 * flagged state, allowing re-notification if the task cycles back into it.
	 *
	 * Dedup cleanup includes archived tasks (fetched via includeArchived=true) to prevent
	 * notifiedTaskSet from accumulating stale keys for tasks that were archived while in
	 * a flagged state. Archived tasks can never re-enter needs_attention or in_progress,
	 * so their dedup keys are always safe to remove.
	 *
	 * Restart contract: because `notifiedTaskSet` is in-memory only, tasks already in
	 * `needs_attention` at daemon startup will re-notify once on the first tick. This is
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
				if (archived || task.status !== 'needs_attention') {
					this.notifiedTaskSet.delete(`${task.id}:needs_attention`);
				}
				if (archived || task.status !== 'in_progress') {
					this.notifiedTaskSet.delete(`${task.id}:timeout`);
				}
			}

			// Emit task_needs_attention for active standalone tasks in needs_attention state.
			for (const task of activeStandalone) {
				if (task.status !== 'needs_attention') continue;
				const dedupKey = `${task.id}:needs_attention`;
				if (!this.notifiedTaskSet.has(dedupKey)) {
					this.notifiedTaskSet.add(dedupKey);
					await this.safeNotify({
						kind: 'task_needs_attention',
						spaceId: space.id,
						taskId: task.id,
						reason: task.error ?? 'Task requires attention',
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
	 * Returns the cached SpaceTaskManager for a space, creating it if needed.
	 * Caching avoids creating a new manager + repository on every executor build.
	 */
	private getOrCreateTaskManager(spaceId: string): SpaceTaskManager {
		let manager = this.taskManagers.get(spaceId);
		if (!manager) {
			manager = new SpaceTaskManager(this.config.db, spaceId);
			this.taskManagers.set(spaceId, manager);
		}
		return manager;
	}

	/**
	 * Builds a WorkflowExecutor for the given run with fresh state.
	 * Used for graph navigation (getCurrentStep, isComplete) and condition evaluation.
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
	 * Returns true when every task in the step has reached a terminal state.
	 *
	 * Terminal statuses: completed, needs_attention, cancelled, archived.
	 *
	 * Used to implement the partial-failure gate: for multi-agent steps, the run
	 * must not be escalated to needs_attention until every sibling task has settled.
	 * The caller is already inside `if (stepTasks.some(needs_attention))`, so
	 * "any failed" is guaranteed true at the call site — no need to return it.
	 *
	 * @param stepTasks - Pre-fetched tasks for the current step.
	 */
	private areAllStepTasksTerminal(stepTasks: SpaceTask[]): boolean {
		const TERMINAL = new Set<string>(['completed', 'needs_attention', 'cancelled', 'archived']);
		return stepTasks.every((t) => TERMINAL.has(t.status));
	}

	/**
	 * Resolves the channel topology for a workflow step and stores it in the run's
	 * config for use by session group creation (Milestone 6).
	 *
	 * Resolves channel topology using `WorkflowNodeAgent.name` entries from the step
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
	resolveAndStoreChannels(
		runId: string,
		spaceId: string,
		step: WorkflowNode,
		channels: WorkflowChannel[]
	): void {
		const run = this.config.workflowRunRepo.getRun(runId);
		if (!run) return;

		const config = (run.config ?? {}) as Record<string, unknown>;

		// Resolve user-declared channels from workflow-level channels array
		const resolved = resolveNodeChannels(step, channels);

		this.config.workflowRunRepo.updateRun(runId, {
			config: { ...config, _resolvedChannels: resolved },
		});
	}

	/**
	 * Returns the channels array for the workflow associated with the given run.
	 * Used by task-agent-tools.ts to pass channels to resolveAndStoreChannels.
	 */
	getWorkflowChannels(runId: string): WorkflowChannel[] {
		const run = this.config.workflowRunRepo.getRun(runId);
		if (!run) return [];
		const workflow = this.config.spaceWorkflowManager.getWorkflow(run.workflowId);
		return workflow?.channels ?? [];
	}
}
