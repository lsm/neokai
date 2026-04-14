import { describe, expect, it, mock } from 'bun:test';
import type { Space, SpaceAgent, SpaceTask, SpaceWorkflow, SpaceWorkflowRun } from '@neokai/shared';
import type { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager';
import {
	buildCustomAgentSystemPrompt,
	buildCustomAgentTaskMessage,
	expandPrompt,
	createCustomAgentInit,
	resolveAgentInit,
	type CustomAgentConfig,
	type SlotOverrides,
} from '../../../../src/lib/space/agents/custom-agent';

function makeAgent(overrides?: Partial<SpaceAgent>): SpaceAgent {
	return {
		id: 'agent-1',
		spaceId: 'space-1',
		name: 'Test Agent',
		customPrompt: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeSpace(overrides?: Partial<Space>): Space {
	return {
		id: 'space-1',
		name: 'Test Space',
		description: 'Space description',
		workspacePath: '/workspace/project',
		backgroundContext: '',
		instructions: '',
		sessionIds: [],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeTask(overrides?: Partial<SpaceTask>): SpaceTask {
	return {
		id: 'task-1',
		spaceId: 'space-1',
		taskNumber: 1,
		title: 'Implement feature X',
		description: 'Add feature X to the codebase',
		status: 'open',
		priority: 'normal',
		dependsOn: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeWorkflowRun(overrides?: Partial<SpaceWorkflowRun>): SpaceWorkflowRun {
	return {
		id: 'run-1',
		spaceId: 'space-1',
		workflowId: 'wf-1',
		title: 'Workflow Run',
		status: 'in_progress',
		startedAt: null,
		completedAt: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeWorkflow(overrides?: Partial<SpaceWorkflow>): SpaceWorkflow {
	return {
		id: 'wf-1',
		spaceId: 'space-1',
		name: 'Coding Workflow',
		description: 'Visible workflow description',
		nodes: [
			{
				id: 'node-1',
				name: 'Plan',
				agents: [
					{
						agentId: 'agent-1',
						name: 'Coder',
						customPrompt: { value: 'Write a plan' },
					},
				],
			},
			{ id: 'node-2', name: 'Code', agents: [{ agentId: 'agent-1', name: 'Coder' }] },
		],
		startNodeId: 'node-1',
		tags: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeConfig(overrides?: Partial<CustomAgentConfig>): CustomAgentConfig {
	return {
		customAgent: makeAgent(),
		task: makeTask(),
		workflowRun: null,
		workflow: null,
		space: makeSpace(),
		sessionId: 'session-1',
		workspacePath: '/workspace/project',
		...overrides,
	};
}

describe('buildCustomAgentSystemPrompt', () => {
	it('returns only trimmed visible prompt text', () => {
		expect(buildCustomAgentSystemPrompt(makeAgent({ customPrompt: '  Visible prompt  ' }))).toBe(
			'Visible prompt'
		);
	});

	it('returns empty string when no prompt is configured', () => {
		expect(buildCustomAgentSystemPrompt(makeAgent({ customPrompt: null }))).toBe('');
	});
});

describe('buildCustomAgentTaskMessage', () => {
	it('includes factual task, workflow, and space context', () => {
		const message = buildCustomAgentTaskMessage(
			makeConfig({
				task: makeTask({
					title: 'Ship auth flow',
					description: 'Implement auth flow',
					priority: 'high',
				}),
				workflowRun: makeWorkflowRun({ title: 'Auth rollout', description: 'Production' }),
				workflow: makeWorkflow(),
				space: makeSpace({
					backgroundContext: 'Monorepo project',
					instructions: 'Run tests before finishing.',
				}),
				previousTaskSummaries: ['Task 0: added login page'],
			})
		);

		expect(message).toContain('Ship auth flow');
		expect(message).toContain('Implement auth flow');
		expect(message).toContain('Workflow Context');
		expect(message).toContain('Auth rollout');
		expect(message).toContain('Workflow Structure');
		expect(message).toContain('Nodes:');
		expect(message).toContain('Plan');
		expect(message).toContain('Monorepo project');
		expect(message).toContain('Run tests before finishing.');
		expect(message).toContain('Task 0: added login page');
	});

	it('does not inject hidden behavioral instructions', () => {
		const message = buildCustomAgentTaskMessage(makeConfig());

		expect(message).not.toContain('Begin working on this task.');
		expect(message).not.toContain('Push your changes to update this PR');
		expect(message).not.toContain('Focus on the current step first');
	});

	it('does not include ## Instructions section', () => {
		const message = buildCustomAgentTaskMessage(
			makeConfig({
				customAgent: makeAgent({ customPrompt: 'Some instructions' }),
			})
		);

		expect(message).not.toContain('## Instructions');
	});
});

describe('createCustomAgentInit', () => {
	it('uses the agent prompt outside workflow runs', () => {
		const init = createCustomAgentInit(
			makeConfig({
				customAgent: makeAgent({ customPrompt: 'Agent-visible prompt' }),
			})
		);

		expect(init.systemPrompt?.type).toBe('preset');
		expect(init.systemPrompt?.append).toBe('Agent-visible prompt');
	});

	it('expands slot customPrompt on top of agent customPrompt inside workflow runs', () => {
		const init = createCustomAgentInit(
			makeConfig({
				customAgent: makeAgent({ customPrompt: 'Base prompt' }),
				workflowRun: makeWorkflowRun(),
				slotOverrides: { customPrompt: 'Slot expansion' },
			})
		);

		expect(init.systemPrompt?.append).toBe('Base prompt\n\nSlot expansion');
	});

	it('uses the agent custom prompt when no slot override is defined', () => {
		const init = createCustomAgentInit(
			makeConfig({
				customAgent: makeAgent({ customPrompt: 'Agent base prompt' }),
				workflowRun: makeWorkflowRun(),
			})
		);

		expect(init.systemPrompt?.append).toBe('Agent base prompt');
	});

	it('uses tool-restricted agent mode when tools are configured', () => {
		const init = createCustomAgentInit(
			makeConfig({
				customAgent: makeAgent({
					name: 'Restricted Agent',
					customPrompt: 'Visible prompt',
					tools: ['Read', 'Bash'],
				}),
			})
		);

		expect(init.agent).toBe('restricted-agent');
		expect(init.agents).toBeDefined();
		expect(init.agents?.['restricted-agent']?.prompt).toBe('Visible prompt');
		expect(init.agents?.['restricted-agent']?.tools).toEqual(['Read', 'Bash']);
		expect(init.systemPrompt?.preset).toBe('claude_code');
		expect(init.systemPrompt?.append).toBeUndefined();
	});

	it('applies model precedence slot > agent > space > default', () => {
		const slot = createCustomAgentInit(
			makeConfig({
				customAgent: makeAgent({ model: 'agent-model' }),
				space: makeSpace({ defaultModel: 'space-model' }),
				slotOverrides: { model: 'slot-model' },
			})
		);
		expect(slot.model).toBe('slot-model');

		const agent = createCustomAgentInit(
			makeConfig({
				customAgent: makeAgent({ model: 'agent-model' }),
				space: makeSpace({ defaultModel: 'space-model' }),
			})
		);
		expect(agent.model).toBe('agent-model');

		const space = createCustomAgentInit(
			makeConfig({
				customAgent: makeAgent({ model: undefined }),
				space: makeSpace({ defaultModel: 'space-model' }),
			})
		);
		expect(space.model).toBe('space-model');

		const fallback = createCustomAgentInit(
			makeConfig({
				customAgent: makeAgent({ model: undefined }),
				space: makeSpace({ defaultModel: undefined }),
			})
		);
		expect(fallback.model).toBe('claude-sonnet-4-6');
	});
});

describe('resolveAgentInit', () => {
	it('throws when assigned agent cannot be found', () => {
		const agentManager = { getById: mock(() => null) } as unknown as SpaceAgentManager;

		expect(() =>
			resolveAgentInit({
				task: makeTask(),
				space: makeSpace(),
				agentManager,
				agentId: 'missing-agent',
				sessionId: 'session-1',
				workspacePath: '/workspace/project',
			})
		).toThrow('Agent not found: missing-agent');
	});

	it('resolves the assigned agent and builds the session init', () => {
		const agentManager = {
			getById: mock(() => makeAgent({ id: 'agent-2', customPrompt: 'Visible prompt' })),
		} as unknown as SpaceAgentManager;

		const init = resolveAgentInit({
			task: makeTask(),
			space: makeSpace(),
			agentManager,
			agentId: 'agent-2',
			sessionId: 'session-1',
			workspacePath: '/workspace/project',
		});

		expect(init.systemPrompt?.append).toBe('Visible prompt');
	});
});

// ---------------------------------------------------------------------------
// expandPrompt
// ---------------------------------------------------------------------------

describe('expandPrompt', () => {
	it('returns base when no expansion is provided', () => {
		expect(expandPrompt('base prompt', undefined)).toBe('base prompt');
	});

	it('returns empty string when base and expansion are both absent', () => {
		expect(expandPrompt(undefined, undefined)).toBe('');
		expect(expandPrompt(null, undefined)).toBe('');
		expect(expandPrompt('', undefined)).toBe('');
	});

	it('appends expansion to base with double newline', () => {
		expect(expandPrompt('base', 'additional')).toBe('base\n\nadditional');
	});

	it('returns expansion only when base is empty', () => {
		expect(expandPrompt('', 'additional')).toBe('additional');
		expect(expandPrompt(null, 'additional')).toBe('additional');
		expect(expandPrompt(undefined, 'additional')).toBe('additional');
	});

	it('trims whitespace from both base and expansion', () => {
		expect(expandPrompt('  base  ', '  extra  ')).toBe('base\n\nextra');
	});

	it('handles multiline values', () => {
		const result = expandPrompt('base', 'line1\nline2\nline3');
		expect(result).toBe('base\n\nline1\nline2\nline3');
	});

	it('expands on top of non-empty base', () => {
		const base = 'Follow TDD principles.\nWrite tests first.';
		const result = expandPrompt(base, 'Use bun:test for all tests.');
		expect(result).toBe(
			'Follow TDD principles.\nWrite tests first.\n\nUse bun:test for all tests.'
		);
	});

	it('returns base when expansion is empty', () => {
		expect(expandPrompt('base', '')).toBe('base');
		expect(expandPrompt('base', '   ')).toBe('base');
	});

	it('returns base when expansion is undefined', () => {
		expect(expandPrompt('base prompt', undefined)).toBe('base prompt');
	});

	it('handles unicode content', () => {
		expect(expandPrompt('English base', '日本語の指示')).toBe('English base\n\n日本語の指示');
	});

	it('handles very long values', () => {
		const longValue = 'x'.repeat(10000);
		const result = expandPrompt('base', longValue);
		expect(result).toBe(`base\n\n${longValue}`);
		expect(result.length).toBe(10006);
	});

	it('returns empty string when base is null and expansion is absent', () => {
		expect(expandPrompt(null, undefined)).toBe('');
	});

	it('handles expansion with only whitespace base', () => {
		expect(expandPrompt('   ', 'value')).toBe('value');
	});

	it('with empty expansion and empty base returns empty', () => {
		expect(expandPrompt('', '')).toBe('');
	});

	it('preserves exact base trimmed when expansion is undefined', () => {
		expect(expandPrompt('  exact  spacing  ', undefined)).toBe('exact  spacing');
	});
});

// ---------------------------------------------------------------------------
// SlotOverrides interface
// ---------------------------------------------------------------------------

describe('SlotOverrides interface', () => {
	it('accepts customPrompt as string', () => {
		const overrides: SlotOverrides = {
			customPrompt: 'extra context',
		};
		expect(expandPrompt('base prompt', overrides.customPrompt)).toBe(
			'base prompt\n\nextra context'
		);
	});

	it('returns base when SlotOverrides.customPrompt is undefined', () => {
		const overrides: SlotOverrides = {};
		expect(expandPrompt('base prompt', overrides.customPrompt)).toBe('base prompt');
	});
});
