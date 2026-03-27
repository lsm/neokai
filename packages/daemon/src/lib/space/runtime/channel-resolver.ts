/**
 * ChannelResolver — validates messaging permissions based on declared channel topology.
 *
 * Reads `ResolvedChannel[]` from a workflow run's config (`run.config._resolvedChannels`)
 * and exposes a simple validation API for checking whether a given agent role is
 * permitted to send messages to another role.
 *
 * Resolved channels are stored by `SpaceRuntime.storeResolvedChannels()` at step-start
 * (see `space-runtime.ts`). Each entry is a concrete directional routing rule already
 * expanded from the declarative `WorkflowChannel` declarations:
 *   - Bidirectional channels are split into two one-way entries
 *   - Wildcard (`*`) and array `to` declarations are expanded per pair
 *
 * When no channels are declared for a step (empty array), all `canSend()` calls
 * return `false`. All agents (including the Task Agent) communicate via `send_message`,
 * which enforces channel topology uniformly.
 */

import type { ResolvedChannel } from '@neokai/shared';

/**
 * Returns true when `entry` is a structurally valid `ResolvedChannel`.
 * Filters out malformed DB values (partial serialization, migration bugs, manual edits)
 * rather than casting them blindly, which would produce undefined behaviour in
 * `canSend()` / `getPermittedTargets()` (e.g. `ch.fromRole === undefined` always false).
 */
function isValidResolvedChannel(entry: unknown): entry is ResolvedChannel {
	if (!entry || typeof entry !== 'object') return false;
	const e = entry as Record<string, unknown>;
	return (
		typeof e.fromRole === 'string' &&
		e.fromRole.length > 0 &&
		typeof e.toRole === 'string' &&
		e.toRole.length > 0 &&
		typeof e.fromAgentId === 'string' &&
		typeof e.toAgentId === 'string' &&
		e.direction === 'one-way' &&
		typeof e.isHubSpoke === 'boolean'
	);
}

export class ChannelResolver {
	constructor(private readonly channels: ResolvedChannel[]) {}

	/**
	 * Build a ChannelResolver from a workflow run's config object.
	 * Reads `config._resolvedChannels` — stored by `storeResolvedChannels()` in SpaceRuntime.
	 * Returns an empty resolver if the field is absent, not an array, or contains only
	 * invalid entries. Invalid entries are silently filtered rather than casting blindly.
	 */
	static fromRunConfig(config: Record<string, unknown> | undefined): ChannelResolver {
		const raw = config?._resolvedChannels;
		if (!Array.isArray(raw)) return new ChannelResolver([]);
		const channels = raw.filter(isValidResolvedChannel);
		return new ChannelResolver(channels);
	}

	/**
	 * Returns true if the declared channel topology permits the sender to message the target.
	 *
	 * Matches by role string. When no channels are declared, always returns false —
	 * all agents use `send_message` which is uniformly constrained by topology.
	 */
	canSend(fromRole: string, toRole: string): boolean {
		return this.channels.some((ch) => ch.fromRole === fromRole && ch.toRole === toRole);
	}

	/**
	 * Returns all target roles that the given sender role is permitted to message
	 * according to the declared channel topology. Duplicate role names are deduplicated
	 * (can occur when multiple agent IDs share the same role and both appear as targets).
	 * Returns an empty array when no channels are declared or none match.
	 */
	getPermittedTargets(fromRole: string): string[] {
		const targets = this.channels.filter((ch) => ch.fromRole === fromRole).map((ch) => ch.toRole);
		return [...new Set(targets)];
	}

	/**
	 * Returns a shallow copy of the full resolved channel topology.
	 * Returns a copy so callers cannot mutate the internal array.
	 * Each entry is a concrete one-way routing rule (bidirectional already split).
	 */
	getResolvedChannels(): ResolvedChannel[] {
		return [...this.channels];
	}

	/** True when no channels are declared (open topology — no routing constraints). */
	isEmpty(): boolean {
		return this.channels.length === 0;
	}
}
