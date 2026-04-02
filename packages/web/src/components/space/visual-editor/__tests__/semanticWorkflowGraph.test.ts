import { describe, expect, it } from 'vitest';
import type { WorkflowChannel } from '@neokai/shared';
import { TASK_AGENT_NODE_ID } from '@neokai/shared';
import { buildSemanticWorkflowEdges } from '../semanticWorkflowGraph';
import type { VisualNode } from '../serialization';

const NODES: VisualNode[] = [
	{
		step: {
			localId: TASK_AGENT_NODE_ID,
			id: TASK_AGENT_NODE_ID,
			name: 'Task Agent',
			agentId: '',
			instructions: '',
		},
		position: { x: 50, y: 20 },
	},
	{
		step: {
			localId: 'plan',
			name: 'Planning',
			agentId: 'planner-id',
			instructions: '',
		},
		position: { x: 50, y: 170 },
	},
	{
		step: {
			localId: 'review',
			name: 'Code Review',
			agentId: '',
			instructions: '',
			agents: [
				{ agentId: 'reviewer-1-id', name: 'Reviewer 1' },
				{ agentId: 'reviewer-2-id', name: 'Reviewer 2' },
				{ agentId: 'reviewer-3-id', name: 'Reviewer 3' },
			],
		},
		position: { x: 50, y: 320 },
	},
	{
		step: {
			localId: 'qa',
			name: 'QA',
			agentId: 'qa-id',
			instructions: '',
		},
		position: { x: 50, y: 470 },
	},
];

describe('buildSemanticWorkflowEdges', () => {
	it('preserves a node-level channel between a single-agent node and a multi-agent node', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'Planning', to: 'Code Review', direction: 'one-way' },
		];

		expect(buildSemanticWorkflowEdges(NODES, channels)).toEqual([
			{
				id: 'plan:review',
				fromStepId: 'plan',
				toStepId: 'review',
				direction: 'one-way',
				channelCount: 1,
				hasGate: false,
				hasCyclic: false,
				gateType: undefined,
				channelIndexes: [0],
			},
		]);
	});

	it('collapses opposite directions into one bidirectional semantic edge', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'Planning', to: 'Reviewer 1', direction: 'one-way' },
			{ from: 'Reviewer 2', to: 'Planning', direction: 'one-way' },
		];

		expect(buildSemanticWorkflowEdges(NODES, channels)).toEqual([
			{
				id: 'plan:review',
				fromStepId: 'plan',
				toStepId: 'review',
				direction: 'bidirectional',
				channelCount: 2,
				hasGate: false,
				hasCyclic: false,
				gateType: undefined,
				channelIndexes: [0, 1],
			},
		]);
	});

	it('ignores task-agent and intra-node channels for the semantic canvas graph', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'task-agent', to: 'Planning', direction: 'one-way' },
			{ from: 'Reviewer 1', to: 'Reviewer 2', direction: 'one-way' },
			{ from: 'Reviewer 1', to: 'QA', direction: 'one-way', gateId: 'test-gate' },
		];

		const result = buildSemanticWorkflowEdges(NODES, channels);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('review:qa');
		expect(result[0].fromStepId).toBe('review');
		expect(result[0].toStepId).toBe('qa');
		expect(result[0].direction).toBe('one-way');
		expect(result[0].hasGate).toBe(true);
		// gateType is derived from the gate definition; when gate lookup has no data,
		// resolveSemanticGateType falls back to 'check'.
		expect(result[0].gateType).toBeTruthy();
	});

	it('tracks per-direction gate types for bidirectional edges', () => {
		// Two one-way channels going opposite directions, each with a gate.
		// plan→review (lowId→highId) has a gate; review→plan (highId→lowId) also has a gate.
		const channels: WorkflowChannel[] = [
			{ from: 'Planning', to: 'Reviewer 1', direction: 'one-way', gateId: 'gate-fwd' },
			{ from: 'Reviewer 2', to: 'Planning', direction: 'one-way', gateId: 'gate-rev' },
		];

		const result = buildSemanticWorkflowEdges(NODES, channels);
		expect(result).toHaveLength(1);
		expect(result[0].direction).toBe('bidirectional');
		expect(result[0].hasGate).toBe(true);
		// Forward gate (plan→review = lowId→highId)
		expect(result[0].gateType).toBeTruthy();
		// Reverse gate (review→plan = highId→lowId)
		expect(result[0].reverseGateType).toBeTruthy();
	});

	it('does not set reverseGateType when only the forward direction has a gate', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'Planning', to: 'Reviewer 1', direction: 'one-way', gateId: 'gate-fwd' },
			{ from: 'Reviewer 2', to: 'Planning', direction: 'one-way' },
		];

		const result = buildSemanticWorkflowEdges(NODES, channels);
		expect(result[0].direction).toBe('bidirectional');
		expect(result[0].gateType).toBeTruthy();
		expect(result[0].reverseGateType).toBeUndefined();
	});

	it('does not set gateType when only the reverse direction has a gate', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'Planning', to: 'Reviewer 1', direction: 'one-way' },
			{ from: 'Reviewer 2', to: 'Planning', direction: 'one-way', gateId: 'gate-rev' },
		];

		const result = buildSemanticWorkflowEdges(NODES, channels);
		expect(result[0].direction).toBe('bidirectional');
		expect(result[0].gateType).toBeUndefined();
		expect(result[0].reverseGateType).toBeTruthy();
	});

	it('a bidirectional underlying channel gates both directions', () => {
		const channels: WorkflowChannel[] = [
			{
				from: 'Planning',
				to: 'Reviewer 1',
				direction: 'bidirectional',
				gateId: 'gate-both',
			},
		];

		const result = buildSemanticWorkflowEdges(NODES, channels);
		expect(result[0].direction).toBe('bidirectional');
		expect(result[0].gateType).toBeTruthy();
		expect(result[0].reverseGateType).toBeTruthy();
	});
});
