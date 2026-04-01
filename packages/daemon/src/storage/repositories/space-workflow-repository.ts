/**
 * SpaceWorkflowRepository
 *
 * Data access layer for SpaceWorkflow and SpaceWorkflowNode records.
 *
 * Storage layout:
 *   space_workflows             — id, space_id, name, description, start_node_id, config (JSON), channels (JSON), layout (JSON), created_at, updated_at
 *   space_workflow_nodes        — id, workflow_id, name, agent_id, order_index, config (JSON), created_at, updated_at
 *
 * The `config` column on space_workflows stores: { tags, rules, ...extra }
 * The `channels` column on space_workflows stores: WorkflowChannel[] JSON (unified channel topology)
 * The `config` column on space_workflow_nodes stores: { systemPrompt?, instructions?, agents? }
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type {
	SpaceWorkflow,
	WorkflowNode,
	WorkflowRule,
	WorkflowNodeInput,
	WorkflowRuleInput,
	WorkflowNodeAgent,
	WorkflowChannel,
	Gate,
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
	channels: string | null;
	gates: string | null;
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

// JSON stored inside space_workflows.config
interface WorkflowConfigJson {
	tags?: string[];
	rules?: WorkflowRule[];
	extra?: Record<string, unknown>;
}

// JSON stored inside space_workflow_nodes.config
interface NodeConfigJson {
	systemPrompt?: string;
	instructions?: string;
	/** Multi-agent array — present when the node uses the agents[] format */
	agents?: WorkflowNodeAgent[];
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
	if (cfg.systemPrompt) {
		node.systemPrompt = cfg.systemPrompt;
	}
	if (cfg.agents && cfg.agents.length > 0) {
		// Backfill name = agentId for rows persisted before the name field was introduced.
		node.agents = cfg.agents.map((a: WorkflowNodeAgent) => ({
			...a,
			// Support legacy data where role was stored instead of name
			name: a.name?.trim() ? a.name : (a as unknown as { role?: string }).role?.trim() || a.agentId,
		}));
	}
	return node;
}

function rowToWorkflow(row: WorkflowRow, nodes: WorkflowNode[]): SpaceWorkflow {
	const cfg = parseJson<WorkflowConfigJson>(row.config, {});
	// Derive startNodeId: use explicit column, fall back to first node
	const startNodeId = row.start_node_id ?? nodes[0]?.id ?? '';
	const layout = parseJson<Record<string, { x: number; y: number }> | null>(row.layout, null);
	// Read channels from the dedicated column (Migration 53+).
	const channels = parseJson<WorkflowChannel[] | null>(row.channels, null);
	// Read gates from the dedicated column (Migration 61+).
	const gates = parseJson<Gate[] | null>(row.gates, null);
	return {
		id: row.id,
		spaceId: row.space_id,
		name: row.name,
		description: row.description || undefined,
		nodes,
		startNodeId,
		rules: cfg.rules ?? [],
		tags: cfg.tags ?? [],
		channels: channels && channels.length > 0 ? channels : undefined,
		gates: gates && gates.length > 0 ? gates : undefined,
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

		const channelsJson =
			params.channels && params.channels.length > 0 ? JSON.stringify(params.channels) : null;
		const gatesJson = params.gates && params.gates.length > 0 ? JSON.stringify(params.gates) : null;
		const layoutJson = params.layout ? JSON.stringify(params.layout) : null;

		this.db
			.prepare(
				`INSERT INTO space_workflows (id, space_id, name, description, start_node_id, config, channels, gates, layout, max_iterations, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				workflowId,
				params.spaceId,
				params.name.trim(),
				params.description ?? '',
				startNodeId,
				JSON.stringify(cfg),
				channelsJson,
				gatesJson,
				layoutJson,
				null, // max_iterations (dead column, kept for backward compat)
				now,
				now
			);

		// Insert node rows
		for (let i = 0; i < resolvedNodes.length; i++) {
			const { id, input } = resolvedNodes[i];
			this.insertNode(workflowId, input, id, i, now);
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
		return rowToWorkflow(row, nodes);
	}

	listWorkflows(spaceId: string): SpaceWorkflow[] {
		const rows = this.db
			.prepare(`SELECT * FROM space_workflows WHERE space_id = ? ORDER BY created_at ASC`)
			.all(spaceId) as WorkflowRow[];
		return rows.map((r) => rowToWorkflow(r, this.fetchNodes(r.id)));
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

		if (params.channels !== undefined) {
			fields.push('channels = ?');
			values.push(
				params.channels && params.channels.length > 0 ? JSON.stringify(params.channels) : null
			);
		}

		if (params.gates !== undefined) {
			fields.push('gates = ?');
			values.push(params.gates && params.gates.length > 0 ? JSON.stringify(params.gates) : null);
		}

		if (params.layout !== undefined) {
			fields.push('layout = ?');
			values.push(params.layout ? JSON.stringify(params.layout) : null);
		}

		const hasNodeReplacement = params.nodes !== undefined;

		if (fields.length > 0 || hasNodeReplacement) {
			fields.push('updated_at = ?');
			values.push(now, id);
			if (fields.length > 0) {
				this.db
					.prepare(`UPDATE space_workflows SET ${fields.join(', ')} WHERE id = ?`)
					.run(...values);
			}
		}

		if (hasNodeReplacement) {
			this.db.prepare(`DELETE FROM space_workflow_nodes WHERE workflow_id = ?`).run(id);
			const nodes = params.nodes ?? [];
			for (let i = 0; i < nodes.length; i++) {
				const node = nodes[i];
				this.insertNode(id, node as WorkflowNodeInput, node.id ?? generateUUID(), i, now);
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

	private insertNode(
		workflowId: string,
		input: WorkflowNodeInput,
		nodeId: string,
		index: number,
		now: number
	): void {
		const nodeCfg: NodeConfigJson = {
			systemPrompt: input.systemPrompt,
			instructions: input.instructions,
		};
		// Persist agents into the JSON config column so they survive round-trips.
		if (input.agents && input.agents.length > 0) {
			nodeCfg.agents = input.agents;
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

	private assignRuleIds(rules: WorkflowRuleInput[]): WorkflowRule[] {
		return rules.map((r) => ({ ...r, id: generateUUID() }));
	}
}
