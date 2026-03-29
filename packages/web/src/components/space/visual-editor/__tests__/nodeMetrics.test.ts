import { describe, expect, it } from 'vitest';
import { TASK_AGENT_NODE_ID } from '@neokai/shared';
import {
	buildVisualNodePositions,
	getVisualNodeDimensions,
	MULTI_AGENT_NODE_HEIGHT,
	MULTI_AGENT_NODE_WIDTH,
	SINGLE_AGENT_NODE_HEIGHT,
	SINGLE_AGENT_NODE_WIDTH,
	TASK_AGENT_NODE_HEIGHT,
	TASK_AGENT_NODE_WIDTH,
} from '../nodeMetrics';

describe('nodeMetrics', () => {
	it('returns task-agent dimensions for the virtual task agent node', () => {
		expect(
			getVisualNodeDimensions({
				localId: TASK_AGENT_NODE_ID,
				id: TASK_AGENT_NODE_ID,
				name: 'Task Agent',
				agentId: '',
				instructions: '',
			})
		).toEqual({
			width: TASK_AGENT_NODE_WIDTH,
			height: TASK_AGENT_NODE_HEIGHT,
		});
	});

	it('returns multi-agent dimensions for multi-agent workflow nodes', () => {
		expect(
			getVisualNodeDimensions({
				localId: 'review',
				name: 'Code Review',
				agentId: '',
				instructions: '',
				agents: [
					{ agentId: 'a1', name: 'Reviewer 1' },
					{ agentId: 'a2', name: 'Reviewer 2' },
				],
			})
		).toEqual({
			width: MULTI_AGENT_NODE_WIDTH,
			height: MULTI_AGENT_NODE_HEIGHT,
		});
	});

	it('returns default dimensions for single-agent workflow nodes', () => {
		expect(
			getVisualNodeDimensions({
				localId: 'plan',
				name: 'Planning',
				agentId: 'planner',
				instructions: '',
			})
		).toEqual({
			width: SINGLE_AGENT_NODE_WIDTH,
			height: SINGLE_AGENT_NODE_HEIGHT,
		});
	});

	it('builds node positions for all visual nodes using their specific dimensions', () => {
		const positions = buildVisualNodePositions([
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
					localId: 'review',
					name: 'Code Review',
					agentId: '',
					instructions: '',
					agents: [
						{ agentId: 'a1', name: 'Reviewer 1' },
						{ agentId: 'a2', name: 'Reviewer 2' },
						{ agentId: 'a3', name: 'Reviewer 3' },
					],
				},
				position: { x: 100, y: 200 },
			},
		]);

		expect(positions[TASK_AGENT_NODE_ID]).toEqual({
			x: 50,
			y: 20,
			width: TASK_AGENT_NODE_WIDTH,
			height: TASK_AGENT_NODE_HEIGHT,
		});

		expect(positions.review).toEqual({
			x: 100,
			y: 200,
			width: MULTI_AGENT_NODE_WIDTH,
			height: MULTI_AGENT_NODE_HEIGHT,
		});
	});
});
