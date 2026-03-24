import { describe, test, expect } from 'bun:test';
import type { SpaceAgent, WorkflowNode } from '../src/types/space.ts';
import {
	resolveNodeAgents,
	resolveNodeChannels,
	validateNodeChannels,
} from '../src/types/space-utils.ts';

// ============================================================================
// Test fixtures
// ============================================================================

function makeAgent(id: string, role: string): SpaceAgent {
	return {
		id,
		spaceId: 'space-1',
		name: `${role} agent`,
		role,
		createdAt: 0,
		updatedAt: 0,
	};
}

function makeNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
	return {
		id: 'node-1',
		name: 'Test Node',
		...overrides,
	};
}

const agentCoder = makeAgent('agent-coder-id', 'coder');
const agentReviewer = makeAgent('agent-reviewer-id', 'reviewer');
const agentSecurity = makeAgent('agent-security-id', 'security');
const allAgents: SpaceAgent[] = [agentCoder, agentReviewer, agentSecurity];

// ============================================================================
// resolveNodeAgents
// ============================================================================

describe('resolveNodeAgents', () => {
	test('returns single-element array when only agentId is set', () => {
		const node = makeNode({ agentId: 'agent-coder-id', instructions: 'do the thing' });
		const result = resolveNodeAgents(node);
		expect(result).toHaveLength(1);
		expect(result[0].agentId).toBe('agent-coder-id');
		expect(result[0].instructions).toBe('do the thing');
		// Synthetic role uses agentId as placeholder
		expect(result[0].role).toBe('agent-coder-id');
	});

	test('returns agents array when agents is set (non-empty)', () => {
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', role: 'coder', instructions: 'write code' },
				{ agentId: 'agent-reviewer-id', role: 'reviewer' },
			],
		});
		const result = resolveNodeAgents(node);
		expect(result).toHaveLength(2);
		expect(result[0].agentId).toBe('agent-coder-id');
		expect(result[0].role).toBe('coder');
		expect(result[1].agentId).toBe('agent-reviewer-id');
		expect(result[1].role).toBe('reviewer');
	});

	test('agents takes precedence over agentId when both are set', () => {
		const node = makeNode({
			agentId: 'agent-coder-id',
			agents: [{ agentId: 'agent-reviewer-id', role: 'reviewer' }],
		});
		const result = resolveNodeAgents(node);
		expect(result).toHaveLength(1);
		expect(result[0].agentId).toBe('agent-reviewer-id');
	});

	test('throws when neither agentId nor agents is provided', () => {
		const node = makeNode();
		expect(() => resolveNodeAgents(node)).toThrow(
			'WorkflowNode "Test Node" (id: node-1) has neither agentId nor agents defined'
		);
	});

	test('throws when agents is an empty array and agentId is absent', () => {
		const node = makeNode({ agents: [] });
		expect(() => resolveNodeAgents(node)).toThrow();
	});

	test('single-element agents array works correctly', () => {
		const node = makeNode({
			agents: [{ agentId: 'agent-coder-id', role: 'coder', instructions: 'custom' }],
		});
		expect(resolveNodeAgents(node)).toEqual([
			{ agentId: 'agent-coder-id', role: 'coder', instructions: 'custom' },
		]);
	});

	test('agentId with no instructions produces entry with undefined instructions', () => {
		const node = makeNode({ agentId: 'agent-coder-id' });
		const result = resolveNodeAgents(node);
		expect(result[0].instructions).toBeUndefined();
	});

	test('same agentId can appear multiple times with different roles', () => {
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', role: 'strict-reviewer' },
				{ agentId: 'agent-coder-id', role: 'quick-reviewer' },
			],
		});
		const result = resolveNodeAgents(node);
		expect(result).toHaveLength(2);
		expect(result[0].role).toBe('strict-reviewer');
		expect(result[1].role).toBe('quick-reviewer');
		expect(result[0].agentId).toBe('agent-coder-id');
		expect(result[1].agentId).toBe('agent-coder-id');
	});

	test('preserves model and systemPrompt override fields', () => {
		const node = makeNode({
			agents: [
				{
					agentId: 'agent-coder-id',
					role: 'fast-coder',
					model: 'claude-haiku-4-5',
					systemPrompt: 'You are a fast coder.',
				},
			],
		});
		const result = resolveNodeAgents(node);
		expect(result[0].model).toBe('claude-haiku-4-5');
		expect(result[0].systemPrompt).toBe('You are a fast coder.');
	});
});

// ============================================================================
// resolveNodeChannels
// ============================================================================

describe('resolveNodeChannels', () => {
	test('returns empty array when no channels defined', () => {
		const node = makeNode({ agentId: 'agent-coder-id' });
		expect(resolveNodeChannels(node)).toEqual([]);
	});

	test('returns empty array when channels is an empty array', () => {
		const node = makeNode({ agentId: 'agent-coder-id', channels: [] });
		expect(resolveNodeChannels(node)).toEqual([]);
	});

	test('A→B one-way: produces one resolved channel', () => {
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', role: 'coder' },
				{ agentId: 'agent-reviewer-id', role: 'reviewer' },
			],
			channels: [{ from: 'coder', to: 'reviewer', direction: 'one-way' }],
		});
		const result = resolveNodeChannels(node);
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
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', role: 'coder' },
				{ agentId: 'agent-reviewer-id', role: 'reviewer' },
			],
			channels: [{ from: 'coder', to: 'reviewer', direction: 'bidirectional' }],
		});
		const result = resolveNodeChannels(node);
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
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', role: 'coder' },
				{ agentId: 'agent-reviewer-id', role: 'reviewer' },
				{ agentId: 'agent-security-id', role: 'security' },
			],
			channels: [{ from: 'coder', to: ['reviewer', 'security'], direction: 'one-way' }],
		});
		const result = resolveNodeChannels(node);
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
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', role: 'coder' },
				{ agentId: 'agent-reviewer-id', role: 'reviewer' },
				{ agentId: 'agent-security-id', role: 'security' },
			],
			channels: [{ from: 'coder', to: ['reviewer', 'security'], direction: 'bidirectional' }],
		});
		const result = resolveNodeChannels(node);

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
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', role: 'coder' },
				{ agentId: 'agent-reviewer-id', role: 'reviewer' },
				{ agentId: 'agent-security-id', role: 'security' },
			],
			channels: [{ from: '*', to: 'reviewer', direction: 'one-way' }],
		});
		const result = resolveNodeChannels(node);

		// coder→reviewer and security→reviewer (reviewer→reviewer self-loop skipped)
		expect(result).toHaveLength(2);
		expect(result.every((r) => r.toRole === 'reviewer')).toBe(true);
		expect(result.every((r) => r.fromRole !== 'reviewer')).toBe(true);
	});

	test('wildcard A→*: A sends to all other agents', () => {
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', role: 'coder' },
				{ agentId: 'agent-reviewer-id', role: 'reviewer' },
				{ agentId: 'agent-security-id', role: 'security' },
			],
			channels: [{ from: 'coder', to: '*', direction: 'one-way' }],
		});
		const result = resolveNodeChannels(node);

		// coder→reviewer and coder→security (coder→coder self-loop skipped)
		expect(result).toHaveLength(2);
		expect(result.every((r) => r.fromRole === 'coder')).toBe(true);
		expect(result.every((r) => r.toRole !== 'coder')).toBe(true);
	});

	test('channel label is propagated to all resolved channels', () => {
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', role: 'coder' },
				{ agentId: 'agent-reviewer-id', role: 'reviewer' },
				{ agentId: 'agent-security-id', role: 'security' },
			],
			channels: [
				{
					from: 'coder',
					to: ['reviewer', 'security'],
					direction: 'bidirectional',
					label: 'feedback',
				},
			],
		});
		const result = resolveNodeChannels(node);
		expect(result.every((r) => r.label === 'feedback')).toBe(true);
	});

	test('skips channels referencing unknown roles (does not throw)', () => {
		const node = makeNode({
			agents: [{ agentId: 'agent-coder-id', role: 'coder' }],
			channels: [{ from: 'coder', to: 'nonexistent-role', direction: 'one-way' }],
		});
		const result = resolveNodeChannels(node);
		expect(result).toHaveLength(0);
	});

	test('self-loop (from === to) is skipped', () => {
		const node = makeNode({
			agents: [{ agentId: 'agent-coder-id', role: 'coder' }],
			channels: [{ from: 'coder', to: 'coder', direction: 'one-way' }],
		});
		const result = resolveNodeChannels(node);
		expect(result).toHaveLength(0);
	});

	test('multiple channels expand independently', () => {
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', role: 'coder' },
				{ agentId: 'agent-reviewer-id', role: 'reviewer' },
				{ agentId: 'agent-security-id', role: 'security' },
			],
			channels: [
				{ from: 'coder', to: 'reviewer', direction: 'one-way' },
				{ from: 'reviewer', to: 'security', direction: 'one-way' },
			],
		});
		const result = resolveNodeChannels(node);
		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({ fromRole: 'coder', toRole: 'reviewer' });
		expect(result[1]).toMatchObject({ fromRole: 'reviewer', toRole: 'security' });
	});

	test('backward-compat: node with only agentId and no channels resolves channels to []', () => {
		const node = makeNode({ agentId: 'agent-coder-id' });
		expect(resolveNodeChannels(node)).toEqual([]);
	});

	test('same agentId with different roles routes channels correctly', () => {
		// Two slots using the same agent but different roles
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', role: 'strict-reviewer' },
				{ agentId: 'agent-coder-id', role: 'quick-reviewer' },
			],
			channels: [{ from: 'strict-reviewer', to: 'quick-reviewer', direction: 'one-way' }],
		});
		const result = resolveNodeChannels(node);
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
		const node = makeNode({ agentId: 'agent-coder-id' });
		expect(validateNodeChannels(node, allAgents)).toEqual([]);
	});

	test('returns empty errors for node with empty channels array', () => {
		const node = makeNode({ agentId: 'agent-coder-id', channels: [] });
		expect(validateNodeChannels(node, allAgents)).toEqual([]);
	});

	test('returns no errors for valid channel references', () => {
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', role: 'coder' },
				{ agentId: 'agent-reviewer-id', role: 'reviewer' },
			],
			channels: [{ from: 'coder', to: 'reviewer', direction: 'one-way' }],
		});
		expect(validateNodeChannels(node, allAgents)).toEqual([]);
	});

	test('accepts wildcard * in from without error', () => {
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', role: 'coder' },
				{ agentId: 'agent-reviewer-id', role: 'reviewer' },
			],
			channels: [{ from: '*', to: 'reviewer', direction: 'one-way' }],
		});
		expect(validateNodeChannels(node, allAgents)).toEqual([]);
	});

	test('accepts wildcard * in to without error', () => {
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', role: 'coder' },
				{ agentId: 'agent-reviewer-id', role: 'reviewer' },
			],
			channels: [{ from: 'coder', to: '*', direction: 'one-way' }],
		});
		expect(validateNodeChannels(node, allAgents)).toEqual([]);
	});

	test('reports error for unknown from role', () => {
		const node = makeNode({
			agents: [{ agentId: 'agent-coder-id', role: 'coder' }],
			channels: [{ from: 'nonexistent', to: 'coder', direction: 'one-way' }],
		});
		const errors = validateNodeChannels(node, allAgents);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('channels[0].from "nonexistent"');
	});

	test('reports error for unknown to role', () => {
		const node = makeNode({
			agents: [{ agentId: 'agent-coder-id', role: 'coder' }],
			channels: [{ from: 'coder', to: 'nonexistent', direction: 'one-way' }],
		});
		const errors = validateNodeChannels(node, allAgents);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('channels[0].to "nonexistent"');
	});

	test('reports error for unknown role in array to', () => {
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', role: 'coder' },
				{ agentId: 'agent-reviewer-id', role: 'reviewer' },
			],
			channels: [{ from: 'coder', to: ['reviewer', 'ghost-role'], direction: 'one-way' }],
		});
		const errors = validateNodeChannels(node, allAgents);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('"ghost-role"');
	});

	test('reports error for agent not found in space agents list', () => {
		const node = makeNode({
			agents: [{ agentId: 'unknown-agent-id', role: 'coder' }],
			channels: [{ from: 'coder', to: 'reviewer', direction: 'one-way' }],
		});
		const errors = validateNodeChannels(node, allAgents);
		expect(errors.some((e) => e.includes('"unknown-agent-id"'))).toBe(true);
	});

	test('returns error from resolveNodeAgents when neither agentId nor agents provided', () => {
		const node = makeNode({
			channels: [{ from: 'coder', to: 'reviewer', direction: 'one-way' }],
		});
		const errors = validateNodeChannels(node, allAgents);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('neither agentId nor agents defined');
	});

	test('accumulates multiple errors', () => {
		const node = makeNode({
			agents: [{ agentId: 'agent-coder-id', role: 'coder' }],
			channels: [
				{ from: 'bad-from', to: 'bad-to', direction: 'one-way' },
				{ from: 'coder', to: 'another-bad', direction: 'one-way' },
			],
		});
		const errors = validateNodeChannels(node, allAgents);
		expect(errors.length).toBeGreaterThanOrEqual(3); // bad-from, bad-to, another-bad
	});

	test('reports error when two agent slots share the same role', () => {
		// Two slots with the same role — duplicate roles make channels ambiguous
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', role: 'reviewer' },
				{ agentId: 'agent-reviewer-id', role: 'reviewer' }, // duplicate role
			],
			channels: [{ from: 'coder', to: 'reviewer', direction: 'one-way' }],
		});
		const errors = validateNodeChannels(node, allAgents);
		expect(errors.some((e) => e.includes('Duplicate roles'))).toBe(true);
	});

	test('allows same agentId with different roles (no error)', () => {
		// Same agent used twice with different roles — this is now permitted
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', role: 'strict-reviewer' },
				{ agentId: 'agent-coder-id', role: 'quick-reviewer' },
			],
			channels: [{ from: 'strict-reviewer', to: 'quick-reviewer', direction: 'one-way' }],
		});
		const errors = validateNodeChannels(node, allAgents);
		expect(errors).toEqual([]);
	});

	test('reports error when * is mixed with other roles in array to', () => {
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', role: 'coder' },
				{ agentId: 'agent-reviewer-id', role: 'reviewer' },
			],
			channels: [{ from: 'coder', to: ['reviewer', '*'], direction: 'one-way' }],
		});
		const errors = validateNodeChannels(node, allAgents);
		expect(errors.some((e) => e.includes("mixes wildcard '*'"))).toBe(true);
	});

	test('plain * in to (not in array) is accepted', () => {
		const node = makeNode({
			agents: [
				{ agentId: 'agent-coder-id', role: 'coder' },
				{ agentId: 'agent-reviewer-id', role: 'reviewer' },
			],
			channels: [{ from: 'coder', to: '*', direction: 'one-way' }],
		});
		expect(validateNodeChannels(node, allAgents)).toEqual([]);
	});
});

// ============================================================================
// Backward compatibility
// ============================================================================

describe('backward compatibility (nodes with only agentId)', () => {
	test('resolveNodeAgents works for legacy single-agent nodes', () => {
		const node: WorkflowNode = {
			id: 'legacy-node',
			name: 'Legacy Node',
			agentId: 'agent-coder-id',
			instructions: 'do stuff',
		};
		const result = resolveNodeAgents(node);
		expect(result).toHaveLength(1);
		expect(result[0].agentId).toBe('agent-coder-id');
		expect(result[0].instructions).toBe('do stuff');
		// Synthetic role = agentId for legacy shorthand
		expect(result[0].role).toBe('agent-coder-id');
	});

	test('resolveNodeChannels returns [] for legacy nodes with no channels', () => {
		const node: WorkflowNode = {
			id: 'legacy-node',
			name: 'Legacy Node',
			agentId: 'agent-coder-id',
		};
		expect(resolveNodeChannels(node)).toEqual([]);
	});

	test('validateNodeChannels returns no errors for legacy nodes with no channels', () => {
		const node: WorkflowNode = {
			id: 'legacy-node',
			name: 'Legacy Node',
			agentId: 'agent-coder-id',
		};
		expect(validateNodeChannels(node, allAgents)).toEqual([]);
	});
});
