/**
 * Custom Agent Factory Unit Tests
 *
 * Tests for buildCustomAgentSystemPrompt, buildCustomAgentTaskMessage,
 * createCustomAgentInit, and resolveAgentInit.
 */

import { describe, it, expect, mock } from 'bun:test';
import {
	buildCustomAgentSystemPrompt,
	buildReviewerNodeAgentPrompt,
	buildCustomAgentTaskMessage,
	buildPlannerNodeAgentPrompt,
	buildQaNodeAgentPrompt,
	createCustomAgentInit,
	resolveAgentInit,
	type CustomAgentConfig,
	type ResolveAgentInitConfig,
} from '../../../src/lib/space/agents/custom-agent';
import type { SpaceAgent, SpaceTask, SpaceWorkflow, SpaceWorkflowRun, Space } from '@neokai/shared';
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
		taskNumber: 1,
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
		iterationCount: 0,
		maxIterations: 5,
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

	it('includes peer communication section with list_peers and send_message', () => {
		const agent = makeAgent();
		const prompt = buildCustomAgentSystemPrompt(agent);
		expect(prompt).toContain('Peer Communication');
		expect(prompt).toContain('list_peers');
		expect(prompt).toContain('send_message');
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
// buildReviewerNodeAgentPrompt
// ============================================================================

describe('buildReviewerNodeAgentPrompt', () => {
	it('identifies agent as a Reviewer Agent', () => {
		const agent = makeAgent({ name: 'PRBot', role: 'reviewer' });
		const prompt = buildReviewerNodeAgentPrompt(agent);
		expect(prompt).toContain('PRBot');
		expect(prompt).toContain('Reviewer Agent');
	});

	it('includes custom systemPrompt when provided', () => {
		const agent = makeAgent({ role: 'reviewer', systemPrompt: 'Focus on security.' });
		const prompt = buildReviewerNodeAgentPrompt(agent);
		expect(prompt).toContain('Focus on security.');
		expect(prompt).toContain('Agent Instructions');
	});

	it('omits Agent Instructions section when systemPrompt is unset', () => {
		const agent = makeAgent({ role: 'reviewer', systemPrompt: undefined });
		const prompt = buildReviewerNodeAgentPrompt(agent);
		expect(prompt).not.toContain('Agent Instructions');
	});

	it('uses list_gates to discover nodeId, does not mention read_gate', () => {
		const agent = makeAgent({ role: 'reviewer' });
		const prompt = buildReviewerNodeAgentPrompt(agent);
		// nodeId is returned by list_gates, NOT read_gate — prompt must use list_gates
		expect(prompt).toContain('list_gates');
		expect(prompt).toContain('nodeId');
		// read_gate does NOT return nodeId; remove it to avoid LLM confusion
		expect(prompt).not.toContain('read_gate');
	});

	it('retrieves PR URL from list_gates response (code-pr-gate currentData)', () => {
		const agent = makeAgent({ role: 'reviewer' });
		const prompt = buildReviewerNodeAgentPrompt(agent);
		expect(prompt).toContain('code-pr-gate');
		expect(prompt).toContain('currentData');
	});

	it('includes review process steps', () => {
		const agent = makeAgent({ role: 'reviewer' });
		const prompt = buildReviewerNodeAgentPrompt(agent);
		expect(prompt).toContain('gh pr diff');
		expect(prompt).toContain('Evaluate the changes');
	});

	it('includes P0/P1/P2/P3 severity classification', () => {
		const agent = makeAgent({ role: 'reviewer' });
		const prompt = buildReviewerNodeAgentPrompt(agent);
		expect(prompt).toContain('Severity Classification');
		expect(prompt).toContain('P0');
		expect(prompt).toContain('P1');
		expect(prompt).toContain('P2');
		expect(prompt).toContain('P3');
	});

	it('includes PR review posting via GitHub REST API', () => {
		const agent = makeAgent({ role: 'reviewer' });
		const prompt = buildReviewerNodeAgentPrompt(agent);
		expect(prompt).toContain('gh api repos/{owner}/{repo}/pulls/{pr_number}/reviews');
		expect(prompt).toContain('--method POST');
		expect(prompt).toContain('APPROVE');
		expect(prompt).toContain('REQUEST_CHANGES');
	});

	it('includes guidance for API failure handling', () => {
		const agent = makeAgent({ role: 'reviewer' });
		const prompt = buildReviewerNodeAgentPrompt(agent);
		expect(prompt).toContain('ERROR');
	});

	it('includes ---REVIEW_POSTED--- and ---END_REVIEW_POSTED--- structured output block', () => {
		const agent = makeAgent({ role: 'reviewer' });
		const prompt = buildReviewerNodeAgentPrompt(agent);
		expect(prompt).toContain('---REVIEW_POSTED---');
		expect(prompt).toContain('---END_REVIEW_POSTED---');
	});

	it('structured output uses flat key-value format with p0/p1/p2/p3 fields', () => {
		const agent = makeAgent({ role: 'reviewer' });
		const prompt = buildReviewerNodeAgentPrompt(agent);
		// Flat format — NOT JSON with severityCounts
		expect(prompt).toContain('p0:');
		expect(prompt).toContain('p1:');
		expect(prompt).toContain('p2:');
		expect(prompt).toContain('p3:');
		expect(prompt).toContain('summary:');
		expect(prompt).toContain('url:');
		expect(prompt).toContain('recommendation:');
		// Should NOT use old nested JSON format
		expect(prompt).not.toContain('"severityCounts"');
		expect(prompt).not.toContain('"critical"');
	});

	it('recommendation vocabulary is APPROVE / REQUEST_CHANGES (uppercase), not approve/reject', () => {
		const agent = makeAgent({ role: 'reviewer' });
		const prompt = buildReviewerNodeAgentPrompt(agent);
		// Flat block: recommendation: APPROVE | REQUEST_CHANGES
		expect(prompt).toContain('recommendation: APPROVE | REQUEST_CHANGES');
		// Should NOT use lowercase "approve"/"reject" as recommendation values
		expect(prompt).not.toContain('"recommendation": "approve"');
		expect(prompt).not.toContain('"recommendation": "reject"');
	});

	it('includes gate interaction: write vote to review-votes-gate using nodeId', () => {
		const agent = makeAgent({ role: 'reviewer' });
		const prompt = buildReviewerNodeAgentPrompt(agent);
		expect(prompt).toContain('review-votes-gate');
		expect(prompt).toContain('write_gate');
		expect(prompt).toContain('"votes"');
		expect(prompt).toContain('"approve"');
		expect(prompt).toContain('"reject"');
	});

	it('idempotency check comes before any action (Step 1 position)', () => {
		const agent = makeAgent({ role: 'reviewer' });
		const prompt = buildReviewerNodeAgentPrompt(agent);
		expect(prompt).toContain('Idempotency Check');
		expect(prompt).toContain('already voted');
		// Idempotency section must appear before the PR review posting section
		const idempotencyPos = prompt.indexOf('Idempotency Check');
		const postReviewPos = prompt.indexOf('Post the PR Review');
		expect(idempotencyPos).toBeLessThan(postReviewPos);
	});

	it('list_gates call appears in idempotency section (nodeId discovery is part of idempotency)', () => {
		const agent = makeAgent({ role: 'reviewer' });
		const prompt = buildReviewerNodeAgentPrompt(agent);
		// The idempotency section tells agent to call list_gates to get nodeId
		const idempotencyPos = prompt.indexOf('Idempotency Check');
		const listGatesPos = prompt.indexOf('list_gates');
		expect(idempotencyPos).toBeGreaterThanOrEqual(0);
		expect(listGatesPos).toBeGreaterThan(idempotencyPos);
	});

	it('includes peer communication section with all target modes including multicast', () => {
		const agent = makeAgent({ role: 'reviewer' });
		const prompt = buildReviewerNodeAgentPrompt(agent);
		expect(prompt).toContain('Peer Communication');
		expect(prompt).toContain('send_message');
		expect(prompt).toContain('list_peers');
		// Must include multicast target form
		expect(prompt).toContain("['role1', 'role2']");
	});

	it('includes completion signalling via report_done', () => {
		const agent = makeAgent({ role: 'reviewer' });
		const prompt = buildReviewerNodeAgentPrompt(agent);
		expect(prompt).toContain('Signalling Completion');
		expect(prompt).toContain('report_done');
	});

	it('does NOT include git commit/push workflow instructions', () => {
		const agent = makeAgent({ role: 'reviewer' });
		const prompt = buildReviewerNodeAgentPrompt(agent);
		expect(prompt).not.toContain('Git Workflow (MANDATORY)');
		expect(prompt).not.toContain('git push -u origin HEAD');
		expect(prompt).not.toContain('gh pr create');
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

	it('builds correct init for reviewer role (uses reviewer-specific prompt)', () => {
		const config = makeConfig({
			customAgent: makeAgent({ role: 'reviewer', name: 'CodeReviewer' }),
		});
		const init = createCustomAgentInit(config);

		expect(init.type).toBe('worker');
		expect(init.systemPrompt?.append).toContain('Reviewer Agent');
		// Reviewer prompt contains gate interaction instructions, not generic git workflow
		expect(init.systemPrompt?.append).toContain('code-pr-gate');
		expect(init.systemPrompt?.append).toContain('review-votes-gate');
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

	// Provider inference tests — verifies the fix for the missing provider bug
	it('always sets provider on simple-path init (Anthropic model)', () => {
		const config = makeConfig({
			customAgent: makeAgent({ model: 'claude-sonnet-4-5-20250929' }),
		});
		const init = createCustomAgentInit(config);
		expect(init.provider).toBe('anthropic');
	});

	it('always sets provider on simple-path init (GLM model)', () => {
		const config = makeConfig({
			customAgent: makeAgent({ model: 'glm-4-flash' }),
		});
		const init = createCustomAgentInit(config);
		expect(init.provider).toBe('glm');
	});

	it('always sets provider on agent/agents-path init', () => {
		const config = makeConfig({
			customAgent: makeAgent({ model: 'claude-opus-4-6', tools: ['Read', 'Bash'] }),
		});
		const init = createCustomAgentInit(config);
		expect(init.provider).toBe('anthropic');
	});

	it('inherits provider from space.defaultModel when agent model is unset', () => {
		const config = makeConfig({
			customAgent: makeAgent({ model: undefined }),
			space: makeSpace({ defaultModel: 'glm-5-turbo' }),
		});
		const init = createCustomAgentInit(config);
		expect(init.provider).toBe('glm');
	});

	it('never produces undefined provider (always falls back to hardcoded default)', () => {
		const config = makeConfig({
			customAgent: makeAgent({ model: undefined }),
			space: makeSpace({ defaultModel: undefined }),
		});
		const init = createCustomAgentInit(config);
		expect(init.provider).toBeDefined();
		expect(typeof init.provider).toBe('string');
		expect(init.provider!.length).toBeGreaterThan(0);
	});
});

// ============================================================================
// createCustomAgentInit — slot overrides
// ============================================================================

describe('createCustomAgentInit — slotOverrides', () => {
	it('model override replaces agent default model', () => {
		const config = makeConfig({
			customAgent: makeAgent({ model: 'claude-sonnet-4-5-20250929' }),
			slotOverrides: { model: 'claude-haiku-4-5-20251001' },
		});
		const init = createCustomAgentInit(config);
		expect(init.model).toBe('claude-haiku-4-5-20251001');
	});

	it('model override replaces space default model', () => {
		const config = makeConfig({
			customAgent: makeAgent({ model: undefined }),
			space: makeSpace({ defaultModel: 'claude-sonnet-4-5-20250929' }),
			slotOverrides: { model: 'claude-opus-4-6' },
		});
		const init = createCustomAgentInit(config);
		expect(init.model).toBe('claude-opus-4-6');
	});

	it('model override sets correct provider', () => {
		const config = makeConfig({
			customAgent: makeAgent({ model: 'claude-sonnet-4-5-20250929' }),
			slotOverrides: { model: 'glm-4-flash' },
		});
		const init = createCustomAgentInit(config);
		expect(init.model).toBe('glm-4-flash');
		expect(init.provider).toBe('glm');
	});

	it('systemPrompt override replaces agent default system prompt', () => {
		const config = makeConfig({
			customAgent: makeAgent({ systemPrompt: 'Original agent instructions.' }),
			slotOverrides: { systemPrompt: 'Override: focus on security.' },
		});
		const init = createCustomAgentInit(config);
		// The override should appear in the append/prompt
		const promptText = init.systemPrompt?.append ?? '';
		expect(promptText).toContain('Override: focus on security.');
		expect(promptText).not.toContain('Original agent instructions.');
	});

	it('systemPrompt override replaces agent prompt in Agent Instructions section', () => {
		const config = makeConfig({
			customAgent: makeAgent({ systemPrompt: 'Base instructions.' }),
			slotOverrides: { systemPrompt: 'Slot-specific instructions.' },
		});
		const init = createCustomAgentInit(config);
		const promptText = init.systemPrompt?.append ?? '';
		expect(promptText).toContain('Agent Instructions');
		expect(promptText).toContain('Slot-specific instructions.');
	});

	it('empty string systemPrompt override removes agent instructions section', () => {
		const config = makeConfig({
			customAgent: makeAgent({ systemPrompt: 'Some instructions.' }),
			slotOverrides: { systemPrompt: '' },
		});
		const init = createCustomAgentInit(config);
		const promptText = init.systemPrompt?.append ?? '';
		// Empty override → the Agent Instructions section is not included
		// (buildCustomAgentSystemPrompt only adds it when systemPrompt is truthy)
		expect(promptText).not.toContain('Some instructions.');
	});

	it('undefined slotOverrides leaves base agent model unchanged', () => {
		const config = makeConfig({
			customAgent: makeAgent({ model: 'claude-opus-4-6' }),
			slotOverrides: undefined,
		});
		const init = createCustomAgentInit(config);
		expect(init.model).toBe('claude-opus-4-6');
	});

	it('undefined slotOverrides leaves base agent system prompt unchanged', () => {
		const config = makeConfig({
			customAgent: makeAgent({ systemPrompt: 'Base prompt.' }),
			slotOverrides: undefined,
		});
		const init = createCustomAgentInit(config);
		const promptText = init.systemPrompt?.append ?? '';
		expect(promptText).toContain('Base prompt.');
	});

	it('partial override: only model provided leaves systemPrompt from agent', () => {
		const config = makeConfig({
			customAgent: makeAgent({
				model: 'claude-sonnet-4-5-20250929',
				systemPrompt: 'Agent prompt.',
			}),
			slotOverrides: { model: 'claude-haiku-4-5-20251001' },
		});
		const init = createCustomAgentInit(config);
		expect(init.model).toBe('claude-haiku-4-5-20251001');
		const promptText = init.systemPrompt?.append ?? '';
		expect(promptText).toContain('Agent prompt.');
	});

	it('partial override: only systemPrompt provided leaves model from agent', () => {
		const config = makeConfig({
			customAgent: makeAgent({ model: 'claude-opus-4-6', systemPrompt: 'Agent prompt.' }),
			slotOverrides: { systemPrompt: 'Slot prompt.' },
		});
		const init = createCustomAgentInit(config);
		expect(init.model).toBe('claude-opus-4-6');
		const promptText = init.systemPrompt?.append ?? '';
		expect(promptText).toContain('Slot prompt.');
		expect(promptText).not.toContain('Agent prompt.');
	});

	it('model override works with agent/agents path (custom tools)', () => {
		const config = makeConfig({
			customAgent: makeAgent({ model: 'claude-sonnet-4-5-20250929', tools: ['Read', 'Bash'] }),
			slotOverrides: { model: 'claude-haiku-4-5-20251001' },
		});
		const init = createCustomAgentInit(config);
		expect(init.model).toBe('claude-haiku-4-5-20251001');
		// Still uses agent/agents path
		expect(init.agents).toBeDefined();
	});

	it('systemPrompt override works with agent/agents path (custom tools) — override lands in agents[key].prompt', () => {
		// When SpaceAgent.tools is set, createCustomAgentInit uses the agent/agents pattern.
		// The behavioral prompt (including the systemPrompt override) is placed in
		// agentDef.prompt, NOT in init.systemPrompt.append — this code path must be tested
		// separately from the simple (no-tools) path.
		const config = makeConfig({
			customAgent: makeAgent({
				name: 'CodeReviewer',
				tools: ['Read', 'Bash'],
				systemPrompt: 'Original agent instructions.',
			}),
			slotOverrides: { systemPrompt: 'Slot-level security focus.' },
		});
		const init = createCustomAgentInit(config);
		// Must use agent/agents path
		expect(init.agents).toBeDefined();
		// systemPrompt.append is not used on this path
		expect(init.systemPrompt?.append).toBeUndefined();
		// The override must appear in agentDef.prompt
		const agentKey = Object.keys(init.agents!)[0];
		const agentDef = init.agents![agentKey];
		expect(agentDef?.prompt).toContain('Slot-level security focus.');
		expect(agentDef?.prompt).not.toContain('Original agent instructions.');
	});
});

// ============================================================================
// resolveAgentInit — slot overrides pass-through
// ============================================================================

describe('resolveAgentInit — slotOverrides pass-through', () => {
	function makeMockAgentManagerForOverrides(agent: SpaceAgent | null): SpaceAgentManager {
		return {
			getById: mock(() => agent),
		} as unknown as SpaceAgentManager;
	}

	function makeResolveConfigWithOverrides(
		overrides?: Partial<ResolveAgentInitConfig>
	): ResolveAgentInitConfig {
		return {
			task: makeTask({ customAgentId: 'agent-1' }),
			space: makeSpace(),
			agentManager: makeMockAgentManagerForOverrides(makeAgent({ id: 'agent-1' })),
			sessionId: 'session-override-test',
			workspacePath: '/workspace/project',
			workflowRun: null,
			...overrides,
		};
	}

	it('slotOverrides model is applied to the resolved session init', () => {
		const agent = makeAgent({ id: 'agent-1', model: 'claude-sonnet-4-5-20250929' });
		const config = makeResolveConfigWithOverrides({
			agentManager: makeMockAgentManagerForOverrides(agent),
			slotOverrides: { model: 'claude-haiku-4-5-20251001' },
		});
		const init = resolveAgentInit(config);
		expect(init.model).toBe('claude-haiku-4-5-20251001');
	});

	it('slotOverrides systemPrompt is applied to the resolved session init', () => {
		const agent = makeAgent({ id: 'agent-1', systemPrompt: 'Base prompt.' });
		const config = makeResolveConfigWithOverrides({
			agentManager: makeMockAgentManagerForOverrides(agent),
			slotOverrides: { systemPrompt: 'Slot-specific override.' },
		});
		const init = resolveAgentInit(config);
		const promptText = init.systemPrompt?.append ?? '';
		expect(promptText).toContain('Slot-specific override.');
		expect(promptText).not.toContain('Base prompt.');
	});

	it('no slotOverrides means base agent config is used unchanged', () => {
		const agent = makeAgent({ id: 'agent-1', model: 'claude-opus-4-6', systemPrompt: 'Base.' });
		const config = makeResolveConfigWithOverrides({
			agentManager: makeMockAgentManagerForOverrides(agent),
		});
		const init = resolveAgentInit(config);
		expect(init.model).toBe('claude-opus-4-6');
		const promptText = init.systemPrompt?.append ?? '';
		expect(promptText).toContain('Base.');
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

	it('accepts workflow field in ResolveAgentInitConfig and does not throw', () => {
		const agent = makeAgent({ id: 'agent-1', injectWorkflowContext: true });
		const manager = makeMockAgentManager(agent);
		const run = makeWorkflowRun();
		const wf = makeWorkflow();

		const config = makeResolveConfig({
			task: makeTask({ customAgentId: 'agent-1' }),
			agentManager: manager,
			workflowRun: run,
			workflow: wf,
		});

		// Should not throw — workflow is now a valid field on ResolveAgentInitConfig
		expect(() => resolveAgentInit(config)).not.toThrow();
	});

	it('workflow field from ResolveAgentInitConfig flows into task message via injectWorkflowContext', () => {
		// Model the SpaceRuntime M4 contract:
		//   1. Caller builds a ResolveAgentInitConfig with workflow + workflowRun
		//   2. resolveAgentInit() produces the session AgentSessionInit
		//   3. SpaceRuntime then calls buildCustomAgentTaskMessage using the same
		//      fields from the resolve config (task, customAgent, workflowRun, workflow, space)
		//
		// The agent has injectWorkflowContext: true — the data-driven gate that
		// controls whether the Workflow Structure section is emitted. This is no
		// longer driven by a hardcoded role check.
		const workflowAgent = makeAgent({ id: 'agent-1', injectWorkflowContext: true });
		const manager = makeMockAgentManager(workflowAgent);
		const run = makeWorkflowRun();
		const wf = makeWorkflow();

		// Step 1+2: resolve session init — workflow is now a field on ResolveAgentInitConfig
		const resolveConfig = makeResolveConfig({
			task: makeTask({ customAgentId: 'agent-1' }),
			agentManager: manager,
			workflowRun: run,
			workflow: wf,
			space: makeSpace(),
		});
		const sessionInit = resolveAgentInit(resolveConfig);

		// Step 3: build the task message from the SAME config fields, as SpaceRuntime M4 would.
		// The resolved agent is the one the agentManager returned (injectWorkflowContext: true).
		const msg = buildCustomAgentTaskMessage({
			customAgent: workflowAgent, // agent resolved by resolveAgentInit internally
			task: resolveConfig.task,
			workflowRun: resolveConfig.workflowRun ?? null,
			workflow: resolveConfig.workflow ?? null, // ← same workflow from resolve config
			space: resolveConfig.space,
			sessionId: sessionInit.sessionId,
			workspacePath: resolveConfig.workspacePath,
		});

		expect(msg).toContain('Workflow Structure');
		expect(msg).toContain('Coding Workflow');
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

// ============================================================================
// buildCustomAgentTaskMessage — planner workflow context
// ============================================================================

function makeWorkflow(overrides?: Partial<SpaceWorkflow>): SpaceWorkflow {
	return {
		id: 'wf-1',
		spaceId: 'space-1',
		name: 'Coding Workflow',
		description: 'Plan, implement, and review code',
		nodes: [
			{ id: 'step-plan', name: 'Plan', agentId: 'agent-planner', instructions: 'Create a plan' },
			{ id: 'step-code', name: 'Code', agentId: 'agent-coder', instructions: 'Write code' },
		],
		transitions: [],
		startNodeId: 'step-plan',
		rules: [{ id: 'rule-1', name: 'No direct commits', content: 'Always use a PR' }],
		tags: ['coding'],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

describe('buildCustomAgentTaskMessage — workflow context injection', () => {
	it('includes workflow structure when injectWorkflowContext is true and workflow is provided', () => {
		const config = makeConfig({
			customAgent: makeAgent({ injectWorkflowContext: true }),
			workflowRun: makeWorkflowRun(),
			workflow: makeWorkflow(),
		});

		const msg = buildCustomAgentTaskMessage(config);

		expect(msg).toContain('Workflow Structure');
		expect(msg).toContain('Coding Workflow');
		expect(msg).toContain('Plan, implement, and review code');
	});

	it('includes step names in workflow structure', () => {
		const config = makeConfig({
			customAgent: makeAgent({ injectWorkflowContext: true }),
			workflowRun: makeWorkflowRun(),
			workflow: makeWorkflow(),
		});

		const msg = buildCustomAgentTaskMessage(config);

		expect(msg).toContain('Plan');
		expect(msg).toContain('Code');
	});

	it('marks the current step', () => {
		const config = makeConfig({
			customAgent: makeAgent({ injectWorkflowContext: true }),
			workflowRun: makeWorkflowRun(),
			workflow: makeWorkflow(),
		});

		const msg = buildCustomAgentTaskMessage(config);

		expect(msg).toContain('current step');
		expect(msg).toContain('step-plan');
	});

	it('includes workflow rules', () => {
		const config = makeConfig({
			customAgent: makeAgent({ injectWorkflowContext: true }),
			workflowRun: makeWorkflowRun(),
			workflow: makeWorkflow(),
		});

		const msg = buildCustomAgentTaskMessage(config);

		expect(msg).toContain('No direct commits');
		expect(msg).toContain('Always use a PR');
	});

	it('does NOT include workflow structure when injectWorkflowContext is false (data-driven gate)', () => {
		// Any agent without injectWorkflowContext — regardless of role — receives no workflow structure.
		// Role is not checked; only the injectWorkflowContext flag matters.
		const config = makeConfig({
			customAgent: makeAgent({ role: 'coder', injectWorkflowContext: false }),
			workflowRun: makeWorkflowRun(),
			workflow: makeWorkflow(),
		});

		const msg = buildCustomAgentTaskMessage(config);

		expect(msg).not.toContain('Workflow Structure');
	});

	it('does NOT include workflow structure when injectWorkflowContext is undefined', () => {
		const config = makeConfig({
			customAgent: makeAgent({ injectWorkflowContext: undefined }),
			workflowRun: makeWorkflowRun(),
			workflow: makeWorkflow(),
		});

		const msg = buildCustomAgentTaskMessage(config);

		expect(msg).not.toContain('Workflow Structure');
	});

	it('does NOT include workflow structure when workflow is null', () => {
		const config = makeConfig({
			customAgent: makeAgent({ injectWorkflowContext: true }),
			workflowRun: makeWorkflowRun(),
			workflow: null,
		});

		const msg = buildCustomAgentTaskMessage(config);

		expect(msg).not.toContain('Workflow Structure');
	});

	it('does NOT include workflow structure when workflowRun is null', () => {
		const config = makeConfig({
			customAgent: makeAgent({ injectWorkflowContext: true }),
			workflowRun: null,
			workflow: makeWorkflow(),
		});

		const msg = buildCustomAgentTaskMessage(config);

		expect(msg).not.toContain('Workflow Structure');
	});

	it('includes workflow guidance to focus on current step first', () => {
		const config = makeConfig({
			customAgent: makeAgent({ injectWorkflowContext: true }),
			workflowRun: makeWorkflowRun(),
			workflow: makeWorkflow(),
		});

		const msg = buildCustomAgentTaskMessage(config);

		expect(msg).toContain('current step first');
	});

	it('handles workflow with no description gracefully', () => {
		const config = makeConfig({
			customAgent: makeAgent({ injectWorkflowContext: true }),
			workflowRun: makeWorkflowRun(),
			workflow: makeWorkflow({ description: undefined }),
		});

		expect(() => buildCustomAgentTaskMessage(config)).not.toThrow();
	});

	it('handles workflow with no rules gracefully', () => {
		const config = makeConfig({
			customAgent: makeAgent({ injectWorkflowContext: true }),
			workflowRun: makeWorkflowRun(),
			workflow: makeWorkflow({ rules: [] }),
		});

		const msg = buildCustomAgentTaskMessage(config);
		expect(msg).toContain('Workflow Structure');
		expect(msg).not.toContain('Workflow rules:');
	});

	it('handles workflow with no steps gracefully', () => {
		const config = makeConfig({
			customAgent: makeAgent({ injectWorkflowContext: true }),
			workflowRun: makeWorkflowRun(),
			workflow: makeWorkflow({ nodes: [] }),
		});

		expect(() => buildCustomAgentTaskMessage(config)).not.toThrow();
	});

	it('any role can receive workflow context when injectWorkflowContext is true', () => {
		// Proves the check is data-driven — a 'reviewer' agent with the flag set
		// receives the same workflow structure as a 'planner' would.
		const config = makeConfig({
			customAgent: makeAgent({ role: 'reviewer', injectWorkflowContext: true }),
			workflowRun: makeWorkflowRun(),
			workflow: makeWorkflow(),
		});

		const msg = buildCustomAgentTaskMessage(config);

		expect(msg).toContain('Workflow Structure');
	});
});

// ============================================================================
// buildPlannerNodeAgentPrompt
// ============================================================================

describe('buildPlannerNodeAgentPrompt', () => {
	it('returns a non-empty string', () => {
		const prompt = buildPlannerNodeAgentPrompt();
		expect(typeof prompt).toBe('string');
		expect(prompt.length).toBeGreaterThan(0);
	});

	it('includes plan document creation instructions', () => {
		const prompt = buildPlannerNodeAgentPrompt();
		expect(prompt).toContain('Planner Responsibilities');
		expect(prompt).toContain('plan document');
		expect(prompt).toContain('docs/plans/');
	});

	it('includes codebase exploration instructions', () => {
		const prompt = buildPlannerNodeAgentPrompt();
		expect(prompt).toContain('explore the codebase');
	});

	it('includes plan document structure guidance', () => {
		const prompt = buildPlannerNodeAgentPrompt();
		expect(prompt).toContain('Objective');
		expect(prompt).toContain('Approach');
		expect(prompt).toContain('Test strategy');
	});

	it('instructs to commit, push, and open a plan PR', () => {
		const prompt = buildPlannerNodeAgentPrompt();
		expect(prompt).toContain('plan PR');
		expect(prompt).toContain('plan:');
	});

	it('instructs to call write_gate with plan-pr-gate', () => {
		const prompt = buildPlannerNodeAgentPrompt();
		expect(prompt).toContain('write_gate');
		expect(prompt).toContain('plan-pr-gate');
	});

	it('specifies the required gate data fields: prUrl, prNumber, branch', () => {
		const prompt = buildPlannerNodeAgentPrompt();
		expect(prompt).toContain('prUrl');
		expect(prompt).toContain('prNumber');
		expect(prompt).toContain('branch');
	});

	it('explains the gate condition (prUrl exists)', () => {
		const prompt = buildPlannerNodeAgentPrompt();
		expect(prompt).toContain('prUrl exists');
	});

	it('instructs to notify reviewers via send_message', () => {
		const prompt = buildPlannerNodeAgentPrompt();
		expect(prompt).toContain('send_message');
		expect(prompt).toContain('reviewer');
	});

	it('send_message example uses "message" field (not "text")', () => {
		const prompt = buildPlannerNodeAgentPrompt();
		expect(prompt).toContain('"message"');
		expect(prompt).not.toContain('"text"');
	});

	it('mentions workflow structure alignment (step 5)', () => {
		const prompt = buildPlannerNodeAgentPrompt();
		expect(prompt).toContain('Workflow Structure');
		expect(prompt).toContain('Step 5');
	});
});

// ============================================================================
// buildCustomAgentSystemPrompt — planner role integration
// ============================================================================

describe('buildCustomAgentSystemPrompt planner integration', () => {
	it('includes planner-specific sections for planner role', () => {
		const agent = makeAgent({ role: 'planner', name: 'Planner' });
		const prompt = buildCustomAgentSystemPrompt(agent);
		expect(prompt).toContain('Planner Responsibilities');
		expect(prompt).toContain('plan-pr-gate');
		expect(prompt).toContain('write_gate');
	});

	it('does NOT include planner sections for coder role', () => {
		const agent = makeAgent({ role: 'coder', name: 'Coder' });
		const prompt = buildCustomAgentSystemPrompt(agent);
		expect(prompt).not.toContain('Planner Responsibilities');
		expect(prompt).not.toContain('plan-pr-gate');
	});

	it('does NOT include planner sections for reviewer role', () => {
		const agent = makeAgent({ role: 'reviewer', name: 'Reviewer' });
		const prompt = buildCustomAgentSystemPrompt(agent);
		expect(prompt).not.toContain('Planner Responsibilities');
		expect(prompt).not.toContain('plan-pr-gate');
	});

	it('does NOT include planner sections for qa role', () => {
		const agent = makeAgent({ role: 'qa', name: 'QA' });
		const prompt = buildCustomAgentSystemPrompt(agent);
		expect(prompt).not.toContain('Planner Responsibilities');
		expect(prompt).not.toContain('plan-pr-gate');
	});

	it('planner prompt still includes mandatory git workflow', () => {
		const agent = makeAgent({ role: 'planner', name: 'Planner' });
		const prompt = buildCustomAgentSystemPrompt(agent);
		expect(prompt).toContain('Git Workflow (MANDATORY)');
		expect(prompt).toContain('git push -u origin HEAD');
	});

	it('planner prompt still includes completion signalling', () => {
		const agent = makeAgent({ role: 'planner', name: 'Planner' });
		const prompt = buildCustomAgentSystemPrompt(agent);
		expect(prompt).toContain('Signalling Completion');
		expect(prompt).toContain('report_done');
	});

	it('planner prompt still includes peer communication', () => {
		const agent = makeAgent({ role: 'planner', name: 'Planner' });
		const prompt = buildCustomAgentSystemPrompt(agent);
		expect(prompt).toContain('Peer Communication');
		expect(prompt).toContain('list_peers');
	});

	it('planner-specific sections appear before completion signalling', () => {
		const agent = makeAgent({ role: 'planner', name: 'Planner' });
		const prompt = buildCustomAgentSystemPrompt(agent);
		const plannerIdx = prompt.indexOf('Planner Responsibilities');
		const completionIdx = prompt.indexOf('Signalling Completion');
		expect(plannerIdx).toBeLessThan(completionIdx);
	});
});

// ============================================================================
// buildQaNodeAgentPrompt
// ============================================================================

describe('buildQaNodeAgentPrompt', () => {
	it('returns a non-empty string', () => {
		const prompt = buildQaNodeAgentPrompt();
		expect(typeof prompt).toBe('string');
		expect(prompt.length).toBeGreaterThan(0);
	});

	it('includes role and responsibility description', () => {
		const prompt = buildQaNodeAgentPrompt();
		expect(prompt).toContain('QA Agent');
		expect(prompt).toContain('verify');
	});

	it('includes gh CLI auth verification step', () => {
		const prompt = buildQaNodeAgentPrompt();
		expect(prompt).toContain('gh auth status');
		expect(prompt).toContain('not authenticated');
	});

	it('includes read_gate instruction for code-pr-gate', () => {
		const prompt = buildQaNodeAgentPrompt();
		expect(prompt).toContain('read_gate');
		expect(prompt).toContain('code-pr-gate');
		expect(prompt).toContain('prUrl');
	});

	it('includes test command detection for package.json', () => {
		const prompt = buildQaNodeAgentPrompt();
		expect(prompt).toContain('package.json');
	});

	it('includes test command detection for Makefile', () => {
		const prompt = buildQaNodeAgentPrompt();
		expect(prompt).toContain('Makefile');
	});

	it('includes CI pipeline check via gh pr checks', () => {
		const prompt = buildQaNodeAgentPrompt();
		expect(prompt).toContain('gh pr checks');
	});

	it('includes PR mergeability check via gh pr view', () => {
		const prompt = buildQaNodeAgentPrompt();
		expect(prompt).toContain('gh pr view');
		expect(prompt).toContain('mergeable');
		expect(prompt).toContain('mergeStateStatus');
	});

	it('includes merge conflict detection using git merge dry-run (not deprecated git merge-tree)', () => {
		const prompt = buildQaNodeAgentPrompt();
		expect(prompt).toContain('git merge --no-commit --no-ff');
		expect(prompt).toContain('git merge --abort');
		expect(prompt).toContain('CONFLICT');
		// Must NOT use the deprecated 3-argument git merge-tree form
		expect(prompt).not.toContain('git merge-tree $(git merge-base');
	});

	it('includes write_gate instruction for qa-result-gate', () => {
		const prompt = buildQaNodeAgentPrompt();
		expect(prompt).toContain('write_gate');
		expect(prompt).toContain('qa-result-gate');
	});

	it('specifies result field with passed and failed values', () => {
		const prompt = buildQaNodeAgentPrompt();
		expect(prompt).toContain('"passed"');
		expect(prompt).toContain('"failed"');
		expect(prompt).toContain('result');
	});

	it('specifies summary field in gate write', () => {
		const prompt = buildQaNodeAgentPrompt();
		expect(prompt).toContain('summary');
	});

	it('mentions gate check condition', () => {
		const prompt = buildQaNodeAgentPrompt();
		expect(prompt).toContain('check: result == passed');
	});

	it('includes VERIFICATION_COMPLETE bypass marker instruction', () => {
		const prompt = buildQaNodeAgentPrompt();
		expect(prompt).toContain('VERIFICATION_COMPLETE:');
	});

	it('explicitly warns not to create commits, push, or open PRs', () => {
		const prompt = buildQaNodeAgentPrompt();
		expect(prompt).toContain('NOT create commits');
		expect(prompt).toContain('push branches');
		expect(prompt).toContain('open pull requests');
	});

	it('references the Git Workflow MANDATORY section to explain bypass', () => {
		const prompt = buildQaNodeAgentPrompt();
		expect(prompt).toContain('Git Workflow (MANDATORY)');
	});

	it('includes structured QA output format', () => {
		const prompt = buildQaNodeAgentPrompt();
		expect(prompt).toContain('QA RESULT');
		expect(prompt).toContain('CI Pipeline');
		expect(prompt).toContain('PR Mergeability');
		expect(prompt).toContain('Blockers');
	});

	it('embeds into custom agent system prompt as Agent Instructions when set as systemPrompt', () => {
		const agent = makeAgent({ role: 'qa', systemPrompt: buildQaNodeAgentPrompt() });
		const fullPrompt = buildCustomAgentSystemPrompt(agent);
		expect(fullPrompt).toContain('Agent Instructions');
		expect(fullPrompt).toContain('QA Agent');
		expect(fullPrompt).toContain('code-pr-gate');
		expect(fullPrompt).toContain('qa-result-gate');
		// The assembled prompt must include the bypass marker so the agent knows to use it
		expect(fullPrompt).toContain('VERIFICATION_COMPLETE:');
	});

	it('assembled prompt does not instruct QA agent to commit code', () => {
		const agent = makeAgent({ role: 'qa', systemPrompt: buildQaNodeAgentPrompt() });
		const fullPrompt = buildCustomAgentSystemPrompt(agent);
		// The QA prompt must explicitly counter the git workflow section's commit instruction
		expect(fullPrompt).toContain('NOT create commits');
	});

	it('is deterministic — returns the same string on multiple calls', () => {
		const prompt1 = buildQaNodeAgentPrompt();
		const prompt2 = buildQaNodeAgentPrompt();
		expect(prompt1).toBe(prompt2);
	});
});
