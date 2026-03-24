/**
 * Utility functions for WorkflowNode agent and channel resolution.
 *
 * These functions handle the multi-agent extension of WorkflowNode:
 * - `resolveNodeAgents` normalises the `agentId` / `agents` duality.
 * - `resolveNodeChannels` expands declarative channel topology into concrete
 *   per-agent-pair routing rules.
 * - `validateNodeChannels` checks that channel role references are valid.
 */

import type { SpaceAgent, WorkflowChannel, WorkflowNode, WorkflowNodeAgent } from './space.ts';

// ============================================================================
// ResolvedChannel
// ============================================================================

/**
 * A concrete, directional routing rule expanded from a `WorkflowChannel` declaration.
 *
 * Bidirectional channels are always expanded into two one-way `ResolvedChannel` entries.
 * Wildcard and array `to` declarations are expanded into one entry per resolved pair.
 */
export interface ResolvedChannel {
	/** Role of the sending agent (matches SpaceAgent.role) */
	fromRole: string;
	/** Role of the receiving agent (matches SpaceAgent.role) */
	toRole: string;
	/** Agent ID of the sender */
	fromAgentId: string;
	/** Agent ID of the receiver */
	toAgentId: string;
	/** Always `'one-way'` after resolution — bidirectional is split into two entries */
	direction: 'one-way';
	/** Optional label inherited from the source WorkflowChannel */
	label?: string;
	/**
	 * True when this channel belongs to a hub-spoke topology
	 * (bidirectional source with an array `to` containing more than one role).
	 * In hub-spoke, spokes may only reply to the hub — no spoke-to-spoke messaging.
	 */
	isHubSpoke: boolean;
}

// ============================================================================
// resolveNodeAgents
// ============================================================================

/**
 * Resolves the concrete agent list for a workflow node.
 *
 * Precedence rules:
 * 1. If `agents` is provided and non-empty, it takes precedence.
 *    (`agentId`, if also set, is silently ignored — callers should validate
 *    and warn users that `agents` overrides `agentId` at edit time.)
 * 2. If only `agentId` is provided, returns a single-element array:
 *    `[{ agentId, role: agentId, instructions: node.instructions }]`.
 *    (The `agentId` is used as a synthetic role since no explicit role is available
 *    in the legacy shorthand format.)
 * 3. If neither is provided, throws an `Error`.
 *
 * @param node - The workflow node to resolve agents for.
 * @returns Non-empty array of `WorkflowNodeAgent` records for this node.
 * @throws {Error} When neither `agentId` nor `agents` is provided.
 */
export function resolveNodeAgents(node: WorkflowNode): WorkflowNodeAgent[] {
	if (node.agents && node.agents.length > 0) {
		return node.agents;
	}

	if (node.agentId) {
		return [{ agentId: node.agentId, role: node.agentId, instructions: node.instructions }];
	}

	throw new Error(
		`WorkflowNode "${node.name}" (id: ${node.id}) has neither agentId nor agents defined. ` +
			'At least one must be provided.'
	);
}

// ============================================================================
// resolveNodeChannels
// ============================================================================

/**
 * Expands the declarative `WorkflowChannel` list of a node into concrete, directional
 * `ResolvedChannel` routing rules.
 *
 * Resolution algorithm:
 * - Each channel's `from`/`to` role strings are resolved against the node's agents via
 *   the `WorkflowNodeAgent.role` field — the per-slot role set on each agent entry.
 * - `'*'` in `from` or `to` (as the sole element) expands to all agent roles in the node.
 *   Note: `'*'` mixed with other roles in an array `to` is treated as a literal role name;
 *   use `validateNodeChannels` to catch this pattern at edit time.
 * - Bidirectional channels are expanded into two one-way entries:
 *   - **Point-to-point** (`A ↔ B`): A→B + B→A, both with `isHubSpoke: false`.
 *   - **Hub-spoke** (`A ↔ [B, C, D]`): hub→each spoke + each spoke→hub, all with
 *     `isHubSpoke: true`. Spoke-to-spoke routing is intentionally omitted.
 * - Self-loops (fromRole === toRole) are skipped.
 * - Roles not present in the node's agent list are skipped silently;
 *   use `validateNodeChannels` to surface these as errors before calling this function.
 * - When two node agents share the same `role`, the last one wins in the
 *   role→agentId map. Duplicate roles are flagged by `validateNodeChannels`.
 *
 * Supported topology patterns:
 * - `A → B`        one-way point-to-point
 * - `A ↔ B`        bidirectional point-to-point (expands to A→B + B→A)
 * - `A → [B,C,D]`  fan-out (one entry per target)
 * - `A ↔ [B,C,D]`  hub-spoke (hub→each spoke + each spoke→hub, no spoke-to-spoke)
 * - `* → B`        all agents send to B
 * - `A → *`        A sends to all agents
 *
 * @param node   - The workflow node whose channels are to be resolved.
 * @param agents - All `SpaceAgent` records in the Space (unused in resolution; kept for API
 *   compatibility with `validateNodeChannels`). Pass `[]` when not available.
 * @returns Array of concrete `ResolvedChannel` routing rules. Empty when no channels are defined.
 * @throws {Error} When neither `agentId` nor `agents` is provided on the node
 *   (propagated from `resolveNodeAgents`). Callers should validate nodes before calling this.
 */
export function resolveNodeChannels(node: WorkflowNode, agents: SpaceAgent[]): ResolvedChannel[] {
	if (!node.channels || node.channels.length === 0) return [];

	// agents param is retained for API compatibility; resolution now uses WorkflowNodeAgent.role directly.
	void agents;

	const nodeAgents = resolveNodeAgents(node);

	// Build role → agentId map using the per-slot role on each WorkflowNodeAgent entry.
	const roleToAgentId = new Map<string, string>();
	for (const sa of nodeAgents) {
		roleToAgentId.set(sa.role, sa.agentId);
	}

	const allRoles = [...roleToAgentId.keys()];
	const results: ResolvedChannel[] = [];

	for (const channel of node.channels) {
		expandChannel(channel, allRoles, roleToAgentId, results);
	}

	return results;
}

function expandChannel(
	channel: WorkflowChannel,
	allRoles: string[],
	roleToAgentId: Map<string, string>,
	out: ResolvedChannel[]
): void {
	const { from, to, direction, label } = channel;

	// Resolve concrete from-roles.
	const fromRoles: string[] = from === '*' ? allRoles : [from];

	// Resolve concrete to-roles.
	// '*' is only expanded when it is the sole element; mixed arrays are treated literally.
	const toList: string[] = Array.isArray(to) ? to : [to];
	const toRoles: string[] = toList.length === 1 && toList[0] === '*' ? allRoles : toList;

	// Hub-spoke: single named from-role + multiple concrete to-roles + bidirectional.
	// If from is '*' (expands to multiple roles) we fall back to point-to-point per pair.
	const isHubSpoke = direction === 'bidirectional' && fromRoles.length === 1 && toRoles.length > 1;

	for (const fromRole of fromRoles) {
		const fromAgentId = roleToAgentId.get(fromRole);
		if (!fromAgentId) continue; // unresolvable role — validation handles this

		for (const toRole of toRoles) {
			if (fromRole === toRole) continue; // skip self-loops

			const toAgentId = roleToAgentId.get(toRole);
			if (!toAgentId) continue; // unresolvable role

			// Forward channel: hub→spoke or from→to.
			out.push({
				fromRole,
				toRole,
				fromAgentId,
				toAgentId,
				direction: 'one-way',
				label,
				isHubSpoke,
			});

			// Reverse channel for bidirectional:
			// - Point-to-point: full A↔B → B→A added here.
			// - Hub-spoke: each spoke→hub (not spoke→spoke, since we only iterate the hub in fromRoles).
			if (direction === 'bidirectional') {
				out.push({
					fromRole: toRole,
					toRole: fromRole,
					fromAgentId: toAgentId,
					toAgentId: fromAgentId,
					direction: 'one-way',
					label,
					isHubSpoke,
				});
			}
		}
	}
}

// ============================================================================
// validateNodeChannels
// ============================================================================

/**
 * Validates that all role references in a node's `channels` are resolvable.
 *
 * Checks:
 * - At least one of `agentId` or `agents` is provided (delegates to `resolveNodeAgents`).
 * - All node agent IDs are found in the provided `agents` list.
 * - No two node agent slots share the same `WorkflowNodeAgent.role` (ambiguous channel targeting).
 *   Note: the same `agentId` may appear multiple times if each slot has a distinct `role`.
 * - `from`/`to` role strings are either the wildcard `'*'` or match a known `WorkflowNodeAgent.role`.
 * - `'*'` is not mixed with other roles in an array `to` (use a plain `'*'` string instead).
 *
 * @param node   - The workflow node to validate.
 * @param agents - All `SpaceAgent` records in the Space (used to verify agentId existence).
 * @returns Array of human-readable error strings. Empty array means no errors.
 * @public
 */
export function validateNodeChannels(node: WorkflowNode, agents: SpaceAgent[]): string[] {
	const errors: string[] = [];

	if (!node.channels || node.channels.length === 0) return errors;

	let nodeAgents: WorkflowNodeAgent[];
	try {
		nodeAgents = resolveNodeAgents(node);
	} catch (err) {
		errors.push((err as Error).message);
		return errors;
	}

	// Build known roles set from WorkflowNodeAgent.role; detect duplicate slot roles.
	const knownRoles = new Set<string>();
	const seenRoles = new Set<string>();
	for (const sa of nodeAgents) {
		// Verify the agentId exists in the space.
		const spaceAgentExists = agents.some((a) => a.id === sa.agentId);
		if (!spaceAgentExists) {
			errors.push(
				`Node agent with agentId "${sa.agentId}" was not found in the provided space agents list.`
			);
		}

		// Validate role uniqueness within the node (duplicate roles make channel targeting ambiguous).
		if (seenRoles.has(sa.role)) {
			errors.push(
				`Node "${node.name}" has two agent slots with role "${sa.role}". ` +
					'Duplicate roles make channel targeting ambiguous.'
			);
		} else {
			seenRoles.add(sa.role);
			knownRoles.add(sa.role);
		}
	}

	for (let i = 0; i < node.channels.length; i++) {
		const ch = node.channels[i];

		if (ch.from !== '*' && !knownRoles.has(ch.from)) {
			errors.push(
				`channels[${i}].from "${ch.from}" does not match any agent role in node "${node.name}". ` +
					`Known roles: [${[...knownRoles].join(', ')}].`
			);
		}

		const toList: string[] = Array.isArray(ch.to) ? ch.to : [ch.to];

		// Reject '*' mixed with other roles in array to — use plain '*' string instead.
		if (toList.length > 1 && toList.includes('*')) {
			errors.push(
				`channels[${i}].to mixes wildcard '*' with explicit roles. ` +
					"Use a plain '*' string (not an array) to target all agents."
			);
		}

		for (const toRole of toList) {
			if (toRole !== '*' && !knownRoles.has(toRole)) {
				errors.push(
					`channels[${i}].to "${toRole}" does not match any agent role in node "${node.name}". ` +
						`Known roles: [${[...knownRoles].join(', ')}].`
				);
			}
		}
	}

	return errors;
}
