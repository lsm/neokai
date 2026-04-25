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
	WorkflowNodeInput,
	CreateSpaceWorkflowParams,
	UpdateSpaceWorkflowParams,
	WorkflowChannel,
} from '@neokai/shared';
import { generateUUID } from '@neokai/shared';
import type { SpaceWorkflowRepository } from '../../../storage/repositories/space-workflow-repository';
import { Logger } from '../../logger';
import { validatePostApproval } from '../workflows/post-approval-validator';

const logger = new Logger('SpaceWorkflowManager');

// ---------------------------------------------------------------------------
// Dependency interfaces
// ---------------------------------------------------------------------------

/**
 * Minimal interface the manager needs from SpaceAgentManager to validate
 * custom agent references in workflow nodes.
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
		const nodes = (params.nodes ?? []).map((node) => ({
			...node,
			id: node.id ?? generateUUID(),
		}));
		this.validateNodes(params.spaceId, nodes);

		const fallbackStartNodeId = nodes[0]?.id ?? '';
		const fallbackEndNodeId = nodes[nodes.length - 1]?.id ?? '';
		const startNodeId =
			params.startNodeId == null ? fallbackStartNodeId : params.startNodeId.trim();
		const endNodeId = params.endNodeId == null ? fallbackEndNodeId : params.endNodeId.trim();

		this.validateStartNodeId(startNodeId, nodes);
		this.validateEndNodeId(endNodeId, nodes);

		if (params.channels && params.channels.length > 0) {
			this.validateChannels(params.channels);
		}

		// Hard-reject invalid `postApproval` routes at create time. Stale routes
		// (target no longer exists) must be caught before the row lands in the
		// DB, where they would otherwise trip the load-time warning path below.
		if (params.postApproval !== undefined) {
			const result = validatePostApproval({ postApproval: params.postApproval, nodes });
			if (!result.ok) {
				throw new WorkflowValidationError(result.error);
			}
		}

		return this.repo.createWorkflow({
			...params,
			name: trimmedName,
			nodes,
			startNodeId,
			endNodeId,
		});
	}

	// -------------------------------------------------------------------------
	// Read
	// -------------------------------------------------------------------------

	getWorkflow(id: string): SpaceWorkflow | null {
		const wf = this.repo.getWorkflow(id);
		if (!wf) return null;
		return this.sanitizePostApprovalForLoad(wf);
	}

	listWorkflows(spaceId: string): SpaceWorkflow[] {
		return this.repo.listWorkflows(spaceId).map((wf) => this.sanitizePostApprovalForLoad(wf));
	}

	/**
	 * Load-time sanitiser for the optional `postApproval` route.
	 *
	 * If a persisted `postApproval` no longer resolves to a valid target (e.g.
	 * the targeted node/agent was removed since the workflow was saved), we do
	 * NOT fail the load — instead we strip the route from the returned object
	 * and log a warning. Workflow loading is in the hot path (every run start,
	 * every RPC list), so a stale route cannot be allowed to break the space.
	 *
	 * The DB row is untouched — re-saving the workflow via `updateWorkflow`
	 * with `postApproval: null` is the documented way to clear a stale route.
	 */
	private sanitizePostApprovalForLoad(wf: SpaceWorkflow): SpaceWorkflow {
		if (!wf.postApproval) return wf;
		const result = validatePostApproval({ postApproval: wf.postApproval, nodes: wf.nodes });
		if (result.ok) return wf;
		logger.warn(
			`disabling stale postApproval route on workflow ${wf.id} ` +
				`(space ${wf.spaceId}): ${result.error}`
		);
		const sanitized: SpaceWorkflow = { ...wf };
		delete sanitized.postApproval;
		return sanitized;
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
		const effectiveNodes: WorkflowNodeInput[] =
			params.nodes !== undefined
				? (params.nodes ?? []).map(
						(n): WorkflowNodeInput => ({
							id: n.id,
							name: n.name,
							agents: n.agents,
						})
					)
				: existing.nodes.map(
						(n): WorkflowNodeInput => ({
							id: n.id,
							name: n.name,
							agents: n.agents,
						})
					);

		this.validateNodes(existing.spaceId, effectiveNodes);

		const fallbackStartNodeId = effectiveNodes[0]?.id ?? '';
		const fallbackEndNodeId = effectiveNodes[effectiveNodes.length - 1]?.id ?? '';
		const nodeIds = new Set(effectiveNodes.map((n) => n.id));
		const startNodeIdInput =
			params.startNodeId === undefined ? existing.startNodeId : params.startNodeId;
		const endNodeIdInput = params.endNodeId === undefined ? existing.endNodeId : params.endNodeId;
		const explicitStartNodeId = params.startNodeId !== undefined;
		const explicitEndNodeId = params.endNodeId !== undefined;
		const normalizedStartNodeId =
			startNodeIdInput == null ? fallbackStartNodeId : startNodeIdInput.trim();
		const normalizedEndNodeId = endNodeIdInput == null ? fallbackEndNodeId : endNodeIdInput.trim();
		const resolvedStartNodeId =
			!explicitStartNodeId && !nodeIds.has(normalizedStartNodeId)
				? fallbackStartNodeId
				: normalizedStartNodeId;
		const resolvedEndNodeId =
			!explicitEndNodeId && !nodeIds.has(normalizedEndNodeId)
				? fallbackEndNodeId
				: normalizedEndNodeId;

		this.validateStartNodeId(resolvedStartNodeId, effectiveNodes);
		this.validateEndNodeId(resolvedEndNodeId, effectiveNodes);
		params = { ...params, startNodeId: resolvedStartNodeId, endNodeId: resolvedEndNodeId };

		if (params.channels && params.channels.length > 0) {
			this.validateChannels(params.channels);
		}

		// Validate `postApproval` against the effective node set so a node rename
		// that is submitted in the same update call doesn't invalidate the route
		// spuriously. `null` clears the route (always valid); `undefined` leaves
		// the existing route untouched — re-validate it against the new nodes so
		// a node rename that strands an existing route is caught at update time.
		if (params.postApproval !== undefined) {
			if (params.postApproval !== null) {
				const result = validatePostApproval({
					postApproval: params.postApproval,
					nodes: effectiveNodes,
				});
				if (!result.ok) {
					throw new WorkflowValidationError(result.error);
				}
			}
		} else if (existing.postApproval) {
			const result = validatePostApproval({
				postApproval: existing.postApproval,
				nodes: effectiveNodes,
			});
			if (!result.ok) {
				throw new WorkflowValidationError(
					`existing postApproval route is no longer valid after update: ${result.error}`
				);
			}
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
			const node = nodes[i];
			this.validateNodeAgentRef(spaceId, node, i);
		}
	}

	private validateNodeAgentRef(spaceId: string, node: WorkflowNodeInput, index: number): void {
		// Backward compat: if `agents` is absent/empty but legacy `agentId` is set on the object,
		// synthesize a single-agent array from it before validating.
		const legacyAgentId = (node as unknown as Record<string, unknown>)['agentId'] as
			| string
			| undefined;
		if ((!node.agents || node.agents.length === 0) && legacyAgentId) {
			node.agents = [{ agentId: legacyAgentId, name: node.name }];
		}

		const hasAgents = node.agents && node.agents.length > 0;

		if (!hasAgents) {
			throw new WorkflowValidationError(`node[${index}]: agents must be a non-empty array`);
		}

		// Format-level validation: always run regardless of agentLookup
		const seenNames = new Set<string>();
		for (let j = 0; j < node.agents.length; j++) {
			const entry = node.agents[j];
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

		// Existence validation: only when agentLookup is available.
		if (this.agentLookup) {
			for (let j = 0; j < node.agents.length; j++) {
				const entry = node.agents[j];
				const agent = this.agentLookup.getAgentById(spaceId, entry.agentId);
				if (!agent) {
					throw new WorkflowValidationError(
						`node[${index}].agents[${j}]: agentId "${entry.agentId}" does not match any SpaceAgent in this space`
					);
				}
			}
		}
	}

	private validateChannels(channels: WorkflowChannel[]): void {
		for (let ci = 0; ci < channels.length; ci++) {
			const ch = channels[ci];
			const loc = `channels[${ci}]`;

			// Validate from
			if (!ch.from || !ch.from.trim()) {
				throw new WorkflowValidationError(`${loc}: 'from' must be a non-empty node name string`);
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
		}
	}

	private validateStartNodeId(startNodeId: string, nodes: WorkflowNodeInput[]): void {
		if (!startNodeId.trim()) {
			throw new WorkflowValidationError('startNodeId must be a non-empty string');
		}
		const nodeIds = new Set(nodes.map((n) => n.id));
		if (!nodeIds.has(startNodeId)) {
			throw new WorkflowValidationError(
				`startNodeId "${startNodeId}" does not match any node in this workflow`
			);
		}
	}

	private validateEndNodeId(endNodeId: string, nodes: WorkflowNodeInput[]): void {
		if (!endNodeId.trim()) {
			throw new WorkflowValidationError('endNodeId must be a non-empty string');
		}
		const endNode = nodes.find((n) => n.id === endNodeId);
		if (!endNode) {
			throw new WorkflowValidationError(
				`endNodeId "${endNodeId}" does not match any node in this workflow`
			);
		}
		// End nodes own the workflow's completion signal via `report_result`.
		// Multi-agent end nodes create ambiguity: who declares the workflow done?
		// Restrict to exactly one agent so there's a single unambiguous owner of
		// the workflow's commitment.
		const agentCount = endNode.agents?.length ?? 0;
		if (agentCount !== 1) {
			throw new WorkflowValidationError(
				`endNode "${endNode.name}" must have exactly 1 agent (has ${agentCount}); ` +
					`end nodes own the workflow completion signal via report_result`
			);
		}
	}
}
