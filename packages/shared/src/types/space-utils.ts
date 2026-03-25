/**
 * Utility functions for WorkflowNode agent and channel resolution.
 *
 * These functions handle the multi-agent extension of WorkflowNode:
 * - `resolveNodeAgents` normalises the `agentId` / `agents` duality.
 * - `resolveNodeChannels` expands declarative channel topology into concrete
 *   per-agent-pair routing rules.
 * - `validateNodeChannels` checks that channel name references are valid.
 */

import type {
	SpaceAgent,
	SpaceWorkflow,
	WorkflowChannel,
	WorkflowCondition,
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
	/** Name of the sending agent (matches WorkflowNodeAgent.name) */
	fromRole: string;
	/** Name of the receiving agent (matches WorkflowNodeAgent.name) */
	toRole: string;
	/** Agent ID of the sender */
	fromAgentId: string;
	/** Agent ID of the receiver */
	toAgentId: string;
	/** Always `'one-way'` after resolution — bidirectional is split into two entries */
	direction: 'one-way';
	/**
	 * True when the `to` side of the source WorkflowChannel resolved to a node name
	 * (fan-out delivery to all agents in that node), not an individual agent role.
	 *
	 * Note: `isFanOut` specifically describes **to-side** fan-out. When `from` in the
	 * source channel is a node name, the resolver creates one `ResolvedChannel` entry
	 * per agent in that node, each with `isFanOut: false` — the individual entries are
	 * point-to-point even though they originated from a node-addressed source.
	 */
	isFanOut?: boolean;
	/** Optional label inherited from the source WorkflowChannel */
	label?: string;
	/** Inherited from the source WorkflowChannel */
	isCyclic?: boolean;
	/**
	 * True when this channel belongs to a hub-spoke topology
	 * (bidirectional source with an array `to` containing more than one name).
	 * In hub-spoke, spokes may only reply to the hub — no spoke-to-spoke messaging.
	 */
	isHubSpoke: boolean;
	/**
	 * Optional gate condition inherited from the source WorkflowChannel.
	 * When present, the message must pass this condition before delivery.
	 * Absent means the channel is always open (no gate enforcement).
	 */
	gate?: WorkflowCondition;
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
 *    `[{ agentId, name: agentId, instructions: node.instructions }]`.
 *    (The `agentId` is used as a synthetic name since no explicit name is available
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
		return [{ agentId: node.agentId, name: node.agentId, instructions: node.instructions }];
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
 * Expands the declarative `WorkflowChannel` list into concrete, directional
 * `ResolvedChannel` routing rules for a given node.
 *
 * Resolution algorithm:
 * - Each channel's `from`/`to` name strings are resolved against the node's agents via
 *   the `WorkflowNodeAgent.name` field — the per-slot name set on each agent entry.
 * - `'*'` in `from` or `to` (as the sole element) expands to all agent names in the node.
 *   Note: `'*'` mixed with other names in an array `to` is treated as a literal name;
 *   use `validateNodeChannels` to catch this pattern at edit time.
 * - Bidirectional channels are expanded into two one-way entries:
 *   - **Point-to-point** (`A ↔ B`): A→B + B→A, both with `isHubSpoke: false`.
 *   - **Hub-spoke** (`A ↔ [B, C, D]`): hub→each spoke + each spoke→hub, all with
 *     `isHubSpoke: true`. Spoke-to-spoke routing is intentionally omitted.
 * - Self-loops (fromRole === toRole) are skipped.
 * - Names not present in the node's agent list are skipped silently;
 *   use `validateNodeChannels` to surface these as errors before calling this function.
 * - When two node agents share the same `name`, the last one wins in the
 *   name→agentId map. Duplicate names are flagged by `validateNodeChannels`.
 *
 * Supported topology patterns:
 * - `A → B`        one-way point-to-point
 * - `A ↔ B`        bidirectional point-to-point (expands to A→B + B→A)
 * - `A → [B,C,D]`  fan-out (one entry per target)
 * - `A ↔ [B,C,D]`  hub-spoke (hub→each spoke + each spoke→hub, no spoke-to-spoke)
 * - `* → B`        all agents send to B
 * - `A → *`        A sends to all agents
 *
 * @param node     - The workflow node whose agents are used for name resolution.
 * @param channels - Channel definitions to resolve (from the workflow-level channels array).
 * @returns Array of concrete `ResolvedChannel` routing rules. Empty when no channels are defined.
 * @throws {Error} When neither `agentId` nor `agents` is provided on the node
 *   (propagated from `resolveNodeAgents`). Callers should validate nodes before calling this.
 * @deprecated Use `resolveChannels()` instead, which operates at the workflow level
 *   and handles all channel types uniformly. This function will be removed in a future milestone.
 */
export function resolveNodeChannels(
	node: WorkflowNode,
	channels: WorkflowChannel[]
): ResolvedChannel[] {
	if (!channels || channels.length === 0) return [];

	const nodeAgents = resolveNodeAgents(node);

	// Build name → agentId map using the per-slot name on each WorkflowNodeAgent entry.
	const nameToAgentId = new Map<string, string>();
	for (const sa of nodeAgents) {
		nameToAgentId.set(sa.name, sa.agentId);
	}

	const allNames = [...nameToAgentId.keys()];
	const results: ResolvedChannel[] = [];

	for (const channel of channels) {
		expandChannel(channel, allNames, nameToAgentId, results);
	}

	return results;
}

function expandChannel(
	channel: WorkflowChannel,
	allNames: string[],
	nameToAgentId: Map<string, string>,
	out: ResolvedChannel[]
): void {
	const { from, to, direction, label, gate } = channel;

	// Resolve concrete from-names.
	const fromNames: string[] = from === '*' ? allNames : [from];

	// Resolve concrete to-names.
	// '*' is only expanded when it is the sole element; mixed arrays are treated literally.
	const toList: string[] = Array.isArray(to) ? to : [to];
	const toNames: string[] = toList.length === 1 && toList[0] === '*' ? allNames : toList;

	// Hub-spoke: single named from-name + multiple concrete to-names + bidirectional.
	// If from is '*' (expands to multiple names) we fall back to point-to-point per pair.
	const isHubSpoke = direction === 'bidirectional' && fromNames.length === 1 && toNames.length > 1;

	for (const fromRole of fromNames) {
		const fromAgentId = nameToAgentId.get(fromRole);
		if (!fromAgentId) continue; // unresolvable name — validation handles this

		for (const toRole of toNames) {
			if (fromRole === toRole) continue; // skip self-loops

			const toAgentId = nameToAgentId.get(toRole);
			if (!toAgentId) continue; // unresolvable name

			// Forward channel: hub→spoke or from→to.
			out.push({
				fromRole,
				toRole,
				fromAgentId,
				toAgentId,
				direction: 'one-way',
				label,
				gate,
				isHubSpoke,
			});

			// Reverse channel for bidirectional:
			// - Point-to-point: full A↔B → B→A added here.
			// - Hub-spoke: each spoke→hub (not spoke→spoke, since we only iterate the hub in fromNames).
			if (direction === 'bidirectional') {
				out.push({
					fromRole: toRole,
					toRole: fromRole,
					fromAgentId: toAgentId,
					toAgentId: fromAgentId,
					direction: 'one-way',
					label,
					gate,
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
 * Validates that all name references in the given channels are resolvable
 * against the agents in the specified node.
 *
 * Checks:
 * - At least one of `agentId` or `agents` is provided (delegates to `resolveNodeAgents`).
 * - All node agent IDs are found in the provided `agents` list.
 * - No two node agent slots share the same `WorkflowNodeAgent.name` (ambiguous channel targeting).
 *   Note: the same `agentId` may appear multiple times if each slot has a distinct `name`.
 * - `from`/`to` name strings are either the wildcard `'*'` or match a known `WorkflowNodeAgent.name`.
 * - `'*'` is not mixed with other names in an array `to` (use a plain `'*'` string instead).
 *
 * @param node     - The workflow node to validate.
 * @param agents   - All `SpaceAgent` records in the Space (used to verify agentId existence).
 * @param channels - Channel definitions to validate (from the workflow-level channels array).
 * @returns Array of human-readable error strings. Empty array means no errors.
 * @public
 * @deprecated Use `validateChannels()` instead, which operates at the workflow level
 *   and handles all channel types uniformly. This function will be removed in a future milestone.
 */
export function validateNodeChannels(
	node: WorkflowNode,
	agents: SpaceAgent[],
	channels: WorkflowChannel[]
): string[] {
	const errors: string[] = [];

	if (!channels || channels.length === 0) return errors;

	let nodeAgents: WorkflowNodeAgent[];
	try {
		nodeAgents = resolveNodeAgents(node);
	} catch (err) {
		errors.push((err as Error).message);
		return errors;
	}

	// Build known names set from WorkflowNodeAgent.name; detect duplicate slot names.
	const knownNames = new Set<string>();
	const seenNames = new Set<string>();
	for (const sa of nodeAgents) {
		// Verify the agentId exists in the space.
		const spaceAgentExists = agents.some((a) => a.id === sa.agentId);
		if (!spaceAgentExists) {
			errors.push(
				`Node agent with agentId "${sa.agentId}" was not found in the provided space agents list.`
			);
		}

		// Validate name uniqueness within the node (duplicate names make channel targeting ambiguous).
		if (seenNames.has(sa.name)) {
			errors.push(
				`Node "${node.name}" has two agent slots with name "${sa.name}". ` +
					'Duplicate names make channel targeting ambiguous.'
			);
		} else {
			seenNames.add(sa.name);
			knownNames.add(sa.name);
		}
	}

	for (let i = 0; i < channels.length; i++) {
		const ch = channels[i];

		if (ch.from !== '*' && !knownNames.has(ch.from)) {
			errors.push(
				`channels[${i}].from "${ch.from}" does not match any agent name in node "${node.name}". ` +
					`Known names: [${[...knownNames].join(', ')}].`
			);
		}

		const toList: string[] = Array.isArray(ch.to) ? ch.to : [ch.to];

		// Reject '*' mixed with other names in array to — use plain '*' string instead.
		if (toList.length > 1 && toList.includes('*')) {
			errors.push(
				`channels[${i}].to mixes wildcard '*' with explicit names. ` +
					"Use a plain '*' string (not an array) to target all agents."
			);
		}

		for (const toName of toList) {
			if (toName !== '*' && !knownNames.has(toName)) {
				errors.push(
					`channels[${i}].to "${toName}" does not match any agent name in node "${node.name}". ` +
						`Known names: [${[...knownNames].join(', ')}].`
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
	// Collect channels from workflow-level only (node-level channels were removed)
	const allChannels: WorkflowChannel[] = workflow.channels ?? [];
	if (allChannels.length === 0) return [];

	// Build global name → agent info map and node name → agents map
	const nameToAgent = new Map<string, { agentId: string }>();
	const nodeNameToAgents = new Map<string, Array<{ name: string; agentId: string }>>();

	for (const node of workflow.nodes) {
		let nodeAgents: WorkflowNodeAgent[];
		try {
			nodeAgents = resolveNodeAgents(node);
		} catch {
			continue; // invalid node — validateChannels handles this
		}

		const nodeAgentList: Array<{ name: string; agentId: string }> = [];
		for (const na of nodeAgents) {
			nameToAgent.set(na.name, { agentId: na.agentId });
			nodeAgentList.push({ name: na.name, agentId: na.agentId });
		}
		nodeNameToAgents.set(node.name, nodeAgentList);
	}

	const allAgentNames = [...nameToAgent.keys()];
	const results: ResolvedChannel[] = [];

	for (const channel of allChannels) {
		expandUnifiedChannel(channel, allAgentNames, nameToAgent, nodeNameToAgents, results);
	}

	return results;
}

function expandUnifiedChannel(
	channel: WorkflowChannel,
	allAgentNames: string[],
	nameToAgent: Map<string, { agentId: string }>,
	nodeNameToAgents: Map<string, Array<{ name: string; agentId: string }>>,
	out: ResolvedChannel[]
): void {
	const { from, to, direction, label, gate, isCyclic } = channel;

	// Resolve from-agents
	const fromAgents = resolveAgentRef(from, allAgentNames, nameToAgent, nodeNameToAgents);

	// Resolve to-agents and determine isFanOut
	const toList: string[] = Array.isArray(to) ? to : [to];
	let isFanOut = false;
	let toAgents: Array<{ name: string; agentId: string }>;

	if (toList.length === 1 && toList[0] === '*') {
		// Wildcard: all agent names
		toAgents = allAgentNames.map((n) => ({ name: n, agentId: nameToAgent.get(n)!.agentId }));
	} else if (
		toList.length === 1 &&
		nodeNameToAgents.has(toList[0]) &&
		!nameToAgent.has(toList[0])
	) {
		// Node name (not an agent name): fan-out to all agents in that node
		toAgents = nodeNameToAgents.get(toList[0])!;
		isFanOut = true;
	} else {
		// Explicit name(s) or array: look up each individually
		toAgents = toList.flatMap((t) =>
			resolveAgentRef(t, allAgentNames, nameToAgent, nodeNameToAgents)
		);
	}

	// Hub-spoke: single named from-agent + multiple to-agents + bidirectional
	const isHubSpoke =
		direction === 'bidirectional' && fromAgents.length === 1 && toAgents.length > 1;

	for (const fromAgent of fromAgents) {
		for (const toAgent of toAgents) {
			if (fromAgent.name === toAgent.name) continue; // skip self-loops

			out.push({
				fromRole: fromAgent.name,
				toRole: toAgent.name,
				fromAgentId: fromAgent.agentId,
				toAgentId: toAgent.agentId,
				direction: 'one-way',
				label,
				gate,
				isFanOut,
				isCyclic,
				isHubSpoke,
			});

			if (direction === 'bidirectional') {
				out.push({
					fromRole: toAgent.name,
					toRole: fromAgent.name,
					fromAgentId: toAgent.agentId,
					toAgentId: fromAgent.agentId,
					direction: 'one-way',
					label,
					gate,
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
	allAgentNames: string[],
	nameToAgent: Map<string, { agentId: string }>,
	nodeNameToAgents: Map<string, Array<{ name: string; agentId: string }>>
): Array<{ name: string; agentId: string }> {
	if (ref === '*') {
		return allAgentNames.map((n) => ({ name: n, agentId: nameToAgent.get(n)!.agentId }));
	}
	const agentInfo = nameToAgent.get(ref);
	if (agentInfo) {
		return [{ name: ref, agentId: agentInfo.agentId }];
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
 * Checks:
 * - All node agents have `agentId` values present in the provided `agents` list.
 * - All `WorkflowNodeAgent.name` values are globally unique across the workflow
 *   (required for unambiguous cross-node channel routing).
 * - `from`/`to` name strings reference either a known agent name, a known node name,
 *   or the wildcard `'*'`.
 * - `'*'` is not mixed with other names in an array `to`.
 *
 * @param workflow - The workflow to validate.
 * @param agents   - All `SpaceAgent` records in the Space (used to verify agentId existence).
 * @returns Array of human-readable error strings. Empty array means no errors.
 */
export function validateChannels(workflow: SpaceWorkflow, agents: SpaceAgent[]): string[] {
	const errors: string[] = [];

	const workflowChannels = workflow.channels ?? [];
	if (workflowChannels.length === 0) return errors;

	const agentIdSet = new Set(agents.map((a) => a.id));
	const knownAgentNames = new Set<string>();
	const seenAgentNames = new Set<string>();
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
			if (seenAgentNames.has(na.name)) {
				errors.push(
					`Agent name "${na.name}" appears in multiple workflow nodes. ` +
						'Agent names must be globally unique across the workflow for unambiguous channel routing.'
				);
			} else {
				seenAgentNames.add(na.name);
				knownAgentNames.add(na.name);
			}
		}
	}

	const allChannels: Array<{ ch: WorkflowChannel; loc: string }> = workflowChannels.map(
		(ch, i) => ({
			ch,
			loc: `workflow.channels[${i}]`,
		})
	);

	for (const { ch, loc } of allChannels) {
		// Validate direction field
		if (ch.direction !== 'one-way' && ch.direction !== 'bidirectional') {
			errors.push(
				`${loc}.direction "${ch.direction}" is not valid. Must be 'one-way' or 'bidirectional'.`
			);
		}

		if (ch.from !== '*') {
			if (!knownAgentNames.has(ch.from) && !knownNodeNames.has(ch.from)) {
				errors.push(
					`${loc}.from "${ch.from}" does not match any agent name or node name in the workflow. ` +
						`Known agent names: [${[...knownAgentNames].join(', ')}]. Known nodes: [${[...knownNodeNames].join(', ')}].`
				);
			} else if (knownAgentNames.has(ch.from) && knownNodeNames.has(ch.from)) {
				// Ambiguous: matches both an agent name and a node name.
				// The resolver always prefers the agent name — flag this so the user can rename to avoid confusion.
				errors.push(
					`${loc}.from "${ch.from}" is ambiguous: it matches both an agent name and a node name. ` +
						'Rename the node or the agent name to avoid misrouting.'
				);
			}
		}

		const toList: string[] = Array.isArray(ch.to) ? ch.to : [ch.to];

		if (toList.length > 1 && toList.includes('*')) {
			errors.push(
				`${loc}.to mixes wildcard '*' with explicit names. ` +
					"Use a plain '*' string (not an array) to target all agents."
			);
		}

		for (const toRef of toList) {
			if (toRef === '*') continue;
			if (!knownAgentNames.has(toRef) && !knownNodeNames.has(toRef)) {
				errors.push(
					`${loc}.to "${toRef}" does not match any agent name or node name in the workflow. ` +
						`Known agent names: [${[...knownAgentNames].join(', ')}]. Known nodes: [${[...knownNodeNames].join(', ')}].`
				);
			} else if (knownAgentNames.has(toRef) && knownNodeNames.has(toRef)) {
				// Ambiguous: matches both an agent name and a node name.
				// The resolver always prefers the agent name — flag this so the user can rename to avoid confusion.
				errors.push(
					`${loc}.to "${toRef}" is ambiguous: it matches both an agent name and a node name. ` +
						'Rename the node or the agent name to avoid misrouting.'
				);
			}
		}
	}

	return errors;
}
