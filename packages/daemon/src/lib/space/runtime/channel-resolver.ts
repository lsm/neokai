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
 * return `false` (open/unrestricted mode is not assumed — Task Agent override handles
 * cross-member messaging outside the topology).
 */

import type { ResolvedChannel } from '@neokai/shared';

export class ChannelResolver {
	constructor(private readonly channels: ResolvedChannel[]) {}

	/**
	 * Build a ChannelResolver from a workflow run's config object.
	 * Reads `config._resolvedChannels` — stored by `storeResolvedChannels()` in SpaceRuntime.
	 * Returns an empty resolver if the field is absent or not an array.
	 */
	static fromRunConfig(config: Record<string, unknown> | undefined): ChannelResolver {
		const raw = config?._resolvedChannels;
		const channels = Array.isArray(raw) ? (raw as ResolvedChannel[]) : [];
		return new ChannelResolver(channels);
	}

	/**
	 * Returns true if the declared channel topology permits the sender to message the target.
	 *
	 * Matches by role string. When no channels are declared, always returns false —
	 * the Task Agent can override this using `relay_message` (unrestricted).
	 */
	canSend(fromRole: string, toRole: string): boolean {
		return this.channels.some((ch) => ch.fromRole === fromRole && ch.toRole === toRole);
	}

	/**
	 * Returns all target roles that the given sender role is permitted to message
	 * according to the declared channel topology.
	 * Returns an empty array when no channels are declared or none match.
	 */
	getPermittedTargets(fromRole: string): string[] {
		return this.channels.filter((ch) => ch.fromRole === fromRole).map((ch) => ch.toRole);
	}

	/**
	 * Returns the full resolved channel topology.
	 * Each entry is a concrete one-way routing rule (bidirectional already split).
	 */
	getResolvedChannels(): ResolvedChannel[] {
		return this.channels;
	}

	/** True when no channels are declared (open topology — no routing constraints). */
	isEmpty(): boolean {
		return this.channels.length === 0;
	}
}
