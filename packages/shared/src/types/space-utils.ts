/**
 * Utility functions for WorkflowNode agent and channel resolution.
 *
 * These functions handle the multi-agent extension of WorkflowNode:
 * - `resolveNodeAgents` normalises the `agentId` / `agents` duality.
 * - `resolveNodeChannels` expands declarative channel topology into concrete
 *   per-agent-pair routing rules.
 * - `validateNodeChannels` checks that channel role references are valid.
 */

import type {
	SpaceAgent,
	SpaceWorkflow,
	WorkflowChannel,
	WorkflowNode,
	WorkflowNodeAgent,
} from './space.ts';

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
	/** ID of the source WorkflowChannel, if provided */
	channelId?: string;
	/** Role of the sending agent (matches WorkflowNodeAgent.role) */
	fromRole: string;
	/** Role of the receiving agent (matches WorkflowNodeAgent.role) */
	toRole: string;
	/** Agent ID of the sender */
	fromAgentId: string;
	/** Agent ID of the receiver */
	toAgentId: string;
	/** Always `'one-way'` after resolution — bidirectional is split into two entries */
	direction: 'one-way';
	/**
	 * True when this channel fans out to all agents in a target node
	 * (i.e. `to` in the source WorkflowChannel was a node name, not an agent role).
	 */
	isFanOut?: boolean;
	/** Optional label inherited from the source WorkflowChannel */
	label?: string;
	/** Inherited from the source WorkflowChannel */
	isCyclic?: boolean;
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
 * @param node - The workflow node whose channels are to be resolved.
 * @returns Array of concrete `ResolvedChannel` routing rules. Empty when no channels are defined.
 * @throws {Error} When neither `agentId` nor `agents` is provided on the node
 *   (propagated from `resolveNodeAgents`). Callers should validate nodes before calling this.
 * @deprecated Use `resolveChannels()` instead, which operates at the workflow level
 *   and handles all channel types uniformly. This function will be removed in a future milestone.
 */
export function resolveNodeChannels(node: WorkflowNode): ResolvedChannel[] {
	if (!node.channels || node.channels.length === 0) return [];

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
 * @deprecated Use `validateChannels()` instead, which operates at the workflow level
 *   and handles all channel types uniformly. This function will be removed in a future milestone.
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

// ============================================================================
// resolveChannels
// ============================================================================

/**
 * Unified workflow-level channel resolver.
 *
 * Resolves all channels in the workflow (from both `workflow.channels` and
 * `workflow.nodes[].channels`) into concrete, directional `ResolvedChannel` entries.
 *
 * This is the single resolution path for all channel types — within-node,
 * cross-node, DM, and fan-out. There is no separate resolveNodeChannels call needed.
 *
 * Addressing semantics:
 * - `from`/`to` values are looked up globally against `WorkflowNodeAgent.role` strings
 *   (which must be unique across all nodes in the workflow for correct routing).
 * - When `to` matches a **node name** (from `WorkflowNode.name`), the channel
 *   fans out to all agents in that node (`isFanOut: true`).
 * - When `to` matches an **agent role**, the channel is a point-to-point DM (`isFanOut: false`).
 * - The wildcard `'*'` for `from` or `to` (as sole element) expands to all agent roles,
 *   preserving backward compatibility with node-level channel declarations.
 * - Bidirectional channels expand to two one-way entries.
 * - Self-loops are skipped.
 * - Unresolvable references are silently skipped; use `validateChannels` to surface them.
 *
 * @param workflow - The workflow whose channels are to be resolved.
 * @param _agents  - Space agents (reserved for future gate/context use; not used by resolver).
 * @returns Array of concrete `ResolvedChannel` routing rules.
 */
export function resolveChannels(
	workflow: SpaceWorkflow,
	_agents?: SpaceAgent[]
): ResolvedChannel[] {
	// Collect channels from workflow-level and node-level
	const allChannels: WorkflowChannel[] = [
		...(workflow.channels ?? []),
		...workflow.nodes.flatMap((n) => n.channels ?? []),
	];
	if (allChannels.length === 0) return [];

	// Build global role → agent info map and node name → agents map
	const roleToAgent = new Map<string, { agentId: string }>();
	const nodeNameToAgents = new Map<string, Array<{ role: string; agentId: string }>>();

	for (const node of workflow.nodes) {
		let nodeAgents: WorkflowNodeAgent[];
		try {
			nodeAgents = resolveNodeAgents(node);
		} catch {
			continue; // invalid node — validateChannels handles this
		}

		const nodeAgentList: Array<{ role: string; agentId: string }> = [];
		for (const na of nodeAgents) {
			roleToAgent.set(na.role, { agentId: na.agentId });
			nodeAgentList.push({ role: na.role, agentId: na.agentId });
		}
		nodeNameToAgents.set(node.name, nodeAgentList);
	}

	const allRoles = [...roleToAgent.keys()];
	const results: ResolvedChannel[] = [];

	for (const channel of allChannels) {
		expandUnifiedChannel(channel, allRoles, roleToAgent, nodeNameToAgents, results);
	}

	return results;
}

function expandUnifiedChannel(
	channel: WorkflowChannel,
	allRoles: string[],
	roleToAgent: Map<string, { agentId: string }>,
	nodeNameToAgents: Map<string, Array<{ role: string; agentId: string }>>,
	out: ResolvedChannel[]
): void {
	const { from, to, direction, label } = channel;
	const channelId = channel.id;
	const isCyclic = channel.isCyclic;

	// Resolve from-agents
	const fromAgents = resolveAgentRef(from, allRoles, roleToAgent, nodeNameToAgents);

	// Resolve to-agents and determine isFanOut
	const toList: string[] = Array.isArray(to) ? to : [to];
	let isFanOut = false;
	let toAgents: Array<{ role: string; agentId: string }>;

	if (toList.length === 1 && toList[0] === '*') {
		// Wildcard: all roles (backward compat with node-level channels)
		toAgents = allRoles.map((r) => ({ role: r, agentId: roleToAgent.get(r)!.agentId }));
	} else if (
		toList.length === 1 &&
		nodeNameToAgents.has(toList[0]) &&
		!roleToAgent.has(toList[0])
	) {
		// Node name (not an agent role): fan-out to all agents in that node
		toAgents = nodeNameToAgents.get(toList[0])!;
		isFanOut = true;
	} else {
		// Explicit role(s) or array: look up each individually
		toAgents = toList.flatMap((t) => resolveAgentRef(t, allRoles, roleToAgent, nodeNameToAgents));
	}

	// Hub-spoke: single named from-agent + multiple to-agents + bidirectional
	const isHubSpoke =
		direction === 'bidirectional' && fromAgents.length === 1 && toAgents.length > 1;

	for (const fromAgent of fromAgents) {
		for (const toAgent of toAgents) {
			if (fromAgent.role === toAgent.role) continue; // skip self-loops

			out.push({
				channelId,
				fromRole: fromAgent.role,
				toRole: toAgent.role,
				fromAgentId: fromAgent.agentId,
				toAgentId: toAgent.agentId,
				direction: 'one-way',
				label,
				isFanOut,
				isCyclic,
				isHubSpoke,
			});

			if (direction === 'bidirectional') {
				out.push({
					channelId,
					fromRole: toAgent.role,
					toRole: fromAgent.role,
					fromAgentId: toAgent.agentId,
					toAgentId: fromAgent.agentId,
					direction: 'one-way',
					label,
					isFanOut,
					isCyclic,
					isHubSpoke,
				});
			}
		}
	}
}

function resolveAgentRef(
	ref: string,
	allRoles: string[],
	roleToAgent: Map<string, { agentId: string }>,
	nodeNameToAgents: Map<string, Array<{ role: string; agentId: string }>>
): Array<{ role: string; agentId: string }> {
	if (ref === '*') {
		return allRoles.map((r) => ({ role: r, agentId: roleToAgent.get(r)!.agentId }));
	}
	const agentInfo = roleToAgent.get(ref);
	if (agentInfo) {
		return [{ role: ref, agentId: agentInfo.agentId }];
	}
	const nodeAgents = nodeNameToAgents.get(ref);
	if (nodeAgents) {
		return [...nodeAgents];
	}
	return []; // unresolvable — validateChannels handles this
}

// ============================================================================
// validateChannels
// ============================================================================

/**
 * Validates all channel declarations in a workflow.
 *
 * Checks both `workflow.channels` (workflow-level) and each node's `channels` (node-level).
 *
 * Checks:
 * - All node agents have `agentId` values present in the provided `agents` list.
 * - All `WorkflowNodeAgent.role` values are globally unique across the workflow
 *   (required for unambiguous cross-node channel routing).
 * - `from`/`to` role strings reference either a known agent role, a known node name,
 *   or the wildcard `'*'`.
 * - `'*'` is not mixed with other roles in an array `to`.
 *
 * @param workflow - The workflow to validate.
 * @param agents   - All `SpaceAgent` records in the Space (used to verify agentId existence).
 * @returns Array of human-readable error strings. Empty array means no errors.
 */
export function validateChannels(workflow: SpaceWorkflow, agents: SpaceAgent[]): string[] {
	const errors: string[] = [];

	const workflowChannels = workflow.channels ?? [];
	const nodeChannels = workflow.nodes.flatMap((n) => n.channels ?? []);
	if (workflowChannels.length === 0 && nodeChannels.length === 0) return errors;

	const agentIdSet = new Set(agents.map((a) => a.id));
	const knownRoles = new Set<string>();
	const seenRoles = new Set<string>();
	const knownNodeNames = new Set<string>();

	for (const node of workflow.nodes) {
		knownNodeNames.add(node.name);

		let nodeAgents: WorkflowNodeAgent[];
		try {
			nodeAgents = resolveNodeAgents(node);
		} catch (err) {
			errors.push((err as Error).message);
			continue;
		}

		for (const na of nodeAgents) {
			if (!agentIdSet.has(na.agentId)) {
				errors.push(
					`Agent with id "${na.agentId}" in node "${node.name}" not found in space agents.`
				);
			}
			if (seenRoles.has(na.role)) {
				errors.push(
					`Agent role "${na.role}" appears in multiple workflow nodes. ` +
						'Roles must be globally unique across the workflow for unambiguous channel routing.'
				);
			} else {
				seenRoles.add(na.role);
				knownRoles.add(na.role);
			}
		}
	}

	const allChannels: Array<{ ch: WorkflowChannel; loc: string }> = [
		...workflowChannels.map((ch, i) => ({ ch, loc: `workflow.channels[${i}]` })),
		...workflow.nodes.flatMap((n, ni) =>
			(n.channels ?? []).map((ch, ci) => ({
				ch,
				loc: `workflow.nodes[${ni}].channels[${ci}]`,
			}))
		),
	];

	for (const { ch, loc } of allChannels) {
		if (ch.from !== '*' && !knownRoles.has(ch.from) && !knownNodeNames.has(ch.from)) {
			errors.push(
				`${loc}.from "${ch.from}" does not match any agent role or node name in the workflow. ` +
					`Known roles: [${[...knownRoles].join(', ')}]. Known nodes: [${[...knownNodeNames].join(', ')}].`
			);
		}

		const toList: string[] = Array.isArray(ch.to) ? ch.to : [ch.to];

		if (toList.length > 1 && toList.includes('*')) {
			errors.push(
				`${loc}.to mixes wildcard '*' with explicit roles. ` +
					"Use a plain '*' string (not an array) to target all agents."
			);
		}

		for (const toRef of toList) {
			if (toRef !== '*' && !knownRoles.has(toRef) && !knownNodeNames.has(toRef)) {
				errors.push(
					`${loc}.to "${toRef}" does not match any agent role or node name in the workflow. ` +
						`Known roles: [${[...knownRoles].join(', ')}]. Known nodes: [${[...knownNodeNames].join(', ')}].`
				);
			}
		}
	}

	return errors;
}
