/**
 * ChannelRouter — message delivery with gate enforcement and lazy node activation.
 *
 * Handles all message delivery within a workflow run:
 * - Within-node DMs (same node, agent-to-agent)
 * - Cross-node DMs (target resolved by agent role)
 * - Fan-out (target resolved by node name → all agents in that node)
 *
 * Gate enforcement — two systems are supported:
 *
 * 1. **New separated Channel+Gate architecture (M1.1/M1.2)**:
 *    When a WorkflowChannel has a `gateId`, the corresponding Gate entity is
 *    loaded from `workflow.gates`, its runtime data is fetched from `gate_data`
 *    via `GateDataRepository`, and `evaluateGate()` is called. This is the
 *    preferred path for new workflows.
 *
 * 2. **Legacy inline gate (WorkflowCondition)**:
 *    When a WorkflowChannel has an inline `gate` (no `gateId`), the
 *    `ChannelGateEvaluator` is used as before. Kept for backward compatibility.
 *
 * Channels without either `gateId` or `gate` are always open.
 *
 * `onGateDataChanged(runId, gateId)`:
 *    Called by agents (via MCP write_gate) whenever gate data changes.
 *    Re-evaluates all channels that reference the changed gate. If a previously
 *    blocked channel is now open and its target node has no active tasks,
 *    the node is lazily activated.
 *
 * `resetOnCycle`:
 *    When a cyclic channel is traversed, gates with `resetOnCycle: true` in the
 *    workflow have their data reset to defaults in `gate_data`. This operation
 *    is performed in the same SQLite transaction as the iteration counter increment.
 *
 * Lazy node activation:
 * - activateNode() is idempotent: if tasks already exist for the node the
 *   existing tasks are returned unchanged.
 * - Concurrency is handled via a DB UNIQUE partial index on
 *   (workflow_run_id, workflow_node_id, agent_name). A duplicate INSERT throws
 *   a SQLiteError; the handler re-reads and returns the tasks created by the
 *   winning writer.
 * - No session group creation — that is the responsibility of TaskAgentManager.
 *   ChannelRouter only creates SpaceTask DB records.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type {
	Gate,
	SpaceTask,
	SpaceTaskType,
	SpaceWorkflow,
	WorkflowChannel,
	WorkflowNode,
} from '@neokai/shared';
import { resolveNodeAgents, isChannelCyclic } from '@neokai/shared';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { GateDataRepository } from '../../../storage/repositories/gate-data-repository';
import type { ChannelCycleRepository } from '../../../storage/repositories/channel-cycle-repository';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import { ChannelGateEvaluator, ChannelGateBlockedError } from './channel-gate-evaluator';
import type { ChannelGateContext, GateResult } from './channel-gate-evaluator';
import { evaluateGate } from './gate-evaluator';

// Re-export for callers that only need to import from channel-router
export { ChannelGateBlockedError };
export type { ChannelGateContext, GateResult };

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
	/**
	 * Role of the receiving agent, or node name for fan-out deliveries.
	 * When isFanOut is true this is the node name, not an individual agent role.
	 */
	toRole: string;
	/** The message content */
	message: string;
	/** Node ID of the target agent */
	targetNodeId: string;
	/**
	 * True when the delivery targeted a node name (fan-out to all agents in the
	 * node) rather than a specific agent role (point-to-point DM).
	 */
	isFanOut: boolean;
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
 *
 * Also thrown by deliverMessage() when the iteration cap is exceeded on a
 * cyclic channel (an unrecoverable limit — not a retryable gate block).
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
	/**
	 * Gate data repository for reading/writing gate runtime data.
	 * Required when workflows use the new separated Channel+Gate architecture
	 * (WorkflowChannel.gateId). Optional for legacy-only workflows.
	 */
	gateDataRepo?: GateDataRepository;
	/**
	 * Channel cycle repository for per-channel iteration tracking.
	 * Required when workflows contain cyclic (backward) channels.
	 */
	channelCycleRepo?: ChannelCycleRepository;
	/**
	 * Raw SQLite database handle.
	 * When provided, gate data resets and cycle counter increments on cyclic
	 * channels are performed in a single atomic transaction (`db.transaction()`).
	 * When omitted, operations are performed sequentially (still safe for most
	 * single-process use cases but not ACID-atomic on crash).
	 */
	db?: BunDatabase;
	/**
	 * Injectable gate evaluator — omit to use the real evaluator (Bun.spawn).
	 * Inject a mock in tests to avoid real subprocess calls.
	 */
	gateEvaluator?: ChannelGateEvaluator;
}

// ---------------------------------------------------------------------------
// ChannelRouter
// ---------------------------------------------------------------------------

export class ChannelRouter {
	private readonly gateEvaluator: ChannelGateEvaluator;

	constructor(private readonly config: ChannelRouterConfig) {
		this.gateEvaluator = config.gateEvaluator ?? new ChannelGateEvaluator();
	}

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
					agentName: agentEntry.name,
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
	 * Check whether delivery of a message from `fromRole` to `toTarget` is currently
	 * permitted — without performing any delivery or state mutations.
	 *
	 * Evaluation order:
	 * 1. **Open topology** — when no channel is declared for the pair, delivery is
	 *    always allowed (no restriction).
	 * 2. **Iteration cap** — for cyclic channels, blocks when
	 *    `run.iterationCount >= run.maxIterations`.
	 * 3. **Gate condition** — evaluates the channel's gate using the provided context.
	 *    For new-style channels (gateId): uses `evaluateGate()`.
	 *    For legacy channels (inline gate): uses `ChannelGateEvaluator`.
	 *
	 * @param runId     - Workflow run ID
	 * @param fromRole  - Sending agent role name
	 * @param toTarget  - Receiving agent role name, or node name for fan-out
	 * @param context   - Gate evaluation context (workspace path, human approval, task result)
	 * @returns GateResult — `{ allowed: true }` or `{ allowed: false, reason }` when blocked
	 * @throws ActivationError when the run or workflow is not found
	 */
	async canDeliver(
		runId: string,
		fromRole: string,
		toTarget: string,
		context: ChannelGateContext
	): Promise<GateResult> {
		const run = this.config.workflowRunRepo.getRun(runId);
		if (!run) throw new ActivationError(`Run not found: ${runId}`);

		const workflow = this.config.workflowManager.getWorkflow(run.workflowId);
		if (!workflow) throw new ActivationError(`Workflow not found: ${run.workflowId}`);

		const match = this.findMatchingWorkflowChannel(workflow, fromRole, toTarget);
		if (!match) {
			// Open topology — no declared channel for this pair; delivery is unrestricted
			return { allowed: true };
		}
		const { channel, index } = match;

		// ── Per-channel cycle cap check ──────────────────────────────────────
		if (this.isChannelCyclicByIndex(index, workflow)) {
			const maxCycles = channel.maxCycles ?? 5;
			if (this.isCycleCapReached(runId, index, maxCycles)) {
				return {
					allowed: false,
					reason: `Cyclic channel from "${fromRole}" to "${toTarget}" has reached the maximum cycle count (${maxCycles}). Increase maxCycles to allow more cycles.`,
				};
			}
		}

		// ── Gate condition evaluation ────────────────────────────────────────
		// New separated architecture: gateId takes precedence
		if (channel.gateId) {
			const gateResult = this.evaluateGateById(runId, channel.gateId, workflow);
			return { allowed: gateResult.open, reason: gateResult.reason };
		}

		// Legacy inline gate
		if (!channel.gate) return { allowed: true };
		return this.gateEvaluator.evaluateCondition(channel.gate, context);
	}

	/**
	 * Deliver a message from one agent role to another (or to a node for fan-out)
	 * within a workflow run.
	 *
	 * **Target resolution:**
	 * - `toTarget` is an agent role name → DM to the agent's node (lazy-activated
	 *   if not already active)
	 * - `toTarget` is a node name → fan-out to the node; all agent slots are
	 *   activated (lazy-activated if not already active)
	 *
	 * **Gate evaluation:**
	 * - Channels with `gateId` (new architecture): `evaluateGate()` is called;
	 *   gate data is loaded from `gate_data` via `GateDataRepository`.
	 *   Does NOT require a context object.
	 * - Channels with inline `gate` (legacy): `ChannelGateEvaluator` is used
	 *   when a `context` object is provided.
	 * - Channels with neither: always open.
	 * - Throws `ChannelGateBlockedError` when a gate blocks delivery.
	 *
	 * **Cyclic iteration tracking:**
	 * - If the matching channel has `isCyclic: true`, `run.iterationCount` is
	 *   incremented after successful delivery.
	 * - Gates with `resetOnCycle: true` have their data reset to defaults in the
	 *   same atomic operation (single SQLite transaction when `db` is in config).
	 * - If the iteration cap has already been reached, throws `ActivationError`.
	 *
	 * @param runId    - Workflow run ID
	 * @param fromRole - Role name of the sending agent (WorkflowNodeAgent.name)
	 * @param toTarget - Role name of the receiving agent, or node name for fan-out
	 * @param message  - Message content to deliver
	 * @param context  - Optional gate evaluation context; used only for legacy inline gates
	 * @returns DeliveredMessage descriptor; `activatedTasks` is set when the
	 *   target node was lazily activated, undefined when it was already active
	 * @throws ActivationError when the run, workflow, or target role/node is not
	 *   found, or the cyclic iteration cap is exceeded
	 * @throws ChannelGateBlockedError when a gate condition blocks delivery
	 */
	async deliverMessage(
		runId: string,
		fromRole: string,
		toTarget: string,
		message: string,
		context?: ChannelGateContext
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

		// ── 2. Gate evaluation and per-channel cycle cap ────────────────────────
		const match = this.findMatchingWorkflowChannel(workflow, fromRole, toTarget);
		const channel = match?.channel;
		const channelIndex = match?.index ?? -1;
		const channelIsCyclic = match ? this.isChannelCyclicByIndex(channelIndex, workflow) : false;

		if (channel) {
			// Enforce per-channel cycle cap for cyclic channels (even without context)
			if (channelIsCyclic) {
				const maxCycles = channel.maxCycles ?? 5;
				if (this.isCycleCapReached(runId, channelIndex, maxCycles)) {
					throw new ActivationError(
						`Cyclic channel from "${fromRole}" to "${toTarget}" has reached the maximum cycle count (${maxCycles}). Increase maxCycles to allow more cycles.`
					);
				}
			}

			// New separated architecture: gateId takes precedence over legacy inline gate
			if (channel.gateId) {
				const gateResult = this.evaluateGateById(runId, channel.gateId, workflow);
				if (!gateResult.open) {
					throw new ChannelGateBlockedError(
						gateResult.reason ??
							`Gate "${channel.gateId}" blocked delivery from "${fromRole}" to "${toTarget}"`,
						channel.gateId
					);
				}
			} else if (context && channel.gate) {
				// Legacy inline gate evaluation — only when the caller supplies evaluation context
				const gateResult = await this.gateEvaluator.evaluateCondition(channel.gate, context);
				if (!gateResult.allowed) {
					throw new ChannelGateBlockedError(
						gateResult.reason ?? `Gate blocked delivery from "${fromRole}" to "${toTarget}"`,
						channel.gate.type
					);
				}
			}
		}

		// ── 3. Target resolution: agent role → DM, node name → fan-out ────────
		let targetNode = this.findNodeByAgentRole(workflow, toTarget);
		let isFanOut = false;

		if (!targetNode) {
			// Try node name for fan-out delivery
			const byName = workflow.nodes.find((n) => n.name === toTarget);
			if (byName) {
				targetNode = byName;
				isFanOut = true;
			} else {
				throw new ActivationError(
					`No node found with agent role or node name "${toTarget}" in workflow "${run.workflowId}"`
				);
			}
		}

		// ── 4. Lazy activation ─────────────────────────────────────────────────
		const activeTasks = this.getActiveTasksForNode(runId, targetNode.id);
		let activatedTasks: SpaceTask[] | undefined;

		if (activeTasks.length === 0) {
			activatedTasks = await this.activateNode(runId, targetNode.id);
		}

		// ── 5. Increment per-channel cycle count and reset cyclic gates ──────
		if (channelIsCyclic && channel) {
			this.incrementAndResetCyclicChannel(runId, channelIndex, channel.maxCycles ?? 5, workflow);
		}

		return {
			runId,
			fromRole,
			toRole: toTarget,
			message,
			targetNodeId: targetNode.id,
			isFanOut,
			activatedTasks,
		};
	}

	/**
	 * Called when gate data changes for a given gate (e.g., after an agent writes
	 * to gate data via the `write_gate` MCP tool).
	 *
	 * Re-evaluates all channels in the workflow run that reference `gateId`. If the
	 * gate is now open AND the channel's target node has no active tasks, the node
	 * is lazily activated.
	 *
	 * This enables vote-counting gates: each agent write calls `onGateDataChanged()`,
	 * and when enough votes accumulate to satisfy the condition, the target node is
	 * automatically activated.
	 *
	 * When multiple channels share the same gate (e.g., three reviewer nodes all
	 * gated by `code-pr-gate`), all target nodes are activated in parallel via
	 * `Promise.allSettled()`. This ensures that reviewer1, reviewer2, and reviewer3
	 * activate simultaneously rather than sequentially.
	 *
	 * @param runId  - Workflow run ID
	 * @param gateId - ID of the gate whose data changed
	 * @returns Array of newly activated SpaceTask records (may be empty)
	 */
	async onGateDataChanged(runId: string, gateId: string): Promise<SpaceTask[]> {
		const run = this.config.workflowRunRepo.getRun(runId);
		if (!run || run.status === 'cancelled' || run.status === 'completed') return [];

		const workflow = this.config.workflowManager.getWorkflow(run.workflowId);
		if (!workflow) return [];

		if (!this.config.gateDataRepo) return [];

		// Find all channels in this workflow that reference this gate
		const channels = (workflow.channels ?? []).filter((ch) => ch.gateId === gateId);
		if (channels.length === 0) return [];

		// Evaluate the gate once (shared across all channels referencing it)
		const gateResult = this.evaluateGateById(runId, gateId, workflow);
		if (!gateResult.open) return [];

		// Determine if any of these channels are cyclic — if so, enforce the per-channel cap
		// before activating any node (mirrors the guard in deliverMessage).
		const allChannels = workflow.channels ?? [];
		let cyclicChannelMatch: { index: number; maxCycles: number } | null = null;
		for (const ch of channels) {
			const chIdx = allChannels.indexOf(ch);
			if (chIdx >= 0 && this.isChannelCyclicByIndex(chIdx, workflow)) {
				const maxCycles = ch.maxCycles ?? 5;
				if (this.isCycleCapReached(runId, chIdx, maxCycles)) {
					throw new ActivationError(
						`Cyclic channel via gate "${gateId}" (index ${chIdx}) has reached the maximum cycle count (${maxCycles}). Increase maxCycles to allow more cycles.`
					);
				}
				cyclicChannelMatch = { index: chIdx, maxCycles };
			}
		}

		// Gate is open → collect all unique node IDs that need activation.
		// Multiple channels may point to the same target (e.g. fan-out via node name),
		// so deduplicate before spawning to avoid redundant activateNode() calls.
		const nodeIdsToActivate = new Set<string>();
		for (const channel of channels) {
			const targets = Array.isArray(channel.to) ? channel.to : [channel.to];
			for (const target of targets) {
				// Resolve target: first by agent role, then by node name (fan-out)
				let targetNode = this.findNodeByAgentRole(workflow, target);
				if (!targetNode) {
					targetNode = workflow.nodes.find((n) => n.name === target);
				}
				if (!targetNode) continue;

				// Only activate if no active tasks for this node
				const activeTasks = this.getActiveTasksForNode(runId, targetNode.id);
				if (activeTasks.length === 0) {
					nodeIdsToActivate.add(targetNode.id);
				}
			}
		}

		if (nodeIdsToActivate.size === 0) return [];

		// Activate all target nodes in parallel. When a shared gate controls multiple
		// independent nodes (e.g., code-pr-gate → reviewer1, reviewer2, reviewer3),
		// this ensures they all become active simultaneously rather than sequentially.
		const results = await Promise.allSettled(
			[...nodeIdsToActivate].map((nodeId) => this.activateNode(runId, nodeId))
		);

		const activatedTasks: SpaceTask[] = [];
		for (const result of results) {
			if (result.status === 'fulfilled') {
				activatedTasks.push(...result.value);
			}
			// Rejected: run may have transitioned to terminal state between the
			// nodeIdsToActivate check above and the activation attempt — silently skip.
		}

		// For cyclic channels: increment the per-channel cycle counter and reset
		// gates with `resetOnCycle: true`. This mirrors the logic in deliverMessage and
		// ensures the QA→Coding feedback path (triggered via write_gate MCP tool →
		// onGateDataChanged) correctly resets reviewer votes and advances the cycle counter.
		if (cyclicChannelMatch && activatedTasks.length > 0) {
			this.incrementAndResetCyclicChannel(runId, cyclicChannelMatch.index, cyclicChannelMatch.maxCycles, workflow);
		}

		return activatedTasks;
	}

	// -------------------------------------------------------------------------
	// Private helpers
	// -------------------------------------------------------------------------

	/**
	 * Evaluates a gate by ID against its current runtime data from `gate_data`.
	 *
	 * Looks up the gate definition in `workflow.gates`, loads the runtime data from
	 * `GateDataRepository`, and evaluates the condition.
	 *
	 * **Fallback behavior when `gateDataRepo` is absent or no DB record exists:**
	 * Evaluates against the gate's default `data` (as declared in the workflow definition).
	 * This means a gate can open on first evaluation if its default data satisfies the
	 * condition — callers that use `gateId` channels should always provide `gateDataRepo`.
	 *
	 * Returns `{ open: false }` with a descriptive reason when:
	 * - The gate is not found in `workflow.gates` (misconfiguration)
	 * - The condition fails against the runtime (or default) data
	 */
	private evaluateGateById(
		runId: string,
		gateId: string,
		workflow: SpaceWorkflow
	): { open: boolean; reason?: string } {
		const gateDef = (workflow.gates ?? []).find((g) => g.id === gateId);
		if (!gateDef) {
			return {
				open: false,
				reason: `Gate "${gateId}" not found in workflow "${workflow.id}" — channel is closed (misconfiguration)`,
			};
		}

		// Load runtime data from DB; fall back to gate's default data when no record exists
		const record = this.config.gateDataRepo?.get(runId, gateId);
		const runtimeData = record?.data ?? gateDef.data;

		const gateWithData: Gate = { ...gateDef, data: runtimeData };
		return evaluateGate(gateWithData);
	}

	// incrementAndResetCyclicChannel is defined alongside findMatchingWorkflowChannel above

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
	 * Finds the first WorkflowChannel in the workflow that matches the given
	 * fromRole → toTarget pair.
	 *
	 * Matching rules:
	 * - `channel.from` may equal either the sender agent role/name or the sender
	 *   node name (wildcard `'*'` matches any sender)
	 * - `channel.to` may equal either the explicit target string or the target
	 *   node name, or contain either in an array (wildcard `'*'` matches any target)
	 *
	 * `toTarget` may be either an agent role name or a node name — the raw
	 * WorkflowChannel declaration is not resolved; the caller is responsible for
	 * knowing the target type.
	 *
	 * Returns undefined when no channel is found (open topology).
	 */
	private findMatchingWorkflowChannel(
		workflow: SpaceWorkflow,
		fromRole: string,
		toTarget: string
	): { channel: WorkflowChannel; index: number } | undefined {
		const fromNodeName = this.findNodeByAgentRole(workflow, fromRole)?.name;
		const toNodeName =
			this.findNodeByAgentRole(workflow, toTarget)?.name ??
			workflow.nodes.find((node) => node.name === toTarget)?.name;
		const channels = workflow.channels ?? [];
		const index = channels.findIndex((ch) => {
			// Match the from side
			if (ch.from !== '*' && ch.from !== fromRole && ch.from !== fromNodeName) return false;
			// Match the to side
			if (ch.to === '*' || ch.to === toTarget || (!!toNodeName && ch.to === toNodeName)) return true;
			if (Array.isArray(ch.to)) {
				return ch.to.includes(toTarget) || (!!toNodeName && ch.to.includes(toNodeName));
			}
			return false;
		});
		return index >= 0 ? { channel: channels[index], index } : undefined;
	}

	/**
	 * Determines if a channel at the given index is cyclic (backward in graph topology).
	 */
	private isChannelCyclicByIndex(channelIndex: number, workflow: SpaceWorkflow): boolean {
		const channels = workflow.channels ?? [];
		return isChannelCyclic(channelIndex, channels, workflow.nodes);
	}

	/**
	 * Checks whether a cyclic channel has reached its per-channel cycle cap.
	 */
	private isCycleCapReached(
		runId: string,
		channelIndex: number,
		maxCycles: number
	): boolean {
		if (!this.config.channelCycleRepo) return false;
		const record = this.config.channelCycleRepo.get(runId, channelIndex);
		return record ? record.count >= maxCycles : false;
	}

	/**
	 * Atomically increments the per-channel cycle counter and resets gates
	 * with `resetOnCycle: true`.
	 *
	 * When `db` is in config: runs both operations in a single SQLite transaction.
	 * When `db` is absent: runs operations sequentially (safe for single-process).
	 *
	 * Throws `ActivationError` if the cycle cap was already reached at the time
	 * of the atomic increment (concurrent TOCTOU race).
	 */
	private incrementAndResetCyclicChannel(
		runId: string,
		channelIndex: number,
		maxCycles: number,
		workflow: SpaceWorkflow
	): void {
		if (!this.config.channelCycleRepo) return;

		const cyclicGates = (workflow.gates ?? []).filter((g) => g.resetOnCycle);

		if (this.config.db && this.config.gateDataRepo && cyclicGates.length > 0) {
			const transaction = this.config.db.transaction(() => {
				for (const gate of cyclicGates) {
					this.config.gateDataRepo!.reset(runId, gate.id, gate.data);
				}
				return this.config.channelCycleRepo!.incrementCycleCount(runId, channelIndex, maxCycles);
			});
			const incremented = transaction();
			if (!incremented) {
				throw new ActivationError(
					`Cyclic channel (index ${channelIndex}) reached the maximum cycle count (${maxCycles}) during delivery.`
				);
			}
		} else {
			if (this.config.gateDataRepo) {
				for (const gate of cyclicGates) {
					this.config.gateDataRepo.reset(runId, gate.id, gate.data);
				}
			}
			const incremented = this.config.channelCycleRepo.incrementCycleCount(runId, channelIndex, maxCycles);
			if (!incremented) {
				throw new ActivationError(
					`Cyclic channel (index ${channelIndex}) reached the maximum cycle count (${maxCycles}) during delivery.`
				);
			}
		}
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
