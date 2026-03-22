/**
 * Unit tests for ChannelResolver
 *
 * Covers:
 *   - Static factory fromRunConfig()
 *   - canSend() validation
 *   - getPermittedTargets() results
 *   - getResolvedChannels() accessor
 *   - isEmpty() for empty/non-empty topology
 */

import { describe, test, expect } from 'bun:test';
import { ChannelResolver } from '../../../src/lib/space/runtime/channel-resolver.ts';
import type { ResolvedChannel } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function oneWayChannel(fromRole: string, toRole: string): ResolvedChannel {
	return {
		fromRole,
		toRole,
		fromAgentId: `agent-${fromRole}`,
		toAgentId: `agent-${toRole}`,
		direction: 'one-way',
		isHubSpoke: false,
	};
}

function hubSpokeChannel(fromRole: string, toRole: string): ResolvedChannel {
	return {
		fromRole,
		toRole,
		fromAgentId: `agent-${fromRole}`,
		toAgentId: `agent-${toRole}`,
		direction: 'one-way',
		isHubSpoke: true,
	};
}

// ===========================================================================
// fromRunConfig()
// ===========================================================================

describe('ChannelResolver.fromRunConfig', () => {
	test('returns empty resolver when config is undefined', () => {
		const resolver = ChannelResolver.fromRunConfig(undefined);
		expect(resolver.isEmpty()).toBe(true);
		expect(resolver.getResolvedChannels()).toEqual([]);
	});

	test('returns empty resolver when config has no _resolvedChannels field', () => {
		const resolver = ChannelResolver.fromRunConfig({ someOtherField: 'value' });
		expect(resolver.isEmpty()).toBe(true);
	});

	test('returns empty resolver when _resolvedChannels is not an array', () => {
		const resolver = ChannelResolver.fromRunConfig({
			_resolvedChannels: 'not-an-array',
		});
		expect(resolver.isEmpty()).toBe(true);
	});

	test('returns empty resolver when _resolvedChannels is an empty array', () => {
		const resolver = ChannelResolver.fromRunConfig({ _resolvedChannels: [] });
		expect(resolver.isEmpty()).toBe(true);
	});

	test('returns populated resolver from valid _resolvedChannels', () => {
		const channels = [oneWayChannel('coder', 'reviewer')];
		const resolver = ChannelResolver.fromRunConfig({ _resolvedChannels: channels });
		expect(resolver.isEmpty()).toBe(false);
		expect(resolver.getResolvedChannels()).toHaveLength(1);
	});
});

// ===========================================================================
// canSend()
// ===========================================================================

describe('ChannelResolver.canSend', () => {
	test('returns true for declared one-way channel', () => {
		const resolver = new ChannelResolver([oneWayChannel('coder', 'reviewer')]);
		expect(resolver.canSend('coder', 'reviewer')).toBe(true);
	});

	test('returns false for reverse direction when only one-way declared', () => {
		const resolver = new ChannelResolver([oneWayChannel('coder', 'reviewer')]);
		expect(resolver.canSend('reviewer', 'coder')).toBe(false);
	});

	test('returns true for both directions when bidirectional (two one-way entries)', () => {
		const resolver = new ChannelResolver([
			oneWayChannel('coder', 'reviewer'),
			oneWayChannel('reviewer', 'coder'),
		]);
		expect(resolver.canSend('coder', 'reviewer')).toBe(true);
		expect(resolver.canSend('reviewer', 'coder')).toBe(true);
	});

	test('returns false for self-loop', () => {
		const resolver = new ChannelResolver([oneWayChannel('coder', 'reviewer')]);
		expect(resolver.canSend('coder', 'coder')).toBe(false);
	});

	test('returns false for unknown roles', () => {
		const resolver = new ChannelResolver([oneWayChannel('coder', 'reviewer')]);
		expect(resolver.canSend('security', 'coder')).toBe(false);
	});

	test('returns false when resolver is empty', () => {
		const resolver = new ChannelResolver([]);
		expect(resolver.canSend('coder', 'reviewer')).toBe(false);
	});

	test('handles hub-spoke channels correctly', () => {
		// Hub: coder (hub) ↔ reviewer, qa (spokes) — expanded to 4 entries
		const resolver = new ChannelResolver([
			hubSpokeChannel('coder', 'reviewer'),
			hubSpokeChannel('reviewer', 'coder'),
			hubSpokeChannel('coder', 'qa'),
			hubSpokeChannel('qa', 'coder'),
		]);
		expect(resolver.canSend('coder', 'reviewer')).toBe(true);
		expect(resolver.canSend('coder', 'qa')).toBe(true);
		expect(resolver.canSend('reviewer', 'coder')).toBe(true);
		expect(resolver.canSend('qa', 'coder')).toBe(true);
		// Spoke-to-spoke is NOT declared in hub-spoke topology
		expect(resolver.canSend('reviewer', 'qa')).toBe(false);
		expect(resolver.canSend('qa', 'reviewer')).toBe(false);
	});

	test('matches by exact role string', () => {
		const resolver = new ChannelResolver([oneWayChannel('coder', 'reviewer')]);
		// Case sensitive
		expect(resolver.canSend('Coder', 'reviewer')).toBe(false);
		expect(resolver.canSend('coder', 'Reviewer')).toBe(false);
	});
});

// ===========================================================================
// getPermittedTargets()
// ===========================================================================

describe('ChannelResolver.getPermittedTargets', () => {
	test('returns empty array for unknown sender', () => {
		const resolver = new ChannelResolver([oneWayChannel('coder', 'reviewer')]);
		expect(resolver.getPermittedTargets('unknown-role')).toEqual([]);
	});

	test('returns empty array when resolver is empty', () => {
		const resolver = new ChannelResolver([]);
		expect(resolver.getPermittedTargets('coder')).toEqual([]);
	});

	test('returns all targets for a sender with multiple channels', () => {
		const resolver = new ChannelResolver([
			oneWayChannel('coder', 'reviewer'),
			oneWayChannel('coder', 'qa'),
			oneWayChannel('reviewer', 'coder'),
		]);
		const targets = resolver.getPermittedTargets('coder').sort();
		expect(targets).toEqual(['qa', 'reviewer']);
	});

	test('returns only targets for the specified sender', () => {
		const resolver = new ChannelResolver([
			oneWayChannel('coder', 'reviewer'),
			oneWayChannel('reviewer', 'coder'),
		]);
		expect(resolver.getPermittedTargets('coder')).toEqual(['reviewer']);
		expect(resolver.getPermittedTargets('reviewer')).toEqual(['coder']);
	});

	test('returns single target for one-way channel', () => {
		const resolver = new ChannelResolver([oneWayChannel('coder', 'reviewer')]);
		expect(resolver.getPermittedTargets('coder')).toEqual(['reviewer']);
	});
});

// ===========================================================================
// getResolvedChannels()
// ===========================================================================

describe('ChannelResolver.getResolvedChannels', () => {
	test('returns empty array when no channels', () => {
		const resolver = new ChannelResolver([]);
		expect(resolver.getResolvedChannels()).toEqual([]);
	});

	test('returns all channels in original order', () => {
		const ch1 = oneWayChannel('coder', 'reviewer');
		const ch2 = oneWayChannel('reviewer', 'coder');
		const resolver = new ChannelResolver([ch1, ch2]);
		expect(resolver.getResolvedChannels()).toEqual([ch1, ch2]);
	});

	test('preserves isHubSpoke field', () => {
		const ch = hubSpokeChannel('hub', 'spoke');
		const resolver = new ChannelResolver([ch]);
		expect(resolver.getResolvedChannels()[0].isHubSpoke).toBe(true);
	});
});

// ===========================================================================
// isEmpty()
// ===========================================================================

describe('ChannelResolver.isEmpty', () => {
	test('true when no channels', () => {
		expect(new ChannelResolver([]).isEmpty()).toBe(true);
	});

	test('false when at least one channel', () => {
		expect(new ChannelResolver([oneWayChannel('a', 'b')]).isEmpty()).toBe(false);
	});
});
