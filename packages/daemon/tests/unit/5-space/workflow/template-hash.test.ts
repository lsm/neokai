/**
 * Unit tests for template-hash utility.
 *
 * Verifies that:
 * - buildWorkflowFingerprint produces deterministic, order-independent output
 * - computeWorkflowHash returns a stable hex string for identical workflows
 * - workflowsMatchFingerprint returns true/false correctly
 * - Layout coordinates and agent UUIDs do NOT affect the hash
 */

import { describe, it, expect } from 'bun:test';
import {
	buildWorkflowFingerprint,
	computeWorkflowHash,
	workflowsMatchFingerprint,
} from '../../../../src/lib/space/workflows/template-hash';
import type { SpaceWorkflow } from '@neokai/shared';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
	return {
		id: 'wf-1',
		spaceId: 'space-1',
		name: 'Test Workflow',
		description: 'A test workflow',
		instructions: 'Do the thing',
		nodes: [
			{ id: 'n1', name: 'Coder', agents: [{ agentId: 'agent-uuid-1', name: 'Coder' }] },
			{ id: 'n2', name: 'Reviewer', agents: [{ agentId: 'agent-uuid-2', name: 'Reviewer' }] },
		],
		channels: [
			{ id: 'ch1', from: 'Coder', to: 'Reviewer' },
			{ id: 'ch2', from: 'Reviewer', to: 'Coder' },
		],
		gates: [
			{
				id: 'gate-1',
				description: 'PR review gate',
				resetOnCycle: false,
			},
		],
		tags: [],
		startNodeId: 'n1',
		endNodeId: 'n2',
		createdAt: 1000,
		updatedAt: 2000,
		completionAutonomyLevel: 3,
		...overrides,
	};
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('buildWorkflowFingerprint', () => {
	it('returns sorted node names', () => {
		const wf = makeWorkflow({
			nodes: [
				{ id: 'n2', name: 'Reviewer', agents: [{ agentId: 'a2', name: 'Reviewer' }] },
				{ id: 'n1', name: 'Coder', agents: [{ agentId: 'a1', name: 'Coder' }] },
			],
		});
		const fp = buildWorkflowFingerprint(wf);
		expect(fp.nodeNames).toEqual(['Coder', 'Reviewer']);
	});

	it('returns sorted channel topology strings', () => {
		const wf = makeWorkflow({
			channels: [
				{ id: 'ch2', from: 'Reviewer', to: 'Coder' },
				{ id: 'ch1', from: 'Coder', to: 'Reviewer' },
			],
		});
		const fp = buildWorkflowFingerprint(wf);
		expect(fp.channels).toEqual(['Coder->Reviewer', 'Reviewer->Coder']);
	});

	it('sorts fan-out targets within a channel', () => {
		const wf = makeWorkflow({
			channels: [{ id: 'ch1', from: 'Coder', to: ['QA', 'Reviewer'] }],
		});
		const fp = buildWorkflowFingerprint(wf);
		// Both orderings of to should produce the same string
		const wf2 = makeWorkflow({
			channels: [{ id: 'ch1', from: 'Coder', to: ['Reviewer', 'QA'] }],
		});
		const fp2 = buildWorkflowFingerprint(wf2);
		expect(fp.channels).toEqual(fp2.channels);
		expect(fp.channels[0]).toBe('Coder->QA,Reviewer');
	});

	it('returns sorted gate serializations', () => {
		const wf = makeWorkflow({
			gates: [
				{ id: 'gate-z', resetOnCycle: false },
				{ id: 'gate-a', resetOnCycle: false },
			],
		});
		const fp = buildWorkflowFingerprint(wf);
		// Both gates serialized in sorted order by their id prefix
		expect(fp.gates).toHaveLength(2);
		expect(fp.gates[0]).toMatch(/^gate-a\|/);
		expect(fp.gates[1]).toMatch(/^gate-z\|/);
	});

	it('uses empty string for missing description/instructions', () => {
		const wf = makeWorkflow({ description: undefined, instructions: undefined });
		const fp = buildWorkflowFingerprint(wf);
		expect(fp.description).toBe('');
		expect(fp.instructions).toBe('');
	});

	it('treats empty channels and gates as empty arrays', () => {
		const wf = makeWorkflow({ channels: undefined, gates: undefined });
		const fp = buildWorkflowFingerprint(wf);
		expect(fp.channels).toEqual([]);
		expect(fp.gates).toEqual([]);
	});

	it('includes sorted nodePrompts for each node-agent pair', () => {
		const wf = makeWorkflow({
			nodes: [
				{
					id: 'n1',
					name: 'Coder',
					agents: [
						{
							agentId: 'a1',
							name: 'coder',
							customPrompt: { value: 'Write clean code' },
						},
					],
				},
				{
					id: 'n2',
					name: 'Reviewer',
					agents: [{ agentId: 'a2', name: 'reviewer' }],
				},
			],
		});
		const fp = buildWorkflowFingerprint(wf);
		expect(fp.nodePrompts).toHaveLength(2);
		expect(fp.nodePrompts[0]).toBe('Coder|coder|Write clean code');
		expect(fp.nodePrompts[1]).toBe('Reviewer|reviewer|');
	});

	it('uses empty string for missing customPrompt in nodePrompts', () => {
		const wf = makeWorkflow({
			nodes: [{ id: 'n1', name: 'Coder', agents: [{ agentId: 'a1', name: 'coder' }] }],
		});
		const fp = buildWorkflowFingerprint(wf);
		expect(fp.nodePrompts[0]).toBe('Coder|coder|');
	});

	it('returns sorted completionActions for each node action', () => {
		const wf = makeWorkflow({
			nodes: [
				{
					id: 'n1',
					name: 'Coder',
					agents: [{ agentId: 'a1', name: 'coder' }],
					completionActions: [
						{
							id: 'merge-pr',
							name: 'Merge PR',
							type: 'script',
							requiredLevel: 4,
							script: 'gh pr merge',
						},
					],
				},
			],
		});
		const fp = buildWorkflowFingerprint(wf);
		expect(fp.completionActions).toHaveLength(1);
		expect(fp.completionActions[0]).toBe('Coder|merge-pr|script|4|gh pr merge');
	});

	it('returns empty completionActions when no node has completion actions', () => {
		const wf = makeWorkflow();
		const fp = buildWorkflowFingerprint(wf);
		expect(fp.completionActions).toEqual([]);
	});

	it('includes completionAutonomyLevel in fingerprint', () => {
		const wf = makeWorkflow({ completionAutonomyLevel: 5 });
		const fp = buildWorkflowFingerprint(wf);
		expect(fp.completionAutonomyLevel).toBe(5);
	});

	it('serializes gate fields with name, type, and check op', () => {
		const wf = makeWorkflow({
			gates: [
				{
					id: 'gate-1',
					resetOnCycle: false,
					fields: [{ name: 'approved', type: 'boolean', writers: [], check: { op: 'exists' } }],
				},
			],
		});
		const fp = buildWorkflowFingerprint(wf);
		expect(fp.gates[0]).toContain('approved:boolean:exists');
	});

	it('includes requiredLevel in gate serialization', () => {
		const wf = makeWorkflow({
			gates: [{ id: 'gate-1', resetOnCycle: false, requiredLevel: 3 }],
		});
		const fp = buildWorkflowFingerprint(wf);
		expect(fp.gates[0]).toMatch(/^gate-1\|3\|/);
	});

	it('includes resetOnCycle in gate serialization', () => {
		const wfFalse = makeWorkflow({
			gates: [{ id: 'gate-1', resetOnCycle: false }],
		});
		const wfTrue = makeWorkflow({
			gates: [{ id: 'gate-1', resetOnCycle: true }],
		});
		expect(buildWorkflowFingerprint(wfFalse).gates[0]).toContain('|false|');
		expect(buildWorkflowFingerprint(wfTrue).gates[0]).toContain('|true|');
	});
});

describe('computeWorkflowHash', () => {
	it('returns a 64-character hex string (SHA-256)', () => {
		const hash = computeWorkflowHash(makeWorkflow());
		expect(hash).toHaveLength(64);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('is deterministic for the same workflow', () => {
		const wf = makeWorkflow();
		expect(computeWorkflowHash(wf)).toBe(computeWorkflowHash(wf));
	});

	it('is stable regardless of node insertion order', () => {
		const wf1 = makeWorkflow({
			nodes: [
				{ id: 'n1', name: 'Coder', agents: [{ agentId: 'a1', name: 'Coder' }] },
				{ id: 'n2', name: 'Reviewer', agents: [{ agentId: 'a2', name: 'Reviewer' }] },
			],
		});
		const wf2 = makeWorkflow({
			nodes: [
				{ id: 'n2', name: 'Reviewer', agents: [{ agentId: 'a2', name: 'Reviewer' }] },
				{ id: 'n1', name: 'Coder', agents: [{ agentId: 'a1', name: 'Coder' }] },
			],
		});
		expect(computeWorkflowHash(wf1)).toBe(computeWorkflowHash(wf2));
	});

	it('does NOT change when agent UUIDs differ', () => {
		const wf1 = makeWorkflow({
			nodes: [{ id: 'n1', name: 'Coder', agents: [{ agentId: 'uuid-aaa', name: 'Coder' }] }],
		});
		const wf2 = makeWorkflow({
			nodes: [{ id: 'n1', name: 'Coder', agents: [{ agentId: 'uuid-bbb', name: 'Coder' }] }],
		});
		expect(computeWorkflowHash(wf1)).toBe(computeWorkflowHash(wf2));
	});

	it('does NOT change when layout coordinates differ', () => {
		const wf1 = makeWorkflow({ layout: { n1: { x: 0, y: 0 } } });
		const wf2 = makeWorkflow({ layout: { n1: { x: 999, y: 999 } } });
		expect(computeWorkflowHash(wf1)).toBe(computeWorkflowHash(wf2));
	});

	it('DOES change when a node name changes', () => {
		const wf1 = makeWorkflow({
			nodes: [{ id: 'n1', name: 'Coder', agents: [{ agentId: 'a1', name: 'Coder' }] }],
		});
		const wf2 = makeWorkflow({
			nodes: [{ id: 'n1', name: 'Developer', agents: [{ agentId: 'a1', name: 'Developer' }] }],
		});
		expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
	});

	it('DOES change when description changes', () => {
		const wf1 = makeWorkflow({ description: 'Original description' });
		const wf2 = makeWorkflow({ description: 'Changed description' });
		expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
	});

	it('DOES change when instructions change', () => {
		const wf1 = makeWorkflow({ instructions: 'Original instructions' });
		const wf2 = makeWorkflow({ instructions: 'Changed instructions' });
		expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
	});

	it('DOES change when channel topology changes', () => {
		const wf1 = makeWorkflow({ channels: [{ id: 'c1', from: 'Coder', to: 'Reviewer' }] });
		const wf2 = makeWorkflow({ channels: [{ id: 'c1', from: 'Reviewer', to: 'Coder' }] });
		expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
	});

	it('DOES change when a gate field is added', () => {
		const wf1 = makeWorkflow({
			gates: [{ id: 'gate-1', resetOnCycle: false, fields: [] }],
		});
		const wf2 = makeWorkflow({
			gates: [
				{
					id: 'gate-1',
					resetOnCycle: false,
					fields: [{ name: 'approved', type: 'boolean', writers: [], check: { op: 'exists' } }],
				},
			],
		});
		expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
	});

	it('DOES change when a gate field check op changes', () => {
		const wf1 = makeWorkflow({
			gates: [
				{
					id: 'gate-1',
					resetOnCycle: false,
					fields: [{ name: 'approved', type: 'boolean', writers: [], check: { op: 'exists' } }],
				},
			],
		});
		const wf2 = makeWorkflow({
			gates: [
				{
					id: 'gate-1',
					resetOnCycle: false,
					fields: [
						{
							name: 'approved',
							type: 'boolean',
							writers: [],
							check: { op: '==', value: true },
						},
					],
				},
			],
		});
		expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
	});

	it('DOES change when gate requiredLevel changes', () => {
		const wf1 = makeWorkflow({
			gates: [{ id: 'gate-1', resetOnCycle: false, requiredLevel: 3 }],
		});
		const wf2 = makeWorkflow({
			gates: [{ id: 'gate-1', resetOnCycle: false, requiredLevel: 4 }],
		});
		expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
	});

	it('DOES change when gate resetOnCycle changes', () => {
		const wf1 = makeWorkflow({
			gates: [{ id: 'gate-1', resetOnCycle: false }],
		});
		const wf2 = makeWorkflow({
			gates: [{ id: 'gate-1', resetOnCycle: true }],
		});
		expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
	});

	it('DOES change when gate script changes', () => {
		const wf1 = makeWorkflow({
			gates: [
				{
					id: 'gate-1',
					resetOnCycle: false,
					script: { interpreter: 'bash', source: 'echo "check A"' },
				},
			],
		});
		const wf2 = makeWorkflow({
			gates: [
				{
					id: 'gate-1',
					resetOnCycle: false,
					script: { interpreter: 'bash', source: 'echo "check B"' },
				},
			],
		});
		expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
	});

	it('DOES change when gate script is added', () => {
		const wf1 = makeWorkflow({
			gates: [{ id: 'gate-1', resetOnCycle: false }],
		});
		const wf2 = makeWorkflow({
			gates: [
				{
					id: 'gate-1',
					resetOnCycle: false,
					script: { interpreter: 'bash', source: 'gh pr view --json mergeable' },
				},
			],
		});
		expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
	});

	it('DOES change when a node agent customPrompt changes', () => {
		const wf1 = makeWorkflow({
			nodes: [
				{
					id: 'n1',
					name: 'Coder',
					agents: [{ agentId: 'a1', name: 'coder', customPrompt: { value: 'Old prompt' } }],
				},
			],
		});
		const wf2 = makeWorkflow({
			nodes: [
				{
					id: 'n1',
					name: 'Coder',
					agents: [{ agentId: 'a1', name: 'coder', customPrompt: { value: 'New prompt' } }],
				},
			],
		});
		expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
	});

	it('DOES change when a node agent customPrompt is added', () => {
		const wf1 = makeWorkflow({
			nodes: [{ id: 'n1', name: 'Coder', agents: [{ agentId: 'a1', name: 'coder' }] }],
		});
		const wf2 = makeWorkflow({
			nodes: [
				{
					id: 'n1',
					name: 'Coder',
					agents: [{ agentId: 'a1', name: 'coder', customPrompt: { value: 'New prompt' } }],
				},
			],
		});
		expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
	});

	it('DOES change when a node completionAction is added', () => {
		const wf1 = makeWorkflow({
			nodes: [{ id: 'n1', name: 'Coder', agents: [{ agentId: 'a1', name: 'coder' }] }],
		});
		const wf2 = makeWorkflow({
			nodes: [
				{
					id: 'n1',
					name: 'Coder',
					agents: [{ agentId: 'a1', name: 'coder' }],
					completionActions: [
						{
							id: 'merge-pr',
							name: 'Merge PR',
							type: 'script',
							requiredLevel: 4,
							script: 'gh pr merge',
						},
					],
				},
			],
		});
		expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
	});

	it('DOES change when a node completionAction script changes', () => {
		const base = {
			id: 'n1',
			name: 'Coder',
			agents: [{ agentId: 'a1', name: 'coder' }],
		};
		const wf1 = makeWorkflow({
			nodes: [
				{
					...base,
					completionActions: [
						{
							id: 'merge-pr',
							name: 'Merge PR',
							type: 'script' as const,
							requiredLevel: 4 as const,
							script: 'gh pr merge --squash',
						},
					],
				},
			],
		});
		const wf2 = makeWorkflow({
			nodes: [
				{
					...base,
					completionActions: [
						{
							id: 'merge-pr',
							name: 'Merge PR',
							type: 'script' as const,
							requiredLevel: 4 as const,
							script: 'gh pr merge --merge',
						},
					],
				},
			],
		});
		expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
	});

	it('DOES change when completionAutonomyLevel changes', () => {
		const wf1 = makeWorkflow({ completionAutonomyLevel: 3 });
		const wf2 = makeWorkflow({ completionAutonomyLevel: 4 });
		expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
	});

	it('does NOT change when tags differ', () => {
		const wf1 = makeWorkflow({ tags: ['coding'] });
		const wf2 = makeWorkflow({ tags: ['coding', 'default'] });
		expect(computeWorkflowHash(wf1)).toBe(computeWorkflowHash(wf2));
	});
});

describe('workflowsMatchFingerprint', () => {
	it('returns true for structurally identical workflows', () => {
		const wf1 = makeWorkflow();
		const wf2 = makeWorkflow({ id: 'wf-different-id', layout: { n1: { x: 42, y: 42 } } });
		expect(workflowsMatchFingerprint(wf1, wf2)).toBe(true);
	});

	it('returns false when node structure differs', () => {
		const wf1 = makeWorkflow({
			nodes: [{ id: 'n1', name: 'Coder', agents: [{ agentId: 'a1', name: 'Coder' }] }],
		});
		const wf2 = makeWorkflow({
			nodes: [
				{ id: 'n1', name: 'Coder', agents: [{ agentId: 'a1', name: 'Coder' }] },
				{ id: 'n2', name: 'Reviewer', agents: [{ agentId: 'a2', name: 'Reviewer' }] },
			],
		});
		expect(workflowsMatchFingerprint(wf1, wf2)).toBe(false);
	});
});
