/**
 * SpaceWorkflowRepository
 *
 * Data access layer for SpaceWorkflow and SpaceWorkflowStep records.
 *
 * Storage layout:
 *   space_workflows  — id, space_id, name, description, config (JSON), created_at, updated_at
 *   space_workflow_steps — id, workflow_id, name, description, agent_id (custom UUID | null),
 *                          order_index, config (JSON), created_at, updated_at
 *
 * The `config` column on space_workflows stores: { tags, rules, ...extra }
 * The `config` column on space_workflow_steps stores: { agentRefType, agentRef, entryGate?,
 *   exitGate?, instructions? }
 * The `agent_id` column stores the custom SpaceAgent's UUID when agentRefType='custom',
 *   otherwise null.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type {
	SpaceWorkflow,
	WorkflowStep,
	WorkflowRule,
	WorkflowGate,
	WorkflowStepInput,
	WorkflowRuleInput,
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
	config: string | null;
	created_at: number;
	updated_at: number;
}

interface StepRow {
	id: string;
	workflow_id: string;
	name: string;
	description: string;
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

// JSON stored inside space_workflow_steps.config
interface StepConfigJson {
	agentRefType: 'builtin' | 'custom';
	agentRef: string;
	entryGate?: WorkflowGate;
	exitGate?: WorkflowGate;
	instructions?: string;
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

function rowToStep(row: StepRow): WorkflowStep {
	const cfg = parseJson<StepConfigJson>(row.config, {
		agentRefType: 'builtin',
		agentRef: 'general',
	});

	const base = {
		id: row.id,
		name: row.name,
		order: row.order_index,
		entryGate: cfg.entryGate,
		exitGate: cfg.exitGate,
		instructions: cfg.instructions,
	};

	if (cfg.agentRefType === 'custom') {
		return { ...base, agentRefType: 'custom', agentRef: cfg.agentRef } as WorkflowStep;
	}
	return {
		...base,
		agentRefType: 'builtin',
		agentRef: cfg.agentRef as 'planner' | 'coder' | 'general',
	} as WorkflowStep;
}

function rowToWorkflow(row: WorkflowRow, steps: WorkflowStep[]): SpaceWorkflow {
	const cfg = parseJson<WorkflowConfigJson>(row.config, {});
	return {
		id: row.id,
		spaceId: row.space_id,
		name: row.name,
		description: row.description || undefined,
		steps,
		rules: cfg.rules ?? [],
		tags: cfg.tags ?? [],
		config: cfg.extra,
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
		const id = generateUUID();
		const now = Date.now();

		const cfg: WorkflowConfigJson = {
			tags: params.tags ?? [],
			rules: this.assignRuleIds(params.rules ?? []),
			extra: params.config,
		};

		this.db
			.prepare(
				`INSERT INTO space_workflows (id, space_id, name, description, config, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				params.spaceId,
				params.name.trim(),
				params.description ?? '',
				JSON.stringify(cfg),
				now,
				now
			);

		// Insert steps in order
		const stepInputs = params.steps ?? [];
		for (let i = 0; i < stepInputs.length; i++) {
			this.insertStep(id, stepInputs[i], i, now);
		}

		return this.getWorkflow(id)!;
	}

	// -------------------------------------------------------------------------
	// Read
	// -------------------------------------------------------------------------

	getWorkflow(id: string): SpaceWorkflow | null {
		const row = this.db.prepare(`SELECT * FROM space_workflows WHERE id = ?`).get(id) as
			| WorkflowRow
			| undefined;
		if (!row) return null;
		const steps = this.fetchSteps(id);
		return rowToWorkflow(row, steps);
	}

	listWorkflows(spaceId: string): SpaceWorkflow[] {
		const rows = this.db
			.prepare(`SELECT * FROM space_workflows WHERE space_id = ? ORDER BY created_at ASC`)
			.all(spaceId) as WorkflowRow[];
		return rows.map((r) => rowToWorkflow(r, this.fetchSteps(r.id)));
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

		// Build updated config
		const existingCfg = parseJson<WorkflowConfigJson>(row.config, {});
		let cfgChanged = false;
		const newCfg: WorkflowConfigJson = { ...existingCfg };

		if (params.tags !== undefined) {
			newCfg.tags = params.tags ?? [];
			cfgChanged = true;
		}
		if (params.rules !== undefined) {
			// Rules in UpdateSpaceWorkflowParams are full WorkflowRule[] (with ids)
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

		// Always bump updated_at if anything changed (scalar fields or steps)
		const hasStepReplacement = params.steps !== undefined;
		if (fields.length > 0 || hasStepReplacement) {
			fields.push('updated_at = ?');
			values.push(now, id);
			this.db
				.prepare(`UPDATE space_workflows SET ${fields.join(', ')} WHERE id = ?`)
				.run(...values);
		}

		// Replace all steps if steps are provided
		if (hasStepReplacement) {
			this.db.prepare(`DELETE FROM space_workflow_steps WHERE workflow_id = ?`).run(id);
			const steps = params.steps ?? [];
			for (let i = 0; i < steps.length; i++) {
				// UpdateSpaceWorkflowParams has steps as WorkflowStep[] (with id/order)
				// We replace them with new IDs to keep the DB consistent
				this.insertStep(id, steps[i] as unknown as WorkflowStepInput, i, now);
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
	 * Find all workflows in a space whose steps reference the given custom SpaceAgent ID.
	 * Used by SpaceAgentManager to prevent deletion of agents that are still in use.
	 */
	getWorkflowsReferencingAgent(agentId: string): SpaceWorkflow[] {
		const stepRows = this.db
			.prepare(`SELECT DISTINCT workflow_id FROM space_workflow_steps WHERE agent_id = ?`)
			.all(agentId) as Array<{ workflow_id: string }>;

		const workflows: SpaceWorkflow[] = [];
		for (const { workflow_id } of stepRows) {
			const wf = this.getWorkflow(workflow_id);
			if (wf) workflows.push(wf);
		}
		return workflows;
	}

	// -------------------------------------------------------------------------
	// Private helpers
	// -------------------------------------------------------------------------

	private fetchSteps(workflowId: string): WorkflowStep[] {
		const rows = this.db
			.prepare(`SELECT * FROM space_workflow_steps WHERE workflow_id = ? ORDER BY order_index ASC`)
			.all(workflowId) as StepRow[];
		return rows.map(rowToStep);
	}

	private insertStep(
		workflowId: string,
		input: WorkflowStepInput,
		index: number,
		now: number
	): void {
		const stepId = generateUUID();
		const stepCfg: StepConfigJson = {
			agentRefType: input.agentRefType,
			agentRef: input.agentRef,
			entryGate: input.entryGate,
			exitGate: input.exitGate,
			instructions: input.instructions,
		};

		const agentId = input.agentRefType === 'custom' ? input.agentRef : null;

		this.db
			.prepare(
				`INSERT INTO space_workflow_steps
           (id, workflow_id, name, description, agent_id, order_index, config, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(stepId, workflowId, input.name, '', agentId, index, JSON.stringify(stepCfg), now, now);
	}

	private assignRuleIds(rules: WorkflowRuleInput[]): WorkflowRule[] {
		return rules.map((r) => ({ ...r, id: generateUUID() }));
	}
}
