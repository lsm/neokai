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
				gateType: undefined,
				channelIndexes: [0, 1],
			},
		]);
	});

	it('ignores task-agent and intra-node channels for the semantic canvas graph', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'task-agent', to: 'Planning', direction: 'one-way' },
			{ from: 'Reviewer 1', to: 'Reviewer 2', direction: 'one-way' },
			{ from: 'Reviewer 1', to: 'QA', direction: 'one-way', gate: { type: 'condition', expression: 'true' } },
		];

		expect(buildSemanticWorkflowEdges(NODES, channels)).toEqual([
			{
				id: 'review:qa',
				fromStepId: 'review',
				toStepId: 'qa',
				direction: 'one-way',
				channelCount: 1,
				hasGate: true,
				gateType: 'condition',
				channelIndexes: [2],
			},
		]);
	});
});
