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
import type { SpaceTask, SpaceWorkflow, SpaceWorkflowRun, Space, SpaceAgent } from '@neokai/shared';

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
		role: 'coder',
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
			{ id: 'step-plan', name: 'Plan', agentId: 'agent-planner' },
			{ id: 'step-code', name: 'Code', agentId: 'agent-1', instructions: 'Write tests too.' },
			{ id: 'step-review', name: 'Review', agentId: 'agent-reviewer' },
		],
		transitions: [
			{ id: 't1', from: 'step-plan', to: 'step-code', order: 0 },
			{
				id: 't2',
				from: 'step-code',
				to: 'step-review',
				order: 0,
				condition: { type: 'human', description: 'Approve code before review' },
			},
		],
		startNodeId: 'step-plan',
		rules: [
			{
				id: 'rule-1',
				name: 'No console.log',
				content: 'Remove all console.log statements before merging.',
			},
			{
				id: 'rule-2',
				name: 'Test coverage',
				content: 'All new code must have 80% coverage.',
				appliesTo: ['step-code'],
			},
		],
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
		currentNodeId: 'step-plan',
		status: 'in_progress',
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
			makeAgent({ id: 'agent-planner', name: 'Planner', role: 'planner' }),
			makeAgent({ id: 'agent-reviewer', name: 'Reviewer', role: 'reviewer' }),
		],
		previousTaskSummaries: [
			{
				taskId: 'task-0',
				title: 'Setup environment',
				status: 'completed',
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

	test('identifies agent as Task Agent orchestrator', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('Task Agent');
		expect(prompt).toContain('workflow orchestrator');
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
	test('includes spawn_step_agent tool', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('spawn_step_agent');
	});

	test('includes check_step_status tool', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('check_step_status');
	});

	test('includes advance_workflow tool', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('advance_workflow');
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
	test('mentions spawning step agents', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('spawn_step_agent');
	});

	test('mentions monitoring completion via check_step_status', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('check_step_status');
	});

	test('mentions advancing the workflow', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('advance_workflow');
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

describe('buildTaskAgentSystemPrompt — step_result vs report_result.status', () => {
	test('includes section distinguishing step_result from report_result.status', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('step_result');
		expect(prompt).toContain('report_result.status');
	});

	test('describes step_result as free-form string for transition evaluation', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('task_result');
	});

	test('advance_workflow description mentions passing step_result on verify/review/test steps', () => {
		const prompt = buildTaskAgentSystemPrompt(makeContext());
		expect(prompt).toContain('step_result');
		expect(prompt).toContain('passed');
	});

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

	test('includes step agent names', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('Coder');
		expect(msg).toContain('Planner');
		expect(msg).toContain('Reviewer');
	});

	test('includes step instructions when present', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('Write tests too.');
	});

	test('includes human gate transition label', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('HUMAN GATE');
	});

	test('includes workflow rules', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('No console.log');
		expect(msg).toContain('Remove all console.log statements before merging.');
	});

	test('includes scoped rule step reference', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('step-code');
	});

	test('rule with no appliesTo shows "(all steps)" scope', () => {
		const ctx = makeContext({
			workflow: makeWorkflow({
				rules: [
					{ id: 'r1', name: 'Global Rule', content: 'Follow conventions.', appliesTo: undefined },
				],
			}),
		});
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('all steps');
	});

	test('rule with empty appliesTo array shows "(all steps)" scope', () => {
		const ctx = makeContext({
			workflow: makeWorkflow({
				rules: [{ id: 'r1', name: 'Global Rule', content: 'Follow conventions.', appliesTo: [] }],
			}),
		});
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('all steps');
	});

	test('always condition transition produces no extra label', () => {
		const ctx = makeContext({
			workflow: makeWorkflow({
				transitions: [
					{ id: 't-always', from: 'step-plan', to: 'step-code', condition: { type: 'always' } },
				],
			}),
		});
		const msg = buildTaskAgentInitialMessage(ctx);
		// The arrow line should appear without a bracketed condition label
		expect(msg).toContain('`step-plan` → `step-code`');
		expect(msg).not.toContain('[HUMAN GATE]');
		expect(msg).not.toContain('[condition:');
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
			workflow: makeWorkflow({ nodes: [], transitions: [], startNodeId: 'none' }),
		});
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('no steps defined');
	});

	test('handles workflow with no steps — start instruction directs to report_result failure', () => {
		const ctx = makeContext({
			workflow: makeWorkflow({
				name: 'Empty Workflow',
				nodes: [],
				transitions: [],
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
				nodes: [{ id: 'step-orphan', name: 'Orphan Step', agentId: 'agent-missing' }],
				transitions: [],
				startNodeId: 'step-orphan',
			}),
			availableAgents: [],
		});
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('agent id: agent-missing');
	});

	test('handles workflow with no rules', () => {
		const ctx = makeContext({ workflow: makeWorkflow({ rules: [] }) });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).not.toContain('Workflow Rules');
	});

	test('handles workflow with no transitions', () => {
		const ctx = makeContext({ workflow: makeWorkflow({ transitions: [] }) });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).not.toContain('→');
	});
});

describe('buildTaskAgentInitialMessage — available agents', () => {
	test('includes agent names', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('Coder');
		expect(msg).toContain('Planner');
	});

	test('includes agent roles', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('coder');
		expect(msg).toContain('planner');
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
			{ taskId: 'task-prev-1', title: 'Setup', status: 'completed', result: 'Done.' },
			{ taskId: 'task-prev-2', title: 'Research', status: 'completed', result: 'Findings noted.' },
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
	test('instructs to begin with spawn_step_agent for workflow tasks', () => {
		const msg = buildTaskAgentInitialMessage(makeContext());
		expect(msg).toContain('spawn_step_agent');
		expect(msg).toContain('step-plan');
	});

	test('instructs to spawn agent for tasks without workflow', () => {
		const ctx = makeContext({ workflow: undefined, workflowRun: undefined });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('spawn_step_agent');
	});
});

describe('buildTaskAgentInitialMessage — formatTransition task_result', () => {
	test('formatTransition labels task_result transitions with result matches expression', () => {
		// Create a workflow with a task_result transition
		const wf: SpaceWorkflow = {
			id: 'wf-task-result',
			spaceId: 'space-1',
			name: 'Task Result WF',
			description: 'Test workflow',
			nodes: [
				{ id: 'step-plan', name: 'Plan', agentId: 'agent-planner' },
				{ id: 'step-code', name: 'Code', agentId: 'agent-1' },
			],
			transitions: [
				{
					id: 't1',
					from: 'step-plan',
					to: 'step-code',
					condition: { type: 'task_result', expression: 'passed' },
				},
			],
			startNodeId: 'step-plan',
			rules: [],
			isDefault: false,
			tags: [],
			createdAt: 1000,
			updatedAt: 2000,
		};
		const ctx = makeContext({ workflow: wf });
		const msg = buildTaskAgentInitialMessage(ctx);
		expect(msg).toContain('[result matches "passed"]');
	});
});
