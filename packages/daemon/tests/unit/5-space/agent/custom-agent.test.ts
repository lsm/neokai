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
		channels: [
			{
				id: 'ch-plan-to-code',
				from: 'Plan',
				to: 'Code',
				label: 'Plan → Code',
				gateId: 'plan-ready-gate',
			},
			{
				id: 'ch-code-to-plan',
				from: 'Code',
				to: 'Plan',
				label: 'Code → Plan (feedback)',
				maxCycles: 3,
			},
		],
		gates: [
			{
				id: 'plan-ready-gate',
				label: 'PR Ready',
				description: 'Planner has opened a plan PR',
				fields: [
					{
						name: 'pr_url',
						type: 'string',
						writers: ['Plan'],
						check: { op: 'exists' },
					},
				],
				resetOnCycle: false,
			},
			{
				id: 'code-pr-gate',
				label: 'Code PR',
				description: 'Coder has opened a code PR',
				fields: [
					{
						name: 'pr_url',
						type: 'string',
						writers: ['Code'],
						check: { op: 'exists' },
					},
				],
				resetOnCycle: false,
			},
		],
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
	it('includes factual task, runtime location, role, previous work, project context, and instructions', () => {
		const message = buildCustomAgentTaskMessage(
			makeConfig({
				task: makeTask({
					title: 'Ship auth flow',
					description: 'Implement auth flow',
					priority: 'high',
				}),
				workflowRun: makeWorkflowRun({ title: 'Auth rollout', description: 'Production' }),
				workflow: makeWorkflow({ instructions: 'Use conventional commits.' }),
				space: makeSpace({
					backgroundContext: 'Monorepo project',
					instructions: 'Run tests before finishing.',
				}),
				workspacePath: '/workspaces/auth',
				previousTaskSummaries: ['Task 0: added login page'],
				nodeId: 'node-1',
				agentSlotName: 'Coder',
			})
		);

		// Task section
		expect(message).toContain('## Your Task');
		expect(message).toContain('Ship auth flow');
		expect(message).toContain('Implement auth flow');
		expect(message).toContain('**Priority:** high');

		// Runtime Location
		expect(message).toContain('## Runtime Location');
		expect(message).toContain('- Worktree: /workspaces/auth');
		expect(message).toContain('- PR: none yet');

		// Your Role
		expect(message).toContain('## Your Role in This Workflow');
		expect(message).toContain('- Node: Plan');
		expect(message).toContain('- Peers: Code');

		// Previous work
		expect(message).toContain('## Previous Work on This Goal');
		expect(message).toContain('- Task 0: added login page');

		// Project context
		expect(message).toContain('## Project Context');
		expect(message).toContain('Monorepo project');

		// Standing instructions (space + workflow combined)
		expect(message).toContain('## Standing Instructions');
		expect(message).toContain('Run tests before finishing.');
		expect(message).toContain('Use conventional commits.');
	});

	it('renders task description in the first 500 characters (action-first ordering)', () => {
		const message = buildCustomAgentTaskMessage(
			makeConfig({
				task: makeTask({
					title: 'Ship auth flow',
					description: 'Implement passwordless auth end-to-end.',
				}),
				workflow: makeWorkflow(),
				workflowRun: makeWorkflowRun(),
				space: makeSpace({
					backgroundContext: 'A'.repeat(5000),
					instructions: 'B'.repeat(5000),
				}),
			})
		);

		const head = message.slice(0, 500);
		expect(head).toContain('Implement passwordless auth end-to-end.');
	});

	it('renders PR URL from gate data when present', () => {
		const message = buildCustomAgentTaskMessage(
			makeConfig({
				workflow: makeWorkflow(),
				workflowRun: makeWorkflowRun(),
				nodeId: 'node-1',
				gateData: [
					{ gateId: 'plan-ready-gate', data: {} },
					{ gateId: 'code-pr-gate', data: { pr_url: 'https://github.com/org/repo/pull/42' } },
				],
			})
		);

		expect(message).toContain('- PR: https://github.com/org/repo/pull/42');
		expect(message).not.toContain('- PR: none yet');
	});

	it('scopes channels and writable gates to the current node', () => {
		const message = buildCustomAgentTaskMessage(
			makeConfig({
				workflow: makeWorkflow(),
				workflowRun: makeWorkflowRun(),
				nodeId: 'node-1', // "Plan" node
				agentSlotName: 'Coder',
			})
		);

		// Plan → Code outbound channel should show, Code → Plan should not
		expect(message).toContain('Channels from this node:');
		expect(message).toContain('Code (Plan → Code)');
		expect(message).not.toContain('Plan (Code → Plan');

		// Only the plan-ready-gate is writable by Plan; code-pr-gate should not appear.
		expect(message).toContain('Gates you can write:');
		expect(message).toContain('plan-ready-gate');
		expect(message).not.toMatch(/code-pr-gate/);
	});

	it('does not contain node UUIDs', () => {
		const workflow = makeWorkflow();
		const message = buildCustomAgentTaskMessage(
			makeConfig({
				workflow,
				workflowRun: makeWorkflowRun(),
				nodeId: 'node-1',
			})
		);

		for (const node of workflow.nodes) {
			expect(message).not.toContain(`id: \`${node.id}\``);
			expect(message).not.toContain(node.id);
		}
	});

	it('omits Runtime Location PR value as "none yet" when gate data is absent', () => {
		const message = buildCustomAgentTaskMessage(
			makeConfig({
				workflow: makeWorkflow(),
				workflowRun: makeWorkflowRun(),
				nodeId: 'node-1',
			})
		);
		expect(message).toContain('- PR: none yet');
	});

	it('omits Your Role section when workflow or node are absent', () => {
		const messageNoWorkflow = buildCustomAgentTaskMessage(makeConfig());
		expect(messageNoWorkflow).not.toContain('## Your Role in This Workflow');

		// Workflow provided but nodeId not resolvable → section omitted.
		const messageUnknownNode = buildCustomAgentTaskMessage(
			makeConfig({
				workflow: makeWorkflow(),
				workflowRun: makeWorkflowRun(),
				nodeId: 'does-not-exist',
			})
		);
		expect(messageUnknownNode).not.toContain('## Your Role in This Workflow');
	});

	it('cleanly omits missing sections (no empty headers)', () => {
		const message = buildCustomAgentTaskMessage(
			makeConfig({
				space: makeSpace({ backgroundContext: '', instructions: '' }),
			})
		);

		expect(message).not.toContain('## Previous Work on This Goal');
		expect(message).not.toContain('## Project Context');
		expect(message).not.toContain('## Standing Instructions');
		// Runtime Location is always rendered so we don't check its absence here.
		expect(message).toContain('## Your Task');
	});

	it('omits channels/gates sub-lines when current node has none', () => {
		const workflow = makeWorkflow({
			nodes: [{ id: 'solo', name: 'Solo', agents: [{ agentId: 'agent-1', name: 'Solo' }] }],
			startNodeId: 'solo',
			channels: [],
			gates: [],
		});

		const message = buildCustomAgentTaskMessage(
			makeConfig({
				workflow,
				workflowRun: makeWorkflowRun(),
				nodeId: 'solo',
				agentSlotName: 'Solo',
			})
		);

		expect(message).toContain('- Node: Solo');
		expect(message).not.toContain('- Peers:');
		expect(message).not.toContain('Channels from this node:');
		expect(message).not.toContain('Gates you can write:');
	});

	it('renders Standing Instructions last, after Project Context', () => {
		const message = buildCustomAgentTaskMessage(
			makeConfig({
				workflow: makeWorkflow({ instructions: 'WF instructions.' }),
				workflowRun: makeWorkflowRun(),
				space: makeSpace({
					backgroundContext: 'Project context block',
					instructions: 'Space instructions.',
				}),
				nodeId: 'node-1',
			})
		);

		const contextIdx = message.indexOf('## Project Context');
		const standingIdx = message.indexOf('## Standing Instructions');
		expect(contextIdx).toBeGreaterThan(-1);
		expect(standingIdx).toBeGreaterThan(contextIdx);

		const standingBlock = message.slice(standingIdx);
		expect(standingBlock).toContain('Space instructions.');
		expect(standingBlock).toContain('WF instructions.');
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

		// Old standalone heading is gone — replaced by ## Standing Instructions.
		expect(message).not.toContain('## Instructions\n');
	});

	it('handles workflow without channels or gates (backward compat)', () => {
		const barebonesWorkflow = makeWorkflow({ channels: undefined, gates: undefined });
		const message = buildCustomAgentTaskMessage(
			makeConfig({
				workflow: barebonesWorkflow,
				workflowRun: makeWorkflowRun(),
				nodeId: 'node-1',
			})
		);

		expect(message).toContain('- Node: Plan');
		expect(message).not.toContain('Channels from this node:');
		expect(message).not.toContain('Gates you can write:');
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
