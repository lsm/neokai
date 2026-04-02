/**
 * Unit tests for buildTaskAgentSystemPrompt() and buildTaskAgentInitialMessage()
 *
 * Verifies:
 * - System prompt includes role, tools, execution instructions, rules, task context
 * - Initial message includes task details, workflow structure, agents, previous results
 * - Edge cases: no workflow, no agents, no previous tasks, minimal context
 */

import { describe, test, expect } from 'bun:test';
import {
	buildTaskAgentSystemPrompt,
	buildTaskAgentInitialMessage,
	type TaskAgentContext,
	type PreviousTaskSummary,
} from '../../../src/lib/space/agents/task-agent';
import type {
	SpaceTask,
	SpaceWorkflow,
	SpaceWorkflowRun,
	Space,
	SpaceAgent,
	WorkflowChannel,
} from '@neokai/shared';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSpace(overrides?: Partial<Space>): Space {
	return {
		id: 'space-1',
		workspacePath: '/workspace',
		name: 'Test Space',
		description: 'A test space',
		backgroundContext: 'This is a TypeScript monorepo.',
		instructions: 'Always open PRs against dev.',
		sessionIds: [],
		status: 'active',
		createdAt: 1000,
		updatedAt: 2000,
		...overrides,
	};
}

function makeTask(overrides?: Partial<SpaceTask>): SpaceTask {
	return {
		id: 'task-1',
		spaceId: 'space-1',
		taskNumber: 1,
		title: 'Implement feature X',
		description: 'Add the X feature to the codebase with tests.',
		status: 'in_progress',
		priority: 'high',
		dependsOn: [],
		createdAt: 1000,
		updatedAt: 2000,
		...overrides,
	};
}

function makeAgent(overrides?: Partial<SpaceAgent>): SpaceAgent {
	return {
		id: 'agent-1',
		spaceId: 'space-1',
		name: 'Coder',
		instructions: null,
		description: 'Implementation specialist',
		createdAt: 1000,
		updatedAt: 2000,
		...overrides,
	};
}

function makeWorkflow(overrides?: Partial<SpaceWorkflow>): SpaceWorkflow {
	return {
		id: 'wf-1',
		spaceId: 'space-1',
		name: 'Feature Workflow',
		description: 'Plan, code, and review.',
		nodes: [
			{ id: 'step-plan', name: 'Plan', agents: [{ agentId: 'agent-planner', name: 'Planner' }] },
			{
				id: 'step-code',
				name: 'Code',
				agents: [{ agentId: 'agent-1', name: 'Coder' }],
				instructions: 'Write tests too.',
			},
			{
				id: 'step-review',
				name: 'Review',
				agents: [{ agentId: 'agent-reviewer', name: 'Reviewer' }],
			},
		],
		startNodeId: 'step-plan',
		isDefault: false,
		tags: ['feature', 'review'],
		createdAt: 1000,
		updatedAt: 2000,
		...overrides,
	};
}

function makeWorkflowRun(overrides?: Partial<SpaceWorkflowRun>): SpaceWorkflowRun {
	return {
		id: 'run-1',
		spaceId: 'space-1',
		workflowId: 'wf-1',
		title: 'Feature X Run #1',
		status: 'in_progress',
		startedAt: null,
		completedAt: null,
		createdAt: 1000,
		updatedAt: 2000,
		...overrides,
	};
}

function makeContext(overrides?: Partial<TaskAgentContext>): TaskAgentContext {
	return {
		task: makeTask(),
		workflow: makeWorkflow(),
		workflowRun: makeWorkflowRun(),
		space: makeSpace(),
		availableAgents: [
			makeAgent(),
			makeAgent({ id: 'agent-planner', name: 'Planner' }),
			makeAgent({ id: 'agent-reviewer', name: 'Reviewer' }),
		],
		previousTaskSummaries: [
			{
				taskId: 'task-0',
				title: 'Setup environment',
				status: 'done',
				result: 'Environment is ready.',
			},
		],
		...overrides,
	};
}

// ===========================================================================
// buildTaskAgentSystemPrompt()
// ===========================================================================

describe('buildTaskAgentSystemPrompt — basic structure', () => {
	test('returns a non-empty string', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(typeof prompt).toBe('string');
		expect(prompt.length).toBeGreaterThan(0);
	});

	test('identifies agent as Task Agent collaboration manager', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('Task Agent');
		expect(prompt).toContain('collaboration manager');
	});

	test('does not throw on minimal context (no workflow, no agents, no previous tasks)', () => {
		const ctx: TaskAgentContext = {
			task: makeTask(),
			space: makeSpace({ backgroundContext: '', instructions: '' }),
			availableAgents: [],
		};
		expect(() => buildTaskAgentSystemPrompt(ctx)).not.toThrow();
	});
});

describe('buildTaskAgentSystemPrompt — MCP tools', () => {
	test('includes spawn_node_agent tool', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('spawn_node_agent');
	});

	test('includes check_node_status tool', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('check_node_status');
	});

	test('includes report_result tool', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('report_result');
	});

	test('includes request_human_input tool', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('request_human_input');
	});
});

describe('buildTaskAgentSystemPrompt — workflow execution instructions', () => {
	test('mentions spawning node agents', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('spawn_node_agent');
	});

	test('mentions monitoring completion via check_node_status', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('check_node_status');
	});

	test('includes instructions to call report_result on terminal step', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('report_result');
	});
});

describe('buildTaskAgentSystemPrompt — human gate handling', () => {
	test('includes human gate section', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('Human Gate');
	});

	test('instructs to call request_human_input', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('request_human_input');
	});

	test('instructs never to bypass a human gate', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('Never bypass a human gate');
	});
});

describe('buildTaskAgentSystemPrompt — result handling', () => {
	test('uses cancelled instead of failed for error handling in Workflow Execution Instructions', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('cancelled');
		// Should not contain the stale "failed" status
		expect(prompt).not.toMatch(/status: "failed"/);
	});
});

describe('buildTaskAgentSystemPrompt — behavioral rules', () => {
	test('includes no direct code execution rule', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('Do not execute code directly');
	});

	test('includes no bypass human gates rule', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('bypass human gates');
	});

	test('includes no architectural decisions rule', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('architectural decisions');
	});
});

describe('buildTaskAgentSystemPrompt — task context', () => {
	test('includes task title', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('Implement feature X');
	});

	test('includes task priority', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('high');
	});

	test('includes task description', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('Add the X feature to the codebase with tests.');
	});

	test('includes task dependencies when present', () => {
		const ctx = makeContext({
			task: makeTask({ dependsOn: ['task-dep-1', 'task-dep-2'] }),
		});
		const prompt = buildTaskAgentSystemPrompt(ctx);
		expect(prompt).toContain('task-dep-1');
		expect(prompt).toContain('task-dep-2');
	});

	test('omits dependencies section when empty', () => {
		const ctx = makeContext({ task: makeTask({ dependsOn: [] }) });
		const prompt = buildTaskAgentSystemPrompt(ctx);
		expect(prompt).not.toContain('Dependencies:');
	});
});

describe('buildTaskAgentSystemPrompt — space context', () => {
	test('includes space background context when provided', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('This is a TypeScript monorepo.');
	});

	test('includes space instructions when provided', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('Always open PRs against dev.');
	});

	test('omits background section when empty', () => {
		const ctx = makeContext({
			space: makeSpace({ backgroundContext: '', instructions: '' }),
		});
		const prompt = buildTaskAgentSystemPrompt(ctx);
		expect(prompt).not.toContain('Space Background');
		expect(prompt).not.toContain('Space Instructions');
	});
});

// ===========================================================================
// buildTaskAgentInitialMessage()
// ===========================================================================

describe('buildTaskAgentInitialMessage — basic structure', () => {
	test('returns a non-empty string', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(typeof msg).toBe('string');
		expect(msg.length).toBeGreaterThan(0);
	});

	test('does not throw on minimal context', () => {
		const ctx: TaskAgentContext = {
			task: makeTask(),
			space: makeSpace(),
			availableAgents: [],
		};
		expect(() => buildTaskAgentInitialMessage(ctx)).not.toThrow();
	});
});

describe('buildTaskAgentInitialMessage — task details', () => {
	test('includes task title', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('Implement feature X');
	});

	test('includes task priority', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('high');
	});

	test('includes task status', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('in_progress');
	});

	test('includes task description', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('Add the X feature to the codebase with tests.');
	});

	test('includes task dependencies when present', () => {
		const ctx = makeContext({
			task: makeTask({ dependsOn: ['dep-task-1'] }),
		});
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('dep-task-1');
	});

	test('omits depends-on when empty', () => {
		const ctx = makeContext({ task: makeTask({ dependsOn: [] }) });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).not.toContain('Depends on:');
	});
});

describe('buildTaskAgentInitialMessage — workflow structure', () => {
	test('includes workflow name', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('Feature Workflow');
	});

	test('includes workflow description', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('Plan, code, and review.');
	});

	test('includes start step ID', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('step-plan');
	});

	test('includes step names', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('Plan');
		expect(msg).toContain('Code');
		expect(msg).toContain('Review');
	});

	test('includes node agent names', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('Coder');
		expect(msg).toContain('Planner');
		expect(msg).toContain('Reviewer');
	});

	test('includes step instructions when present', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('Write tests too.');
	});

	test('includes workflow step IDs and names', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('step-plan');
		expect(msg).toContain('step-code');
		expect(msg).toContain('step-review');
	});

	test('includes step IDs for each node', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('step-code');
	});

	test('includes workflow name and step count', () => {
		const ctx = makeContext({
			workflow: makeWorkflow({
				nodes: [{ id: 'step-a', name: 'Step A', agents: [{ agentId: 'agent-1', name: 'Coder' }] }],
				startNodeId: 'step-a',
			}),
		});
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('Feature Workflow');
		expect(msg).toContain('step-a');
	});

	test('shows all steps listed under workflow section', () => {
		const ctx = makeContext({
			workflow: makeWorkflow({
				nodes: [{ id: 's1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'Coder' }] }],
				startNodeId: 's1',
			}),
		});
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('s1');
		expect(msg).toContain('Step One');
	});

	test('includes workflow run details when present', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('run-1');
		expect(msg).toContain('Feature X Run #1');
	});

	test('shows current step from workflow run', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		// current step is step-plan
		expect(msg).toContain('Plan');
	});

	test('handles no workflow gracefully', () => {
		const ctx = makeContext({ workflow: undefined, workflowRun: undefined });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).not.toContain('undefined');
		expect(msg).toContain('No workflow is assigned');
	});

	test('handles workflow with no steps — body shows no steps message', () => {
		const ctx = makeContext({
			workflow: makeWorkflow({ nodes: [], startNodeId: 'none' }),
		});
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('no steps defined');
	});

	test('handles workflow with no steps — start instruction directs to report_result failure', () => {
		const ctx = makeContext({
			workflow: makeWorkflow({
				name: 'Empty Workflow',
				nodes: [],
				startNodeId: 'none',
			}),
		});
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('report_result');
		expect(msg).toContain('Empty Workflow');
		expect(msg).toContain('no steps');
	});

	test('step with unresolvable agentId falls back to raw agent id', () => {
		const ctx = makeContext({
			workflow: makeWorkflow({
				nodes: [
					{
						id: 'step-orphan',
						name: 'Orphan Step',
						agents: [{ agentId: 'agent-missing', name: 'OrphanAgent' }],
					},
				],
				startNodeId: 'step-orphan',
			}),
			availableAgents: [],
		});
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('agent id: agent-missing');
	});

	test('handles workflow with no channels', () => {
		const ctx = makeContext({ workflow: makeWorkflow({ channels: [] }) });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('No channels are declared');
	});
});

describe('buildTaskAgentInitialMessage — available agents', () => {
	test('includes agent names', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('Coder');
		expect(msg).toContain('Planner');
	});

	test('includes agent names for available agents', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('Coder');
		expect(msg).toContain('Planner');
	});

	test('includes agent IDs', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('agent-1');
	});

	test('includes agent description when present', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('Implementation specialist');
	});

	test('includes agent model when present', () => {
		const ctx = makeContext({
			availableAgents: [makeAgent({ model: 'claude-haiku-4-5' })],
		});
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('claude-haiku-4-5');
	});

	test('shows message when no agents configured', () => {
		const ctx = makeContext({ availableAgents: [] });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('No agents are configured');
	});
});

describe('buildTaskAgentInitialMessage — previous task results', () => {
	test('includes previous task titles', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('Setup environment');
	});

	test('includes previous task status', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('completed');
	});

	test('includes previous task results', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('Environment is ready.');
	});

	test('includes multiple previous tasks', () => {
		const summaries: PreviousTaskSummary[] = [
			{ taskId: 'task-prev-1', title: 'Setup', status: 'done', result: 'Done.' },
			{ taskId: 'task-prev-2', title: 'Research', status: 'done', result: 'Findings noted.' },
		];
		const ctx = makeContext({ previousTaskSummaries: summaries });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('Setup');
		expect(msg).toContain('Research');
	});

	test('omits previous results section when empty', () => {
		const ctx = makeContext({ previousTaskSummaries: [] });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).not.toContain('Previous Task Results');
	});

	test('omits previous results section when undefined', () => {
		const ctx = makeContext({ previousTaskSummaries: undefined });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).not.toContain('Previous Task Results');
	});

	test('handles previous task with no result', () => {
		const summaries: PreviousTaskSummary[] = [
			{ taskId: 'task-prev-1', title: 'Setup', status: 'cancelled' },
		];
		const ctx = makeContext({ previousTaskSummaries: summaries });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('Setup');
		expect(msg).not.toContain('**Result:**');
	});
});

describe('buildTaskAgentInitialMessage — start instruction', () => {
	test('instructs to begin with spawn_node_agent for workflow tasks', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('spawn_node_agent');
		expect(msg).toContain('step-plan');
	});

	test('instructs to spawn agent for tasks without workflow', () => {
		const ctx = makeContext({ workflow: undefined, workflowRun: undefined });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('spawn_node_agent');
	});
});

// ===========================================================================
// New agent-centric collaboration model tests
// ===========================================================================

describe('buildTaskAgentSystemPrompt — collaboration manager role', () => {
	test('uses collaboration manager terminology', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('collaboration manager');
	});

	test('does not use workflow orchestrator terminology', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).not.toContain('workflow orchestrator');
	});

	test('mentions monitoring completion via list_group_members querying space_tasks', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('list_group_members');
		expect(prompt).toContain('space_tasks');
	});
});

describe('buildTaskAgentSystemPrompt — gate-blocked messages', () => {
	test('includes guidance on handling gate-blocked messages', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('gate-blocked');
	});

	test('instructs to call request_human_input for human gates on channels', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		// gate condition guidance section
		expect(prompt).toContain('human` gate');
		expect(prompt).toContain('request_human_input');
	});

	test('mentions condition and task_result gates are evaluated automatically', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('condition` and `task_result` gates are evaluated automatically');
	});
});

describe('buildTaskAgentSystemPrompt — string-based target addressing', () => {
	test('explains agent name resolves to DM', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('DM');
	});

	test('explains node name resolves to fan-out', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('fan-out');
	});

	test('mentions broadcast target *', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('"*"');
	});
});

describe('buildTaskAgentSystemPrompt — list_reachable_agents guidance', () => {
	test('mentions list_reachable_agents as a node agent tool', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('list_reachable_agents');
	});

	test('mentions list_peers as a node agent tool for completion state', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('list_peers');
	});
});

describe('buildTaskAgentInitialMessage — channel map', () => {
	function makeWorkflowWithChannels(channels: WorkflowChannel[]): SpaceWorkflow {
		return {
			...makeWorkflow(),
			channels,
		};
	}

	test('includes channel map section when workflow has channels', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'coder', to: 'reviewer', direction: 'bidirectional' },
		];
		const ctx = makeContext({ workflow: makeWorkflowWithChannels(channels) });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('Collaboration Channel Map');
	});

	test('shows channel from/to agents', () => {
		const channels: WorkflowChannel[] = [{ from: 'coder', to: 'reviewer', direction: 'one-way' }];
		const ctx = makeContext({ workflow: makeWorkflowWithChannels(channels) });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('`coder`');
		expect(msg).toContain('`reviewer`');
	});

	test('shows bidirectional arrow for bidirectional channels', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'coder', to: 'reviewer', direction: 'bidirectional' },
		];
		const ctx = makeContext({ workflow: makeWorkflowWithChannels(channels) });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('↔');
	});

	test('shows one-way arrow for one-way channels', () => {
		const channels: WorkflowChannel[] = [{ from: 'coder', to: 'reviewer', direction: 'one-way' }];
		const ctx = makeContext({ workflow: makeWorkflowWithChannels(channels) });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('→');
	});

	test('shows gate reference for gated channels', () => {
		const channels: WorkflowChannel[] = [
			{
				from: 'coder',
				to: 'reviewer',
				direction: 'one-way',
				gateId: 'approval-gate',
			},
		];
		const wf = {
			...makeWorkflowWithChannels(channels),
			gates: [
				{
					id: 'approval-gate',
					description: 'Approve before review',
					fields: [
						{ name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
					],
					resetOnCycle: false,
				},
			],
		};
		const ctx = makeContext({ workflow: wf });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('approval-gate');
		expect(msg).toContain('Approve before review');
	});

	test('shows gate id for gated channel without description', () => {
		const channels: WorkflowChannel[] = [
			{
				from: 'coder',
				to: 'reviewer',
				direction: 'one-way',
				gateId: 'ci-gate',
			},
		];
		const wf = {
			...makeWorkflowWithChannels(channels),
			gates: [
				{
					id: 'ci-gate',
					fields: [
						{ name: 'ci_passed', type: 'string', writers: ['coder'], check: { op: 'exists' } },
					],
					resetOnCycle: false,
				},
			],
		};
		const ctx = makeContext({ workflow: wf });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('ci-gate');
	});

	test('shows gate info for gated channel with check condition', () => {
		const channels: WorkflowChannel[] = [
			{
				from: 'coder',
				to: 'reviewer',
				direction: 'one-way',
				gateId: 'result-gate',
			},
		];
		const wf = {
			...makeWorkflowWithChannels(channels),
			gates: [
				{
					id: 'result-gate',
					description: 'Check passed',
					fields: [
						{
							name: 'result',
							type: 'string',
							writers: ['general'],
							check: { op: '==', value: 'passed' },
						},
					],
					resetOnCycle: true,
				},
			],
		};
		const ctx = makeContext({ workflow: wf });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('result-gate');
	});

	test('shows channel label when present', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'coder', to: 'reviewer', direction: 'one-way', label: 'code-review' },
		];
		const ctx = makeContext({ workflow: makeWorkflowWithChannels(channels) });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('code-review');
	});

	test('shows no-channels message when workflow has empty channels', () => {
		const ctx = makeContext({ workflow: makeWorkflowWithChannels([]) });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('No channels are declared');
	});

	test('shows no channel map when no workflow is assigned', () => {
		const ctx = makeContext({ workflow: undefined });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).not.toContain('Collaboration Channel Map');
	});

	test('mentions target addressing guidance in channel map', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'coder', to: 'reviewer', direction: 'bidirectional' },
		];
		const ctx = makeContext({ workflow: makeWorkflowWithChannels(channels) });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('list_reachable_agents');
	});

	test('handles fan-out channel with array of targets', () => {
		const channels: WorkflowChannel[] = [
			{ from: 'coder', to: ['reviewer', 'qa'], direction: 'one-way' },
		];
		const ctx = makeContext({ workflow: makeWorkflowWithChannels(channels) });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('reviewer');
		expect(msg).toContain('qa');
	});
});
