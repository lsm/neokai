/**
 * SpaceWorkflowRepository
 *
 * Data access layer for SpaceWorkflow, SpaceWorkflowStep, and SpaceWorkflowTransition records.
 *
 * Storage layout:
 *   space_workflows             — id, space_id, name, description, start_step_id, config (JSON), layout (JSON), created_at, updated_at
 *   space_workflow_steps        — id, workflow_id, name, agent_id, order_index, config (JSON), created_at, updated_at
 *   space_workflow_transitions  — id, workflow_id, from_step_id, to_step_id, condition (JSON), order_index, is_cyclic, created_at, updated_at
 *
 * The `config` column on space_workflows stores: { tags, rules, ...extra }
 * The `config` column on space_workflow_steps stores: { instructions? }
 * The `condition` column on space_workflow_transitions stores: WorkflowCondition JSON or null
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type {
	SpaceWorkflow,
	WorkflowStep,
	WorkflowRule,
	WorkflowCondition,
	WorkflowTransition,
	WorkflowStepInput,
	WorkflowTransitionInput,
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
	start_step_id: string | null;
	config: string | null;
	layout: string | null;
	max_iterations: number | null;
	created_at: number;
	updated_at: number;
}

interface StepRow {
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
	from_step_id: string;
	to_step_id: string;
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

// JSON stored inside space_workflow_steps.config
interface StepConfigJson {
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
	if (!row.agent_id) {
		throw new Error(`WorkflowStep ${row.id}: agent_id is null in DB`);
	}
	const cfg = parseJson<StepConfigJson>(row.config, {});
	return {
		id: row.id,
		name: row.name,
		agentId: row.agent_id,
		instructions: cfg.instructions,
	};
}

function rowToTransition(row: TransitionRow): WorkflowTransition {
	const condition = parseJson<WorkflowCondition | null>(row.condition, null);
	return {
		id: row.id,
		from: row.from_step_id,
		to: row.to_step_id,
		condition: condition ?? undefined,
		order: row.order_index,
		isCyclic: Boolean(row.is_cyclic),
	};
}

function rowToWorkflow(
	row: WorkflowRow,
	steps: WorkflowStep[],
	transitions: WorkflowTransition[]
): SpaceWorkflow {
	const cfg = parseJson<WorkflowConfigJson>(row.config, {});
	// Derive startStepId: use explicit column, fall back to first step
	const startStepId = row.start_step_id ?? steps[0]?.id ?? '';
	const layout = parseJson<Record<string, { x: number; y: number }> | null>(row.layout, null);
	return {
		id: row.id,
		spaceId: row.space_id,
		name: row.name,
		description: row.description || undefined,
		steps,
		transitions,
		startStepId,
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

		// Pre-resolve step IDs so transitions can reference them
		const stepInputs = params.steps ?? [];
		const resolvedSteps: Array<{ id: string; input: WorkflowStepInput }> = stepInputs.map(
			(input) => ({
				id: input.id ?? generateUUID(),
				input,
			})
		);

		// Determine startStepId: use provided value or default to first step
		const startStepId = params.startStepId ?? resolvedSteps[0]?.id ?? null;

		const cfg: WorkflowConfigJson = {
			tags: params.tags ?? [],
			rules: this.assignRuleIds(params.rules ?? []),
			extra: params.config,
		};

		const layoutJson = params.layout ? JSON.stringify(params.layout) : null;

		this.db
			.prepare(
				`INSERT INTO space_workflows (id, space_id, name, description, start_step_id, config, layout, max_iterations, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				workflowId,
				params.spaceId,
				params.name.trim(),
				params.description ?? '',
				startStepId,
				JSON.stringify(cfg),
				layoutJson,
				params.maxIterations ?? null,
				now,
				now
			);

		// Insert step rows
		for (let i = 0; i < resolvedSteps.length; i++) {
			const { id, input } = resolvedSteps[i];
			this.insertStep(workflowId, input, id, i, now);
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
		const steps = this.fetchSteps(id);
		const transitions = this.fetchTransitions(id);
		return rowToWorkflow(row, steps, transitions);
	}

	listWorkflows(spaceId: string): SpaceWorkflow[] {
		const rows = this.db
			.prepare(`SELECT * FROM space_workflows WHERE space_id = ? ORDER BY created_at ASC`)
			.all(spaceId) as WorkflowRow[];
		return rows.map((r) => rowToWorkflow(r, this.fetchSteps(r.id), this.fetchTransitions(r.id)));
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
		if (params.startStepId !== undefined) {
			fields.push('start_step_id = ?');
			values.push(params.startStepId ?? null);
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

		const hasStepReplacement = params.steps !== undefined;
		const hasTransitionReplacement = params.transitions !== undefined;

		if (fields.length > 0 || hasStepReplacement || hasTransitionReplacement) {
			fields.push('updated_at = ?');
			values.push(now, id);
			if (fields.length > 0) {
				this.db
					.prepare(`UPDATE space_workflows SET ${fields.join(', ')} WHERE id = ?`)
					.run(...values);
			}
		}

		if (hasStepReplacement) {
			// Must delete transitions before steps (FK constraint)
			this.db.prepare(`DELETE FROM space_workflow_transitions WHERE workflow_id = ?`).run(id);
			this.db.prepare(`DELETE FROM space_workflow_steps WHERE workflow_id = ?`).run(id);
			const steps = params.steps ?? [];
			for (let i = 0; i < steps.length; i++) {
				const step = steps[i];
				this.insertStep(id, step as WorkflowStepInput, step.id ?? generateUUID(), i, now);
			}
			// After replacing steps, also replace transitions if provided
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
			.prepare(
				`SELECT * FROM space_workflow_steps WHERE workflow_id = ? ORDER BY order_index ASC, rowid ASC`
			)
			.all(workflowId) as StepRow[];
		return rows.map(rowToStep);
	}

	private fetchTransitions(workflowId: string): WorkflowTransition[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM space_workflow_transitions WHERE workflow_id = ? ORDER BY order_index ASC, rowid ASC`
			)
			.all(workflowId) as TransitionRow[];
		return rows.map(rowToTransition);
	}

	private insertStep(
		workflowId: string,
		input: WorkflowStepInput,
		stepId: string,
		index: number,
		now: number
	): void {
		const stepCfg: StepConfigJson = {
			instructions: input.instructions,
		};

		this.db
			.prepare(
				`INSERT INTO space_workflow_steps
           (id, workflow_id, name, description, agent_id, order_index, config, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				stepId,
				workflowId,
				input.name,
				'',
				input.agentId,
				index,
				JSON.stringify(stepCfg),
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
           (id, workflow_id, from_step_id, to_step_id, condition, order_index, is_cyclic, created_at, updated_at)
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
