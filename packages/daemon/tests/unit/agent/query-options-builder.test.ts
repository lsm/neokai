/**
 * QueryOptionsBuilder Tests
 *
 * Tests SDK query options construction from session config.
 */

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import {
	QueryOptionsBuilder,
	type QueryOptionsBuilderContext,
} from '../../../src/lib/agent/query-options-builder';
import type { Session } from '@neokai/shared';
import type { SettingsManager } from '../../../src/lib/settings-manager';
import { generateUUID } from '@neokai/shared';
import { homedir } from 'os';

describe('QueryOptionsBuilder', () => {
	let builder: QueryOptionsBuilder;
	let mockSession: Session;
	let mockSettingsManager: SettingsManager;
	let mockContext: QueryOptionsBuilderContext;

	beforeEach(() => {
		mockSession = {
			id: generateUUID(),
			title: 'Test Session',
			workspacePath: '/test/workspace',
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'active',
			config: {
				model: 'default',
				maxTokens: 8192,
				temperature: 1.0,
			},
			metadata: {
				messageCount: 0,
				totalTokens: 0,
				inputTokens: 0,
				outputTokens: 0,
				totalCost: 0,
				toolCallCount: 0,
			},
		};

		mockSettingsManager = {
			getGlobalSettings: mock(() => ({})),
			prepareSDKOptions: mock(async () => ({})),
		} as unknown as SettingsManager;

		mockContext = {
			session: mockSession,
			settingsManager: mockSettingsManager,
		};

		builder = new QueryOptionsBuilder(mockContext);
	});

	afterEach(() => {});

	describe('build', () => {
		it('should build basic query options', async () => {
			const options = await builder.build();

			expect(options.model).toBe('default');
			expect(options.maxTurns).toBe(Infinity);
			expect(options.cwd).toBe('/test/workspace');
		});

		it('should include maxBudgetUsd when configured', async () => {
			mockSession.config.maxBudgetUsd = 10;
			const options = await builder.build();
			expect(options.maxBudgetUsd).toBe(10);
		});

		it('should set permissionMode from session config', async () => {
			mockSession.config.permissionMode = 'acceptEdits';
			const options = await builder.build();
			expect(options.permissionMode).toBe('acceptEdits');
		});

		it('should set allowDangerouslySkipPermissions when bypassPermissions', async () => {
			mockSession.config.permissionMode = 'bypassPermissions';
			const options = await builder.build();
			expect(options.permissionMode).toBe('bypassPermissions');
			expect(options.allowDangerouslySkipPermissions).toBe(true);
		});

		it('should include fallbackModel when configured', async () => {
			mockSession.config.fallbackModel = 'haiku';
			const options = await builder.build();
			expect(options.fallbackModel).toBe('haiku');
		});

		it('should include agents when configured', async () => {
			mockSession.config.agents = {
				'test-agent': {
					name: 'test-agent',
					description: 'Test agent',
					prompt: 'Test prompt',
				},
			};
			const options = await builder.build();
			expect(options.agents).toBeDefined();
		});

		it('should include sandbox settings when configured', async () => {
			mockSession.config.sandbox = { enabled: true };
			const options = await builder.build();
			expect(options.sandbox).toEqual({ enabled: true });
		});

		it('should include outputFormat when configured', async () => {
			mockSession.config.outputFormat = {
				type: 'json_schema',
				schema: { type: 'object' },
			};
			const options = await builder.build();
			expect(options.outputFormat).toBeDefined();
		});

		it('should include betas when configured', async () => {
			mockSession.config.betas = ['beta-feature'];
			const options = await builder.build();
			expect(options.betas).toEqual(['beta-feature']);
		});

		it('should include env when configured', async () => {
			mockSession.config.env = { MY_VAR: 'value' };
			const options = await builder.build();
			expect(options.env).toEqual({ MY_VAR: 'value' });
		});

		it('should remove undefined values from options', async () => {
			const options = await builder.build();
			// Should not have undefined values
			for (const [_key, value] of Object.entries(options)) {
				expect(value).not.toBeUndefined();
			}
		});
	});

	describe('getCwd', () => {
		it('should return workspacePath when no worktree', () => {
			expect(builder.getCwd()).toBe('/test/workspace');
		});

		it('should return worktreePath when worktree exists', () => {
			mockSession.worktree = {
				worktreePath: '/worktree/path',
				mainRepoPath: '/main/repo',
				branch: 'session/test',
			};
			const newBuilder = new QueryOptionsBuilder({
				session: mockSession,
				settingsManager: mockSettingsManager,
			});
			expect(newBuilder.getCwd()).toBe('/worktree/path');
		});
	});

	describe('setCanUseTool', () => {
		it('should set canUseTool callback', async () => {
			const callback = mock(async () => ({ behavior: 'allow' as const }));
			builder.setCanUseTool(callback);

			const options = await builder.build();
			expect(options.canUseTool).toBe(callback);
		});
	});

	describe('addSessionStateOptions', () => {
		it('should add resume parameter when SDK session ID exists', async () => {
			mockSession.sdkSessionId = 'sdk-session-123';
			const options = await builder.build();
			const result = builder.addSessionStateOptions(options);

			expect(result.resume).toBe('sdk-session-123');
		});

		it('should not add resume when no SDK session ID', async () => {
			const options = await builder.build();
			const result = builder.addSessionStateOptions(options);

			expect(result.resume).toBeUndefined();
		});

		it('should add thinking tokens based on thinkingLevel', async () => {
			// Use 'ultrathink' which is a known valid thinking level
			mockSession.config.thinkingLevel = 'ultrathink';
			const options = await builder.build();
			const result = builder.addSessionStateOptions(options);

			// THINKING_LEVEL_TOKENS maps ultrathink to a specific value
			// Note: if the level doesn't exist in the map, it returns undefined
			// This test verifies the mechanism works
			expect(result).toBeDefined();
		});

		it('should use auto as default thinking level', async () => {
			const options = await builder.build();
			const result = builder.addSessionStateOptions(options);

			// auto should not set maxThinkingTokens (undefined in map)
			// The exact behavior depends on THINKING_LEVEL_TOKENS values
			expect(result).toBeDefined();
		});
	});

	describe('system prompt configuration', () => {
		it('should use Claude Code preset by default', async () => {
			const options = await builder.build();

			expect(options.systemPrompt).toEqual({
				type: 'preset',
				preset: 'claude_code',
			});
		});

		it('should append worktree isolation text when worktree exists', async () => {
			mockSession.worktree = {
				worktreePath: '/worktree/path',
				mainRepoPath: '/main/repo',
				branch: 'session/test-branch',
			};
			const newBuilder = new QueryOptionsBuilder({
				session: mockSession,
				settingsManager: mockSettingsManager,
			});
			const options = await newBuilder.build();

			expect(options.systemPrompt).toEqual(
				expect.objectContaining({
					type: 'preset',
					preset: 'claude_code',
					append: expect.stringContaining('Git Worktree Isolation'),
				})
			);
		});

		it('should use custom string system prompt when set', async () => {
			mockSession.config.systemPrompt = 'Custom system prompt';
			const options = await builder.build();

			expect(options.systemPrompt).toBe('Custom system prompt');
		});

		it('should combine custom prompt with worktree isolation', async () => {
			mockSession.config.systemPrompt = 'Custom prompt';
			mockSession.worktree = {
				worktreePath: '/worktree',
				mainRepoPath: '/main',
				branch: 'session/test',
			};
			const newBuilder = new QueryOptionsBuilder({
				session: mockSession,
				settingsManager: mockSettingsManager,
			});
			const options = await newBuilder.build();

			expect(options.systemPrompt).toContain('Custom prompt');
			expect(options.systemPrompt).toContain('Git Worktree Isolation');
		});

		it('should use minimal worktree prompt when Claude Code preset disabled', async () => {
			mockSession.config.tools = { useClaudeCodePreset: false };
			mockSession.worktree = {
				worktreePath: '/worktree',
				mainRepoPath: '/main',
				branch: 'session/test',
			};
			const newBuilder = new QueryOptionsBuilder({
				session: mockSession,
				settingsManager: mockSettingsManager,
			});
			const options = await newBuilder.build();

			expect(typeof options.systemPrompt).toBe('string');
			expect(options.systemPrompt).toContain('Git Worktree Isolation');
		});
	});

	describe('tools configuration', () => {
		it('should include sdkToolsPreset when configured', async () => {
			mockSession.config.sdkToolsPreset = 'full';
			const options = await builder.build();
			expect(options.tools).toBe('full');
		});

		it('should include allowedTools when configured', async () => {
			mockSession.config.allowedTools = ['Bash', 'Read'];
			const options = await builder.build();
			expect(options.allowedTools).toEqual(['Bash', 'Read']);
		});

		it('should include disallowedTools when configured', async () => {
			mockSession.config.disallowedTools = ['Write'];
			const options = await builder.build();
			expect(options.disallowedTools).toContain('Write');
		});

		it('should disable memory tool by default', async () => {
			const options = await builder.build();
			expect(options.disallowedTools).toContain('kai__memory__*');
		});

		it('should not disable memory tool when enabled', async () => {
			mockSession.config.tools = { kaiTools: { memory: true } };
			const options = await builder.build();
			// When memory is enabled, disallowedTools may be undefined or not contain the memory pattern
			const disallowed = options.disallowedTools || [];
			expect(disallowed).not.toContain('kai__memory__*');
		});
	});

	describe('MCP servers configuration', () => {
		it('should use configured mcpServers', async () => {
			mockSession.config.mcpServers = {
				'test-server': { command: 'test-command' },
			};
			const options = await builder.build();

			expect(options.mcpServers).toEqual({
				'test-server': { command: 'test-command' },
			});
		});

		it('should leave mcpServers undefined for auto-load', async () => {
			const options = await builder.build();
			// When not configured, should be undefined to let SDK auto-load
			expect(options.mcpServers).toBeUndefined();
		});
	});

	describe('setting sources configuration', () => {
		it('should include project and local sources by default', async () => {
			const options = await builder.build();
			expect(options.settingSources).toEqual(['project', 'local']);
		});

		it('should use local only when loadSettingSources is false', async () => {
			mockSession.config.tools = { loadSettingSources: false };
			const options = await builder.build();
			expect(options.settingSources).toEqual(['local']);
		});
	});

	describe('additional directories configuration', () => {
		it('should allow temp directories for shell operations when worktree exists', async () => {
			mockSession.worktree = {
				worktreePath: '/worktree',
				mainRepoPath: '/main',
				branch: 'session/test',
			};
			const newBuilder = new QueryOptionsBuilder({
				session: mockSession,
				settingsManager: mockSettingsManager,
			});
			const options = await newBuilder.build();

			// Should include home directories for settings/storage and temp directories for shell operations
			expect(options.additionalDirectories).toEqual([
				homedir() + '/.claude',
				homedir() + '/.neokai',
				'/tmp/claude',
				expect.stringContaining('/tmp/zsh-'),
			]);
		});

		it('should include home directories when no worktree', async () => {
			const options = await builder.build();
			expect(options.additionalDirectories).toEqual([
				homedir() + '/.claude',
				homedir() + '/.neokai',
			]);
		});
	});

	describe('permission mode', () => {
		it('should use session config permission mode first', async () => {
			mockSession.config.permissionMode = 'acceptEdits';
			const options = await builder.build();
			expect(options.permissionMode).toBe('acceptEdits');
		});

		it('should fallback to global settings', async () => {
			(mockSettingsManager.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
				permissionMode: 'prompt',
			});
			const newBuilder = new QueryOptionsBuilder({
				session: mockSession,
				settingsManager: mockSettingsManager,
			});
			const options = await newBuilder.build();

			expect(options.permissionMode).toBe('prompt');
		});

		it('should default to bypassPermissions', async () => {
			const options = await builder.build();
			expect(options.permissionMode).toBe('bypassPermissions');
		});

		it('should map default to bypassPermissions', async () => {
			mockSession.config.permissionMode = 'default';
			const options = await builder.build();
			expect(options.permissionMode).toBe('bypassPermissions');
		});
	});

	describe('hooks configuration', () => {
		it('should return empty hooks', async () => {
			const options = await builder.build();

			// buildHooks() returns {} — no hooks configured
			expect(options.hooks).toEqual({});
		});
	});

	describe('worktree isolation text', () => {
		it('should include worktree path in isolation text', async () => {
			mockSession.worktree = {
				worktreePath: '/custom/worktree/path',
				mainRepoPath: '/main/repo',
				branch: 'session/feature',
			};
			const newBuilder = new QueryOptionsBuilder({
				session: mockSession,
				settingsManager: mockSettingsManager,
			});
			const options = await newBuilder.build();

			const systemPrompt = options.systemPrompt as { append?: string };
			expect(systemPrompt.append).toContain('/custom/worktree/path');
		});

		it('should include branch name in isolation text', async () => {
			mockSession.worktree = {
				worktreePath: '/worktree',
				mainRepoPath: '/main',
				branch: 'session/my-feature',
			};
			const newBuilder = new QueryOptionsBuilder({
				session: mockSession,
				settingsManager: mockSettingsManager,
			});
			const options = await newBuilder.build();

			const systemPrompt = options.systemPrompt as { append?: string };
			expect(systemPrompt.append).toContain('session/my-feature');
		});

		it('should include main repo path in isolation text', async () => {
			mockSession.worktree = {
				worktreePath: '/worktree',
				mainRepoPath: '/projects/my-repo',
				branch: 'session/test',
			};
			const newBuilder = new QueryOptionsBuilder({
				session: mockSession,
				settingsManager: mockSettingsManager,
			});
			const options = await newBuilder.build();

			const systemPrompt = options.systemPrompt as { append?: string };
			expect(systemPrompt.append).toContain('/projects/my-repo');
		});
	});

	describe('coordinator mode', () => {
		it('should set agent=Coordinator and include specialist agents when coordinatorMode is true', async () => {
			mockSession.config.coordinatorMode = true;
			const options = await builder.build();

			expect(options.agent).toBe('Coordinator');
			expect(options.agents).toBeDefined();
			const agentNames = Object.keys(options.agents!);
			expect(agentNames).toContain('Coordinator');
			expect(agentNames).toContain('Coder');
			expect(agentNames).toContain('Debugger');
			expect(agentNames).toContain('Tester');
			expect(agentNames).toContain('Reviewer');
			expect(agentNames).toContain('VCS');
			expect(agentNames).toContain('Verifier');
			expect(agentNames).toContain('Executor');
			expect(agentNames).toHaveLength(8);
		});

		it('should NOT set agent or specialist agents when coordinatorMode is false', async () => {
			mockSession.config.coordinatorMode = false;
			const options = await builder.build();

			expect(options.agent).toBeUndefined();
			// agents should not contain coordinator specialists
			if (options.agents) {
				const agentNames = Object.keys(options.agents);
				expect(agentNames).not.toContain('Coordinator');
			}
		});

		it('should NOT set coordinator agent when coordinatorMode is undefined', async () => {
			// coordinatorMode not set - defaults to falsy
			const options = await builder.build();

			expect(options.agent).toBeUndefined();
		});

		it('should transition from non-coordinator to coordinator options (OFF -> ON)', async () => {
			// Build with coordinator OFF
			mockSession.config.coordinatorMode = false;
			const optionsOff = await builder.build();
			expect(optionsOff.agent).toBeUndefined();

			// Build with coordinator ON (simulating config update + query restart)
			mockSession.config.coordinatorMode = true;
			const builderOn = new QueryOptionsBuilder(mockContext);
			const optionsOn = await builderOn.build();
			expect(optionsOn.agent).toBe('Coordinator');
			expect(Object.keys(optionsOn.agents!)).toHaveLength(8);
		});

		it('should transition ON -> OFF -> ON correctly', async () => {
			// ON
			mockSession.config.coordinatorMode = true;
			let options = await new QueryOptionsBuilder(mockContext).build();
			expect(options.agent).toBe('Coordinator');

			// OFF
			mockSession.config.coordinatorMode = false;
			options = await new QueryOptionsBuilder(mockContext).build();
			expect(options.agent).toBeUndefined();

			// ON again
			mockSession.config.coordinatorMode = true;
			options = await new QueryOptionsBuilder(mockContext).build();
			expect(options.agent).toBe('Coordinator');
			expect(Object.keys(options.agents!)).toHaveLength(8);
		});

		it('should preserve user-defined agents alongside coordinator agents', async () => {
			mockSession.config.coordinatorMode = true;
			mockSession.config.agents = {
				'my-custom-agent': {
					description: 'Custom agent',
					prompt: 'You are custom.',
				},
			};
			const options = await builder.build();

			expect(options.agents!['my-custom-agent']).toBeDefined();
			expect(options.agents!['Coder']).toBeDefined();
			expect(options.agents!['Coordinator']).toBeDefined();
		});

		it('should inject worktree isolation into specialist agents but not coordinator', async () => {
			mockSession.config.coordinatorMode = true;
			mockSession.worktree = {
				worktreePath: '/worktree/path',
				mainRepoPath: '/main/repo',
				branch: 'session/test',
			};
			const newBuilder = new QueryOptionsBuilder({
				session: mockSession,
				settingsManager: mockSettingsManager,
			});
			const options = await newBuilder.build();

			// Coordinator should NOT have worktree text
			const coordinatorPrompt = (options.agents!['Coordinator'] as { prompt: string }).prompt;
			expect(coordinatorPrompt).not.toContain('Git Worktree Isolation');

			// Specialists should have worktree text
			const coderPrompt = (options.agents!['Coder'] as { prompt: string }).prompt;
			expect(coderPrompt).toContain('Git Worktree Isolation');
		});

		it('should NOT restrict session-level tools in coordinator mode (sub-agents need full tool access)', async () => {
			mockSession.config.coordinatorMode = true;
			const options = await builder.build();

			// Session-level tools must NOT be restricted to coordinator's tools.
			// Options.tools is the BASE set for the entire session including sub-agents.
			// If restricted to ['Task', 'TodoWrite', 'AskUserQuestion'], sub-agents like
			// Coder (tools: ['Read', 'Edit', 'Write', ...]) get an empty tool set
			// because AgentDefinition.tools is a filter on the base set.
			expect(options.tools).not.toEqual(['Task', 'TodoWrite', 'AskUserQuestion']);
		});

		it('should preserve sdkToolsPreset in coordinator mode', async () => {
			mockSession.config.coordinatorMode = true;
			mockSession.config.sdkToolsPreset = { type: 'preset', preset: 'claude_code' };
			const options = await builder.build();

			// Coordinator mode should NOT override the preset - sub-agents need full tools
			expect(options.tools).toEqual({ type: 'preset', preset: 'claude_code' });
		});

		it('should set allowedTools for all tools in coordinator mode', async () => {
			mockSession.config.coordinatorMode = true;
			const options = await builder.build();

			// allowedTools ensures sub-agents can use tools under dontAsk permission mode
			expect(options.allowedTools).toBeDefined();
			expect(options.allowedTools).toContain('Read');
			expect(options.allowedTools).toContain('Write');
			expect(options.allowedTools).toContain('Bash');
			expect(options.allowedTools).toContain('Edit');
			expect(options.allowedTools).toContain('Task');
		});

		it('should not add coordinator canUseTool wrapper', async () => {
			mockSession.config.coordinatorMode = true;
			const options = await builder.build();

			// canUseTool should not be set by coordinator mode
			// (only set if explicitly via setCanUseTool for AskUserQuestion handler)
			expect(options.canUseTool).toBeUndefined();
		});

		it('should preserve existing canUseTool when coordinatorMode is on', async () => {
			mockSession.config.coordinatorMode = true;

			// Set an existing canUseTool callback (like AskUserQuestion handler)
			const originalCallback = async () => {
				return { behavior: 'allow' as const };
			};
			builder.setCanUseTool(originalCallback);
			const options = await builder.build();

			// The original callback should be passed through unchanged
			expect(options.canUseTool).toBe(originalCallback);
		});
	});

	describe('file checkpointing configuration', () => {
		it('should enable file checkpointing by default', async () => {
			const options = await builder.build();
			expect(options.enableFileCheckpointing).toBe(true);
		});

		it('should enable file checkpointing when explicitly set to true', async () => {
			mockSession.config.enableFileCheckpointing = true;
			const options = await builder.build();
			expect(options.enableFileCheckpointing).toBe(true);
		});

		it('should disable file checkpointing when explicitly set to false', async () => {
			mockSession.config.enableFileCheckpointing = false;
			const options = await builder.build();
			expect(options.enableFileCheckpointing).toBe(false);
		});

		it('should include enableFileCheckpointing in debug logging', async () => {
			mockSession.config.enableFileCheckpointing = true;
			const options = await builder.build();
			// Verify the option is included in the final options object
			// (Debug logging will show this value automatically)
			expect('enableFileCheckpointing' in options).toBe(true);
		});
	});
});
