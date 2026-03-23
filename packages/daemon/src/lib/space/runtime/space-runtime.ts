/**
 * SpaceRuntime
 *
 * Workflow-first orchestration engine for Spaces.
 * Manages workflow run lifecycles and standalone task queuing
 * using Space tables exclusively (not Room tables).
 *
 * Responsibilities:
 * - Maintain a Map<runId, WorkflowExecutor> for active workflow runs
 * - Rehydrate executors from DB on first executeTick() call
 * - Start new workflow runs (creates run record + executor + first step task)
 * - Process completed tasks and advance workflows to the next step
 * - Resolve task types from agent roles (planner → planning, coder/general → coding, etc.)
 * - Filter and expose workflow rules applicable to a given step
 * - Clean up executors when runs reach terminal states
 *
 * Note: advance() creates SpaceTask DB records only.
 * Session group spawning is handled separately and is NOT in scope here.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type {
	SpaceTask,
	SpaceTaskType,
	SpaceWorkflow,
	SpaceWorkflowRun,
	WorkflowRule,
	WorkflowStep,
} from '@neokai/shared';
import { resolveStepAgents, resolveStepChannels } from '@neokai/shared';
import type { SpaceManager } from '../managers/space-manager';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { TaskAgentManager } from './task-agent-manager';
import { SpaceTaskManager } from '../managers/space-task-manager';
import { WorkflowExecutor, WorkflowTransitionError } from './workflow-executor';
import { selectWorkflow } from './workflow-selector';
import { Logger } from '../../logger';
import { type NotificationSink, NullNotificationSink } from './notification-sink';

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

	constructor(private config: SpaceRuntimeConfig) {
		this.notificationSink = config.notificationSink ?? new NullNotificationSink();
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
	 * Once set, the tick loop will use Task Agent sessions to drive workflow execution
	 * instead of calling advance() directly.
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
			currentStepId: workflow.startStepId,
			goalId,
			maxIterations: workflow.maxIterations,
		});

		const run = this.config.workflowRunRepo.updateStatus(pendingRun.id, 'in_progress')!;

		// Register executor and meta. If a later step fails, we must clean these up.
		const meta: ExecutorMeta = { workflow, spaceId, workspacePath: space.workspacePath };
		this.executorMeta.set(run.id, meta);
		const executor = this.buildExecutor(workflow, run, spaceId, space.workspacePath);
		this.executors.set(run.id, executor);

		// Find the start step and create the initial task. Roll back map entries if this fails.
		const startStep = workflow.steps.find((s) => s.id === workflow.startStepId);
		if (!startStep) {
			this.executors.delete(run.id);
			this.executorMeta.delete(run.id);
			this.config.workflowRunRepo.updateStatus(run.id, 'cancelled');
			throw new Error(`Start step "${workflow.startStepId}" not found in workflow "${workflowId}"`);
		}

		const taskManager = this.getOrCreateTaskManager(spaceId);
		// Multi-agent start steps: create one SpaceTask per agent.
		// resolveStepAgents() normalises agentId vs agents[] for backward compatibility.
		// Keep inside the try block so a malformed step (neither agentId nor agents)
		// triggers the rollback path and does not leave the executor/run orphaned.
		const tasks: SpaceTask[] = [];
		try {
			const startAgents = resolveStepAgents(startStep);
			for (const agentEntry of startAgents) {
				const resolved = this.resolveTaskTypeForAgent(agentEntry.agentId);
				const task = await taskManager.createTask({
					title: startStep.name,
					description: agentEntry.instructions ?? startStep.instructions ?? '',
					workflowRunId: run.id,
					workflowStepId: startStep.id,
					taskType: resolved.taskType,
					customAgentId: resolved.customAgentId,
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
			this.config.workflowRunRepo.updateStatus(run.id, 'cancelled');
			throw err;
		}

		// Resolve channel topology for the start step and store in run config.
		// TODO: Milestone 6: pass resolvedChannels to session group creation in
		// TaskAgentManager.spawnTaskAgent() rather than storing in run config.
		this.storeResolvedChannels(run.id, space.id, startStep);

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
	resolveTaskTypesForStep(step: WorkflowStep): ResolvedTaskType[] {
		const stepAgents = resolveStepAgents(step);
		return stepAgents.map((sa) => this.resolveTaskTypeForAgent(sa.agentId));
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
	resolveTaskTypeForStep(step: WorkflowStep): ResolvedTaskType {
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
	 * executors with the run's persisted currentStepId so the tick loop can
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
		// Executors must be loaded first so Task Agents can use advance_workflow
		// and other MCP tools that rely on the SpaceRuntimeService executor map.
		if (this.config.taskAgentManager) {
			await this.config.taskAgentManager.rehydrate();
		}
	}

	// -------------------------------------------------------------------------
	// Private — tick helpers
	// -------------------------------------------------------------------------

	/**
	 * For each active executor, checks whether the current step's tasks have all
	 * completed. If so, calls advance() to move to the next step (creating a new
	 * pending SpaceTask) or marks the run as completed when the terminal step is
	 * reached.
	 *
	 * If a gate condition fails, the run status becomes 'needs_attention'.
	 * The executor is retained so the run can be re-examined after the gate is
	 * manually resolved (e.g., humanApproved set in run.config).
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
	 * with fresh state, check for completed step tasks, and advance if ready.
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

		// Recreate the executor with the fresh run from DB. This ensures that
		// external run mutations (e.g. status reset after human approval) are
		// reflected in the executor's advance() guard checks. The executor is
		// stateless beyond this.run (all workflow state is in the DB), so
		// recreation is safe and cheap.
		const meta = this.executorMeta.get(runId);
		if (!meta) return;

		const freshExecutor = this.buildExecutor(meta.workflow, run, meta.spaceId, meta.workspacePath);
		this.executors.set(runId, freshExecutor);

		const currentStep = freshExecutor.getCurrentStep();
		if (!currentStep) {
			// Run is in_progress but currentStepId references a step that doesn't exist in
			// the workflow. This is a data inconsistency — cancel the run and clean up maps
			// so it is not rehydrated on every subsequent restart into the same throw loop.
			this.executors.delete(runId);
			this.executorMeta.delete(runId);
			this.config.workflowRunRepo.updateStatus(runId, 'cancelled');
			throw new Error(
				`Run "${runId}" has currentStepId "${run.currentStepId}" not found in workflow "${run.workflowId}"`
			);
		}

		// Find tasks that belong to the current step
		const stepTasks = this.config.taskRepo
			.listByWorkflowRun(runId)
			.filter((t) => t.workflowStepId === currentStep.id);

		// Only advance when there is at least one task and ALL are completed.
		// stepTasks.length === 0 is the normal "waiting" state — the task for this
		// step has not been spawned yet (session group creation is async and handled
		// by a separate layer). Silently returning here is intentional.
		if (stepTasks.length === 0) return;

		// Refresh dedup entries: clear keys for tasks that have left their flagged state.
		for (const task of stepTasks) {
			if (task.status !== 'needs_attention') {
				this.notifiedTaskSet.delete(`${task.id}:needs_attention`);
			}
			if (task.status !== 'in_progress') {
				this.notifiedTaskSet.delete(`${task.id}:timeout`);
			}
		}

		// Detect task-level needs_attention BEFORE the all-completed guard.
		// This is an explicit check — not inferred from WorkflowTransitionError.
		if (stepTasks.some((t) => t.status === 'needs_attention')) {
			for (const task of stepTasks) {
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

			// Partial failure gate: applies only to multi-agent steps (stepTasks.length > 1).
			// For single-task steps the existing per-task notification is sufficient —
			// a human can reset just the task without also needing to reset the run.
			// For multi-agent parallel steps, wait until ALL sibling tasks reach a
			// terminal state before escalating the run. This prevents premature
			// escalation when one task has failed but siblings are still running.
			if (stepTasks.length > 1) {
				if (this.areAllStepTasksTerminal(stepTasks)) {
					this.config.workflowRunRepo.updateStatus(runId, 'needs_attention');
					await this.safeNotify({
						kind: 'workflow_run_needs_attention',
						spaceId: meta.spaceId,
						runId,
						reason: `One or more parallel tasks on step "${currentStep.name}" require attention`,
						timestamp: new Date().toISOString(),
					});
				}
			}

			return;
		}

		// Timeout detection: check in_progress tasks against Space.config.taskTimeoutMs.
		const space = await this.config.spaceManager.getSpace(meta.spaceId);
		const taskTimeoutMs = space?.config?.taskTimeoutMs;
		if (taskTimeoutMs !== undefined) {
			const now = Date.now();
			for (const task of stepTasks) {
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
		// tasks, check liveness, and recover from crashes. advance() is never called
		// directly — the Task Agent calls it via the advance_workflow MCP tool.
		if (this.config.taskAgentManager) {
			const tam = this.config.taskAgentManager;

			// Step 1: Check tasks that already have a Task Agent session (in_progress).
			// Full loop always completes so that dead-agent resets are applied to ALL
			// tasks before deciding whether to skip.
			//
			// NOTE: we intentionally do NOT return early when alive agents are found.
			// For multi-agent parallel steps, some tasks may have alive agents while
			// siblings are still pending (e.g. a spawn failure on a prior tick). An
			// early return here would permanently skip spawning those unspawned tasks.
			// Always proceed to Step 2 so pending tasks are always re-examined.
			// The final `return` at the end of the TAM block still prevents advance().
			for (const task of stepTasks) {
				if (!task.taskAgentSessionId) continue;

				if (tam.isTaskAgentAlive(task.id)) {
					continue; // still check remaining tasks for dead agents
				}

				// Task Agent session is gone — reset for re-spawn on next tick
				log.warn(
					`SpaceRuntime: task agent for task ${task.id} is gone ` +
						`(session ${task.taskAgentSessionId}), resetting to pending for re-spawn`
				);
				this.config.taskRepo.updateTask(task.id, {
					taskAgentSessionId: null,
					status: 'pending',
				});
			}

			// Step 2: Spawn Task Agents for pending tasks without an agent session.
			// Re-read from DB to pick up status resets applied in Step 1.
			const pendingTasksNeedingAgent = this.config.taskRepo
				.listByWorkflowRun(runId)
				.filter(
					(t) =>
						t.workflowStepId === currentStep.id && t.status === 'pending' && !t.taskAgentSessionId
				);

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

			// Never call advance() directly — Task Agent drives the workflow.
			return;
		}
		// ─────────────────────────────────────────────────────────────────────────

		if (!stepTasks.every((t) => t.status === 'completed')) return;

		try {
			const { step: newStep, tasks: newTasks } = await freshExecutor.advance();

			// Tasks are created with taskType already set by the TaskTypeResolver
			// injected into the executor via buildExecutor(). No second update needed.

			if (newTasks.length === 0) {
				// Terminal step reached — run marked completed by advance().
				// cleanupTerminalExecutors() will emit workflow_run_completed and remove executor.
				// No cleanup here: executors map is iterated by for..of which captures the
				// initial key set, so the entry stays until cleanupTerminalExecutors() runs.
			} else {
				// Resolve channel topology for the new step.
				// TODO: Milestone 6: pass to session group creation instead of run config.
				this.storeResolvedChannels(runId, meta.spaceId, newStep);
			}
		} catch (err) {
			if (!(err instanceof WorkflowTransitionError)) {
				// Unexpected error — propagate to caller (processCompletedTasks collects it)
				throw err;
			}
			// Gate blocked: run status already set to 'needs_attention' by the executor.
			// Emit notification so the Space Agent session is informed.
			await this.safeNotify({
				kind: 'workflow_run_needs_attention',
				spaceId: meta.spaceId,
				runId,
				reason: err.message,
				timestamp: new Date().toISOString(),
			});
			// Keep executor and meta in map — will be retried after gate is resolved.
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
	 * `completed` state (either naturally via advance() or externally).
	 */
	private async cleanupTerminalExecutors(): Promise<void> {
		for (const [runId] of this.executors) {
			const run = this.config.workflowRunRepo.getRun(runId);
			if (!run || run.status === 'completed' || run.status === 'cancelled') {
				if (run?.status === 'completed') {
					const meta = this.executorMeta.get(runId);
					if (meta) {
						await this.safeNotify({
							kind: 'workflow_run_completed',
							spaceId: meta.spaceId,
							runId,
							status: 'completed',
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
	 * Injects a per-agent TaskTypeResolver so each task is created with the correct
	 * taskType / customAgentId in a single atomic DB write.
	 */
	private buildExecutor(
		workflow: SpaceWorkflow,
		run: SpaceWorkflowRun,
		spaceId: string,
		workspacePath: string
	): WorkflowExecutor {
		const taskManager = this.getOrCreateTaskManager(spaceId);
		return new WorkflowExecutor(
			workflow,
			run,
			taskManager,
			this.config.workflowRunRepo,
			workspacePath,
			undefined, // use default commandRunner
			// Per-agent resolver: called once per agent entry in the step.
			// This replaces the old step-level resolver so multi-agent steps produce
			// correctly-typed tasks for each agent independently.
			(_step, agentEntry) => this.resolveTaskTypeForAgent(agentEntry.agentId)
		);
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
	 * Calls `resolveStepChannels()` using all Space agents as the lookup table.
	 * Stores the result under `run.config._resolvedChannels`.
	 *
	 * TODO Milestone 6: pass resolvedChannels to session group metadata in
	 * TaskAgentManager.spawnTaskAgent() instead of storing in run config.
	 *
	 * Default task-agent channels:
	 * When a step has node agents, bidirectional channels are auto-created between
	 * 'task-agent' and each node agent role. These defaults are added in addition
	 * to any user-declared channels, ensuring the Task Agent can always reach peers.
	 * Duplicates are avoided: if the user explicitly declares a task-agent channel,
	 * it is not re-added.
	 *
	 * Steps with no `channels` declaration still get default task-agent channels,
	 * so the Task Agent always has peer communication ability.
	 */
	private storeResolvedChannels(runId: string, spaceId: string, step: WorkflowStep): void {
		const run = this.config.workflowRunRepo.getRun(runId);
		if (!run) return;

		const config = (run.config ?? {}) as Record<string, unknown>;

		const allAgents = this.config.spaceAgentManager.listBySpaceId(spaceId);

		// Resolve user-declared channels (empty array if none declared)
		const userResolved = resolveStepChannels(step, allAgents);

		// Auto-generate default bidirectional channels between task-agent and each node agent role.
		// These are added regardless of whether user-declared channels exist, ensuring the
		// Task Agent can always communicate with step agents.
		const stepAgents = resolveStepAgents(step);
		const nodeRoles = stepAgents
			.map((sa) => {
				const spaceAgent = allAgents.find((a) => a.id === sa.agentId);
				return spaceAgent?.role ?? null;
			})
			.filter((role): role is string => role !== null);

		// Build a set of existing channel pairs (fromRole→toRole) to avoid duplicates
		const existingPairs = new Set<string>();
		for (const ch of userResolved) {
			existingPairs.add(`${ch.fromRole}→${ch.toRole}`);
		}

		// Generate default task-agent ↔ node bidirectional channels
		const defaultChannels: typeof userResolved = [];
		const TASK_AGENT_ID = 'task-agent';

		for (const nodeRole of nodeRoles) {
			// task-agent → node (if not already declared)
			if (!existingPairs.has(`task-agent→${nodeRole}`)) {
				defaultChannels.push({
					fromRole: 'task-agent',
					toRole: nodeRole,
					fromAgentId: TASK_AGENT_ID,
					toAgentId: nodeRole, // Use role as agentId placeholder; canSend only checks roles
					direction: 'one-way',
					isHubSpoke: false,
				});
			}
			// node → task-agent (if not already declared)
			if (!existingPairs.has(`${nodeRole}→task-agent`)) {
				defaultChannels.push({
					fromRole: nodeRole,
					toRole: 'task-agent',
					fromAgentId: nodeRole, // Use role as agentId placeholder
					toAgentId: TASK_AGENT_ID,
					direction: 'one-way',
					isHubSpoke: false,
				});
			}
		}

		const resolved = [...userResolved, ...defaultChannels];

		this.config.workflowRunRepo.updateRun(runId, {
			config: { ...config, _resolvedChannels: resolved },
		});
	}
}
