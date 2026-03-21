/**
 * Utility functions for WorkflowStep agent and channel resolution.
 *
 * These functions handle the multi-agent extension of WorkflowStep:
 * - `resolveStepAgents` normalises the `agentId` / `agents` duality.
 * - `resolveStepChannels` expands declarative channel topology into concrete
 *   per-agent-pair routing rules.
 * - `validateStepChannels` checks that channel role references are valid.
 */

import type { SpaceAgent, WorkflowChannel, WorkflowStep, WorkflowStepAgent } from './space.ts';

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
// resolveStepAgents
// ============================================================================

/**
 * Resolves the concrete agent list for a workflow step.
 *
 * Precedence rules:
 * 1. If `agents` is provided and non-empty, it takes precedence.
 *    (`agentId`, if also set, is silently ignored — callers should validate
 *    and warn users that `agents` overrides `agentId` at edit time.)
 * 2. If only `agentId` is provided, returns a single-element array:
 *    `[{ agentId, instructions: step.instructions }]`.
 * 3. If neither is provided, throws an `Error`.
 *
 * @param step - The workflow step to resolve agents for.
 * @returns Non-empty array of `WorkflowStepAgent` records for this step.
 * @throws {Error} When neither `agentId` nor `agents` is provided.
 */
export function resolveStepAgents(step: WorkflowStep): WorkflowStepAgent[] {
	if (step.agents && step.agents.length > 0) {
		return step.agents;
	}

	if (step.agentId) {
		return [{ agentId: step.agentId, instructions: step.instructions }];
	}

	throw new Error(
		`WorkflowStep "${step.name}" (id: ${step.id}) has neither agentId nor agents defined. ` +
			'At least one must be provided.'
	);
}

// ============================================================================
// resolveStepChannels
// ============================================================================

/**
 * Expands the declarative `WorkflowChannel` list of a step into concrete, directional
 * `ResolvedChannel` routing rules.
 *
 * Resolution algorithm:
 * - Each channel's `from`/`to` role strings are resolved against the step's agents via
 *   the provided `SpaceAgent[]` lookup table (role strings matched via SpaceAgent.role).
 * - `'*'` in `from` or `to` (as the sole element) expands to all agent roles in the step.
 *   Note: `'*'` mixed with other roles in an array `to` is treated as a literal role name;
 *   use `validateStepChannels` to catch this pattern at edit time.
 * - Bidirectional channels are expanded into two one-way entries:
 *   - **Point-to-point** (`A ↔ B`): A→B + B→A, both with `isHubSpoke: false`.
 *   - **Hub-spoke** (`A ↔ [B, C, D]`): hub→each spoke + each spoke→hub, all with
 *     `isHubSpoke: true`. Spoke-to-spoke routing is intentionally omitted.
 * - Self-loops (fromRole === toRole) are skipped.
 * - Roles not resolvable via the provided `agents` list are skipped silently;
 *   use `validateStepChannels` to surface these as errors before calling this function.
 * - When two step agents share the same SpaceAgent.role, the last one wins in the
 *   role→agentId map. Duplicate roles are flagged by `validateStepChannels`.
 *
 * Supported topology patterns:
 * - `A → B`        one-way point-to-point
 * - `A ↔ B`        bidirectional point-to-point (expands to A→B + B→A)
 * - `A → [B,C,D]`  fan-out (one entry per target)
 * - `A ↔ [B,C,D]`  hub-spoke (hub→each spoke + each spoke→hub, no spoke-to-spoke)
 * - `* → B`        all agents send to B
 * - `A → *`        A sends to all agents
 *
 * @param step   - The workflow step whose channels are to be resolved.
 * @param agents - All `SpaceAgent` records in the Space; used to map agentId → role.
 * @returns Array of concrete `ResolvedChannel` routing rules. Empty when no channels are defined.
 */
export function resolveStepChannels(step: WorkflowStep, agents: SpaceAgent[]): ResolvedChannel[] {
	if (!step.channels || step.channels.length === 0) return [];

	const stepAgents = resolveStepAgents(step);

	// Build role → agentId map for agents present in this step.
	const roleToAgentId = new Map<string, string>();
	for (const sa of stepAgents) {
		const spaceAgent = agents.find((a) => a.id === sa.agentId);
		if (spaceAgent) {
			roleToAgentId.set(spaceAgent.role, sa.agentId);
		}
	}

	const allRoles = [...roleToAgentId.keys()];
	const results: ResolvedChannel[] = [];

	for (const channel of step.channels) {
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
// validateStepChannels
// ============================================================================

/**
 * Validates that all role references in a step's `channels` are resolvable.
 *
 * Checks:
 * - At least one of `agentId` or `agents` is provided (delegates to `resolveStepAgents`).
 * - All step agent IDs are found in the provided `agents` list.
 * - No two step agents share the same `SpaceAgent.role` (ambiguous channel targeting).
 * - `from`/`to` role strings are either the wildcard `'*'` or match a known role.
 * - `'*'` is not mixed with other roles in an array `to` (use a plain `'*'` string instead).
 *
 * @param step   - The workflow step to validate.
 * @param agents - All `SpaceAgent` records in the Space.
 * @returns Array of human-readable error strings. Empty array means no errors.
 */
export function validateStepChannels(step: WorkflowStep, agents: SpaceAgent[]): string[] {
	const errors: string[] = [];

	if (!step.channels || step.channels.length === 0) return errors;

	let stepAgents: WorkflowStepAgent[];
	try {
		stepAgents = resolveStepAgents(step);
	} catch (err) {
		errors.push((err as Error).message);
		return errors;
	}

	// Build known roles set from step agents; detect duplicate roles.
	const knownRoles = new Set<string>();
	const seenRoles = new Set<string>();
	for (const sa of stepAgents) {
		const spaceAgent = agents.find((a) => a.id === sa.agentId);
		if (spaceAgent) {
			if (seenRoles.has(spaceAgent.role)) {
				errors.push(
					`Step "${step.name}" has two agents with role "${spaceAgent.role}". ` +
						'Duplicate roles make channel targeting ambiguous.'
				);
			} else {
				seenRoles.add(spaceAgent.role);
				knownRoles.add(spaceAgent.role);
			}
		} else {
			errors.push(
				`Step agent with agentId "${sa.agentId}" was not found in the provided space agents list.`
			);
		}
	}

	for (let i = 0; i < step.channels.length; i++) {
		const ch = step.channels[i];

		if (ch.from !== '*' && !knownRoles.has(ch.from)) {
			errors.push(
				`channels[${i}].from "${ch.from}" does not match any agent role in step "${step.name}". ` +
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
					`channels[${i}].to "${toRole}" does not match any agent role in step "${step.name}". ` +
						`Known roles: [${[...knownRoles].join(', ')}].`
				);
			}
		}
	}

	return errors;
}
