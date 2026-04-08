import { describe, expect, it, mock } from 'bun:test';
import type { Space, SpaceAgent, SpaceTask, SpaceWorkflow, SpaceWorkflowRun } from '@neokai/shared';
import type { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager';
import {
	buildCustomAgentSystemPrompt,
	buildCustomAgentTaskMessage,
	composePromptLayer,
	createCustomAgentInit,
	resolveAgentInit,
	type CustomAgentConfig,
} from '../../../../src/lib/space/agents/custom-agent';

function makeAgent(overrides?: Partial<SpaceAgent>): SpaceAgent {
	return {
		id: 'agent-1',
		spaceId: 'space-1',
		name: 'Test Agent',
		instructions: null,
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
						instructions: { mode: 'override', value: 'Write a plan' },
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
		expect(buildCustomAgentSystemPrompt(makeAgent({ systemPrompt: '  Visible prompt  ' }))).toBe(
			'Visible prompt'
		);
	});

	it('returns empty string when no prompt is configured', () => {
		expect(buildCustomAgentSystemPrompt(makeAgent({ systemPrompt: undefined }))).toBe('');
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
					prUrl: 'https://github.com/org/repo/pull/42',
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
		// Agent slot carries the instructions (node-level instructions removed)
		expect(message).toContain('Monorepo project');
		expect(message).toContain('Run tests before finishing.');
		expect(message).toContain('https://github.com/org/repo/pull/42');
		expect(message).toContain('Task 0: added login page');
	});

	it('does not inject hidden behavioral instructions', () => {
		const message = buildCustomAgentTaskMessage(makeConfig());

		expect(message).not.toContain('Begin working on this task.');
		expect(message).not.toContain('Push your changes to update this PR');
		expect(message).not.toContain('Focus on the current step first');
	});

	it('applies instructions override in override mode', () => {
		const message = buildCustomAgentTaskMessage(
			makeConfig({
				customAgent: makeAgent({ instructions: 'Base instructions' }),
				slotOverrides: {
					instructions: { mode: 'override', value: 'Override instructions' },
				},
			})
		);

		expect(message).toContain('## Instructions');
		expect(message).toContain('Override instructions');
		expect(message).not.toContain('Base instructions');
	});

	it('applies instructions override in expand mode', () => {
		const message = buildCustomAgentTaskMessage(
			makeConfig({
				customAgent: makeAgent({ instructions: 'Base instructions' }),
				slotOverrides: {
					instructions: { mode: 'expand', value: 'Additional context' },
				},
			})
		);

		expect(message).toContain('## Instructions');
		expect(message).toContain('Base instructions');
		expect(message).toContain('Additional context');
		expect(message).toContain('Base instructions\n\nAdditional context');
	});

	it('uses agent instructions when no slot override is provided', () => {
		const message = buildCustomAgentTaskMessage(
			makeConfig({
				customAgent: makeAgent({ instructions: 'Agent own instructions' }),
			})
		);

		expect(message).toContain('## Instructions');
		expect(message).toContain('Agent own instructions');
	});
});

describe('createCustomAgentInit', () => {
	it('uses the agent prompt outside workflow runs', () => {
		const init = createCustomAgentInit(
			makeConfig({
				customAgent: makeAgent({ systemPrompt: 'Agent-visible prompt' }),
			})
		);

		expect(init.systemPrompt?.type).toBe('preset');
		expect(init.systemPrompt?.append).toBe('Agent-visible prompt');
	});

	it('uses only the workflow slot prompt inside workflow runs', () => {
		const init = createCustomAgentInit(
			makeConfig({
				customAgent: makeAgent({ systemPrompt: 'Hidden base prompt' }),
				workflowRun: makeWorkflowRun(),
				slotOverrides: { systemPrompt: { mode: 'override', value: 'Workflow-visible prompt' } },
			})
		);

		expect(init.systemPrompt?.append).toBe('Workflow-visible prompt');
		expect(init.systemPrompt?.append).not.toContain('Hidden base prompt');
	});

	it('uses the agent system prompt when no slot override is defined', () => {
		const init = createCustomAgentInit(
			makeConfig({
				customAgent: makeAgent({ systemPrompt: 'Agent base prompt' }),
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
					systemPrompt: 'Visible prompt',
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
		expect(fallback.model).toBe('claude-sonnet-4-5-20250929');
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
			getById: mock(() => makeAgent({ id: 'agent-2', systemPrompt: 'Visible prompt' })),
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
// composePromptLayer
// ---------------------------------------------------------------------------

describe('composePromptLayer', () => {
	describe('override mode', () => {
		it('replaces non-empty base entirely', () => {
			expect(composePromptLayer('Base value', { mode: 'override', value: 'X' })).toBe('X');
		});

		it('replaces null base', () => {
			expect(composePromptLayer(null, { mode: 'override', value: 'Override only' })).toBe(
				'Override only'
			);
		});

		it('replaces empty string base', () => {
			expect(composePromptLayer('', { mode: 'override', value: 'Override' })).toBe('Override');
		});

		it('returns trimmed override value', () => {
			expect(composePromptLayer('Base', { mode: 'override', value: '  Trimmed  ' })).toBe(
				'Trimmed'
			);
		});
	});

	describe('expand mode', () => {
		it('appends override to non-empty base with double newline', () => {
			expect(composePromptLayer('Base prompt', { mode: 'expand', value: 'Extra' })).toBe(
				'Base prompt\n\nExtra'
			);
		});

		it('returns only override value when base is empty string', () => {
			expect(composePromptLayer('', { mode: 'expand', value: 'Expand only' })).toBe('Expand only');
		});

		it('returns only override value when base is null', () => {
			expect(composePromptLayer(null, { mode: 'expand', value: 'Expand only' })).toBe(
				'Expand only'
			);
		});

		it('returns base only when override value is blank', () => {
			expect(composePromptLayer('Base value', { mode: 'expand', value: '   ' })).toBe('Base value');
		});
	});

	describe('no override (undefined)', () => {
		it('returns base value unchanged', () => {
			expect(composePromptLayer('Agent base prompt', undefined)).toBe('Agent base prompt');
		});

		it('returns empty string when base is null', () => {
			expect(composePromptLayer(null, undefined)).toBe('');
		});

		it('returns empty string when base is empty', () => {
			expect(composePromptLayer('', undefined)).toBe('');
		});
	});
});
