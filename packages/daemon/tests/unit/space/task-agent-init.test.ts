/**
 * Unit tests for createTaskAgentInit()
 *
 * Verifies:
 * - Returns AgentSessionInit with correct session type, features, context, model
 * - System prompt is built from buildTaskAgentSystemPrompt()
 * - MCP servers are NOT included in the init
 * - Model resolution: space.defaultModel → hardcoded default
 * - context includes both spaceId and taskId
 * - contextAutoQueue is false
 */

import { describe, test, expect } from 'bun:test';
import {
	createTaskAgentInit,
	type TaskAgentSessionConfig,
} from '../../../src/lib/space/agents/task-agent';
import type { SpaceTask, Space, SpaceWorkflow, SpaceWorkflowRun } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSpace(overrides?: Partial<Space>): Space {
	return {
		id: 'space-1',
		workspacePath: '/workspace',
		name: 'Test Space',
		description: 'A test space',
		backgroundContext: '',
		instructions: '',
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

function makeWorkflow(overrides?: Partial<SpaceWorkflow>): SpaceWorkflow {
	return {
		id: 'wf-1',
		spaceId: 'space-1',
		name: 'Feature Workflow',
		description: 'Plan, code, and review.',
		nodes: [{ id: 'step-code', name: 'Code', agentId: 'agent-1' }],
		transitions: [],
		rules: [],
		startNodeId: 'step-code',
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
		title: 'Feature X run',
		currentNodeId: 'step-code',
		status: 'in_progress',
		createdAt: 1000,
		updatedAt: 2000,
		...overrides,
	};
}

function makeConfig(overrides?: Partial<TaskAgentSessionConfig>): TaskAgentSessionConfig {
	return {
		task: makeTask(),
		space: makeSpace(),
		sessionId: 'session-abc',
		workspacePath: '/workspace',
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createTaskAgentInit', () => {
	describe('session type', () => {
		test('sets type to space_task_agent', () => {
			const init = createTaskAgentInit(makeConfig());
			expect(init.type).toBe('space_task_agent');
		});
	});

	describe('features', () => {
		test('disables rewind', () => {
			const init = createTaskAgentInit(makeConfig());
			expect(init.features?.rewind).toBe(false);
		});

		test('disables worktree', () => {
			const init = createTaskAgentInit(makeConfig());
			expect(init.features?.worktree).toBe(false);
		});

		test('disables coordinator', () => {
			const init = createTaskAgentInit(makeConfig());
			expect(init.features?.coordinator).toBe(false);
		});

		test('disables archive', () => {
			const init = createTaskAgentInit(makeConfig());
			expect(init.features?.archive).toBe(false);
		});

		test('enables sessionInfo', () => {
			const init = createTaskAgentInit(makeConfig());
			expect(init.features?.sessionInfo).toBe(true);
		});
	});

	describe('context', () => {
		test('includes spaceId', () => {
			const init = createTaskAgentInit(makeConfig());
			expect(init.context?.spaceId).toBe('space-1');
		});

		test('includes taskId', () => {
			const init = createTaskAgentInit(makeConfig());
			expect(init.context?.taskId).toBe('task-1');
		});

		test('uses correct space and task IDs', () => {
			const config = makeConfig({
				task: makeTask({ id: 'task-xyz', spaceId: 'space-abc' }),
				space: makeSpace({ id: 'space-abc' }),
			});
			const init = createTaskAgentInit(config);
			expect(init.context?.spaceId).toBe('space-abc');
			expect(init.context?.taskId).toBe('task-xyz');
		});
	});

	describe('session IDs', () => {
		test('uses provided sessionId', () => {
			const init = createTaskAgentInit(makeConfig({ sessionId: 'my-session-id' }));
			expect(init.sessionId).toBe('my-session-id');
		});

		test('uses provided workspacePath', () => {
			const init = createTaskAgentInit(makeConfig({ workspacePath: '/my/workspace' }));
			expect(init.workspacePath).toBe('/my/workspace');
		});
	});

	describe('model resolution', () => {
		test('uses space.defaultModel when set', () => {
			const config = makeConfig({
				space: makeSpace({ defaultModel: 'claude-opus-4-6' }),
			});
			const init = createTaskAgentInit(config);
			expect(init.model).toBe('claude-opus-4-6');
		});

		test('falls back to hardcoded default when space.defaultModel is unset', () => {
			const config = makeConfig({
				space: makeSpace({ defaultModel: undefined }),
			});
			const init = createTaskAgentInit(config);
			expect(init.model).toBe('claude-sonnet-4-5-20250929');
		});

		test('falls back to hardcoded default when space.defaultModel is null', () => {
			const config = makeConfig({
				space: makeSpace({ defaultModel: null }),
			});
			const init = createTaskAgentInit(config);
			expect(init.model).toBe('claude-sonnet-4-5-20250929');
		});
	});

	describe('system prompt', () => {
		test('systemPrompt is a string', () => {
			const init = createTaskAgentInit(makeConfig());
			expect(typeof init.systemPrompt).toBe('string');
		});

		test('systemPrompt contains task title', () => {
			const init = createTaskAgentInit(makeConfig());
			expect(init.systemPrompt as string).toContain('Implement feature X');
		});

		test('systemPrompt contains Task Agent role declaration', () => {
			const init = createTaskAgentInit(makeConfig());
			expect(init.systemPrompt as string).toContain('Task Agent');
		});

		test('systemPrompt contains task details even when workflow is provided', () => {
			const config = makeConfig({
				workflow: makeWorkflow({ name: 'My Workflow' }),
			});
			const init = createTaskAgentInit(config);
			// Workflow steps appear only in buildTaskAgentInitialMessage(), not the system prompt
			expect(init.systemPrompt as string).toContain('Implement feature X');
		});
	});

	describe('MCP servers', () => {
		test('does not include mcpServers', () => {
			const init = createTaskAgentInit(makeConfig());
			expect(init.mcpServers).toBeUndefined();
		});

		test('does not include mcpServers even with workflow', () => {
			const config = makeConfig({ workflow: makeWorkflow() });
			const init = createTaskAgentInit(config);
			expect(init.mcpServers).toBeUndefined();
		});
	});

	describe('contextAutoQueue', () => {
		test('sets contextAutoQueue to false', () => {
			const init = createTaskAgentInit(makeConfig());
			expect(init.contextAutoQueue).toBe(false);
		});
	});

	describe('optional workflow and workflowRun', () => {
		test('works without workflow', () => {
			const config = makeConfig({ workflow: undefined });
			const init = createTaskAgentInit(config);
			expect(init.type).toBe('space_task_agent');
		});

		test('works with null workflow', () => {
			const config = makeConfig({ workflow: null });
			const init = createTaskAgentInit(config);
			expect(init.type).toBe('space_task_agent');
		});

		test('works with workflow and workflowRun', () => {
			const config = makeConfig({
				workflow: makeWorkflow(),
				workflowRun: makeWorkflowRun(),
			});
			const init = createTaskAgentInit(config);
			expect(init.type).toBe('space_task_agent');
			expect(init.context?.taskId).toBe('task-1');
		});
	});

	describe('provider', () => {
		test('sets provider for default model', () => {
			const init = createTaskAgentInit(makeConfig());
			expect(init.provider).toBeDefined();
			expect(typeof init.provider).toBe('string');
		});
	});
});
