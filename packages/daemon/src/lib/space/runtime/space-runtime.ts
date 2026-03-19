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
import { WorkflowExecutor, WorkflowGateError } from './workflow-executor';

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
	 * Set to true after the first executeTick() call, after rehydrateExecutors()
	 * has loaded in-progress runs from the DB. Prevents repeated rehydration.
	 */
	private rehydrated = false;

	constructor(private config: SpaceRuntimeConfig) {}

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

		// Store metadata for future executor recreation with fresh run state
		const meta: ExecutorMeta = { workflow, spaceId, workspacePath: space.workspacePath };
		this.executorMeta.set(run.id, meta);

		const executor = this.buildExecutor(workflow, run, spaceId, space.workspacePath);
		this.executors.set(run.id, executor);

		// Find the start step and create the initial task
		const startStep = workflow.steps.find((s) => s.id === workflow.startStepId);
		if (!startStep) {
			throw new Error(`Start step "${workflow.startStepId}" not found in workflow "${workflowId}"`);
		}

		const resolved = this.resolveTaskTypeForStep(startStep);
		const taskManager = new SpaceTaskManager(this.config.db, spaceId);
		const task = await taskManager.createTask({
			title: startStep.name,
			description: startStep.instructions ?? '',
			workflowRunId: run.id,
			workflowStepId: startStep.id,
			taskType: resolved.taskType,
			customAgentId: resolved.customAgentId ?? startStep.agentId,
			status: 'pending',
		});

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
	 * Runs that reference a missing workflow are skipped (logged as a warning).
	 */
	async rehydrateExecutors(): Promise<void> {
		const spaces = await this.config.spaceManager.listSpaces(false);

		for (const space of spaces) {
			const activeRuns = this.config.workflowRunRepo.getActiveRuns(space.id);

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
	 */
	private async processCompletedTasks(): Promise<void> {
		for (const [runId] of this.executors) {
			// Always re-read run from DB to pick up external status changes (e.g. human
			// approval reset, external cancellation).
			const run = this.config.workflowRunRepo.getRun(runId);
			if (!run) continue;
			if (
				run.status === 'needs_attention' ||
				run.status === 'cancelled' ||
				run.status === 'completed'
			) {
				continue;
			}

			// Recreate the executor with the fresh run from DB. This ensures that
			// external run mutations (e.g. status reset after human approval) are
			// reflected in the executor's advance() guard checks. The executor is
			// stateless beyond this.run (all workflow state is in the DB), so
			// recreation is safe and cheap.
			const meta = this.executorMeta.get(runId);
			if (!meta) continue;

			const freshExecutor = this.buildExecutor(
				meta.workflow,
				run,
				meta.spaceId,
				meta.workspacePath
			);
			this.executors.set(runId, freshExecutor);

			const currentStep = freshExecutor.getCurrentStep();
			if (!currentStep) continue;

			// Find tasks that belong to the current step
			const stepTasks = this.config.taskRepo
				.listByWorkflowRun(runId)
				.filter((t) => t.workflowStepId === currentStep.id);

			// Only advance when there is at least one task and ALL are completed
			if (stepTasks.length === 0) continue;
			if (!stepTasks.every((t) => t.status === 'completed')) continue;

			try {
				const { step: nextStep, tasks: newTasks } = await freshExecutor.advance();

				// Apply task-type assignment to tasks created by advance()
				for (const task of newTasks) {
					const resolved = this.resolveTaskTypeForStep(nextStep);
					this.config.taskRepo.updateTask(task.id, {
						taskType: resolved.taskType,
						customAgentId: resolved.customAgentId ?? nextStep.agentId,
					});
				}

				if (newTasks.length === 0) {
					// Terminal step reached — run marked completed by advance(); clean up executor.
					this.executors.delete(runId);
					this.executorMeta.delete(runId);
				}
			} catch (err) {
				if (!(err instanceof WorkflowGateError)) {
					// Unexpected error — re-throw so the caller's error boundary handles it
					throw err;
				}
				// Gate blocked: run status already set to 'needs_attention' by the executor.
				// Keep executor and meta in map — will be retried after gate is resolved.
			}
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
	 * Builds a WorkflowExecutor for the given run with fresh state.
	 */
	private buildExecutor(
		workflow: SpaceWorkflow,
		run: SpaceWorkflowRun,
		spaceId: string,
		workspacePath: string
	): WorkflowExecutor {
		const taskManager = new SpaceTaskManager(this.config.db, spaceId);
		return new WorkflowExecutor(
			workflow,
			run,
			taskManager,
			this.config.workflowRunRepo,
			workspacePath
		);
	}
}
