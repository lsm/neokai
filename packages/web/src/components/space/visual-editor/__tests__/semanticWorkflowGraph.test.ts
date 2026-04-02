import type { Gate, WorkflowChannel } from '@neokai/shared';
import { TASK_AGENT_NODE_ID } from '@neokai/shared';
import { describe, expect, it } from 'vitest';
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

/** Helper: create a Gate with only fields (approved → human gate). */
function humanGate(id: string, overrides?: Partial<Gate>): Gate {
	return {
		id,
		resetOnCycle: false,
		fields: [
			{
				name: 'approved',
				type: 'boolean',
				writers: ['human'],
				check: { op: '==', value: true },
			},
		],
		...overrides,
	};
}

/** Helper: create a check gate with no label/color/script. */
function checkGate(id: string, overrides?: Partial<Gate>): Gate {
	return {
		id,
		resetOnCycle: false,
		...overrides,
	};
}

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
				gateLabel: undefined,
				gateColor: undefined,
				hasScript: undefined,
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
				gateLabel: undefined,
				gateColor: undefined,
				hasScript: undefined,
				reverseGateType: undefined,
				reverseGateLabel: undefined,
				reverseGateColor: undefined,
				reverseHasScript: undefined,
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
		const gates = [humanGate('gate-fwd'), humanGate('gate-rev')];

		const result = buildSemanticWorkflowEdges(NODES, channels, gates);
		expect(result).toHaveLength(1);
		expect(result[0].direction).toBe('bidirectional');
		expect(result[0].hasGate).toBe(true);
		// Forward gate (plan→review = lowId→highId)
		expect(result[0].gateType).toBe('human');
		// Reverse gate (review→plan = highId→lowId)
		expect(result[0].reverseGateType).toBe('human');
	});

	it('does not set reverseGateType when only the forward direction has a gate', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'Planning', to: 'Reviewer 1', direction: 'one-way', gateId: 'gate-fwd' },
			{ from: 'Reviewer 2', to: 'Planning', direction: 'one-way' },
		];
		const gates = [humanGate('gate-fwd')];

		const result = buildSemanticWorkflowEdges(NODES, channels, gates);
		expect(result[0].direction).toBe('bidirectional');
		expect(result[0].gateType).toBe('human');
		expect(result[0].reverseGateType).toBeUndefined();
	});

	it('does not set gateType when only the reverse direction has a gate', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'Planning', to: 'Reviewer 1', direction: 'one-way' },
			{ from: 'Reviewer 2', to: 'Planning', direction: 'one-way', gateId: 'gate-rev' },
		];
		const gates = [humanGate('gate-rev')];

		const result = buildSemanticWorkflowEdges(NODES, channels, gates);
		expect(result[0].direction).toBe('bidirectional');
		expect(result[0].gateType).toBeUndefined();
		expect(result[0].reverseGateType).toBe('human');
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
		const gates = [humanGate('gate-both')];

		const result = buildSemanticWorkflowEdges(NODES, channels, gates);
		expect(result[0].direction).toBe('bidirectional');
		expect(result[0].gateType).toBe('human');
		expect(result[0].reverseGateType).toBe('human');
	});
});

describe('gate label/color/hasScript propagation', () => {
	it('propagates gate label and color for a one-way edge', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'Planning', to: 'Code Review', direction: 'one-way', gateId: 'g1' },
		];
		const gates = [
			humanGate('g1', {
				label: 'Team Lead',
				color: '#ff5500',
			}),
		];

		const result = buildSemanticWorkflowEdges(NODES, channels, gates);
		expect(result[0]).toMatchObject({
			gateType: 'human',
			gateLabel: 'Team Lead',
			gateColor: '#ff5500',
			hasScript: undefined,
		});
	});

	it('propagates hasScript when gate has a script', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'Planning', to: 'Code Review', direction: 'one-way', gateId: 'g1' },
		];
		const gates = [
			checkGate('g1', {
				script: { interpreter: 'bash', source: 'exit 0' },
			}),
		];

		const result = buildSemanticWorkflowEdges(NODES, channels, gates);
		expect(result[0]).toMatchObject({
			gateType: 'check',
			hasScript: true,
		});
	});

	it('returns undefined for label/color when gate has neither', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'Planning', to: 'Code Review', direction: 'one-way', gateId: 'g1' },
		];
		const gates = [humanGate('g1')];

		const result = buildSemanticWorkflowEdges(NODES, channels, gates);
		expect(result[0].gateLabel).toBeUndefined();
		expect(result[0].gateColor).toBeUndefined();
		expect(result[0].hasScript).toBeUndefined();
	});

	it('returns undefined for label/color/hasScript when gate is missing from lookup', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'Planning', to: 'Code Review', direction: 'one-way', gateId: 'missing-gate' },
		];

		const result = buildSemanticWorkflowEdges(NODES, channels);
		expect(result[0]).toMatchObject({
			gateType: 'check',
			gateLabel: undefined,
			gateColor: undefined,
			hasScript: undefined,
		});
	});

	it('returns undefined for label/color/hasScript when channel has no gateId', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'Planning', to: 'Code Review', direction: 'one-way' },
		];

		const result = buildSemanticWorkflowEdges(NODES, channels);
		expect(result[0]).toMatchObject({
			gateType: undefined,
			gateLabel: undefined,
			gateColor: undefined,
			hasScript: undefined,
		});
	});

	it('propagates label/color/hasScript for bidirectional edges per direction', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'Planning', to: 'Reviewer 1', direction: 'one-way', gateId: 'gate-fwd' },
			{ from: 'Reviewer 2', to: 'Planning', direction: 'one-way', gateId: 'gate-rev' },
		];
		const gates = [
			humanGate('gate-fwd', {
				label: 'Forward',
				color: '#00ff00',
				script: { interpreter: 'bash', source: 'echo ok' },
			}),
			humanGate('gate-rev', {
				label: 'Reverse',
				color: '#ff0000',
			}),
		];

		const result = buildSemanticWorkflowEdges(NODES, channels, gates);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			gateType: 'human',
			gateLabel: 'Forward',
			gateColor: '#00ff00',
			hasScript: true,
			reverseGateType: 'human',
			reverseGateLabel: 'Reverse',
			reverseGateColor: '#ff0000',
			reverseHasScript: undefined,
		});
	});

	it('propagates label/color/hasScript for a bidirectional underlying channel to both directions', () => {
		const channels: WorkflowChannel[] = [
			{
				from: 'Planning',
				to: 'Reviewer 1',
				direction: 'bidirectional',
				gateId: 'gate-both',
			},
		];
		const gates = [
			humanGate('gate-both', {
				label: 'Both Ways',
				color: '#123456',
				script: { interpreter: 'python3', source: 'print("ok")' },
			}),
		];

		const result = buildSemanticWorkflowEdges(NODES, channels, gates);
		expect(result[0]).toMatchObject({
			direction: 'bidirectional',
			gateType: 'human',
			gateLabel: 'Both Ways',
			gateColor: '#123456',
			hasScript: true,
			reverseGateType: 'human',
			reverseGateLabel: 'Both Ways',
			reverseGateColor: '#123456',
			reverseHasScript: true,
		});
	});

	it('tracks label/color/hasScript only for forward direction when only forward has a gate', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'Planning', to: 'Reviewer 1', direction: 'one-way', gateId: 'gate-fwd' },
			{ from: 'Reviewer 2', to: 'Planning', direction: 'one-way' },
		];
		const gates = [
			checkGate('gate-fwd', {
				label: 'Fwd Only',
				color: '#abcdef',
			}),
		];

		const result = buildSemanticWorkflowEdges(NODES, channels, gates);
		expect(result[0]).toMatchObject({
			direction: 'bidirectional',
			gateType: 'check',
			gateLabel: 'Fwd Only',
			gateColor: '#abcdef',
			reverseGateType: undefined,
			reverseGateLabel: undefined,
			reverseGateColor: undefined,
			reverseHasScript: undefined,
		});
	});

	it('tracks label/color/hasScript only for reverse direction when only reverse has a gate', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'Planning', to: 'Reviewer 1', direction: 'one-way' },
			{ from: 'Reviewer 2', to: 'Planning', direction: 'one-way', gateId: 'gate-rev' },
		];
		const gates = [
			checkGate('gate-rev', {
				label: 'Rev Only',
				color: '#fedcba',
				script: { interpreter: 'bash', source: 'true' },
			}),
		];

		const result = buildSemanticWorkflowEdges(NODES, channels, gates);
		expect(result[0]).toMatchObject({
			direction: 'bidirectional',
			gateType: undefined,
			gateLabel: undefined,
			gateColor: undefined,
			hasScript: undefined,
			reverseGateType: 'check',
			reverseGateLabel: 'Rev Only',
			reverseGateColor: '#fedcba',
			reverseHasScript: true,
		});
	});

	it('propagates label/color/hasScript for a one-way highToLow edge', () => {
		// review→plan direction (highId→lowId) for a one-way edge
		const channels: WorkflowChannel[] = [
			{ from: 'Reviewer 1', to: 'Planning', direction: 'one-way', gateId: 'gate-rev' },
		];
		const gates = [
			checkGate('gate-rev', {
				label: 'HighToLow',
				color: '#aabbcc',
				script: { interpreter: 'node', source: 'process.exit(0)' },
			}),
		];

		const result = buildSemanticWorkflowEdges(NODES, channels, gates);
		expect(result[0]).toMatchObject({
			direction: 'one-way',
			fromStepId: 'review',
			toStepId: 'plan',
			gateType: 'check',
			gateLabel: 'HighToLow',
			gateColor: '#aabbcc',
			hasScript: true,
		});
	});

	it('gates with label but no color propagate label and undefined color', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'Planning', to: 'Code Review', direction: 'one-way', gateId: 'g1' },
		];
		const gates = [
			humanGate('g1', {
				label: 'Label Only',
			}),
		];

		const result = buildSemanticWorkflowEdges(NODES, channels, gates);
		expect(result[0]).toMatchObject({
			gateLabel: 'Label Only',
			gateColor: undefined,
		});
	});

	it('gates with color but no label propagate color and undefined label', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'Planning', to: 'Code Review', direction: 'one-way', gateId: 'g1' },
		];
		const gates = [
			humanGate('g1', {
				color: '#998877',
			}),
		];

		const result = buildSemanticWorkflowEdges(NODES, channels, gates);
		expect(result[0]).toMatchObject({
			gateLabel: undefined,
			gateColor: '#998877',
		});
	});
});
