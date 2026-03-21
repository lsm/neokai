/**
 * SpaceWorkflowManager
 *
 * Business logic layer for SpaceWorkflow operations within a Space.
 *
 * Responsibilities:
 * - Validate workflow integrity (unique name, step agent refs, transition graph validity)
 * - Protect custom agents that are referenced by steps
 *
 * Workflow selection: either explicit workflowId provided by the caller, or
 * AI auto-select at runtime via list_workflows + start_workflow_run. There is
 * no default workflow concept.
 */

import type {
	SpaceWorkflow,
	WorkflowCondition,
	WorkflowStepInput,
	WorkflowTransitionInput,
	CreateSpaceWorkflowParams,
	UpdateSpaceWorkflowParams,
} from '@neokai/shared';
import type { SpaceWorkflowRepository } from '../../../storage/repositories/space-workflow-repository';

// ---------------------------------------------------------------------------
// Dependency interfaces
// ---------------------------------------------------------------------------

/**
 * Minimal interface the manager needs from SpaceAgentManager to validate
 * custom agent references in workflow steps.
 */
export interface SpaceAgentLookup {
	/** Returns the SpaceAgent with the given UUID in the given space, or null if not found. */
	getAgentById(spaceId: string, id: string): { id: string; name: string } | null;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class WorkflowValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WorkflowValidationError';
	}
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class SpaceWorkflowManager {
	constructor(
		private repo: SpaceWorkflowRepository,
		private agentLookup: SpaceAgentLookup | null = null
	) {}

	// -------------------------------------------------------------------------
	// Create
	// -------------------------------------------------------------------------

	createWorkflow(params: CreateSpaceWorkflowParams): SpaceWorkflow {
		const trimmedName = params.name.trim();
		this.validateName(params.spaceId, trimmedName, null);
		const steps = params.steps ?? [];
		this.validateSteps(params.spaceId, steps);
		this.validateTransitions(steps, params.transitions ?? [], params.startStepId);
		return this.repo.createWorkflow({ ...params, name: trimmedName });
	}

	// -------------------------------------------------------------------------
	// Read
	// -------------------------------------------------------------------------

	getWorkflow(id: string): SpaceWorkflow | null {
		return this.repo.getWorkflow(id);
	}

	listWorkflows(spaceId: string): SpaceWorkflow[] {
		return this.repo.listWorkflows(spaceId);
	}

	// -------------------------------------------------------------------------
	// Update
	// -------------------------------------------------------------------------

	updateWorkflow(id: string, params: UpdateSpaceWorkflowParams): SpaceWorkflow | null {
		const existing = this.repo.getWorkflow(id);
		if (!existing) return null;

		if (params.name !== undefined) {
			const trimmedName = params.name.trim();
			this.validateName(existing.spaceId, trimmedName, id);
			params = { ...params, name: trimmedName };
		}
		if (params.steps !== undefined) {
			const inputs: WorkflowStepInput[] = (params.steps ?? []).map(
				(s): WorkflowStepInput => ({
					id: s.id,
					name: s.name,
					agentId: s.agentId,
					agents: s.agents,
					channels: s.channels,
					instructions: s.instructions,
				})
			);
			this.validateSteps(existing.spaceId, inputs);
			if (params.transitions !== undefined) {
				this.validateTransitions(inputs, params.transitions ?? [], params.startStepId ?? null);
			}
		} else if (params.transitions !== undefined) {
			// Validate transitions against existing steps
			const existingStepInputs: WorkflowStepInput[] = existing.steps.map((s) => ({
				id: s.id,
				name: s.name,
				agentId: s.agentId,
				instructions: s.instructions,
			}));
			this.validateTransitions(
				existingStepInputs,
				params.transitions ?? [],
				params.startStepId ?? null
			);
		}

		return this.repo.updateWorkflow(id, params);
	}

	// -------------------------------------------------------------------------
	// Delete
	// -------------------------------------------------------------------------

	deleteWorkflow(id: string): boolean {
		const existing = this.repo.getWorkflow(id);
		if (!existing) return false;
		return this.repo.deleteWorkflow(id);
	}

	// -------------------------------------------------------------------------
	// Agent reference protection
	// -------------------------------------------------------------------------

	/**
	 * Returns all workflows whose steps reference the given custom agent.
	 * Used by SpaceAgentManager to block deletion of in-use agents.
	 */
	getWorkflowsReferencingAgent(agentId: string): SpaceWorkflow[] {
		return this.repo.getWorkflowsReferencingAgent(agentId);
	}

	// -------------------------------------------------------------------------
	// Validation
	// -------------------------------------------------------------------------

	private validateName(spaceId: string, name: string, excludeId: string | null): void {
		if (!name) {
			throw new WorkflowValidationError('Workflow name must not be empty');
		}
		const existing = this.repo.listWorkflows(spaceId);
		for (const wf of existing) {
			if (wf.name === name && wf.id !== excludeId) {
				throw new WorkflowValidationError(
					`A workflow named "${name}" already exists in this space`
				);
			}
		}
	}

	private validateSteps(spaceId: string, steps: WorkflowStepInput[]): void {
		if (steps.length === 0) {
			throw new WorkflowValidationError('A workflow must have at least one step');
		}

		for (let i = 0; i < steps.length; i++) {
			this.validateStepAgentRef(spaceId, steps[i], i);
		}
	}

	private validateStepAgentRef(spaceId: string, step: WorkflowStepInput, index: number): void {
		const hasAgentId = step.agentId && step.agentId.trim().length > 0;
		const hasAgents = step.agents && step.agents.length > 0;

		if (!hasAgentId && !hasAgents) {
			throw new WorkflowValidationError(
				`step[${index}]: at least one of agentId or agents must be provided`
			);
		}

		if (this.agentLookup) {
			if (hasAgentId) {
				const agent = this.agentLookup.getAgentById(spaceId, step.agentId!);
				if (!agent) {
					throw new WorkflowValidationError(
						`step[${index}]: agentId "${step.agentId}" does not match any SpaceAgent in this space`
					);
				}
			}
			if (hasAgents) {
				for (let j = 0; j < step.agents!.length; j++) {
					const entry = step.agents![j];
					if (!entry.agentId || !entry.agentId.trim()) {
						throw new WorkflowValidationError(
							`step[${index}].agents[${j}]: agentId must be a non-empty SpaceAgent UUID`
						);
					}
					const agent = this.agentLookup.getAgentById(spaceId, entry.agentId);
					if (!agent) {
						throw new WorkflowValidationError(
							`step[${index}].agents[${j}]: agentId "${entry.agentId}" does not match any SpaceAgent in this space`
						);
					}
				}
			}
		}
	}

	private validateTransitions(
		steps: WorkflowStepInput[],
		transitions: WorkflowTransitionInput[],
		startStepId: string | null | undefined
	): void {
		const knownStepIds = new Set<string>(steps.filter((s) => s.id).map((s) => s.id as string));

		// When transitions reference step IDs but some steps have no explicit id, we cannot
		// validate the references at all — an invalid transition would only surface at runtime.
		// Require all steps to have explicit IDs when transitions are provided.
		if (transitions.length > 0 && knownStepIds.size < steps.length) {
			throw new WorkflowValidationError(
				'All steps must have explicit id values when transitions are specified'
			);
		}

		for (let i = 0; i < transitions.length; i++) {
			const t = transitions[i];
			if (!t.from || !t.from.trim()) {
				throw new WorkflowValidationError(`transition[${i}]: 'from' step ID must not be empty`);
			}
			if (!t.to || !t.to.trim()) {
				throw new WorkflowValidationError(`transition[${i}]: 'to' step ID must not be empty`);
			}
			if (!knownStepIds.has(t.from)) {
				throw new WorkflowValidationError(
					`transition[${i}]: 'from' step ID "${t.from}" does not match any step in this workflow`
				);
			}
			if (!knownStepIds.has(t.to)) {
				throw new WorkflowValidationError(
					`transition[${i}]: 'to' step ID "${t.to}" does not match any step in this workflow`
				);
			}
			if (t.condition) {
				this.validateCondition(t.condition, `transition[${i}].condition`);
			}
		}

		// Validate startStepId if provided
		if (startStepId && knownStepIds.size > 0 && !knownStepIds.has(startStepId)) {
			throw new WorkflowValidationError(
				`startStepId "${startStepId}" does not match any step in this workflow`
			);
		}
	}

	private validateCondition(condition: WorkflowCondition, location: string): void {
		if (condition.type === 'condition') {
			if (!condition.expression || !condition.expression.trim()) {
				throw new WorkflowValidationError(
					`${location}: 'condition' type requires a non-empty expression`
				);
			}
		}
	}
}
