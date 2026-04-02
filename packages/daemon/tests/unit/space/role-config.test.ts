/**
 * Role Configuration Unit Tests
 *
 * Verifies feature flag profiles and tool access per role.
 * Ensures reviewers and QA cannot use Write/Edit, while coders and planners
 * have full tool access.
 */

import { describe, it, expect } from 'bun:test';
import {
	ROLE_FEATURES,
	ROLE_TOOLS,
	DEFAULT_ROLE_FEATURES,
	getFeaturesForRole,
} from '../../../src/lib/space/agents/seed-agents';
import {
	createCustomAgentInit,
	type CustomAgentConfig,
} from '../../../src/lib/space/agents/custom-agent';
import type { SpaceAgent, Space, SpaceTask, SessionFeatures } from '@neokai/shared';

// ============================================================================
// Test fixtures
// ============================================================================

function makeAgent(overrides?: Partial<SpaceAgent>): SpaceAgent {
	return {
		id: 'agent-1',
		spaceId: 'space-1',
		name: 'TestAgent',
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
		title: 'Test task',
		description: 'A test task',
		status: 'open',
		priority: 'normal',
		dependsOn: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeConfig(role: string, tools?: string[]): CustomAgentConfig {
	return {
		customAgent: makeAgent({ role, tools, name: `Test${role}` }),
		task: makeTask(),
		workflowRun: null,
		space: makeSpace(),
		sessionId: 'session-test',
		workspacePath: '/workspace/project',
	};
}

const ALL_FEATURES_FALSE: SessionFeatures = {
	rewind: false,
	worktree: false,
	coordinator: false,
	archive: false,
	sessionInfo: false,
};

// ============================================================================
// Feature flag profiles per role
// ============================================================================

describe('ROLE_FEATURES', () => {
	it('defines feature profiles for all known roles', () => {
		const knownRoles = ['coder', 'general', 'planner', 'reviewer', 'qa'];
		for (const role of knownRoles) {
			expect(ROLE_FEATURES[role]).toBeDefined();
		}
	});

	it('disables all features for coder role', () => {
		expect(ROLE_FEATURES.coder).toEqual(ALL_FEATURES_FALSE);
	});

	it('disables all features for reviewer role', () => {
		expect(ROLE_FEATURES.reviewer).toEqual(ALL_FEATURES_FALSE);
	});

	it('disables all features for planner role', () => {
		expect(ROLE_FEATURES.planner).toEqual(ALL_FEATURES_FALSE);
	});

	it('disables all features for qa role', () => {
		expect(ROLE_FEATURES.qa).toEqual(ALL_FEATURES_FALSE);
	});

	it('disables all features for general role', () => {
		expect(ROLE_FEATURES.general).toEqual(ALL_FEATURES_FALSE);
	});
});

describe('getFeaturesForRole', () => {
	it('returns correct features for known roles', () => {
		expect(getFeaturesForRole('coder')).toEqual(ALL_FEATURES_FALSE);
		expect(getFeaturesForRole('reviewer')).toEqual(ALL_FEATURES_FALSE);
		expect(getFeaturesForRole('qa')).toEqual(ALL_FEATURES_FALSE);
	});

	it('falls back to DEFAULT_ROLE_FEATURES for unknown roles', () => {
		expect(getFeaturesForRole('unknown-role')).toEqual(DEFAULT_ROLE_FEATURES);
		expect(getFeaturesForRole('')).toEqual(DEFAULT_ROLE_FEATURES);
	});
});

// ============================================================================
// Tool access per role
// ============================================================================

describe('ROLE_TOOLS', () => {
	it('coder has full tool access (Read, Write, Edit, Bash, Grep, Glob)', () => {
		const tools = ROLE_TOOLS.coder;
		expect(tools).toContain('Read');
		expect(tools).toContain('Write');
		expect(tools).toContain('Edit');
		expect(tools).toContain('Bash');
		expect(tools).toContain('Grep');
		expect(tools).toContain('Glob');
	});

	it('coder does not have Task/TaskOutput/TaskStop', () => {
		const tools = ROLE_TOOLS.coder;
		expect(tools).not.toContain('Task');
		expect(tools).not.toContain('TaskOutput');
		expect(tools).not.toContain('TaskStop');
	});

	it('planner has full tool access', () => {
		const tools = ROLE_TOOLS.planner;
		expect(tools).toContain('Read');
		expect(tools).toContain('Write');
		expect(tools).toContain('Edit');
		expect(tools).toContain('Bash');
		expect(tools).toContain('Grep');
		expect(tools).toContain('Glob');
	});

	it('reviewer cannot Write or Edit', () => {
		const tools = ROLE_TOOLS.reviewer;
		expect(tools).not.toContain('Write');
		expect(tools).not.toContain('Edit');
	});

	it('reviewer has read-only tools', () => {
		const tools = ROLE_TOOLS.reviewer;
		expect(tools).toContain('Read');
		expect(tools).toContain('Bash');
		expect(tools).toContain('Grep');
		expect(tools).toContain('Glob');
	});

	it('qa cannot Write or Edit', () => {
		const tools = ROLE_TOOLS.qa;
		expect(tools).not.toContain('Write');
		expect(tools).not.toContain('Edit');
	});

	it('qa has read-only + bash tools for running tests', () => {
		const tools = ROLE_TOOLS.qa;
		expect(tools).toContain('Read');
		expect(tools).toContain('Bash');
		expect(tools).toContain('Grep');
		expect(tools).toContain('Glob');
	});

	it('general (Done node) has read-only tools — no Write or Edit', () => {
		const tools = ROLE_TOOLS.general;
		expect(tools).not.toContain('Write');
		expect(tools).not.toContain('Edit');
		expect(tools).toContain('Read');
		expect(tools).toContain('Bash');
		expect(tools).toContain('Grep');
		expect(tools).toContain('Glob');
	});
});

// ============================================================================
// createCustomAgentInit applies role-based configuration
// ============================================================================

describe('createCustomAgentInit — role-based configuration', () => {
	it('applies correct features for coder role', () => {
		const init = createCustomAgentInit(makeConfig('coder', ROLE_TOOLS.coder));
		expect(init.features).toEqual(ALL_FEATURES_FALSE);
	});

	it('applies correct features for reviewer role', () => {
		const init = createCustomAgentInit(makeConfig('reviewer', ROLE_TOOLS.reviewer));
		expect(init.features).toEqual(ALL_FEATURES_FALSE);
	});

	it('applies correct features for planner role', () => {
		const init = createCustomAgentInit(makeConfig('planner', ROLE_TOOLS.planner));
		expect(init.features).toEqual(ALL_FEATURES_FALSE);
	});

	it('applies correct features for qa role', () => {
		const init = createCustomAgentInit(makeConfig('qa', ROLE_TOOLS.qa));
		expect(init.features).toEqual(ALL_FEATURES_FALSE);
	});

	it('applies correct features for unknown role', () => {
		const init = createCustomAgentInit(makeConfig('custom-role', ['Read', 'Bash']));
		expect(init.features).toEqual(DEFAULT_ROLE_FEATURES);
	});

	it('reviewer init uses agents pattern with restricted tools', () => {
		const config = makeConfig('reviewer', ROLE_TOOLS.reviewer);
		const init = createCustomAgentInit(config);

		// When tools are specified, the agents pattern is used
		expect(init.agent).toBeDefined();
		expect(init.agents).toBeDefined();

		// The agent definition should use the reviewer's restricted tools
		const agentKey = init.agent as string;
		const agentDef = init.agents![agentKey];
		expect(agentDef.tools).toEqual(ROLE_TOOLS.reviewer);
		expect(agentDef.tools).not.toContain('Write');
		expect(agentDef.tools).not.toContain('Edit');
	});

	it('qa init uses agents pattern with restricted tools', () => {
		const config = makeConfig('qa', ROLE_TOOLS.qa);
		const init = createCustomAgentInit(config);

		expect(init.agent).toBeDefined();
		expect(init.agents).toBeDefined();

		const agentKey = init.agent as string;
		const agentDef = init.agents![agentKey];
		expect(agentDef.tools).toEqual(ROLE_TOOLS.qa);
		expect(agentDef.tools).not.toContain('Write');
		expect(agentDef.tools).not.toContain('Edit');
	});

	it('coder init uses agents pattern with full tools', () => {
		const config = makeConfig('coder', ROLE_TOOLS.coder);
		const init = createCustomAgentInit(config);

		expect(init.agent).toBeDefined();
		expect(init.agents).toBeDefined();

		const agentKey = init.agent as string;
		const agentDef = init.agents![agentKey];
		expect(agentDef.tools).toContain('Write');
		expect(agentDef.tools).toContain('Edit');
	});

	it('agent without tools uses simple preset path (no agent key)', () => {
		const config = makeConfig('coder');
		const init = createCustomAgentInit(config);

		expect(init.agent).toBeUndefined();
		expect(init.agents).toBeUndefined();
	});
});
