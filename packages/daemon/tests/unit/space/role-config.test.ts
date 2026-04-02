/**
 * Tool Access and Sub-Session Features Unit Tests
 *
 * Verifies tool access per preset agent and that sub-session features are
 * correctly applied to custom agent init configs.
 */

import { describe, it, expect } from 'bun:test';
import { ROLE_TOOLS, SUB_SESSION_FEATURES } from '../../../src/lib/space/agents/seed-agents';
import {
	createCustomAgentInit,
	composePromptLayer,
	type SlotOverrides,
	type CustomAgentConfig,
} from '../../../src/lib/space/agents/custom-agent';
import type { SpaceAgent, Space, SpaceTask } from '@neokai/shared';

// ============================================================================
// Test fixtures
// ============================================================================

function makeAgent(overrides?: Partial<SpaceAgent>): SpaceAgent {
	return {
		id: 'agent-1',
		spaceId: 'space-1',
		name: 'TestAgent',
		instructions: null,
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

function makeConfig(tools?: string[]): CustomAgentConfig {
	return {
		customAgent: makeAgent({ tools, name: 'TestAgent' }),
		task: makeTask(),
		workflowRun: null,
		space: makeSpace(),
		sessionId: 'session-test',
		workspacePath: '/workspace/project',
	};
}

// ============================================================================
// Tool access per preset agent
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
// Sub-session features
// ============================================================================

describe('SUB_SESSION_FEATURES', () => {
	it('disables all UI features for sub-session agents', () => {
		expect(SUB_SESSION_FEATURES).toEqual({
			rewind: false,
			worktree: false,
			coordinator: false,
			archive: false,
			sessionInfo: false,
		});
	});
});

// ============================================================================
// composePromptLayer — override/expand composition
// ============================================================================

describe('composePromptLayer', () => {
	it('returns base when no override is provided', () => {
		expect(composePromptLayer('base prompt', undefined)).toBe('base prompt');
	});

	it('returns empty string when base and override are both absent', () => {
		expect(composePromptLayer(undefined, undefined)).toBe('');
		expect(composePromptLayer(null, undefined)).toBe('');
		expect(composePromptLayer('', undefined)).toBe('');
	});

	it('override mode replaces base entirely', () => {
		const override = { mode: 'override' as const, value: 'new prompt' };
		expect(composePromptLayer('old base', override)).toBe('new prompt');
	});

	it('override mode uses value when base is absent', () => {
		const override = { mode: 'override' as const, value: 'new prompt' };
		expect(composePromptLayer(null, override)).toBe('new prompt');
	});

	it('expand mode appends to base with double newline', () => {
		const override = { mode: 'expand' as const, value: 'additional' };
		expect(composePromptLayer('base', override)).toBe('base\n\nadditional');
	});

	it('expand mode returns value only when base is empty', () => {
		const override = { mode: 'expand' as const, value: 'additional' };
		expect(composePromptLayer('', override)).toBe('additional');
		expect(composePromptLayer(null, override)).toBe('additional');
		expect(composePromptLayer(undefined, override)).toBe('additional');
	});

	it('trims whitespace from both base and override value', () => {
		const override = { mode: 'expand' as const, value: '  extra  ' };
		expect(composePromptLayer('  base  ', override)).toBe('base\n\nextra');
	});

	it('handles multiline values in expand mode', () => {
		const override = { mode: 'expand' as const, value: 'line1\nline2\nline3' };
		const result = composePromptLayer('base', override);
		expect(result).toBe('base\n\nline1\nline2\nline3');
	});

	it('handles multiline values in override mode', () => {
		const override = { mode: 'override' as const, value: 'line1\nline2' };
		expect(composePromptLayer('old base', override)).toBe('line1\nline2');
	});

	it('expands on top of non-empty base instructions', () => {
		const base = 'Follow TDD principles.\nWrite tests first.';
		const override = { mode: 'expand' as const, value: 'Use bun:test for all tests.' };
		const result = composePromptLayer(base, override);
		expect(result).toBe(
			'Follow TDD principles.\nWrite tests first.\n\nUse bun:test for all tests.'
		);
	});

	it('overrides long base instructions with short override', () => {
		const base = 'Follow TDD principles.\nWrite tests first.\nCommit frequently.';
		const override = { mode: 'override' as const, value: 'Just write code.' };
		expect(composePromptLayer(base, override)).toBe('Just write code.');
	});

	it('preserves empty override value in override mode', () => {
		const override = { mode: 'override' as const, value: '' };
		expect(composePromptLayer('base', override)).toBe('');
	});

	it('preserves empty override value in expand mode', () => {
		const override = { mode: 'expand' as const, value: '' };
		expect(composePromptLayer('base', override)).toBe('base');
	});

	it('works with SlotOverrides interface type', () => {
		const overrides: SlotOverrides = {
			systemPrompt: { mode: 'expand', value: 'extra context' },
			instructions: { mode: 'override', value: 'new instructions' },
		};

		expect(composePromptLayer('base prompt', overrides.systemPrompt)).toBe(
			'base prompt\n\nextra context'
		);
		expect(composePromptLayer('old instructions', overrides.instructions)).toBe('new instructions');
	});

	it('returns base when SlotOverrides.systemPrompt is undefined', () => {
		const overrides: SlotOverrides = {};
		expect(composePromptLayer('base prompt', overrides.systemPrompt)).toBe('base prompt');
	});

	it('returns base when SlotOverrides.instructions is undefined', () => {
		const overrides: SlotOverrides = {};
		expect(composePromptLayer('base instructions', overrides.instructions)).toBe(
			'base instructions'
		);
	});

	it('handles expand with null base', () => {
		const override = { mode: 'expand' as const, value: 'some text' };
		expect(composePromptLayer(null, override)).toBe('some text');
	});

	it('handles override trimming edge cases', () => {
		const override = { mode: 'override' as const, value: '\n\n  padded  \n\n' };
		expect(composePromptLayer('old', override)).toBe('padded');
	});

	it('handles expand trimming edge cases', () => {
		const override = { mode: 'expand' as const, value: '\n\n  padded  \n\n' };
		expect(composePromptLayer('base', override)).toBe('base\n\npadded');
	});

	it('with only whitespace base and expand mode', () => {
		const override = { mode: 'expand' as const, value: 'value' };
		expect(composePromptLayer('   ', override)).toBe('value');
	});

	it('with only whitespace base and override mode', () => {
		const override = { mode: 'override' as const, value: 'value' };
		expect(composePromptLayer('   ', override)).toBe('value');
	});

	it('with empty override and empty base returns empty', () => {
		const override = { mode: 'expand' as const, value: '' };
		expect(composePromptLayer('', override)).toBe('');
	});

	it('preserves exact base when override is undefined', () => {
		expect(composePromptLayer('  exact  spacing  ', undefined)).toBe('exact  spacing');
	});

	it('handles unicode content', () => {
		const override = { mode: 'expand' as const, value: '日本語の指示' };
		expect(composePromptLayer('English base', override)).toBe('English base\n\n日本語の指示');
	});

	it('handles very long values', () => {
		const longValue = 'x'.repeat(10000);
		const override = { mode: 'expand' as const, value: longValue };
		const result = composePromptLayer('base', override);
		expect(result).toBe(`base\n\n${longValue}`);
		expect(result.length).toBe(10006);
	});
});

// ============================================================================
// createCustomAgentInit applies sub-session features
// ============================================================================

describe('createCustomAgentInit — sub-session features', () => {
	it('applies SUB_SESSION_FEATURES for agent with tools', () => {
		const init = createCustomAgentInit(makeConfig(ROLE_TOOLS.coder));
		expect(init.features).toEqual(SUB_SESSION_FEATURES);
	});

	it('applies SUB_SESSION_FEATURES for agent with restricted tools', () => {
		const init = createCustomAgentInit(makeConfig(ROLE_TOOLS.reviewer));
		expect(init.features).toEqual(SUB_SESSION_FEATURES);
	});

	it('applies SUB_SESSION_FEATURES for agent without tools', () => {
		const init = createCustomAgentInit(makeConfig(undefined));
		expect(init.features).toEqual(SUB_SESSION_FEATURES);
	});

	it('reviewer init uses agents pattern with restricted tools', () => {
		const config = makeConfig(ROLE_TOOLS.reviewer);
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
		const config = makeConfig(ROLE_TOOLS.qa);
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
		const config = makeConfig(ROLE_TOOLS.coder);
		const init = createCustomAgentInit(config);

		expect(init.agent).toBeDefined();
		expect(init.agents).toBeDefined();

		const agentKey = init.agent as string;
		const agentDef = init.agents![agentKey];
		expect(agentDef.tools).toContain('Write');
		expect(agentDef.tools).toContain('Edit');
	});

	it('agent without tools uses simple preset path (no agent key)', () => {
		const config = makeConfig(undefined);
		const init = createCustomAgentInit(config);

		expect(init.agent).toBeUndefined();
		expect(init.agents).toBeUndefined();
	});

	it('applies systemPrompt override mode in system prompt', () => {
		const config = makeConfig(ROLE_TOOLS.coder);
		config.slotOverrides = {
			systemPrompt: { mode: 'override', value: 'Override prompt' },
		};
		const init = createCustomAgentInit(config);

		// Check that the system prompt is set via append (non-tools path)
		if (init.systemPrompt && 'append' in init.systemPrompt) {
			expect(init.systemPrompt.append).toBe('Override prompt');
		} else if (init.systemPrompt && 'type' in init.systemPrompt) {
			// tools path — check agent prompt
			const agentKey = init.agent as string;
			const agentDef = init.agents![agentKey];
			expect(agentDef.prompt).toBe('Override prompt');
		}
	});

	it('applies systemPrompt expand mode in system prompt', () => {
		const config = makeConfig(undefined);
		config.customAgent = makeAgent({
			systemPrompt: 'Base prompt',
			tools: undefined,
		});
		config.slotOverrides = {
			systemPrompt: { mode: 'expand', value: 'Expanded context' },
		};
		const init = createCustomAgentInit(config);

		if (init.systemPrompt && 'append' in init.systemPrompt) {
			expect(init.systemPrompt.append).toBe('Base prompt\n\nExpanded context');
		}
	});
});
