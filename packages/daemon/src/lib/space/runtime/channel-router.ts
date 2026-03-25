/**
 * ChannelRouter — lazy node activation for agent-centric workflow execution.
 *
 * When a message arrives for a target agent role whose node has no active tasks,
 * the router creates pending SpaceTask records on-demand (lazy activation).
 * This replaces the step-centric model where the executor always pre-created
 * tasks for the next node eagerly.
 *
 * Key design decisions:
 * - activateNode() is idempotent: if tasks already exist for the node the
 *   existing tasks are returned unchanged.
 * - Concurrency is handled via a DB UNIQUE partial index on
 *   (workflow_run_id, workflow_node_id, slot_role). A duplicate INSERT throws
 *   a SQLiteError; the handler re-reads and returns the tasks created by the
 *   winning writer.
 * - No session group creation — that is the responsibility of TaskAgentManager.
 *   ChannelRouter only creates SpaceTask DB records.
 */

import type { SpaceTask, SpaceTaskType, SpaceWorkflow, WorkflowNode } from '@neokai/shared';
import { resolveNodeAgents } from '@neokai/shared';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceAgentManager } from '../managers/space-agent-manager';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Resolved task-type metadata for a single agent slot */
interface ResolvedTaskType {
	taskType: SpaceTaskType;
	customAgentId: string | undefined;
}

/**
 * Return value from deliverMessage().
 * Callers can inspect `activatedTasks` to know whether a lazy activation occurred.
 */
export interface DeliveredMessage {
	/** Workflow run ID */
	runId: string;
	/** Role of the sending agent */
	fromRole: string;
	/** Role of the receiving agent */
	toRole: string;
	/** The message content */
	message: string;
	/** Node ID of the target agent */
	targetNodeId: string;
	/**
	 * Tasks created by lazy activation, or undefined when the node was already active.
	 * An empty array is never returned — either undefined (already active) or ≥1 tasks.
	 */
	activatedTasks?: SpaceTask[];
}

// ---------------------------------------------------------------------------
// ActivationError
// ---------------------------------------------------------------------------

/**
 * Thrown by activateNode() for unrecoverable problems such as a missing run
 * or workflow, a node that does not exist, or an attempted activation on a
 * run that has already reached a terminal state.
 */
export class ActivationError extends Error {
	constructor(
		message: string,
		public readonly cause?: unknown
	) {
		super(message);
		this.name = 'ActivationError';
	}
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ChannelRouterConfig {
	/** Task repository for creating and querying SpaceTask records */
	taskRepo: SpaceTaskRepository;
	/** Workflow run repository for reading run metadata */
	workflowRunRepo: SpaceWorkflowRunRepository;
	/** Workflow manager for loading workflow definitions */
	workflowManager: SpaceWorkflowManager;
	/** Agent manager for resolving agent roles → task types */
	agentManager: SpaceAgentManager;
}

// ---------------------------------------------------------------------------
// ChannelRouter
// ---------------------------------------------------------------------------

export class ChannelRouter {
	constructor(private readonly config: ChannelRouterConfig) {}

	// -------------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------------

	/**
	 * Lazily activate a workflow node by creating a pending SpaceTask for each
	 * agent declared on the node.
	 *
	 * Idempotency rules (checked in order):
	 * 1. If non-cancelled tasks already exist for (runId, nodeId) → return them.
	 * 2. If a concurrent writer beats this call (UNIQUE constraint violation) →
	 *    re-read and return the tasks created by the winning writer.
	 *
	 * @param runId  - ID of the SpaceWorkflowRun that owns the node
	 * @param nodeId - ID of the WorkflowNode to activate
	 * @returns Array of created (or pre-existing) SpaceTask records (≥ 1)
	 * @throws ActivationError when the run/workflow/node is not found, or the
	 *   run is in a terminal state (cancelled / completed)
	 */
	async activateNode(runId: string, nodeId: string): Promise<SpaceTask[]> {
		// ── 1. Load the run ────────────────────────────────────────────────────
		const run = this.config.workflowRunRepo.getRun(runId);
		if (!run) {
			throw new ActivationError(`Run not found: ${runId}`);
		}
		if (run.status === 'cancelled' || run.status === 'completed') {
			throw new ActivationError(`Cannot activate node for run in status "${run.status}": ${runId}`);
		}

		// ── 2. Idempotency check — return existing active tasks if present ─────
		const existingTasks = this.getActiveTasksForNode(runId, nodeId);
		if (existingTasks.length > 0) {
			return existingTasks;
		}

		// ── 3. Resolve the workflow and node ───────────────────────────────────
		const workflow = this.config.workflowManager.getWorkflow(run.workflowId);
		if (!workflow) {
			throw new ActivationError(`Workflow not found: ${run.workflowId}`);
		}
		const node = workflow.nodes.find((n) => n.id === nodeId);
		if (!node) {
			throw new ActivationError(`Node "${nodeId}" not found in workflow "${run.workflowId}"`);
		}

		// ── 4. Resolve agent slots and create one task per slot ───────────────
		let agents: ReturnType<typeof resolveNodeAgents>;
		try {
			agents = resolveNodeAgents(node);
		} catch (err) {
			throw new ActivationError(
				`Cannot resolve agents for node "${nodeId}": ${err instanceof Error ? err.message : String(err)}`,
				err
			);
		}

		const tasks: SpaceTask[] = [];
		for (const agentEntry of agents) {
			const resolved = this.resolveTaskTypeForAgent(agentEntry.agentId);
			try {
				const task = this.config.taskRepo.createTask({
					spaceId: run.spaceId,
					title: node.name,
					description: agentEntry.instructions ?? node.instructions ?? '',
					workflowRunId: runId,
					workflowNodeId: nodeId,
					taskType: resolved.taskType,
					customAgentId: resolved.customAgentId,
					slotRole: agentEntry.name,
					status: 'pending',
					goalId: run.goalId,
				});
				tasks.push(task);
			} catch (err) {
				// Detect DB UNIQUE constraint violation caused by a concurrent activateNode() call.
				// The winning writer already created the tasks — re-read and return them.
				//
				// Note on partial-activation tradeoff: when the violation occurs on the nth
				// agent slot (n > 1), the tasks already pushed to `tasks` earlier in this
				// loop are silently discarded in favour of the re-read set. This is safe
				// because both callers resolved task metadata from the same DB state, so the
				// winning writer's tasks are equivalent. The returned set is guaranteed to be
				// a superset of what this caller created so far, so no task is lost.
				if (isDuplicateConstraintError(err)) {
					const concurrentTasks = this.getActiveTasksForNode(runId, nodeId);
					if (concurrentTasks.length > 0) {
						return concurrentTasks;
					}
				}
				throw new ActivationError(
					`Failed to create task for agent "${agentEntry.name}" on node "${nodeId}": ${err instanceof Error ? err.message : String(err)}`,
					err
				);
			}
		}

		return tasks;
	}

	/**
	 * Deliver a message from one agent role to another within a workflow run.
	 *
	 * If the target role's node has no active tasks the node is lazily activated
	 * (pending SpaceTask records created) before returning.
	 *
	 * @param runId    - Workflow run ID
	 * @param fromRole - Role name of the sending agent (WorkflowNodeAgent.name)
	 * @param toRole   - Role name of the receiving agent (WorkflowNodeAgent.name)
	 * @param message  - Message content to deliver
	 * @returns DeliveredMessage descriptor; `activatedTasks` is set when the
	 *   target node was lazily activated, undefined when it was already active
	 * @throws ActivationError when the run, workflow, or target role is not found
	 */
	async deliverMessage(
		runId: string,
		fromRole: string,
		toRole: string,
		message: string
	): Promise<DeliveredMessage> {
		// ── 1. Load the run and workflow ───────────────────────────────────────
		const run = this.config.workflowRunRepo.getRun(runId);
		if (!run) {
			throw new ActivationError(`Run not found: ${runId}`);
		}

		const workflow = this.config.workflowManager.getWorkflow(run.workflowId);
		if (!workflow) {
			throw new ActivationError(`Workflow not found: ${run.workflowId}`);
		}

		// ── 2. Locate the node that owns the target role ───────────────────────
		const targetNode = this.findNodeByAgentRole(workflow, toRole);
		if (!targetNode) {
			throw new ActivationError(
				`No node found with agent role "${toRole}" in workflow "${run.workflowId}"`
			);
		}

		// ── 3. Lazy activation ─────────────────────────────────────────────────
		const activeTasks = this.getActiveTasksForNode(runId, targetNode.id);
		let activatedTasks: SpaceTask[] | undefined;

		if (activeTasks.length === 0) {
			activatedTasks = await this.activateNode(runId, targetNode.id);
		}

		return { runId, fromRole, toRole, message, targetNodeId: targetNode.id, activatedTasks };
	}

	// -------------------------------------------------------------------------
	// Private helpers
	// -------------------------------------------------------------------------

	/**
	 * Returns all in-flight tasks for a given (runId, nodeId) pair.
	 *
	 * "In-flight" means the task is in an active (non-terminal) status:
	 * pending, in_progress, review, rate_limited, or usage_limited.
	 * This mirrors the partial index constraint in Migration 54 so the
	 * application-level check stays consistent with the DB-level constraint.
	 *
	 * Terminal tasks (completed, cancelled, needs_attention, archived) are
	 * excluded so cyclic workflows can re-activate a node after its tasks complete.
	 *
	 * `draft` is intentionally excluded even though it is a valid `SpaceTaskStatus`.
	 * The ChannelRouter always creates tasks with `status: 'pending'` — `draft` is
	 * reserved for tasks created by external callers that are not yet ready to run.
	 * The Migration 54 index matches this exclusion, meaning two draft tasks for the
	 * same (run, node, slot) are allowed to coexist. Callers that create draft tasks
	 * outside ChannelRouter must manage uniqueness themselves.
	 */
	private getActiveTasksForNode(runId: string, nodeId: string): SpaceTask[] {
		const ACTIVE_STATUSES = new Set([
			'pending',
			'in_progress',
			'review',
			'rate_limited',
			'usage_limited',
		]);
		return this.config.taskRepo
			.listByWorkflowRun(runId)
			.filter((t) => t.workflowNodeId === nodeId && ACTIVE_STATUSES.has(t.status));
	}

	/**
	 * Searches workflow nodes for the first node that has an agent slot with the
	 * given role name. Returns undefined when no node matches.
	 */
	private findNodeByAgentRole(workflow: SpaceWorkflow, role: string): WorkflowNode | undefined {
		for (const node of workflow.nodes) {
			try {
				const agents = resolveNodeAgents(node);
				if (agents.some((a) => a.name === role)) return node;
			} catch {
				// Skip malformed nodes (neither agentId nor agents defined)
			}
		}
		return undefined;
	}

	/**
	 * Resolves the SpaceTaskType and optional customAgentId for an agent ID.
	 * Mirrors SpaceRuntime.resolveTaskTypeForAgent() so task creation is consistent.
	 */
	private resolveTaskTypeForAgent(agentId: string): ResolvedTaskType {
		const agent = this.config.agentManager.getById(agentId);
		if (!agent) return { taskType: 'coding', customAgentId: agentId };
		if (agent.role === 'planner') return { taskType: 'planning', customAgentId: undefined };
		if (agent.role === 'coder' || agent.role === 'general') {
			return { taskType: 'coding', customAgentId: undefined };
		}
		// Custom role
		return { taskType: 'coding', customAgentId: agentId };
	}
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Returns true when `err` is a SQLite UNIQUE constraint violation.
 * Bun's SQLite driver throws an Error whose message contains "UNIQUE constraint failed".
 */
function isDuplicateConstraintError(err: unknown): boolean {
	return err instanceof Error && err.message.includes('UNIQUE constraint failed');
}
