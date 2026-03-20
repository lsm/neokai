/**
 * Custom Agent Factory Unit Tests
 *
 * Tests for buildCustomAgentSystemPrompt, buildCustomAgentTaskMessage,
 * createCustomAgentInit, and resolveAgentInit.
 */

import { describe, it, expect, mock } from 'bun:test';
import {
	buildCustomAgentSystemPrompt,
	buildCustomAgentTaskMessage,
	createCustomAgentInit,
	resolveAgentInit,
	type CustomAgentConfig,
	type ResolveAgentInitConfig,
} from '../../../src/lib/space/agents/custom-agent';
import type { SpaceAgent, SpaceTask, SpaceWorkflowRun, Space } from '@neokai/shared';
import type { SpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager';

// ============================================================================
// Test fixtures
// ============================================================================

function makeAgent(overrides?: Partial<SpaceAgent>): SpaceAgent {
	return {
		id: 'agent-1',
		spaceId: 'space-1',
		name: 'TestCoder',
		role: 'coder',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeSpace(overrides?: Partial<Space>): Space {
	return {
		id: 'space-1',
		workspacePath: '/workspace/project',
		name: 'Test Space',
		description: 'A test space',
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
		title: 'Implement feature X',
		description: 'Add feature X to the codebase',
		status: 'pending',
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
		title: 'Deploy v1.0',
		status: 'in_progress',
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
		space: makeSpace(),
		sessionId: 'session-abc',
		workspacePath: '/workspace/project',
		...overrides,
	};
}

// ============================================================================
// buildCustomAgentSystemPrompt
// ============================================================================

describe('buildCustomAgentSystemPrompt', () => {
	it('includes agent name in role identification', () => {
		const agent = makeAgent({ name: 'MyCoderBot', role: 'coder' });
		const prompt = buildCustomAgentSystemPrompt(agent);
		expect(prompt).toContain('MyCoderBot');
		expect(prompt).toContain('Coder Agent');
	});

	it('includes general role label for general role', () => {
		const agent = makeAgent({ role: 'general' });
		const prompt = buildCustomAgentSystemPrompt(agent);
		expect(prompt).toContain('General Agent');
	});

	it('includes planner role label for planner role', () => {
		const agent = makeAgent({ role: 'planner' });
		const prompt = buildCustomAgentSystemPrompt(agent);
		expect(prompt).toContain('Planner Agent');
	});

	it('includes reviewer role label for reviewer role', () => {
		const agent = makeAgent({ role: 'reviewer' });
		const prompt = buildCustomAgentSystemPrompt(agent);
		expect(prompt).toContain('Reviewer Agent');
	});

	it('includes custom systemPrompt content', () => {
		const agent = makeAgent({ systemPrompt: 'Focus only on backend changes.' });
		const prompt = buildCustomAgentSystemPrompt(agent);
		expect(prompt).toContain('Focus only on backend changes.');
		expect(prompt).toContain('Agent Instructions');
	});

	it('omits Agent Instructions section when systemPrompt is unset', () => {
		const agent = makeAgent({ systemPrompt: undefined });
		const prompt = buildCustomAgentSystemPrompt(agent);
		expect(prompt).not.toContain('Agent Instructions');
	});

	it('includes mandatory git workflow instructions', () => {
		const agent = makeAgent();
		const prompt = buildCustomAgentSystemPrompt(agent);
		expect(prompt).toContain('Git Workflow (MANDATORY)');
		expect(prompt).toContain('git fetch origin && git rebase origin/$DEFAULT_BRANCH');
		expect(prompt).toContain('git push -u origin HEAD');
		expect(prompt).toContain('gh pr create');
	});

	it('includes bypass markers section', () => {
		const agent = makeAgent();
		const prompt = buildCustomAgentSystemPrompt(agent);
		expect(prompt).toContain('Bypassing Git/PR Gates for Research-Only Tasks');
		expect(prompt).toContain('RESEARCH_ONLY:');
		expect(prompt).toContain('VERIFICATION_COMPLETE:');
		expect(prompt).toContain('INVESTIGATION_RESULT:');
		expect(prompt).toContain('ANALYSIS_COMPLETE:');
	});

	it('includes review feedback section', () => {
		const agent = makeAgent();
		const prompt = buildCustomAgentSystemPrompt(agent);
		expect(prompt).toContain('Addressing Review Feedback');
		expect(prompt).toContain('pullrequestreview');
	});

	it('no role produces role-specific instructions (roles are display labels only)', () => {
		for (const role of ['coder', 'general', 'planner', 'reviewer', 'custom-role']) {
			const agent = makeAgent({ role });
			const prompt = buildCustomAgentSystemPrompt(agent);
			expect(prompt).not.toContain('Review Responsibilities');
		}
	});

	it('warns about not committing to main branch', () => {
		const agent = makeAgent();
		const prompt = buildCustomAgentSystemPrompt(agent);
		expect(prompt).toContain('Do NOT commit directly to the main/dev/master branch');
	});
});

// ============================================================================
// buildCustomAgentTaskMessage
// ============================================================================

describe('buildCustomAgentTaskMessage', () => {
	it('includes task title and description', () => {
		const config = makeConfig({
			task: makeTask({ title: 'Add login flow', description: 'Implement JWT login' }),
		});
		const msg = buildCustomAgentTaskMessage(config);
		expect(msg).toContain('Add login flow');
		expect(msg).toContain('Implement JWT login');
	});

	it('includes task priority when set', () => {
		const config = makeConfig({ task: makeTask({ priority: 'high' }) });
		const msg = buildCustomAgentTaskMessage(config);
		expect(msg).toContain('high');
	});

	it('includes task type when set', () => {
		const config = makeConfig({ task: makeTask({ taskType: 'coding' }) });
		const msg = buildCustomAgentTaskMessage(config);
		expect(msg).toContain('coding');
	});

	it('includes workflow run context when provided', () => {
		const run = makeWorkflowRun({ title: 'Deploy v2.1', description: 'Production deploy' });
		const config = makeConfig({ workflowRun: run });
		const msg = buildCustomAgentTaskMessage(config);
		expect(msg).toContain('Workflow Context');
		expect(msg).toContain('Deploy v2.1');
		expect(msg).toContain('Production deploy');
	});

	it('omits workflow context when workflowRun is null', () => {
		const config = makeConfig({ workflowRun: null });
		const msg = buildCustomAgentTaskMessage(config);
		expect(msg).not.toContain('Workflow Context');
	});

	it('includes space backgroundContext', () => {
		const space = makeSpace({ backgroundContext: 'This is a Node.js REST API project.' });
		const config = makeConfig({ space });
		const msg = buildCustomAgentTaskMessage(config);
		expect(msg).toContain('Project Context');
		expect(msg).toContain('This is a Node.js REST API project.');
	});

	it('includes space instructions', () => {
		const space = makeSpace({ instructions: 'Always run bun test before pushing.' });
		const config = makeConfig({ space });
		const msg = buildCustomAgentTaskMessage(config);
		expect(msg).toContain('Instructions');
		expect(msg).toContain('Always run bun test before pushing.');
	});

	it('includes existing PR URL when task has a PR', () => {
		const task = makeTask({ prUrl: 'https://github.com/org/repo/pull/42' });
		const config = makeConfig({ task });
		const msg = buildCustomAgentTaskMessage(config);
		expect(msg).toContain('Existing Pull Request');
		expect(msg).toContain('https://github.com/org/repo/pull/42');
	});

	it('includes previous task summaries when provided', () => {
		const config = makeConfig({
			previousTaskSummaries: ['Task A: Added auth module', 'Task B: Added user model'],
		});
		const msg = buildCustomAgentTaskMessage(config);
		expect(msg).toContain('Previous Work on This Goal');
		expect(msg).toContain('Task A: Added auth module');
		expect(msg).toContain('Task B: Added user model');
	});

	it('does not include review instructions for any role or task type', () => {
		// Review instructions were removed — role is a display label only
		for (const role of ['coder', 'reviewer']) {
			for (const taskType of ['coding', 'review'] as const) {
				const config = makeConfig({
					task: makeTask({ taskType }),
					customAgent: makeAgent({ role }),
				});
				const msg = buildCustomAgentTaskMessage(config);
				expect(msg).not.toContain('Review Instructions');
			}
		}
	});

	it('ends with begin working prompt', () => {
		const config = makeConfig();
		const msg = buildCustomAgentTaskMessage(config);
		expect(msg).toContain('Begin working on this task.');
	});
});

// ============================================================================
// createCustomAgentInit
// ============================================================================

describe('createCustomAgentInit', () => {
	it('produces a valid session init', () => {
		const config = makeConfig();
		const init = createCustomAgentInit(config);

		expect(init.sessionId).toBe('session-abc');
		expect(init.workspacePath).toBe('/workspace/project');
		expect(init.type).toBe('worker');
		expect(init.contextAutoQueue).toBe(false);
	});

	it('uses claude_code preset with appended system prompt', () => {
		const config = makeConfig();
		const init = createCustomAgentInit(config);

		expect(init.systemPrompt).toBeDefined();
		expect(init.systemPrompt?.type).toBe('preset');
		expect(init.systemPrompt?.preset).toBe('claude_code');
		expect(init.systemPrompt?.append).toBeDefined();
		expect(typeof init.systemPrompt?.append).toBe('string');
	});

	it('appended prompt contains git workflow instructions', () => {
		const config = makeConfig();
		const init = createCustomAgentInit(config);
		expect(init.systemPrompt?.append).toContain('Git Workflow (MANDATORY)');
	});

	it('uses model from SpaceAgent.model when set', () => {
		const config = makeConfig({
			customAgent: makeAgent({ model: 'claude-opus-4-6' }),
		});
		const init = createCustomAgentInit(config);
		expect(init.model).toBe('claude-opus-4-6');
	});

	it('falls back to space.defaultModel when agent model is unset', () => {
		const config = makeConfig({
			customAgent: makeAgent({ model: undefined }),
			space: makeSpace({ defaultModel: 'claude-haiku-4-5' }),
		});
		const init = createCustomAgentInit(config);
		expect(init.model).toBe('claude-haiku-4-5');
	});

	it('falls back to hardcoded default when both agent and space models are unset', () => {
		const config = makeConfig({
			customAgent: makeAgent({ model: undefined }),
			space: makeSpace({ defaultModel: undefined }),
		});
		const init = createCustomAgentInit(config);
		expect(init.model).toBe('claude-sonnet-4-5-20250929');
	});

	it('uses agent/agents pattern when SpaceAgent.tools is configured', () => {
		const customTools = ['Read', 'Bash', 'Grep'];
		const config = makeConfig({
			customAgent: makeAgent({ tools: customTools, name: 'MyBot' }),
		});
		const init = createCustomAgentInit(config);

		// Should use the agent/agents pattern for tool restriction
		expect(init.agent).toBe('mybot');
		expect(init.agents).toBeDefined();
		expect(init.agents?.['mybot']).toBeDefined();
		expect(init.agents?.['mybot'].tools).toEqual(customTools);
		// No append in this path — prompt is in the agent def
		expect(init.systemPrompt?.append).toBeUndefined();
	});

	it('uses simple preset path when SpaceAgent.tools is unset', () => {
		const config = makeConfig({
			customAgent: makeAgent({ tools: undefined }),
		});
		const init = createCustomAgentInit(config);

		// Simple path: no agents map, prompt appended to preset
		expect(init.agent).toBeUndefined();
		expect(init.agents).toBeUndefined();
		expect(init.systemPrompt?.append).toBeDefined();
	});

	it('uses simple preset path when SpaceAgent.tools is empty array', () => {
		const config = makeConfig({
			customAgent: makeAgent({ tools: [] }),
		});
		const init = createCustomAgentInit(config);

		// Empty array treated as unset — falls back to simple path
		expect(init.agent).toBeUndefined();
		expect(init.agents).toBeUndefined();
	});

	it('sets spaceId in session context', () => {
		const config = makeConfig({ space: makeSpace({ id: 'space-xyz' }) });
		const init = createCustomAgentInit(config);
		expect(init.context?.spaceId).toBe('space-xyz');
	});

	it('disables all worker features', () => {
		const config = makeConfig();
		const init = createCustomAgentInit(config);
		expect(init.features?.rewind).toBe(false);
		expect(init.features?.worktree).toBe(false);
		expect(init.features?.coordinator).toBe(false);
		expect(init.features?.archive).toBe(false);
		expect(init.features?.sessionInfo).toBe(false);
	});

	it('builds correct init for reviewer role (no role-specific instructions)', () => {
		const config = makeConfig({
			customAgent: makeAgent({ role: 'reviewer', name: 'CodeReviewer' }),
		});
		const init = createCustomAgentInit(config);

		expect(init.type).toBe('worker');
		expect(init.systemPrompt?.append).toContain('Reviewer Agent');
		expect(init.systemPrompt?.append).not.toContain('Review Responsibilities');
	});

	it('builds correct init for planner role (treated as worker)', () => {
		const config = makeConfig({
			customAgent: makeAgent({ role: 'planner', name: 'ArchitectBot' }),
		});
		const init = createCustomAgentInit(config);

		expect(init.type).toBe('worker');
		expect(init.systemPrompt?.append).toContain('Planner Agent');
		expect(init.systemPrompt?.append).not.toContain('Review Responsibilities');
	});
});

// ============================================================================
// resolveAgentInit
// ============================================================================

describe('resolveAgentInit', () => {
	function makeMockAgentManager(agent: SpaceAgent | null): SpaceAgentManager {
		return {
			getById: mock(() => agent),
		} as unknown as SpaceAgentManager;
	}

	function makeResolveConfig(overrides?: Partial<ResolveAgentInitConfig>): ResolveAgentInitConfig {
		return {
			task: makeTask(),
			space: makeSpace(),
			agentManager: makeMockAgentManager(makeAgent()),
			sessionId: 'session-resolve',
			workspacePath: '/workspace/project',
			workflowRun: null,
			...overrides,
		};
	}

	it('resolves agent by ID and calls createCustomAgentInit', () => {
		const agent = makeAgent({ id: 'agent-1', name: 'MyAgent' });
		const manager = makeMockAgentManager(agent);

		const config = makeResolveConfig({
			task: makeTask({ customAgentId: 'agent-1' }),
			agentManager: manager,
		});

		const init = resolveAgentInit(config);

		expect(init.sessionId).toBe('session-resolve');
		expect(init.type).toBe('worker');
		expect(init.systemPrompt?.append).toContain('MyAgent');
	});

	it('always calls createCustomAgentInit — no builtin fork', () => {
		// A preset/seeded agent is just a regular SpaceAgent record.
		// resolveAgentInit resolves it by ID identically to any other agent.
		const presetAgent = makeAgent({ id: 'preset-coder', name: 'Coder', role: 'coder' });
		const manager = makeMockAgentManager(presetAgent);

		const config = makeResolveConfig({
			task: makeTask({ customAgentId: 'preset-coder' }),
			agentManager: manager,
		});

		const init = resolveAgentInit(config);
		expect(init.sessionId).toBe('session-resolve');
		expect(init.systemPrompt?.append).toContain('Coder Agent');
	});

	it('throws when task has no agentId', () => {
		const config = makeResolveConfig({
			task: makeTask({ customAgentId: undefined }),
		});

		expect(() => resolveAgentInit(config)).toThrow('has no agentId');
	});

	it('throws when agent ID not found in manager', () => {
		const manager = makeMockAgentManager(null);

		const config = makeResolveConfig({
			task: makeTask({ customAgentId: 'missing-agent' }),
			agentManager: manager,
		});

		expect(() => resolveAgentInit(config)).toThrow('Agent not found: missing-agent');
	});

	it('passes workflowRun context to createCustomAgentInit', () => {
		const customAgent = makeAgent({ id: 'agent-1', name: 'CoderBot' });
		const manager = makeMockAgentManager(customAgent);
		const run = makeWorkflowRun({ title: 'Workflow Alpha' });

		const config = makeResolveConfig({
			task: makeTask({ customAgentId: 'agent-1' }),
			agentManager: manager,
			workflowRun: run,
		});

		// Should not throw and should produce an init with the workflowRun available
		const init = resolveAgentInit(config);
		expect(init.sessionId).toBe('session-resolve');
	});

	it('passes previousTaskSummaries to createCustomAgentInit', () => {
		const customAgent = makeAgent({ id: 'agent-1' });
		const manager = makeMockAgentManager(customAgent);

		const config = makeResolveConfig({
			task: makeTask({ customAgentId: 'agent-1' }),
			agentManager: manager,
			previousTaskSummaries: ['Summary of task A'],
		});

		const init = resolveAgentInit(config);
		expect(init.sessionId).toBe('session-resolve');
	});
});

// ============================================================================
// SpaceAgent.tools field via repository (integration-style)
// ============================================================================

describe('SpaceAgent tools field', () => {
	it('agent with tools set has tools on the object', () => {
		const agent = makeAgent({ tools: ['Read', 'Bash'] });
		expect(agent.tools).toEqual(['Read', 'Bash']);
	});

	it('agent without tools has tools as undefined', () => {
		const agent = makeAgent({ tools: undefined });
		expect(agent.tools).toBeUndefined();
	});

	it('createCustomAgentInit wires tools into agents map when set', () => {
		const config = makeConfig({
			customAgent: makeAgent({ tools: ['Read', 'Bash', 'Grep'], name: 'ToolBot' }),
		});
		const init = createCustomAgentInit(config);
		expect(init.agents?.['toolbot']?.tools).toEqual(['Read', 'Bash', 'Grep']);
	});

	it('createCustomAgentInit uses simple path when agent tools is empty array', () => {
		const config = makeConfig({
			customAgent: makeAgent({ tools: [] }),
		});
		const init = createCustomAgentInit(config);
		expect(init.agents).toBeUndefined();
	});
});

// ============================================================================
// sanitizeAgentKey edge cases (via observable init.agent key)
// ============================================================================

describe('sanitizeAgentKey (via init.agent)', () => {
	function initWithName(name: string): ReturnType<typeof createCustomAgentInit> {
		return createCustomAgentInit(makeConfig({ customAgent: makeAgent({ name, tools: ['Read'] }) }));
	}

	it('lowercases the name', () => {
		expect(initWithName('MyBot').agent).toBe('mybot');
	});

	it('replaces spaces with hyphens', () => {
		expect(initWithName('My Agent').agent).toBe('my-agent');
	});

	it('collapses consecutive non-alphanumeric chars to a single hyphen', () => {
		expect(initWithName('foo  --  bar').agent).toBe('foo-bar');
	});

	it('strips leading and trailing hyphens', () => {
		expect(initWithName('---agent---').agent).toBe('agent');
	});

	it('truncates to 40 chars', () => {
		const longName = 'a'.repeat(50);
		expect(initWithName(longName).agent).toBe('a'.repeat(40));
	});

	it('falls back to custom-agent when name is all special characters', () => {
		expect(initWithName('!!!###').agent).toBe('custom-agent');
	});

	it('handles Unicode/emoji gracefully (strips to fallback)', () => {
		expect(initWithName('🤖🔥').agent).toBe('custom-agent');
	});
});
