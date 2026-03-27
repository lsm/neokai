/**
 * Reviewer and Leader Sub-Agent Configuration Tests
 *
 * Verifies that:
 * 1. Leader with SDK-based reviewer config includes Task tools in reviewer agent definitions
 * 2. Agents map always includes `reviewer-explorer` and `reviewer-fact-checker`
 * 3. Reviewer sub-agents (`reviewer-explorer`, `reviewer-fact-checker`) lack Task tools
 *    (enforcing one-level-max sub-agent depth)
 * 4. Leader without reviewer config still has built-in `leader-explorer` and
 *    `leader-fact-checker` sub-agents
 * 5. Leader always has `agent: 'Leader'` and `agents` map (no simple-path fallback)
 * 6. CLI-based reviewer configurations are structured correctly
 *
 * These tests verify the configuration contracts that govern the agent/agents pattern
 * for both leader and reviewer agents. They import the production functions directly
 * so the assertions reflect the exact configuration sent to the SDK at runtime.
 *
 * MODES:
 * - No real API calls required — tests verify static configuration
 * - Compatible with NEOKAI_USE_DEV_PROXY=1
 *
 * Run:
 *   bun test packages/daemon/tests/online/room/reviewer-leader-subagents.test.ts
 *   NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/room/reviewer-leader-subagents.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
	buildReviewerAgents,
	buildReviewerExplorerAgentDef,
	buildReviewerFactCheckerAgentDef,
	createLeaderAgentInit,
	type LeaderAgentConfig,
	type LeaderToolCallbacks,
} from '../../../src/lib/room/agents/leader-agent';
import type { Room, RoomGoal, NeoTask, AgentDefinition } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Minimal fixtures (no database or daemon required)
// ---------------------------------------------------------------------------

function makeRoom(config?: Room['config']): Room {
	return {
		id: 'room-test',
		name: 'Test Room',
		allowedPaths: [{ path: '/workspace', label: 'ws' }],
		defaultPath: '/workspace',
		sessionIds: [],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		config,
	};
}

function makeGoal(): RoomGoal {
	return {
		id: 'goal-test',
		roomId: 'room-test',
		title: 'Test Goal',
		description: 'A test goal',
		status: 'active',
		priority: 'normal',
		progress: 0,
		linkedTaskIds: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function makeTask(): NeoTask {
	return {
		id: 'task-test',
		roomId: 'room-test',
		title: 'Implement feature',
		description: 'A test task',
		status: 'in_progress',
		priority: 'normal',
		dependsOn: [],
		createdAt: Date.now(),
	};
}

function makeConfig(roomConfig?: Room['config']): LeaderAgentConfig {
	return {
		task: makeTask(),
		goal: makeGoal(),
		room: makeRoom(roomConfig),
		sessionId: 'leader:room-test:task-test',
		workspacePath: '/workspace',
		groupId: 'group-test',
	};
}

/** Minimal stub satisfying LeaderToolCallbacks — tests don't invoke tools */
function makeCallbacks(): LeaderToolCallbacks {
	const stub = async () => ({ content: [{ type: 'text' as const, text: '{}' }] });
	return {
		sendToWorker: stub,
		completeTask: stub,
		failTask: stub,
		replanGoal: stub,
		submitForReview: stub,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agentHasTool(def: AgentDefinition, tool: string): boolean {
	return Array.isArray(def.tools) && (def.tools as string[]).includes(tool);
}

function agentLacksTaskTools(def: AgentDefinition): boolean {
	const taskTools = ['Task', 'TaskOutput', 'TaskStop'];
	return taskTools.every((t) => !agentHasTool(def, t));
}

// ---------------------------------------------------------------------------
// 1. Leader always uses agent/agents pattern
// ---------------------------------------------------------------------------

describe('Leader: always uses agent/agents pattern', () => {
	test('has agent: Leader with no reviewers configured', () => {
		const init = createLeaderAgentInit(makeConfig(), makeCallbacks());
		expect(init.agent).toBe('Leader');
		expect(init.agents).toBeDefined();
	});

	test('agents map always contains Leader, leader-explorer, leader-fact-checker', () => {
		const init = createLeaderAgentInit(makeConfig(), makeCallbacks());
		expect(Object.keys(init.agents!)).toContain('Leader');
		expect(Object.keys(init.agents!)).toContain('leader-explorer');
		expect(Object.keys(init.agents!)).toContain('leader-fact-checker');
	});

	test('coordinatorMode is NOT set (leader uses own prompt/tools)', () => {
		const init = createLeaderAgentInit(makeConfig(), makeCallbacks());
		expect(init.coordinatorMode).toBeUndefined();
	});

	test('Leader agent definition has Task, TaskOutput, TaskStop tools', () => {
		const init = createLeaderAgentInit(makeConfig(), makeCallbacks());
		const leaderDef = init.agents!['Leader'];
		expect(leaderDef).toBeDefined();
		expect(agentHasTool(leaderDef, 'Task')).toBe(true);
		expect(agentHasTool(leaderDef, 'TaskOutput')).toBe(true);
		expect(agentHasTool(leaderDef, 'TaskStop')).toBe(true);
	});

	test('has agent: Leader even with reviewers configured', () => {
		const init = createLeaderAgentInit(
			makeConfig({
				agentSubagents: {
					leader: [{ model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' }],
				},
			}),
			makeCallbacks()
		);
		expect(init.agent).toBe('Leader');
		expect(init.agents).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// 2. Built-in leader sub-agents (always present)
// ---------------------------------------------------------------------------

describe('Leader: built-in sub-agents are always present', () => {
	test('leader-explorer lacks Task tools (one-level-max enforcement)', () => {
		const init = createLeaderAgentInit(makeConfig(), makeCallbacks());
		const explorerDef = init.agents!['leader-explorer'];
		expect(explorerDef).toBeDefined();
		expect(agentLacksTaskTools(explorerDef)).toBe(true);
	});

	test('leader-fact-checker lacks Task tools (one-level-max enforcement)', () => {
		const init = createLeaderAgentInit(makeConfig(), makeCallbacks());
		const factCheckerDef = init.agents!['leader-fact-checker'];
		expect(factCheckerDef).toBeDefined();
		expect(agentLacksTaskTools(factCheckerDef)).toBe(true);
	});

	test('leader-explorer is present even when reviewers configured', () => {
		const init = createLeaderAgentInit(
			makeConfig({
				agentSubagents: {
					leader: [
						{ model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' },
						{ model: 'claude-haiku-4-5-20251001', provider: 'anthropic' },
					],
				},
			}),
			makeCallbacks()
		);
		expect(Object.keys(init.agents!)).toContain('leader-explorer');
		expect(Object.keys(init.agents!)).toContain('leader-fact-checker');
	});
});

// ---------------------------------------------------------------------------
// 3. SDK-based reviewer configuration
// ---------------------------------------------------------------------------

describe('SDK reviewer: agent configuration', () => {
	test('reviewer agent map includes reviewer-explorer and reviewer-fact-checker', () => {
		const init = createLeaderAgentInit(
			makeConfig({
				agentSubagents: {
					leader: [{ model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' }],
				},
			}),
			makeCallbacks()
		);
		expect(Object.keys(init.agents!)).toContain('reviewer-explorer');
		expect(Object.keys(init.agents!)).toContain('reviewer-fact-checker');
	});

	test('SDK reviewer agent has Task, TaskOutput, TaskStop tools', () => {
		const init = createLeaderAgentInit(
			makeConfig({
				agentSubagents: {
					leader: [{ model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' }],
				},
			}),
			makeCallbacks()
		);
		const reviewerDef = init.agents!['reviewer-sonnet'];
		expect(reviewerDef).toBeDefined();
		expect(agentHasTool(reviewerDef, 'Task')).toBe(true);
		expect(agentHasTool(reviewerDef, 'TaskOutput')).toBe(true);
		expect(agentHasTool(reviewerDef, 'TaskStop')).toBe(true);
	});

	test('SDK reviewer agent has read tools (Read, Grep, Glob, Bash)', () => {
		const init = createLeaderAgentInit(
			makeConfig({
				agentSubagents: {
					leader: [{ model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' }],
				},
			}),
			makeCallbacks()
		);
		const reviewerDef = init.agents!['reviewer-sonnet'];
		expect(agentHasTool(reviewerDef, 'Read')).toBe(true);
		expect(agentHasTool(reviewerDef, 'Grep')).toBe(true);
		expect(agentHasTool(reviewerDef, 'Glob')).toBe(true);
		expect(agentHasTool(reviewerDef, 'Bash')).toBe(true);
	});

	test('two SDK reviewers both appear in agents map with correct names', () => {
		const init = createLeaderAgentInit(
			makeConfig({
				agentSubagents: {
					leader: [
						{ model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' },
						{ model: 'claude-haiku-4-5-20251001', provider: 'anthropic' },
					],
				},
			}),
			makeCallbacks()
		);
		const agentKeys = Object.keys(init.agents!);
		// Leader + 2 built-ins + 2 reviewers + reviewer-explorer + reviewer-fact-checker = 7
		expect(agentKeys).toHaveLength(7);
		expect(agentKeys).toContain('reviewer-sonnet');
		expect(agentKeys).toContain('reviewer-haiku');
		expect(agentKeys).toContain('reviewer-explorer');
		expect(agentKeys).toContain('reviewer-fact-checker');
	});
});

// ---------------------------------------------------------------------------
// 4. CLI-based reviewer configuration
// ---------------------------------------------------------------------------

describe('CLI reviewer: agent configuration', () => {
	test('CLI reviewer agent appears in agents map', () => {
		const init = createLeaderAgentInit(
			makeConfig({
				agentSubagents: {
					leader: [{ model: 'codex', type: 'cli', cliModel: 'gpt-5.3-codex' }],
				},
			}),
			makeCallbacks()
		);
		const agentKeys = Object.keys(init.agents!);
		expect(agentKeys).toContain('reviewer-codex');
	});

	test('CLI reviewer agent has Task, TaskOutput, TaskStop tools', () => {
		const init = createLeaderAgentInit(
			makeConfig({
				agentSubagents: {
					leader: [{ model: 'codex', type: 'cli', cliModel: 'gpt-5.3-codex' }],
				},
			}),
			makeCallbacks()
		);
		const reviewerDef = init.agents!['reviewer-codex'];
		expect(reviewerDef).toBeDefined();
		expect(agentHasTool(reviewerDef, 'Task')).toBe(true);
		expect(agentHasTool(reviewerDef, 'TaskOutput')).toBe(true);
		expect(agentHasTool(reviewerDef, 'TaskStop')).toBe(true);
	});

	test('CLI reviewer includes reviewer-explorer and reviewer-fact-checker sub-agents', () => {
		const init = createLeaderAgentInit(
			makeConfig({
				agentSubagents: {
					leader: [{ model: 'codex', type: 'cli', cliModel: 'gpt-5.3-codex' }],
				},
			}),
			makeCallbacks()
		);
		expect(Object.keys(init.agents!)).toContain('reviewer-explorer');
		expect(Object.keys(init.agents!)).toContain('reviewer-fact-checker');
	});

	test('CLI reviewer uses inherit model (routes through leader runtime model)', () => {
		const init = createLeaderAgentInit(
			makeConfig({
				agentSubagents: {
					leader: [{ model: 'codex', type: 'cli', cliModel: 'gpt-5.3-codex' }],
				},
			}),
			makeCallbacks()
		);
		const reviewerDef = init.agents!['reviewer-codex'];
		expect(reviewerDef.model).toBe('inherit');
	});
});

// ---------------------------------------------------------------------------
// 5. Reviewer sub-agents lack Task tools (one-level-max enforcement)
// ---------------------------------------------------------------------------

describe('Reviewer sub-agents: no Task tools (one-level-max)', () => {
	test('reviewer-explorer lacks Task, TaskOutput, TaskStop', () => {
		const explorerDef = buildReviewerExplorerAgentDef();
		expect(agentLacksTaskTools(explorerDef)).toBe(true);
	});

	test('reviewer-fact-checker lacks Task, TaskOutput, TaskStop', () => {
		const factCheckerDef = buildReviewerFactCheckerAgentDef();
		expect(agentLacksTaskTools(factCheckerDef)).toBe(true);
	});

	test('reviewer-explorer tools are read-only (Read, Grep, Glob, Bash only)', () => {
		const explorerDef = buildReviewerExplorerAgentDef();
		expect(explorerDef.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
	});

	test('reviewer-fact-checker tools are web-only (WebSearch, WebFetch only)', () => {
		const factCheckerDef = buildReviewerFactCheckerAgentDef();
		expect(factCheckerDef.tools).toEqual(['WebSearch', 'WebFetch']);
	});

	test('reviewer-explorer uses inherit model', () => {
		const explorerDef = buildReviewerExplorerAgentDef();
		expect(explorerDef.model).toBe('inherit');
	});

	test('reviewer-fact-checker uses inherit model', () => {
		const factCheckerDef = buildReviewerFactCheckerAgentDef();
		expect(factCheckerDef.model).toBe('inherit');
	});

	test('buildReviewerAgents always seeds reviewer-explorer and reviewer-fact-checker', () => {
		const agents = buildReviewerAgents([
			{ model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' },
		]);
		expect(agents['reviewer-explorer']).toBeDefined();
		expect(agents['reviewer-fact-checker']).toBeDefined();
		expect(agentLacksTaskTools(agents['reviewer-explorer'])).toBe(true);
		expect(agentLacksTaskTools(agents['reviewer-fact-checker'])).toBe(true);
	});

	test('buildReviewerAgents sub-agents are not overwritten by user reviewers', () => {
		// Even if a user configures a reviewer with a conflicting name pattern,
		// reviewer-explorer and reviewer-fact-checker remain as built-ins
		const agents = buildReviewerAgents([
			{ model: 'claude-opus-4-6', provider: 'anthropic' },
			{ model: 'claude-sonnet-4-6', provider: 'anthropic' },
		]);
		const explorerDef = agents['reviewer-explorer'];
		expect(explorerDef).toBeDefined();
		// Built-in explorer has exactly [Read, Grep, Glob, Bash]
		expect(explorerDef.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
	});
});
