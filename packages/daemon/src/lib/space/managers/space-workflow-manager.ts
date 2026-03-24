/**
 * SpaceWorkflowManager
 *
 * Business logic layer for SpaceWorkflow operations within a Space.
 *
 * Responsibilities:
 * - Validate workflow integrity (unique name, node agent refs, transition graph validity)
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
		this.validateTransitions(nodes, params.transitions ?? [], params.startNodeId);
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
					channels: n.channels,
					instructions: n.instructions,
				})
			);
			this.validateNodes(existing.spaceId, inputs);
			if (params.transitions !== undefined) {
				this.validateTransitions(inputs, params.transitions ?? [], params.startNodeId ?? null);
			}
		} else if (params.transitions !== undefined) {
			// Validate transitions against existing nodes
			const existingNodeInputs: WorkflowNodeInput[] = existing.nodes.map((n) => ({
				id: n.id,
				name: n.name,
				agentId: n.agentId,
				agents: n.agents,
				channels: n.channels,
				instructions: n.instructions,
			}));
			this.validateTransitions(
				existingNodeInputs,
				params.transitions ?? [],
				params.startNodeId ?? null
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
			for (let j = 0; j < node.agents!.length; j++) {
				const entry = node.agents![j];
				if (!entry.agentId || !entry.agentId.trim()) {
					throw new WorkflowValidationError(
						`node[${index}].agents[${j}]: agentId must be a non-empty SpaceAgent UUID`
					);
				}
				if (!entry.role || !entry.role.trim()) {
					throw new WorkflowValidationError(
						`node[${index}].agents[${j}]: role must be a non-empty string`
					);
				}
			}
		}

		// Existence validation: only when agentLookup is available.
		// Also collect agent roles here to avoid a second traversal in channel validation.
		let knownRoles: Set<string> | null = null;
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
				knownRoles = new Set<string>();
				for (let j = 0; j < node.agents!.length; j++) {
					const entry = node.agents![j];
					const agent = this.agentLookup.getAgentById(spaceId, entry.agentId);
					if (!agent) {
						throw new WorkflowValidationError(
							`node[${index}].agents[${j}]: agentId "${entry.agentId}" does not match any SpaceAgent in this space`
						);
					}
					knownRoles.add(entry.role);
				}
			}
		}

		// Channel validation (after agent validation so roles are already collected)
		if (node.channels && node.channels.length > 0) {
			this.validateNodeChannels(node, index, knownRoles);
		}
	}

	private validateNodeChannels(
		node: WorkflowNodeInput,
		nodeIndex: number,
		/**
		 * Roles collected from agentLookup during agent existence validation.
		 * Null when agentLookup is not configured — role-reference checks are skipped.
		 */
		knownRoles: Set<string> | null
	): void {
		const channels = node.channels!;

		// Channels require the multi-agent agents[] format — single-agent nodes have no peers
		if (!node.agents || node.agents.length === 0) {
			throw new WorkflowValidationError(
				`node[${nodeIndex}]: channels require a multi-agent node (agents[] must be provided)`
			);
		}

		const validDirections = new Set(['one-way', 'bidirectional']);

		for (let ci = 0; ci < channels.length; ci++) {
			const ch = channels[ci];
			const loc = `node[${nodeIndex}].channels[${ci}]`;

			// Validate direction
			if (!validDirections.has(ch.direction)) {
				throw new WorkflowValidationError(
					`${loc}: direction must be 'one-way' or 'bidirectional', got "${ch.direction}"`
				);
			}

			// Validate from
			if (!ch.from || !ch.from.trim()) {
				throw new WorkflowValidationError(`${loc}: 'from' must be a non-empty role string`);
			}

			// Validate to
			if (Array.isArray(ch.to)) {
				if (ch.to.length === 0) {
					throw new WorkflowValidationError(
						`${loc}: 'to' array must contain at least one role string`
					);
				}
				for (let ti = 0; ti < ch.to.length; ti++) {
					if (!ch.to[ti] || !ch.to[ti].trim()) {
						throw new WorkflowValidationError(`${loc}.to[${ti}]: must be a non-empty role string`);
					}
				}
			} else {
				if (!ch.to || !(ch.to as string).trim()) {
					throw new WorkflowValidationError(`${loc}: 'to' must be a non-empty role string`);
				}
			}

			// Role reference validation: only when agentLookup resolved roles
			if (knownRoles !== null) {
				this.validateChannelRoleRef(ch.from, knownRoles, `${loc}.from`);
				const toRoles = Array.isArray(ch.to) ? ch.to : [ch.to as string];
				for (const toRole of toRoles) {
					this.validateChannelRoleRef(toRole, knownRoles, `${loc}.to`);
				}
			}
		}
	}

	private validateChannelRoleRef(role: string, knownRoles: Set<string>, location: string): void {
		if (role === '*') return; // wildcard matches all agents
		if (!knownRoles.has(role)) {
			const known = [...knownRoles].join(', ') || 'none';
			throw new WorkflowValidationError(
				`${location}: role "${role}" does not match any agent role in this node (known roles: ${known})`
			);
		}
	}

	private validateTransitions(
		nodes: WorkflowNodeInput[],
		transitions: WorkflowTransitionInput[],
		startNodeId: string | null | undefined
	): void {
		const knownNodeIds = new Set<string>(nodes.filter((n) => n.id).map((n) => n.id as string));

		// When transitions reference node IDs but some nodes have no explicit id, we cannot
		// validate the references at all — an invalid transition would only surface at runtime.
		// Require all nodes to have explicit IDs when transitions are provided.
		if (transitions.length > 0 && knownNodeIds.size < nodes.length) {
			throw new WorkflowValidationError(
				'All nodes must have explicit id values when transitions are specified'
			);
		}

		for (let i = 0; i < transitions.length; i++) {
			const t = transitions[i];
			if (!t.from || !t.from.trim()) {
				throw new WorkflowValidationError(`transition[${i}]: 'from' node ID must not be empty`);
			}
			if (!t.to || !t.to.trim()) {
				throw new WorkflowValidationError(`transition[${i}]: 'to' node ID must not be empty`);
			}
			if (!knownNodeIds.has(t.from)) {
				throw new WorkflowValidationError(
					`transition[${i}]: 'from' node ID "${t.from}" does not match any node in this workflow`
				);
			}
			if (!knownNodeIds.has(t.to)) {
				throw new WorkflowValidationError(
					`transition[${i}]: 'to' node ID "${t.to}" does not match any node in this workflow`
				);
			}
			if (t.condition) {
				this.validateCondition(t.condition, `transition[${i}].condition`);
			}
		}

		// Validate startNodeId if provided
		if (startNodeId && knownNodeIds.size > 0 && !knownNodeIds.has(startNodeId)) {
			throw new WorkflowValidationError(
				`startNodeId "${startNodeId}" does not match any node in this workflow`
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
