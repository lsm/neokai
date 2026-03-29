/**
 * SpaceWorkflowManager
 *
 * Business logic layer for SpaceWorkflow operations within a Space.
 *
 * Responsibilities:
 * - Validate workflow integrity (unique name, node agent refs, channel graph validity)
 * - Protect custom agents that are referenced by nodes
 *
 * Workflow selection: either explicit workflowId provided by the caller, or
 * AI auto-select at runtime via list_workflows + start_workflow_run. There is
 * no default workflow concept.
 */

import type {
	SpaceWorkflow,
	WorkflowCondition,
	WorkflowNodeInput,
	CreateSpaceWorkflowParams,
	UpdateSpaceWorkflowParams,
	WorkflowChannel,
} from '@neokai/shared';
import type { SpaceWorkflowRepository } from '../../../storage/repositories/space-workflow-repository';

// ---------------------------------------------------------------------------
// Dependency interfaces
// ---------------------------------------------------------------------------

/**
 * Minimal interface the manager needs from SpaceAgentManager to validate
 * custom agent references in workflow nodes.
 */
export interface SpaceAgentLookup {
	/** Returns the SpaceAgent with the given UUID in the given space, or null if not found. */
	getAgentById(spaceId: string, id: string): { id: string; name: string; role: string } | null;
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
		const nodes = params.nodes ?? [];
		this.validateNodes(params.spaceId, nodes);
		if (params.channels && params.channels.length > 0) {
			this.validateChannels(params.channels);
		}
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
		if (params.nodes !== undefined) {
			const inputs: WorkflowNodeInput[] = (params.nodes ?? []).map(
				(n): WorkflowNodeInput => ({
					id: n.id,
					name: n.name,
					agentId: n.agentId,
					agents: n.agents,
					systemPrompt: n.systemPrompt,
					instructions: n.instructions,
				})
			);
			this.validateNodes(existing.spaceId, inputs);
		}

		if (params.channels && params.channels.length > 0) {
			this.validateChannels(params.channels);
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
	 * Returns all workflows whose nodes reference the given custom agent.
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

	private validateNodes(spaceId: string, nodes: WorkflowNodeInput[]): void {
		if (nodes.length === 0) {
			throw new WorkflowValidationError('A workflow must have at least one node');
		}

		for (let i = 0; i < nodes.length; i++) {
			this.validateNodeAgentRef(spaceId, nodes[i], i);
		}
	}

	private validateNodeAgentRef(spaceId: string, node: WorkflowNodeInput, index: number): void {
		const hasAgentId = node.agentId && node.agentId.trim().length > 0;
		const hasAgents = node.agents && node.agents.length > 0;

		if (!hasAgentId && !hasAgents) {
			throw new WorkflowValidationError(
				`node[${index}]: at least one of agentId or agents must be provided`
			);
		}

		// Format-level validation: always run regardless of agentLookup
		if (hasAgents) {
			const seenNames = new Set<string>();
			for (let j = 0; j < node.agents!.length; j++) {
				const entry = node.agents![j];
				if (!entry.agentId || !entry.agentId.trim()) {
					throw new WorkflowValidationError(
						`node[${index}].agents[${j}]: agentId must be a non-empty SpaceAgent UUID`
					);
				}
				if (!entry.name || !entry.name.trim()) {
					throw new WorkflowValidationError(
						`node[${index}].agents[${j}]: name must be a non-empty string`
					);
				}
				if (seenNames.has(entry.name)) {
					throw new WorkflowValidationError(
						`node[${index}].agents[${j}]: duplicate name "${entry.name}" — each agent slot must have a unique name within the node`
					);
				}
				seenNames.add(entry.name);
			}
		}

		// Existence validation: only when agentLookup is available.
		if (this.agentLookup) {
			if (hasAgentId) {
				const agent = this.agentLookup.getAgentById(spaceId, node.agentId!);
				if (!agent) {
					throw new WorkflowValidationError(
						`node[${index}]: agentId "${node.agentId}" does not match any SpaceAgent in this space`
					);
				}
			}
			if (hasAgents) {
				for (let j = 0; j < node.agents!.length; j++) {
					const entry = node.agents![j];
					const agent = this.agentLookup.getAgentById(spaceId, entry.agentId);
					if (!agent) {
						throw new WorkflowValidationError(
							`node[${index}].agents[${j}]: agentId "${entry.agentId}" does not match any SpaceAgent in this space`
						);
					}
				}
			}
		}
	}

	private validateChannels(channels: WorkflowChannel[]): void {
		const validDirections = new Set(['one-way', 'bidirectional']);

		for (let ci = 0; ci < channels.length; ci++) {
			const ch = channels[ci];
			const loc = `channels[${ci}]`;

			// Validate direction
			if (!validDirections.has(ch.direction)) {
				throw new WorkflowValidationError(
					`${loc}: direction must be 'one-way' or 'bidirectional', got "${ch.direction}"`
				);
			}

			// Validate from
			if (!ch.from || !ch.from.trim()) {
				throw new WorkflowValidationError(`${loc}: 'from' must be a non-empty agent name string`);
			}

			// Validate to
			if (Array.isArray(ch.to)) {
				if (ch.to.length === 0) {
					throw new WorkflowValidationError(
						`${loc}: 'to' array must contain at least one agent name string`
					);
				}
				for (let ti = 0; ti < ch.to.length; ti++) {
					if (!ch.to[ti] || !ch.to[ti].trim()) {
						throw new WorkflowValidationError(
							`${loc}.to[${ti}]: must be a non-empty agent name string`
						);
					}
				}
			} else {
				if (!ch.to || !(ch.to as string).trim()) {
					throw new WorkflowValidationError(`${loc}: 'to' must be a non-empty agent name string`);
				}
			}

			// Validate gate condition if present
			if (ch.gate) {
				this.validateCondition(ch.gate, `${loc}.gate`);
			}
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
