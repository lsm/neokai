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
import type { SpaceManager } from '../managers/space-manager';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import { SpaceTaskManager } from '../managers/space-task-manager';
import { WorkflowExecutor, WorkflowTransitionError } from './workflow-executor';
import { selectWorkflow } from './workflow-selector';
import { Logger } from '../../logger';

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
	 * Interval between executeTick() calls in milliseconds.
	 * Used by start(). Default: 5000 (5 seconds).
	 */
	tickIntervalMs?: number;
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

	constructor(private config: SpaceRuntimeConfig) {}

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
	 */
	async executeTick(): Promise<void> {
		if (!this.rehydrated) {
			await this.rehydrateExecutors();
			this.rehydrated = true;
		}

		await this.processCompletedTasks();
		this.cleanupTerminalExecutors();
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
		description?: string
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

		const resolved = this.resolveTaskTypeForStep(startStep);
		const taskManager = this.getOrCreateTaskManager(spaceId);
		let task: SpaceTask;
		try {
			task = await taskManager.createTask({
				title: startStep.name,
				description: startStep.instructions ?? '',
				workflowRunId: run.id,
				workflowStepId: startStep.id,
				taskType: resolved.taskType,
				customAgentId: resolved.customAgentId,
				status: 'pending',
			});
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

		return { run, tasks: [task] };
	}

	/**
	 * Resolve the appropriate SpaceTaskType (and optional customAgentId) for
	 * a workflow step, based on the assigned agent's role.
	 *
	 * Mapping rules:
	 *   agent.role === 'planner'          → taskType: 'planning',  customAgentId: undefined
	 *   agent.role === 'coder'|'general'  → taskType: 'coding',    customAgentId: undefined
	 *   any other role (custom)           → taskType: 'coding',    customAgentId: step.agentId
	 *   agent not found                   → taskType: 'coding',    customAgentId: step.agentId
	 */
	resolveTaskTypeForStep(step: WorkflowStep): ResolvedTaskType {
		const agent = this.config.spaceAgentManager.getById(step.agentId);

		if (!agent) {
			// Unknown agent → treat as custom coding agent
			return { taskType: 'coding', customAgentId: step.agentId };
		}

		if (agent.role === 'planner') {
			return { taskType: 'planning', customAgentId: undefined };
		}

		if (agent.role === 'coder' || agent.role === 'general') {
			return { taskType: 'coding', customAgentId: undefined };
		}

		// Custom role
		return { taskType: 'coding', customAgentId: step.agentId };
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
	 * Rehydrates WorkflowExecutors from the DB for all in-progress workflow runs.
	 *
	 * Called once at the start of the first executeTick(). Reconstructs
	 * executors with the run's persisted currentStepId so the tick loop can
	 * resume advancement from where it left off.
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
		if (!stepTasks.every((t) => t.status === 'completed')) return;

		try {
			const { tasks: newTasks } = await freshExecutor.advance();

			// Tasks are created with taskType already set by the TaskTypeResolver
			// injected into the executor via buildExecutor(). No second update needed.

			if (newTasks.length === 0) {
				// Terminal step reached — run marked completed by advance(); clean up executor.
				this.executors.delete(runId);
				this.executorMeta.delete(runId);
			}
		} catch (err) {
			if (!(err instanceof WorkflowTransitionError)) {
				// Unexpected error — propagate to caller (processCompletedTasks collects it)
				throw err;
			}
			// Gate blocked: run status already set to 'needs_attention' by the executor.
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
	 */
	private cleanupTerminalExecutors(): void {
		for (const [runId] of this.executors) {
			const run = this.config.workflowRunRepo.getRun(runId);
			if (!run || run.status === 'completed' || run.status === 'cancelled') {
				this.executors.delete(runId);
				this.executorMeta.delete(runId);
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
	 * Injects the TaskTypeResolver so tasks are created with correct taskType
	 * in a single atomic DB write.
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
			(step) => this.resolveTaskTypeForStep(step) // inject TaskTypeResolver
		);
	}
}
