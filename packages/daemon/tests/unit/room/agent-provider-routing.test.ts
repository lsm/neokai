/**
 * Tests for provider routing through agent session init factories.
 *
 * Bug: When selecting 'anthropic opus-4.6' as the leader subagent, traffic was
 * being sent to GitHub Copilot instead of Anthropic. Root cause: AgentSessionInit
 * was missing a `provider` field, so query-runner.ts fell back to the deprecated
 * detectProvider() heuristic which always returns Anthropic first for any claude-*
 * model — causing Copilot-targeted sessions to be misrouted.
 *
 * Fix: Thread explicit provider from model cache through the full creation chain:
 *   resolveAgentModelWithProvider → agent config → AgentSessionInit → SessionConfig
 */

import { describe, expect, it } from 'bun:test';
import {
	createPlannerAgentInit,
	type PlannerAgentConfig,
} from '../../../src/lib/room/agents/planner-agent';
import {
	createCoderAgentInit,
	type CoderAgentConfig,
} from '../../../src/lib/room/agents/coder-agent';
import {
	createGeneralAgentInit,
	type GeneralAgentConfig,
} from '../../../src/lib/room/agents/general-agent';
import {
	createLeaderAgentInit,
	type LeaderAgentConfig,
	type LeaderToolCallbacks,
	type LeaderToolResult,
} from '../../../src/lib/room/agents/leader-agent';
import type { Room, RoomGoal, NeoTask } from '@neokai/shared';

// ─── Shared fixtures ─────────────────────────────────────────────────────────

function makeRoom(overrides?: Partial<Room>): Room {
	return {
		id: 'room-1',
		name: 'Test Room',
		allowedPaths: [{ path: '/workspace', label: 'ws' }],
		defaultPath: '/workspace',
		sessionIds: [],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeGoal(overrides?: Partial<RoomGoal>): RoomGoal {
	return {
		id: 'goal-1',
		roomId: 'room-1',
		title: 'Build health check',
		description: 'Add a health check endpoint',
		status: 'active',
		priority: 'normal',
		progress: 0,
		linkedTaskIds: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeTask(overrides?: Partial<NeoTask>): NeoTask {
	return {
		id: 'task-1',
		roomId: 'room-1',
		title: 'Add GET /health endpoint',
		description: 'Create health endpoint',
		status: 'pending',
		priority: 'normal',
		dependsOn: [],
		createdAt: Date.now(),
		...overrides,
	};
}

const noop = async (): Promise<LeaderToolResult> => ({ content: [{ type: 'text', text: 'ok' }] });
const leaderCallbacks: LeaderToolCallbacks = {
	sendToWorker: noop,
	completeTask: noop,
	failTask: noop,
	replanGoal: noop,
	submitForReview: noop,
};

// ─── createPlannerAgentInit ───────────────────────────────────────────────────

describe('createPlannerAgentInit — provider routing', () => {
	const baseConfig: PlannerAgentConfig = {
		task: makeTask({ taskType: 'planning', status: 'in_progress' }),
		goal: makeGoal(),
		room: makeRoom(),
		sessionId: 'session-1',
		workspacePath: '/workspace',
		createDraftTask: async () => ({ id: 'draft-1', title: 'Draft' }),
		updateDraftTask: async () => ({ id: 'draft-1', title: 'Draft' }),
		removeDraftTask: async () => true,
	};

	it('sets provider to undefined when not specified', () => {
		const init = createPlannerAgentInit(baseConfig);
		expect(init.provider).toBeUndefined();
	});

	it('passes explicit anthropic provider through to AgentSessionInit', () => {
		const init = createPlannerAgentInit({ ...baseConfig, provider: 'anthropic' });
		expect(init.provider).toBe('anthropic');
	});

	it('passes explicit anthropic-copilot provider through to AgentSessionInit', () => {
		const init = createPlannerAgentInit({ ...baseConfig, provider: 'anthropic-copilot' });
		expect(init.provider).toBe('anthropic-copilot');
	});
});

// ─── createCoderAgentInit ─────────────────────────────────────────────────────

describe('createCoderAgentInit — provider routing', () => {
	const baseConfig: CoderAgentConfig = {
		task: makeTask(),
		goal: makeGoal(),
		room: makeRoom(),
		sessionId: 'session-2',
		workspacePath: '/workspace',
	};

	it('sets provider to undefined when not specified', () => {
		const init = createCoderAgentInit(baseConfig);
		expect(init.provider).toBeUndefined();
	});

	it('passes explicit anthropic provider through to AgentSessionInit', () => {
		const init = createCoderAgentInit({ ...baseConfig, provider: 'anthropic' });
		expect(init.provider).toBe('anthropic');
	});

	it('passes explicit anthropic-copilot provider through to AgentSessionInit', () => {
		const init = createCoderAgentInit({ ...baseConfig, provider: 'anthropic-copilot' });
		expect(init.provider).toBe('anthropic-copilot');
	});

	it('passes explicit glm provider through to AgentSessionInit', () => {
		const init = createCoderAgentInit({ ...baseConfig, provider: 'glm' });
		expect(init.provider).toBe('glm');
	});
});

// ─── createGeneralAgentInit ───────────────────────────────────────────────────

describe('createGeneralAgentInit — provider routing', () => {
	const baseConfig: GeneralAgentConfig = {
		task: makeTask(),
		goal: makeGoal(),
		room: makeRoom(),
		sessionId: 'session-3',
		workspacePath: '/workspace',
	};

	it('sets provider to undefined when not specified', () => {
		const init = createGeneralAgentInit(baseConfig);
		expect(init.provider).toBeUndefined();
	});

	it('passes explicit anthropic provider through to AgentSessionInit', () => {
		const init = createGeneralAgentInit({ ...baseConfig, provider: 'anthropic' });
		expect(init.provider).toBe('anthropic');
	});

	it('passes explicit anthropic-copilot provider through to AgentSessionInit', () => {
		const init = createGeneralAgentInit({ ...baseConfig, provider: 'anthropic-copilot' });
		expect(init.provider).toBe('anthropic-copilot');
	});
});

// ─── createLeaderAgentInit ────────────────────────────────────────────────────

describe('createLeaderAgentInit — provider routing', () => {
	const baseConfig: LeaderAgentConfig = {
		task: makeTask(),
		goal: makeGoal(),
		room: makeRoom(),
		sessionId: 'session-4',
		workspacePath: '/workspace',
		groupId: 'group-1',
	};

	it('sets provider to undefined when not specified', () => {
		const init = createLeaderAgentInit(baseConfig, leaderCallbacks);
		expect(init.provider).toBeUndefined();
	});

	it('passes explicit anthropic provider through to AgentSessionInit', () => {
		const init = createLeaderAgentInit({ ...baseConfig, provider: 'anthropic' }, leaderCallbacks);
		expect(init.provider).toBe('anthropic');
	});

	it('passes explicit anthropic-copilot provider through to AgentSessionInit', () => {
		const init = createLeaderAgentInit(
			{ ...baseConfig, provider: 'anthropic-copilot' },
			leaderCallbacks
		);
		expect(init.provider).toBe('anthropic-copilot');
	});

	it('passes provider when leader has reviewer sub-agents configured', () => {
		const roomWithReviewers = makeRoom({
			config: {
				agentSubagents: [{ model: 'claude-sonnet-4-5-20250929', role: 'reviewer' }],
			},
		});
		const configWithReviewers: LeaderAgentConfig = {
			...baseConfig,
			room: roomWithReviewers,
			provider: 'anthropic-copilot',
		};
		const init = createLeaderAgentInit(configWithReviewers, leaderCallbacks);
		expect(init.provider).toBe('anthropic-copilot');
	});
});

// ─── Provider consistency across agent types ──────────────────────────────────

describe('Provider propagation — same provider is preserved across agent types', () => {
	const copilotProvider = 'anthropic-copilot';
	const copilotModel = 'claude-opus-4.6';

	it('coder, general, and planner all receive the same provider', () => {
		const task = makeTask();
		const goal = makeGoal();
		const room = makeRoom();

		const baseArgs = {
			task,
			goal,
			room,
			sessionId: 'session-x',
			workspacePath: '/workspace',
			model: copilotModel,
			provider: copilotProvider,
		};

		const coderInit = createCoderAgentInit(baseArgs);
		const generalInit = createGeneralAgentInit(baseArgs);
		const plannerInit = createPlannerAgentInit({
			...baseArgs,
			taskType: undefined,
			createDraftTask: async () => ({ id: 'draft-1', title: 'Draft' }),
			updateDraftTask: async () => ({ id: 'draft-1', title: 'Draft' }),
			removeDraftTask: async () => true,
		} as PlannerAgentConfig);

		expect(coderInit.provider).toBe(copilotProvider);
		expect(generalInit.provider).toBe(copilotProvider);
		expect(plannerInit.provider).toBe(copilotProvider);
	});

	it('model is preserved alongside provider', () => {
		const init = createCoderAgentInit({
			task: makeTask(),
			goal: makeGoal(),
			room: makeRoom(),
			sessionId: 'session-y',
			workspacePath: '/workspace',
			model: copilotModel,
			provider: copilotProvider,
		});

		expect(init.model).toBe(copilotModel);
		expect(init.provider).toBe(copilotProvider);
	});
});
