/**
 * SpaceWorkflowRepository
 *
 * Data access layer for SpaceWorkflow and SpaceWorkflowNode records.
 *
 * Storage layout:
 *   space_workflows             — id, space_id, name, description, start_node_id, end_node_id,
 *                                  tags (JSON), channels (JSON), gates (JSON), layout (JSON),
 *                                  created_at, updated_at
 *   space_workflow_nodes        — id, workflow_id, name, description, config (JSON),
 *                                  created_at, updated_at
 *
 * The `config` column on space_workflow_nodes stores: { agents? }
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type {
	SpaceWorkflow,
	WorkflowNode,
	WorkflowNodeInput,
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
	end_node_id?: string | null;
	tags: string;
	channels: string | null;
	gates: string | null;
	layout: string | null;
	created_at: number;
	updated_at: number;
}

interface NodeRow {
	id: string;
	workflow_id: string;
	name: string;
	description: string;
	config: string | null;
	created_at: number;
	updated_at: number;
}

// JSON stored inside space_workflow_nodes.config
interface NodeConfigJson {
	/** Multi-agent array */
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
	// Ensure agents is always a non-empty array
	const agents: WorkflowNodeAgent[] =
		cfg.agents && cfg.agents.length > 0
			? cfg.agents.map((a: WorkflowNodeAgent) => ({
					...a,
					// Backfill name if missing (legacy rows)
					name: a.name?.trim() ? a.name : a.agentId,
				}))
			: [];

	return {
		id: row.id,
		name: row.name,
		agents,
	};
}

function rowToWorkflow(row: WorkflowRow, nodes: WorkflowNode[]): SpaceWorkflow {
	const startNodeId = row.start_node_id ?? nodes[0]?.id ?? '';
	const tags = parseJson<string[]>(row.tags, []);
	const layout = parseJson<Record<string, { x: number; y: number }> | null>(row.layout, null);
	const channels = parseJson<WorkflowChannel[] | null>(row.channels, null);
	const gates = parseJson<Gate[] | null>(row.gates, null);

	const wf: SpaceWorkflow = {
		id: row.id,
		spaceId: row.space_id,
		name: row.name,
		description: row.description || undefined,
		nodes,
		startNodeId,
		tags,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
	if (row.end_node_id) wf.endNodeId = row.end_node_id;
	if (channels && channels.length > 0) wf.channels = channels;
	if (gates && gates.length > 0) wf.gates = gates;
	if (layout) wf.layout = layout;
	return wf;
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

		// Pre-resolve node IDs so channels can reference them
		const nodeInputs = params.nodes ?? [];
		const resolvedNodes: Array<{ id: string; input: WorkflowNodeInput }> = nodeInputs.map(
			(input) => ({
				id: input.id ?? generateUUID(),
				input,
			})
		);

		const startNodeId = params.startNodeId ?? resolvedNodes[0]?.id ?? null;
		const endNodeId = params.endNodeId ?? null;

		const channelsJson =
			params.channels && params.channels.length > 0 ? JSON.stringify(params.channels) : null;
		const gatesJson = params.gates && params.gates.length > 0 ? JSON.stringify(params.gates) : null;
		const layoutJson = params.layout ? JSON.stringify(params.layout) : null;

		this.db
			.prepare(
				`INSERT INTO space_workflows (id, space_id, name, description, start_node_id, end_node_id, tags, channels, gates, layout, created_at, updated_at)
	         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				workflowId,
				params.spaceId,
				params.name.trim(),
				params.description ?? '',
				startNodeId,
				endNodeId,
				JSON.stringify(params.tags ?? []),
				channelsJson,
				gatesJson,
				layoutJson,
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
			.prepare(
				`SELECT * FROM space_workflows WHERE space_id = ? ORDER BY created_at ASC, rowid ASC`
			)
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
		if (params.endNodeId !== undefined) {
			fields.push('end_node_id = ?');
			values.push(params.endNodeId ?? null);
		}
		if (params.tags !== undefined) {
			fields.push('tags = ?');
			values.push(JSON.stringify(params.tags ?? []));
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
	 * Checks the `config` JSON column for multi-agent nodes (agents[] format).
	 */
	getWorkflowsReferencingAgent(agentId: string): SpaceWorkflow[] {
		const nodeRows = this.db
			.prepare(
				`SELECT DISTINCT workflow_id FROM space_workflow_nodes
	         WHERE config LIKE '%' || ? || '%'`
			)
			.all(agentId) as Array<{ workflow_id: string }>;

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
			.prepare(`SELECT * FROM space_workflow_nodes WHERE workflow_id = ? ORDER BY rowid ASC`)
			.all(workflowId) as NodeRow[];
		return rows.map(rowToNode);
	}

	private insertNode(
		workflowId: string,
		input: WorkflowNodeInput,
		nodeId: string,
		_index: number,
		now: number
	): void {
		const nodeCfg: NodeConfigJson = {};

		// Normalize agents: use `agents` array if present, otherwise fall back to legacy
		// `agentId` shorthand (still used in tests and older call-sites).
		const legacyAgentId = (input as unknown as Record<string, unknown>)['agentId'] as
			| string
			| undefined;
		let resolvedAgents = input.agents && input.agents.length > 0 ? input.agents : undefined;
		if (!resolvedAgents && legacyAgentId) {
			resolvedAgents = [{ agentId: legacyAgentId, name: input.name }];
		}
		if (resolvedAgents && resolvedAgents.length > 0) {
			nodeCfg.agents = resolvedAgents;
		}

		this.db
			.prepare(
				`INSERT INTO space_workflow_nodes
	           (id, workflow_id, name, description, config, created_at, updated_at)
	         VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.run(nodeId, workflowId, input.name, '', JSON.stringify(nodeCfg), now, now);
	}
}
