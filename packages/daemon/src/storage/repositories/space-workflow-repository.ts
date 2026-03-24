/**
 * SpaceWorkflowRepository
 *
 * Data access layer for SpaceWorkflow, SpaceWorkflowNode, and SpaceWorkflowTransition records.
 *
 * Storage layout:
 *   space_workflows             — id, space_id, name, description, start_node_id, config (JSON), layout (JSON), created_at, updated_at
 *   space_workflow_nodes        — id, workflow_id, name, agent_id, order_index, config (JSON), created_at, updated_at
 *   space_workflow_transitions  — id, workflow_id, from_node_id, to_node_id, condition (JSON), order_index, is_cyclic, created_at, updated_at
 *
 * The `config` column on space_workflows stores: { tags, rules, ...extra }
 * The `config` column on space_workflow_nodes stores: { instructions? }
 * The `condition` column on space_workflow_transitions stores: WorkflowCondition JSON or null
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type {
	SpaceWorkflow,
	WorkflowNode,
	WorkflowRule,
	WorkflowCondition,
	WorkflowTransition,
	WorkflowNodeInput,
	WorkflowTransitionInput,
	WorkflowRuleInput,
	WorkflowNodeAgent,
	WorkflowChannel,
	CreateSpaceWorkflowParams,
	UpdateSpaceWorkflowParams,
} from '@neokai/shared';

// ---------------------------------------------------------------------------
// Internal DB row shapes
// ---------------------------------------------------------------------------

interface WorkflowRow {
	id: string;
	space_id: string;
	name: string;
	description: string;
	start_node_id: string | null;
	config: string | null;
	layout: string | null;
	max_iterations: number | null;
	created_at: number;
	updated_at: number;
}

interface NodeRow {
	id: string;
	workflow_id: string;
	name: string;
	agent_id: string | null;
	order_index: number;
	config: string | null;
	created_at: number;
	updated_at: number;
}

interface TransitionRow {
	id: string;
	workflow_id: string;
	from_node_id: string;
	to_node_id: string;
	condition: string | null;
	order_index: number;
	is_cyclic: number | null;
	created_at: number;
	updated_at: number;
}

// JSON stored inside space_workflows.config
interface WorkflowConfigJson {
	tags?: string[];
	rules?: WorkflowRule[];
	extra?: Record<string, unknown>;
}

// JSON stored inside space_workflow_nodes.config
interface NodeConfigJson {
	instructions?: string;
	/** Multi-agent array — present when the node uses the agents[] format */
	agents?: WorkflowNodeAgent[];
	/** Channel topology declarations — present when channels are defined */
	channels?: WorkflowChannel[];
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
	if (!raw) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

function rowToNode(row: NodeRow): WorkflowNode {
	const cfg = parseJson<NodeConfigJson>(row.config, {});
	const node: WorkflowNode = {
		id: row.id,
		name: row.name,
	};
	// agentId: stored as non-empty string for single-agent nodes, null/empty for multi-agent nodes.
	if (row.agent_id) {
		node.agentId = row.agent_id;
	}
	if (cfg.instructions) {
		node.instructions = cfg.instructions;
	}
	if (cfg.agents && cfg.agents.length > 0) {
		node.agents = cfg.agents;
	}
	if (cfg.channels && cfg.channels.length > 0) {
		node.channels = cfg.channels;
	}
	return node;
}

function rowToTransition(row: TransitionRow): WorkflowTransition {
	const condition = parseJson<WorkflowCondition | null>(row.condition, null);
	return {
		id: row.id,
		from: row.from_node_id,
		to: row.to_node_id,
		condition: condition ?? undefined,
		order: row.order_index,
		isCyclic: row.is_cyclic !== null ? Boolean(row.is_cyclic) : undefined,
	};
}

function rowToWorkflow(
	row: WorkflowRow,
	nodes: WorkflowNode[],
	transitions: WorkflowTransition[]
): SpaceWorkflow {
	const cfg = parseJson<WorkflowConfigJson>(row.config, {});
	// Derive startNodeId: use explicit column, fall back to first node
	const startNodeId = row.start_node_id ?? nodes[0]?.id ?? '';
	const layout = parseJson<Record<string, { x: number; y: number }> | null>(row.layout, null);
	return {
		id: row.id,
		spaceId: row.space_id,
		name: row.name,
		description: row.description || undefined,
		nodes,
		transitions,
		startNodeId,
		rules: cfg.rules ?? [],
		tags: cfg.tags ?? [],
		config: cfg.extra,
		maxIterations: row.max_iterations ?? undefined,
		layout: layout ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class SpaceWorkflowRepository {
	constructor(private db: BunDatabase) {}

	// -------------------------------------------------------------------------
	// Create
	// -------------------------------------------------------------------------

	createWorkflow(params: CreateSpaceWorkflowParams): SpaceWorkflow {
		const workflowId = generateUUID();
		const now = Date.now();

		// Pre-resolve node IDs so transitions can reference them
		const nodeInputs = params.nodes ?? [];
		const resolvedNodes: Array<{ id: string; input: WorkflowNodeInput }> = nodeInputs.map(
			(input) => ({
				id: input.id ?? generateUUID(),
				input,
			})
		);

		// Determine startNodeId: use provided value or default to first node
		const startNodeId = params.startNodeId ?? resolvedNodes[0]?.id ?? null;

		const cfg: WorkflowConfigJson = {
			tags: params.tags ?? [],
			rules: this.assignRuleIds(params.rules ?? []),
			extra: params.config,
		};

		const layoutJson = params.layout ? JSON.stringify(params.layout) : null;

		this.db
			.prepare(
				`INSERT INTO space_workflows (id, space_id, name, description, start_node_id, config, layout, max_iterations, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				workflowId,
				params.spaceId,
				params.name.trim(),
				params.description ?? '',
				startNodeId,
				JSON.stringify(cfg),
				layoutJson,
				params.maxIterations ?? null,
				now,
				now
			);

		// Insert node rows
		for (let i = 0; i < resolvedNodes.length; i++) {
			const { id, input } = resolvedNodes[i];
			this.insertNode(workflowId, input, id, i, now);
		}

		// Insert transition rows
		const transitionInputs = params.transitions ?? [];
		for (let i = 0; i < transitionInputs.length; i++) {
			this.insertTransition(workflowId, transitionInputs[i], i, now);
		}

		return this.getWorkflow(workflowId)!;
	}

	// -------------------------------------------------------------------------
	// Read
	// -------------------------------------------------------------------------

	getWorkflow(id: string): SpaceWorkflow | null {
		const row = this.db.prepare(`SELECT * FROM space_workflows WHERE id = ?`).get(id) as
			| WorkflowRow
			| undefined;
		if (!row) return null;
		const nodes = this.fetchNodes(id);
		const transitions = this.fetchTransitions(id);
		return rowToWorkflow(row, nodes, transitions);
	}

	listWorkflows(spaceId: string): SpaceWorkflow[] {
		const rows = this.db
			.prepare(`SELECT * FROM space_workflows WHERE space_id = ? ORDER BY created_at ASC`)
			.all(spaceId) as WorkflowRow[];
		return rows.map((r) => rowToWorkflow(r, this.fetchNodes(r.id), this.fetchTransitions(r.id)));
	}

	// -------------------------------------------------------------------------
	// Update
	// -------------------------------------------------------------------------

	updateWorkflow(id: string, params: UpdateSpaceWorkflowParams): SpaceWorkflow | null {
		const row = this.db.prepare(`SELECT * FROM space_workflows WHERE id = ?`).get(id) as
			| WorkflowRow
			| undefined;
		if (!row) return null;

		const now = Date.now();
		const fields: string[] = [];
		const values: (string | number | null)[] = [];

		if (params.name !== undefined) {
			fields.push('name = ?');
			values.push(params.name.trim());
		}
		if (params.description !== undefined) {
			fields.push('description = ?');
			values.push(params.description ?? '');
		}
		if (params.startNodeId !== undefined) {
			fields.push('start_node_id = ?');
			values.push(params.startNodeId ?? null);
		}

		// Build updated config
		const existingCfg = parseJson<WorkflowConfigJson>(row.config, {});
		let cfgChanged = false;
		const newCfg: WorkflowConfigJson = { ...existingCfg };

		if (params.tags !== undefined) {
			newCfg.tags = params.tags ?? [];
			cfgChanged = true;
		}
		if (params.rules !== undefined) {
			newCfg.rules = params.rules ?? [];
			cfgChanged = true;
		}
		if (params.config !== undefined) {
			newCfg.extra = params.config ?? undefined;
			cfgChanged = true;
		}

		if (cfgChanged) {
			fields.push('config = ?');
			values.push(JSON.stringify(newCfg));
		}

		if (params.maxIterations !== undefined) {
			fields.push('max_iterations = ?');
			values.push(params.maxIterations);
		}

		if (params.layout !== undefined) {
			fields.push('layout = ?');
			values.push(params.layout ? JSON.stringify(params.layout) : null);
		}

		const hasNodeReplacement = params.nodes !== undefined;
		const hasTransitionReplacement = params.transitions !== undefined;

		if (fields.length > 0 || hasNodeReplacement || hasTransitionReplacement) {
			fields.push('updated_at = ?');
			values.push(now, id);
			if (fields.length > 0) {
				this.db
					.prepare(`UPDATE space_workflows SET ${fields.join(', ')} WHERE id = ?`)
					.run(...values);
			}
		}

		if (hasNodeReplacement) {
			// Must delete transitions before nodes (FK constraint)
			this.db.prepare(`DELETE FROM space_workflow_transitions WHERE workflow_id = ?`).run(id);
			this.db.prepare(`DELETE FROM space_workflow_nodes WHERE workflow_id = ?`).run(id);
			const nodes = params.nodes ?? [];
			for (let i = 0; i < nodes.length; i++) {
				const node = nodes[i];
				this.insertNode(id, node as WorkflowNodeInput, node.id ?? generateUUID(), i, now);
			}
			// After replacing nodes, also replace transitions if provided
			if (hasTransitionReplacement) {
				const transitions = params.transitions ?? [];
				for (let i = 0; i < transitions.length; i++) {
					this.insertTransition(id, transitions[i], i, now);
				}
			}
		} else if (hasTransitionReplacement) {
			this.db.prepare(`DELETE FROM space_workflow_transitions WHERE workflow_id = ?`).run(id);
			const transitions = params.transitions ?? [];
			for (let i = 0; i < transitions.length; i++) {
				this.insertTransition(id, transitions[i], i, now);
			}
		}

		return this.getWorkflow(id)!;
	}

	// -------------------------------------------------------------------------
	// Delete
	// -------------------------------------------------------------------------

	deleteWorkflow(id: string): boolean {
		const result = this.db.prepare(`DELETE FROM space_workflows WHERE id = ?`).run(id);
		return result.changes > 0;
	}

	// -------------------------------------------------------------------------
	// Agent reference queries
	// -------------------------------------------------------------------------

	/**
	 * Find all workflows in a space whose nodes reference the given custom SpaceAgent ID.
	 * Used by SpaceAgentManager to prevent deletion of agents that are still in use.
	 *
	 * Checks two storage locations:
	 * - The `agent_id` column: used by single-agent nodes (legacy agentId format).
	 * - The `config` JSON column: used by multi-agent nodes (agents[] format stores agent IDs
	 *   in the JSON config; the agent_id column is NULL for these nodes).
	 */
	getWorkflowsReferencingAgent(agentId: string): SpaceWorkflow[] {
		// Match single-agent nodes (agent_id column) and multi-agent nodes (config JSON contains
		// the agent ID string). The LIKE pattern is conservative — it matches any config that
		// contains the UUID as a substring, which is safe because UUIDs are globally unique.
		const nodeRows = this.db
			.prepare(
				`SELECT DISTINCT workflow_id FROM space_workflow_nodes
         WHERE agent_id = ? OR config LIKE '%' || ? || '%'`
			)
			.all(agentId, agentId) as Array<{ workflow_id: string }>;

		const workflows: SpaceWorkflow[] = [];
		for (const { workflow_id } of nodeRows) {
			const wf = this.getWorkflow(workflow_id);
			if (wf) workflows.push(wf);
		}
		return workflows;
	}

	// -------------------------------------------------------------------------
	// Private helpers
	// -------------------------------------------------------------------------

	private fetchNodes(workflowId: string): WorkflowNode[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM space_workflow_nodes WHERE workflow_id = ? ORDER BY order_index ASC, rowid ASC`
			)
			.all(workflowId) as NodeRow[];
		return rows.map(rowToNode);
	}

	private fetchTransitions(workflowId: string): WorkflowTransition[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM space_workflow_transitions WHERE workflow_id = ? ORDER BY order_index ASC, rowid ASC`
			)
			.all(workflowId) as TransitionRow[];
		return rows.map(rowToTransition);
	}

	private insertNode(
		workflowId: string,
		input: WorkflowNodeInput,
		nodeId: string,
		index: number,
		now: number
	): void {
		const nodeCfg: NodeConfigJson = {
			instructions: input.instructions,
		};
		// Persist agents and channels into the JSON config column so they survive round-trips.
		if (input.agents && input.agents.length > 0) {
			nodeCfg.agents = input.agents;
		}
		if (input.channels && input.channels.length > 0) {
			nodeCfg.channels = input.channels;
		}

		// Store null for agent_id when using the multi-agent agents[] format.
		// Single-agent nodes store the UUID directly for fast lookups.
		const agentIdValue = input.agentId && input.agentId.trim() ? input.agentId : null;

		this.db
			.prepare(
				`INSERT INTO space_workflow_nodes
           (id, workflow_id, name, description, agent_id, order_index, config, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				nodeId,
				workflowId,
				input.name,
				'',
				agentIdValue,
				index,
				JSON.stringify(nodeCfg),
				now,
				now
			);
	}

	private insertTransition(
		workflowId: string,
		input: WorkflowTransitionInput,
		index: number,
		now: number
	): void {
		const transitionId = generateUUID();
		const conditionJson = input.condition ? JSON.stringify(input.condition) : null;
		const isCyclicValue = input.isCyclic !== undefined ? (input.isCyclic ? 1 : 0) : null;

		this.db
			.prepare(
				`INSERT INTO space_workflow_transitions
           (id, workflow_id, from_node_id, to_node_id, condition, order_index, is_cyclic, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				transitionId,
				workflowId,
				input.from,
				input.to,
				conditionJson,
				input.order ?? index,
				isCyclicValue,
				now,
				now
			);
	}

	private assignRuleIds(rules: WorkflowRuleInput[]): WorkflowRule[] {
		return rules.map((r) => ({ ...r, id: generateUUID() }));
	}
}
