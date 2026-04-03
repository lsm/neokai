import type { SpaceWorkflow, WorkflowNodeAgent } from '@neokai/shared';

type BuiltInTemplateFixtureOptions = {
	includeSystemPrompts?: boolean;
};

function agent(
	agentId: string,
	name: string,
	prompt: string,
	includeSystemPrompts: boolean
): WorkflowNodeAgent {
	if (!includeSystemPrompts) {
		return { agentId, name };
	}
	return {
		agentId,
		name,
		systemPrompt: { mode: 'override', value: prompt },
	};
}

export function makeBuiltInTemplateWorkflows(
	options: BuiltInTemplateFixtureOptions = {}
): SpaceWorkflow[] {
	const includeSystemPrompts = options.includeSystemPrompts === true;

	return [
		{
			id: 'tpl-coding',
			spaceId: 'space-1',
			name: 'Coding Workflow',
			description: 'Coding desc',
			nodes: [
				{
					id: 'c1',
					name: 'Code',
					agents: [agent('agent-2', 'coder', 'Code.', includeSystemPrompts)],
				},
				{
					id: 'c2',
					name: 'Review',
					agents: [agent('agent-4', 'reviewer', 'Review.', includeSystemPrompts)],
				},
			],
			startNodeId: 'c1',
			endNodeId: 'c2',
			tags: [],
			createdAt: 0,
			updatedAt: 0,
		},
		{
			id: 'tpl-research',
			spaceId: 'space-1',
			name: 'Research Workflow',
			nodes: [
				{
					id: 'r1',
					name: 'Research',
					agents: [agent('agent-5', 'research', 'Research.', includeSystemPrompts)],
				},
				{
					id: 'r2',
					name: 'Review',
					agents: [agent('agent-4', 'reviewer', 'Review.', includeSystemPrompts)],
				},
			],
			startNodeId: 'r1',
			endNodeId: 'r2',
			tags: [],
			createdAt: 0,
			updatedAt: 0,
		},
		{
			id: 'tpl-review-only',
			spaceId: 'space-1',
			name: 'Review-Only Workflow',
			nodes: [
				{
					id: 'ro1',
					name: 'Review',
					agents: [agent('agent-4', 'reviewer', 'Review.', includeSystemPrompts)],
				},
			],
			startNodeId: 'ro1',
			endNodeId: 'ro1',
			tags: [],
			createdAt: 0,
			updatedAt: 0,
		},
		{
			id: 'tpl-full-cycle',
			spaceId: 'space-1',
			name: 'Full-Cycle Coding Workflow',
			nodes: [
				{
					id: 'f1',
					name: 'Planning',
					agents: [agent('agent-1', 'planner', 'Plan.', includeSystemPrompts)],
				},
				{
					id: 'f2',
					name: 'Plan Review',
					agents: [agent('agent-4', 'reviewer', 'Plan review.', includeSystemPrompts)],
				},
				{
					id: 'f3',
					name: 'Coding',
					agents: [agent('agent-2', 'coder', 'Code.', includeSystemPrompts)],
				},
				{
					id: 'f4',
					name: 'Code Review',
					agents: [
						agent('agent-4', 'Reviewer 1', 'Review 1.', includeSystemPrompts),
						agent('agent-4', 'Reviewer 2', 'Review 2.', includeSystemPrompts),
						agent('agent-4', 'Reviewer 3', 'Review 3.', includeSystemPrompts),
					],
				},
				{
					id: 'f5',
					name: 'QA',
					agents: [agent('agent-6', 'qa', 'QA.', includeSystemPrompts)],
				},
				{
					id: 'f6',
					name: 'Done',
					agents: [agent('agent-3', 'general', 'Done.', includeSystemPrompts)],
				},
			],
			startNodeId: 'f1',
			endNodeId: 'f6',
			tags: [],
			createdAt: 0,
			updatedAt: 0,
			channels: [
				{
					from: 'Planning',
					to: 'Plan Review',
					direction: 'one-way',
					gateId: 'plan-pr-gate',
					label: 'Planning → Plan Review',
				},
				{
					from: 'Plan Review',
					to: 'Coding',
					direction: 'one-way',
					gateId: 'plan-approval-gate',
					label: 'Plan Review → Coding',
				},
				{
					from: 'Coding',
					to: 'Code Review',
					direction: 'one-way',
					gateId: 'code-pr-gate',
					label: 'Coding → Code Review',
				},
				{
					from: 'Code Review',
					to: 'QA',
					direction: 'one-way',
					gateId: 'review-votes-gate',
					label: 'Code Review → QA',
				},
				{
					from: 'QA',
					to: 'Done',
					direction: 'one-way',
					gateId: 'qa-result-gate',
					label: 'QA → Done',
				},
				{
					from: 'QA',
					to: 'Coding',
					direction: 'one-way',
					gateId: 'qa-fail-gate',
					maxCycles: 5,
					label: 'QA → Coding (on fail)',
				},
				{
					from: 'Code Review',
					to: 'Coding',
					direction: 'one-way',
					gateId: 'review-reject-gate',
					maxCycles: 5,
					label: 'Code Review → Coding (on reject)',
				},
				{
					from: 'Plan Review',
					to: 'Planning',
					direction: 'one-way',
					maxCycles: 5,
					label: 'Plan Review → Planning (feedback)',
				},
				{
					from: 'Coding',
					to: 'Planning',
					direction: 'one-way',
					maxCycles: 5,
					label: 'Coding → Planning (feedback)',
				},
			],
			gates: [
				{
					id: 'plan-pr-gate',
					description: 'Planning submitted',
					fields: [
						{
							name: 'plan_submitted',
							type: 'boolean',
							writers: ['planner'],
							check: { op: 'exists' },
						},
					],
					resetOnCycle: false,
				},
				{
					id: 'plan-approval-gate',
					description: 'Plan approved',
					fields: [
						{
							name: 'approved',
							type: 'boolean',
							writers: ['reviewer'],
							check: { op: '==', value: true },
						},
					],
					resetOnCycle: true,
				},
				{
					id: 'code-pr-gate',
					description: 'PR URL captured',
					fields: [{ name: 'pr_url', type: 'string', writers: ['coder'], check: { op: 'exists' } }],
					resetOnCycle: false,
				},
				{
					id: 'review-votes-gate',
					description: 'All reviewers approved',
					fields: [
						{
							name: 'votes',
							type: 'map',
							writers: ['reviewer'],
							check: { op: 'count', match: 'approved', min: 3 },
						},
					],
					resetOnCycle: true,
				},
				{
					id: 'review-reject-gate',
					description: 'A reviewer rejected',
					fields: [
						{
							name: 'votes',
							type: 'map',
							writers: ['reviewer'],
							check: { op: 'count', match: 'rejected', min: 1 },
						},
					],
					resetOnCycle: true,
				},
				{
					id: 'qa-result-gate',
					description: 'QA passed',
					fields: [
						{
							name: 'result',
							type: 'string',
							writers: ['qa'],
							check: { op: '==', value: 'passed' },
						},
					],
					resetOnCycle: true,
				},
				{
					id: 'qa-fail-gate',
					description: 'QA failed',
					fields: [
						{
							name: 'result',
							type: 'string',
							writers: ['qa'],
							check: { op: '==', value: 'failed' },
						},
					],
					resetOnCycle: true,
				},
			],
		},
	];
}
