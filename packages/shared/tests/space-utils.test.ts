import { describe, test, expect } from 'bun:test';
import type { SpaceAgent, WorkflowChannel, WorkflowNode } from '../src/types/space.ts';
import {
	resolveNodeAgents,
	resolveNodeChannels,
	validateNodeChannels,
} from '../src/types/space-utils.ts';

// ============================================================================
// Test fixtures
// ============================================================================

function makeAgent(id: string, name: string): SpaceAgent {
	return {
		id,
		spaceId: 'space-1',
		name,
		instructions: null,
		createdAt: 0,
		updatedAt: 0,
	};
}

function makeNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
	return {
		id: 'node-1',
		name: 'Test Node',
		agents: [],
		...overrides,
	};
}

const agentCoder = makeAgent('agent-coder-id', 'coder agent');
const agentReviewer = makeAgent('agent-reviewer-id', 'reviewer agent');
const agentSecurity = makeAgent('agent-security-id', 'security agent');
const allAgents: SpaceAgent[] = [agentCoder, agentReviewer, agentSecurity];

// ============================================================================
// resolveNodeAgents
// ============================================================================

describe('resolveNodeAgents', () => {
	test('returns agents array when agents is set (non-empty)', () => {
		const node = makeNode({
			instructions: 'shared guidance',
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
			],
		});
		const result = resolveNodeAgents(node);
		expect(result).toHaveLength(2);
		expect(result[0].agentId).toBe('agent-coder-id');
		expect(result[0].name).toBe('coder');
		expect(result[1].agentId).toBe('agent-reviewer-id');
		expect(result[1].name).toBe('reviewer');
	});

	test('throws when agents is an empty array', () => {
		const node = makeNode({ agents: [] });
		expect(() => resolveNodeAgents(node)).toThrow();
	});

	test('single-element agents array works correctly', () => {
		const node = makeNode({
			agents: [{ agentId: 'agent-coder-id', name: 'coder' }],
		});
		expect(resolveNodeAgents(node)).toEqual([{ agentId: 'agent-coder-id', name: 'coder' }]);
	});

	test('same agentId can appear multiple times with different names', () => {
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', name: 'strict-reviewer' },
				{ agentId: 'agent-coder-id', name: 'quick-reviewer' },
			],
		});
		const result = resolveNodeAgents(node);
		expect(result).toHaveLength(2);
		expect(result[0].name).toBe('strict-reviewer');
		expect(result[1].name).toBe('quick-reviewer');
		expect(result[0].agentId).toBe('agent-coder-id');
		expect(result[1].agentId).toBe('agent-coder-id');
	});

	test('preserves systemPrompt and instructions overrides on agent slots', () => {
		const node = makeNode({
			agents: [
				{
					agentId: 'agent-coder-id',
					name: 'fast-coder',
					systemPrompt: { mode: 'override', value: 'Be concise.' },
					instructions: { mode: 'expand', value: 'Extra guidance.' },
				},
			],
		});
		const result = resolveNodeAgents(node);
		expect(result[0].systemPrompt).toEqual({ mode: 'override', value: 'Be concise.' });
		expect(result[0].instructions).toEqual({ mode: 'expand', value: 'Extra guidance.' });
	});
});

// ============================================================================
// resolveNodeChannels
// ============================================================================

describe('resolveNodeChannels', () => {
	test('returns empty array when no channels defined', () => {
		const node = makeNode({
			agents: [{ agentId: 'agent-coder-id', name: 'coder' }],
		});
		expect(resolveNodeChannels(node, [])).toEqual([]);
	});

	test('returns empty array when channels is an empty array', () => {
		const channels: WorkflowChannel[] = [];
		const node = makeNode({
			agents: [{ agentId: 'agent-coder-id', name: 'coder' }],
		});
		expect(resolveNodeChannels(node, channels)).toEqual([]);
	});

	test('A→B one-way: produces one resolved channel', () => {
		const channels = [{ from: 'coder', to: 'reviewer', direction: 'one-way' as const }];
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
			],
		});
		const result = resolveNodeChannels(node, channels);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			fromRole: 'coder',
			toRole: 'reviewer',
			fromAgentId: 'agent-coder-id',
			toAgentId: 'agent-reviewer-id',
			direction: 'one-way',
			isHubSpoke: false,
		});
	});

	test('A↔B bidirectional point-to-point: produces two one-way channels', () => {
		const channels = [{ from: 'coder', to: 'reviewer', direction: 'bidirectional' as const }];
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
			],
		});
		const result = resolveNodeChannels(node, channels);
		expect(result).toHaveLength(2);

		const forward = result.find((r) => r.fromRole === 'coder' && r.toRole === 'reviewer');
		const reverse = result.find((r) => r.fromRole === 'reviewer' && r.toRole === 'coder');

		expect(forward).toBeDefined();
		expect(forward!.isHubSpoke).toBe(false);
		expect(forward!.direction).toBe('one-way');

		expect(reverse).toBeDefined();
		expect(reverse!.isHubSpoke).toBe(false);
		expect(reverse!.direction).toBe('one-way');
	});

	test('A→[B,C] fan-out: produces one channel per target', () => {
		const channels = [
			{ from: 'coder', to: ['reviewer', 'security'], direction: 'one-way' as const },
		];
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
				{ agentId: 'agent-security-id', name: 'security' },
			],
		});
		const result = resolveNodeChannels(node, channels);
		expect(result).toHaveLength(2);

		const toReviewer = result.find((r) => r.toRole === 'reviewer');
		const toSecurity = result.find((r) => r.toRole === 'security');

		expect(toReviewer).toBeDefined();
		expect(toReviewer!.fromRole).toBe('coder');
		expect(toReviewer!.isHubSpoke).toBe(false);

		expect(toSecurity).toBeDefined();
		expect(toSecurity!.fromRole).toBe('coder');
		expect(toSecurity!.isHubSpoke).toBe(false);
	});

	test('A↔[B,C] hub-spoke: produces hub→spoke + spoke→hub, no spoke-to-spoke', () => {
		const channels = [
			{ from: 'coder', to: ['reviewer', 'security'], direction: 'bidirectional' as const },
		];
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
				{ agentId: 'agent-security-id', name: 'security' },
			],
		});
		const result = resolveNodeChannels(node, channels);

		// 2 spokes × 2 directions = 4 channels
		expect(result).toHaveLength(4);

		// All channels should be marked as hub-spoke
		expect(result.every((r) => r.isHubSpoke)).toBe(true);

		// Hub → each spoke
		expect(result.some((r) => r.fromRole === 'coder' && r.toRole === 'reviewer')).toBe(true);
		expect(result.some((r) => r.fromRole === 'coder' && r.toRole === 'security')).toBe(true);

		// Each spoke → hub
		expect(result.some((r) => r.fromRole === 'reviewer' && r.toRole === 'coder')).toBe(true);
		expect(result.some((r) => r.fromRole === 'security' && r.toRole === 'coder')).toBe(true);

		// No spoke-to-spoke
		expect(result.some((r) => r.fromRole === 'reviewer' && r.toRole === 'security')).toBe(false);
		expect(result.some((r) => r.fromRole === 'security' && r.toRole === 'reviewer')).toBe(false);
	});

	test('wildcard *→B: all agents send to B', () => {
		const channels = [{ from: '*', to: 'reviewer', direction: 'one-way' as const }];
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
				{ agentId: 'agent-security-id', name: 'security' },
			],
		});
		const result = resolveNodeChannels(node, channels);

		// coder→reviewer and security→reviewer (reviewer→reviewer self-loop skipped)
		expect(result).toHaveLength(2);
		expect(result.every((r) => r.toRole === 'reviewer')).toBe(true);
		expect(result.every((r) => r.fromRole !== 'reviewer')).toBe(true);
	});

	test('wildcard A→*: A sends to all other agents', () => {
		const channels = [{ from: 'coder', to: '*', direction: 'one-way' as const }];
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
				{ agentId: 'agent-security-id', name: 'security' },
			],
		});
		const result = resolveNodeChannels(node, channels);

		// coder→reviewer and coder→security (coder→coder self-loop skipped)
		expect(result).toHaveLength(2);
		expect(result.every((r) => r.fromRole === 'coder')).toBe(true);
		expect(result.every((r) => r.toRole !== 'coder')).toBe(true);
	});

	test('channel label is propagated to all resolved channels', () => {
		const channels = [
			{
				from: 'coder',
				to: ['reviewer', 'security'],
				direction: 'bidirectional' as const,
				label: 'feedback',
			},
		];
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
				{ agentId: 'agent-security-id', name: 'security' },
			],
		});
		const result = resolveNodeChannels(node, channels);
		expect(result.every((r) => r.label === 'feedback')).toBe(true);
	});

	test('skips channels referencing unknown roles (does not throw)', () => {
		const channels = [{ from: 'coder', to: 'nonexistent-role', direction: 'one-way' as const }];
		const node = makeNode({
			agents: [{ agentId: 'agent-coder-id', name: 'coder' }],
		});
		const result = resolveNodeChannels(node, channels);
		expect(result).toHaveLength(0);
	});

	test('self-loop (from === to) is skipped', () => {
		const channels = [{ from: 'coder', to: 'coder', direction: 'one-way' as const }];
		const node = makeNode({
			agents: [{ agentId: 'agent-coder-id', name: 'coder' }],
		});
		const result = resolveNodeChannels(node, channels);
		expect(result).toHaveLength(0);
	});

	test('multiple channels expand independently', () => {
		const channels = [
			{ from: 'coder', to: 'reviewer', direction: 'one-way' as const },
			{ from: 'reviewer', to: 'security', direction: 'one-way' as const },
		];
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
				{ agentId: 'agent-security-id', name: 'security' },
			],
		});
		const result = resolveNodeChannels(node, channels);
		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({ fromRole: 'coder', toRole: 'reviewer' });
		expect(result[1]).toMatchObject({ fromRole: 'reviewer', toRole: 'security' });
	});

	test('same agentId with different names routes channels correctly', () => {
		// Two slots using the same agent but different names
		const channels = [
			{ from: 'strict-reviewer', to: 'quick-reviewer', direction: 'one-way' as const },
		];
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', name: 'strict-reviewer' },
				{ agentId: 'agent-coder-id', name: 'quick-reviewer' },
			],
		});
		const result = resolveNodeChannels(node, channels);
		expect(result).toHaveLength(1);
		expect(result[0].fromRole).toBe('strict-reviewer');
		expect(result[0].toRole).toBe('quick-reviewer');
		// Both resolve to the same agentId
		expect(result[0].fromAgentId).toBe('agent-coder-id');
		expect(result[0].toAgentId).toBe('agent-coder-id');
	});
});

// ============================================================================
// validateNodeChannels
// ============================================================================

describe('validateNodeChannels', () => {
	test('returns empty errors for node with no channels', () => {
		const node = makeNode({ agents: [{ agentId: 'agent-coder-id', name: 'coder' }] });
		expect(validateNodeChannels(node, allAgents, [])).toEqual([]);
	});

	test('returns empty errors for node with empty channels array', () => {
		const channels: WorkflowChannel[] = [];
		const node = makeNode({ agents: [{ agentId: 'agent-coder-id', name: 'coder' }] });
		expect(validateNodeChannels(node, allAgents, channels)).toEqual([]);
	});

	test('returns no errors for valid channel references', () => {
		const channels = [{ from: 'coder', to: 'reviewer', direction: 'one-way' as const }];
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
			],
		});
		expect(validateNodeChannels(node, allAgents, channels)).toEqual([]);
	});

	test('accepts wildcard * in from without error', () => {
		const channels = [{ from: '*', to: 'reviewer', direction: 'one-way' as const }];
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
			],
		});
		expect(validateNodeChannels(node, allAgents, channels)).toEqual([]);
	});

	test('accepts wildcard * in to without error', () => {
		const channels = [{ from: 'coder', to: '*', direction: 'one-way' as const }];
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
			],
		});
		expect(validateNodeChannels(node, allAgents, channels)).toEqual([]);
	});

	test('reports error for unknown from role', () => {
		const channels = [{ from: 'nonexistent', to: 'coder', direction: 'one-way' as const }];
		const node = makeNode({
			agents: [{ agentId: 'agent-coder-id', name: 'coder' }],
		});
		const errors = validateNodeChannels(node, allAgents, channels);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('channels[0].from "nonexistent"');
	});

	test('reports error for unknown to role', () => {
		const channels = [{ from: 'coder', to: 'nonexistent', direction: 'one-way' as const }];
		const node = makeNode({
			agents: [{ agentId: 'agent-coder-id', name: 'coder' }],
		});
		const errors = validateNodeChannels(node, allAgents, channels);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('channels[0].to "nonexistent"');
	});

	test('reports error for unknown role in array to', () => {
		const channels = [
			{ from: 'coder', to: ['reviewer', 'ghost-role'], direction: 'one-way' as const },
		];
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
			],
		});
		const errors = validateNodeChannels(node, allAgents, channels);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('"ghost-role"');
	});

	test('reports error for agent not found in space agents list', () => {
		const channels = [{ from: 'coder', to: 'reviewer', direction: 'one-way' as const }];
		const node = makeNode({
			agents: [{ agentId: 'unknown-agent-id', name: 'coder' }],
		});
		const errors = validateNodeChannels(node, allAgents, channels);
		expect(errors.some((e) => e.includes('"unknown-agent-id"'))).toBe(true);
	});

	test('returns error from resolveNodeAgents when agents is empty', () => {
		const channels = [{ from: 'coder', to: 'reviewer', direction: 'one-way' as const }];
		const node = makeNode({});
		const errors = validateNodeChannels(node, allAgents, channels);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('no agents defined');
	});

	test('accumulates multiple errors', () => {
		const channels = [
			{ from: 'bad-from', to: 'bad-to', direction: 'one-way' as const },
			{ from: 'coder', to: 'another-bad', direction: 'one-way' as const },
		];
		const node = makeNode({
			agents: [{ agentId: 'agent-coder-id', name: 'coder' }],
		});
		const errors = validateNodeChannels(node, allAgents, channels);
		expect(errors.length).toBeGreaterThanOrEqual(3); // bad-from, bad-to, another-bad
	});

	test('reports error when two agent slots share the same name', () => {
		// Two slots with the same name — duplicate names make channels ambiguous
		const channels = [{ from: 'coder', to: 'reviewer', direction: 'one-way' as const }];
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', name: 'reviewer' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' }, // duplicate name
			],
		});
		const errors = validateNodeChannels(node, allAgents, channels);
		expect(errors.some((e) => e.includes('Duplicate names'))).toBe(true);
	});

	test('allows same agentId with different names (no error)', () => {
		// Same agent used twice with different names — this is permitted
		const channels = [
			{ from: 'strict-reviewer', to: 'quick-reviewer', direction: 'one-way' as const },
		];
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', name: 'strict-reviewer' },
				{ agentId: 'agent-coder-id', name: 'quick-reviewer' },
			],
		});
		const errors = validateNodeChannels(node, allAgents, channels);
		expect(errors).toEqual([]);
	});

	test('reports error when * is mixed with other roles in array to', () => {
		const channels = [{ from: 'coder', to: ['reviewer', '*'], direction: 'one-way' as const }];
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
			],
		});
		const errors = validateNodeChannels(node, allAgents, channels);
		expect(errors.some((e) => e.includes("mixes wildcard '*'"))).toBe(true);
	});

	test('plain * in to (not in array) is accepted', () => {
		const channels = [{ from: 'coder', to: '*', direction: 'one-way' as const }];
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
			],
		});
		expect(validateNodeChannels(node, allAgents, channels)).toEqual([]);
	});
});

// ============================================================================
// Multi-agent nodes
// ============================================================================

describe('multi-agent nodes', () => {
	test('resolveNodeAgents works for multi-agent nodes', () => {
		const node: WorkflowNode = {
			id: 'multi-node',
			name: 'Multi Node',
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
			],
		};
		const result = resolveNodeAgents(node);
		expect(result).toHaveLength(2);
		expect(result[0].agentId).toBe('agent-coder-id');
		expect(result[0].name).toBe('coder');
	});

	test('resolveNodeChannels works for multi-agent nodes', () => {
		const node: WorkflowNode = {
			id: 'multi-node',
			name: 'Multi Node',
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
			],
		};
		const channels = [{ from: 'coder', to: 'reviewer', direction: 'one-way' as const }];
		const result = resolveNodeChannels(node, channels);
		expect(result).toHaveLength(1);
		expect(result[0].fromAgentId).toBe('agent-coder-id');
		expect(result[0].toAgentId).toBe('agent-reviewer-id');
	});

	test('validateNodeChannels returns no errors for valid multi-agent nodes', () => {
		const node: WorkflowNode = {
			id: 'multi-node',
			name: 'Multi Node',
			agents: [
				{ agentId: 'agent-coder-id', name: 'coder' },
				{ agentId: 'agent-reviewer-id', name: 'reviewer' },
			],
		};
		const channels = [{ from: 'coder', to: 'reviewer', direction: 'one-way' as const }];
		expect(validateNodeChannels(node, allAgents, channels)).toEqual([]);
	});
});
