/**
 * MCP `.mcp.json` auto-load leak — regression suite (M1 + M5).
 *
 * This test exercises the three session spawn paths called out in the M1
 * task (docs/plans/unify-mcp-config-model/00-overview.md): Space ad-hoc
 * (`worker` type in a Space context), `space_task_agent`, and the workflow
 * node-agent sub-session (also `worker` type). For each we:
 *
 *   1. Build a representative `AgentSessionInit` using the real factory
 *      (`createTaskAgentInit` / `createCustomAgentInit`) or a bare Space
 *      worker shape, then synthesize a `Session` from it.
 *   2. Run it through `QueryOptionsBuilder.build()` with no other mocks.
 *   3. Assert the resulting SDK options force `strictMcpConfig: true` and
 *      `settingSources: []`, so the Claude Agent SDK has no path to
 *      auto-load a project-level `.mcp.json` or `.claude/settings.local.json`.
 *
 * M5 removed the `NEOKAI_LEGACY_MCP_AUTOLOAD=1` escape hatch entirely —
 * setting it has no effect, which is also asserted below so any accidental
 * resurrection is caught here.
 */

import { describe, expect, it, mock } from 'bun:test';
import { QueryOptionsBuilder } from '../../../../src/lib/agent/query-options-builder';
import { createTaskAgentInit } from '../../../../src/lib/space/agents/task-agent';
import { createCustomAgentInit } from '../../../../src/lib/space/agents/custom-agent';
import type { SettingsManager } from '../../../../src/lib/settings-manager';
import type { Session, Space, SpaceAgent, SpaceTask } from '@neokai/shared';
import type { AgentSessionInit } from '../../../../src/lib/agent/agent-session';

function mockSettingsManager(): SettingsManager {
	return {
		getGlobalSettings: mock(() => ({})),
		prepareSDKOptions: mock(async () => ({})),
	} as unknown as SettingsManager;
}

function makeSpace(overrides?: Partial<Space>): Space {
	return {
		id: 'space-m1',
		workspacePath: '/workspace',
		name: 'M1 Space',
		description: '',
		backgroundContext: '',
		instructions: '',
		sessionIds: [],
		status: 'active',
		createdAt: 1,
		updatedAt: 2,
		...overrides,
	};
}

function makeTask(overrides?: Partial<SpaceTask>): SpaceTask {
	return {
		id: 'task-m1',
		spaceId: 'space-m1',
		taskNumber: 42,
		title: 'M1 task',
		description: 'Test that `.mcp.json` does not leak.',
		status: 'in_progress',
		priority: 'high',
		dependsOn: [],
		createdAt: 1,
		updatedAt: 2,
		...overrides,
	};
}

function makeCustomAgent(overrides?: Partial<SpaceAgent>): SpaceAgent {
	return {
		id: 'agent-m1',
		spaceId: 'space-m1',
		name: 'coder',
		description: 'Implementation worker.',
		model: 'claude-sonnet-4-6',
		customPrompt: 'You write code.',
		createdAt: 1,
		updatedAt: 2,
		...overrides,
	} as SpaceAgent;
}

/**
 * Translate an `AgentSessionInit` into a minimal `Session` suitable for the
 * `QueryOptionsBuilder`. Only the fields the builder consults matter for
 * these assertions.
 */
function sessionFromInit(init: AgentSessionInit): Session {
	return {
		id: init.sessionId,
		title: 'M1 test session',
		workspacePath: init.workspacePath,
		type: init.type,
		context: init.context,
		createdAt: new Date().toISOString(),
		lastActiveAt: new Date().toISOString(),
		status: 'active',
		config: {
			model: init.model ?? 'claude-sonnet-4-6',
			provider: (init.provider as Session['config']['provider']) ?? 'anthropic',
			systemPrompt: init.systemPrompt,
			mcpServers: init.mcpServers,
			sdkToolsPreset: init.sdkToolsPreset,
			allowedTools: init.allowedTools,
			disallowedTools: init.disallowedTools,
			maxTokens: 8192,
			temperature: 1,
		},
		metadata: {
			messageCount: 0,
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
			toolCallCount: 0,
		},
	} as Session;
}

describe('MCP leak regression: strictMcpConfig + empty settingSources per spawn path', () => {
	describe('space_task_agent (createTaskAgentInit)', () => {
		it('emits SDK options with strictMcpConfig=true and empty settingSources', async () => {
			const init = createTaskAgentInit({
				task: makeTask(),
				space: makeSpace(),
				sessionId: 'space:space-m1:task:task-m1',
				workspacePath: '/workspace/task',
			});
			expect(init.type).toBe('space_task_agent');

			const session = sessionFromInit(init);
			const builder = new QueryOptionsBuilder({
				session,
				settingsManager: mockSettingsManager(),
			});
			const options = await builder.build();

			expect(options.strictMcpConfig).toBe(true);
			expect(options.settingSources).toEqual([]);
			// No programmatic mcpServers were passed → map is absent, so nothing
			// from a project `.mcp.json` can possibly surface here.
			expect(options.mcpServers).toBeUndefined();
		});

		it('ignores NEOKAI_LEGACY_MCP_AUTOLOAD — kill switch was removed in M5', async () => {
			const previous = process.env.NEOKAI_LEGACY_MCP_AUTOLOAD;
			try {
				process.env.NEOKAI_LEGACY_MCP_AUTOLOAD = '1';
				const init = createTaskAgentInit({
					task: makeTask(),
					space: makeSpace(),
					sessionId: 'space:space-m1:task:task-m1',
					workspacePath: '/workspace/task',
				});
				const session = sessionFromInit(init);
				const builder = new QueryOptionsBuilder({
					session,
					settingsManager: mockSettingsManager(),
				});
				const options = await builder.build();

				expect(options.strictMcpConfig).toBe(true);
				expect(options.settingSources).toEqual([]);
			} finally {
				if (previous === undefined) {
					delete process.env.NEOKAI_LEGACY_MCP_AUTOLOAD;
				} else {
					process.env.NEOKAI_LEGACY_MCP_AUTOLOAD = previous;
				}
			}
		});
	});

	describe('node-agent workflow sub-session (createCustomAgentInit)', () => {
		it('emits SDK options with strictMcpConfig=true and empty settingSources', async () => {
			const init = createCustomAgentInit({
				customAgent: makeCustomAgent(),
				task: makeTask(),
				workflowRun: null,
				workflow: null,
				space: makeSpace(),
				sessionId: 'space:space-m1:task:task-m1:exec:e1',
				workspacePath: '/workspace/task',
			});
			expect(init.type).toBe('worker');

			const session = sessionFromInit(init);
			const builder = new QueryOptionsBuilder({
				session,
				settingsManager: mockSettingsManager(),
			});
			const options = await builder.build();

			expect(options.strictMcpConfig).toBe(true);
			expect(options.settingSources).toEqual([]);
			// A workflow node-agent's `node-agent` MCP server is attached at runtime
			// via `mergeRuntimeMcpServers` after session creation, not by the init
			// factory. Without that runtime merge, no ambient `.mcp.json` servers
			// must appear here either.
			expect(options.mcpServers).toBeUndefined();
		});

		it('carries SpaceAgent tool restrictions into workflow node SDK options', async () => {
			const init = createCustomAgentInit({
				customAgent: makeCustomAgent({ tools: ['Read', 'Bash'] }),
				task: makeTask(),
				workflowRun: null,
				workflow: null,
				space: makeSpace(),
				sessionId: 'space:space-m1:task:task-m1:exec:e1',
				workspacePath: '/workspace/task',
			});

			const session = sessionFromInit(init);
			const builder = new QueryOptionsBuilder({
				session,
				settingsManager: mockSettingsManager(),
			});
			const options = await builder.build();

			expect(options.tools).toEqual(['Read', 'Bash']);
			expect(options.allowedTools).toEqual(['Read', 'Bash']);
			expect(options.disallowedTools).toEqual(
				expect.arrayContaining(['Write', 'Edit', 'Task', 'NotebookEdit', 'TodoWrite', 'Skill'])
			);
			expect(options.disallowedTools).not.toContain('Read');
			expect(options.disallowedTools).not.toContain('Bash');
		});

		it('ignores NEOKAI_LEGACY_MCP_AUTOLOAD — kill switch was removed in M5', async () => {
			const previous = process.env.NEOKAI_LEGACY_MCP_AUTOLOAD;
			try {
				process.env.NEOKAI_LEGACY_MCP_AUTOLOAD = '1';
				const init = createCustomAgentInit({
					customAgent: makeCustomAgent(),
					task: makeTask(),
					workflowRun: null,
					workflow: null,
					space: makeSpace(),
					sessionId: 'space:space-m1:task:task-m1:exec:e1',
					workspacePath: '/workspace/task',
				});
				const session = sessionFromInit(init);
				const builder = new QueryOptionsBuilder({
					session,
					settingsManager: mockSettingsManager(),
				});
				const options = await builder.build();

				expect(options.strictMcpConfig).toBe(true);
				expect(options.settingSources).toEqual([]);
			} finally {
				if (previous === undefined) {
					delete process.env.NEOKAI_LEGACY_MCP_AUTOLOAD;
				} else {
					process.env.NEOKAI_LEGACY_MCP_AUTOLOAD = previous;
				}
			}
		});
	});

	describe('Space ad-hoc (worker session attached to a space by context)', () => {
		it('emits SDK options with strictMcpConfig=true and empty settingSources', async () => {
			// Space ad-hoc = any session opened in a Space that is neither the
			// coordinator (`space_chat`) nor a task-agent. The runtime model uses
			// `type: 'worker'` with a `spaceId` on the context.
			const session: Session = {
				id: 'adhoc-1',
				title: 'Space ad-hoc session',
				workspacePath: '/workspace/adhoc',
				type: 'worker',
				context: { spaceId: 'space-m1' },
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-6',
					provider: 'anthropic',
					maxTokens: 8192,
					temperature: 1,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			} as Session;

			const builder = new QueryOptionsBuilder({
				session,
				settingsManager: mockSettingsManager(),
			});
			const options = await builder.build();

			expect(options.strictMcpConfig).toBe(true);
			expect(options.settingSources).toEqual([]);
			expect(options.mcpServers).toBeUndefined();
		});
	});
});
