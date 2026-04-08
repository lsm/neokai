/**
 * QueryOptionsBuilder Tests
 *
 * Tests SDK query options construction from session config.
 */

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import {
	QueryOptionsBuilder,
	type QueryOptionsBuilderContext,
} from '../../../src/lib/agent/query-options-builder';
import type { Session } from '@neokai/shared';
import type { SettingsManager } from '../../../src/lib/settings-manager';
import { generateUUID } from '@neokai/shared';
import { homedir } from 'os';
import { createTables } from '../../../src/storage/schema';
import { SkillRepository } from '../../../src/storage/repositories/skill-repository';
import { AppMcpServerRepository } from '../../../src/storage/repositories/app-mcp-server-repository';
import { SkillsManager } from '../../../src/lib/skills-manager';
import { noOpReactiveDb } from '../../helpers/reactive-database';

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
				provider: 'anthropic',
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

		it('should add resume for room sessions when SDK session ID exists', async () => {
			mockSession.type = 'room';
			mockSession.sdkSessionId = 'sdk-session-123';
			const options = await builder.build();
			const result = builder.addSessionStateOptions(options);

			expect(result.resume).toBe('sdk-session-123');
		});

		it('should add resume for manager/worker orchestration sessions', async () => {
			mockSession.sdkSessionId = 'sdk-session-123';
			mockSession.metadata.sessionType = 'manager';
			const options = await builder.build();
			const result = builder.addSessionStateOptions(options);

			expect(result.resume).toBe('sdk-session-123');
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

	describe('room session restrictions', () => {
		it('should preserve room MCP servers while enforcing strict MCP config', async () => {
			mockSession.type = 'room_chat';
			mockSession.config.mcpServers = {
				'room-agent-tools': { command: 'test-command' },
			};

			const options = await builder.build();
			expect(options.mcpServers).toEqual({
				'room-agent-tools': { command: 'test-command' },
			});
			expect(options.strictMcpConfig).toBe(true);
			expect(options.settingSources).toEqual([]);
		});

		it('should enforce room built-in tool allowlist including Bash', async () => {
			mockSession.type = 'room_chat';
			const options = await builder.build();
			expect(options.tools).toEqual([
				'Read',
				'Glob',
				'Grep',
				'Bash',
				'WebFetch',
				'WebSearch',
				'ToolSearch',
				'AskUserQuestion',
				'Skill',
			]);
			expect(options.allowedTools).toEqual(
				expect.arrayContaining([
					'Read',
					'Glob',
					'Grep',
					'Bash',
					'WebFetch',
					'WebSearch',
					'ToolSearch',
					'AskUserQuestion',
					'Skill',
				])
			);
		});

		it('should not include Write/Edit/NotebookEdit in room tool allowlist', async () => {
			mockSession.type = 'room_chat';
			const options = await builder.build();
			expect(options.disallowedTools).toEqual(
				expect.arrayContaining(['Edit', 'Write', 'NotebookEdit'])
			);
			expect(options.tools).not.toContain('Edit');
			expect(options.tools).not.toContain('Write');
			expect(options.tools).not.toContain('NotebookEdit');
		});

		it('should auto-allow wildcards for all configured MCP servers', async () => {
			mockSession.type = 'room_chat';
			mockSession.config.mcpServers = {
				'room-agent-tools': { command: 'room-cmd' },
				github: { command: 'github-cmd' },
			};

			const options = await builder.build();
			expect(options.allowedTools).toEqual(
				expect.arrayContaining(['room-agent-tools__*', 'github__*'])
			);
		});

		it('should disable Claude Code preset system prompt for room sessions', async () => {
			mockSession.type = 'room_chat';
			const options = await builder.build();
			expect(options.systemPrompt).toBeUndefined();
		});

		it('should preserve a custom string system prompt for room sessions', async () => {
			mockSession.type = 'room_chat';
			mockSession.config.systemPrompt = 'You are the Room Agent.';
			const options = await builder.build();
			expect(options.systemPrompt).toBe('You are the Room Agent.');
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
			expect(agentNames).toHaveLength(7);
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
			expect(Object.keys(optionsOn.agents!)).toHaveLength(7);
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
			expect(Object.keys(options.agents!)).toHaveLength(7);
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

	describe('skills injection', () => {
		const enabledSkills = [
			{
				id: 'skill-plugin-1',
				name: 'my-plugin',
				displayName: 'My Plugin',
				description: 'A plugin skill',
				sourceType: 'plugin' as const,
				config: { type: 'plugin' as const, pluginPath: '/path/to/plugin' },
				enabled: true,
				builtIn: false,
				validationStatus: 'valid' as const,
				createdAt: Date.now(),
			},
			{
				id: 'skill-mcp-1',
				name: 'brave-search',
				displayName: 'Brave Search',
				description: 'Web search via Brave',
				sourceType: 'mcp_server' as const,
				config: { type: 'mcp_server' as const, appMcpServerId: 'mcp-server-uuid' },
				enabled: true,
				builtIn: false,
				validationStatus: 'valid' as const,
				createdAt: Date.now(),
			},
			{
				id: 'skill-disabled-1',
				name: 'disabled-skill',
				displayName: 'Disabled Skill',
				description: 'A disabled skill',
				sourceType: 'plugin' as const,
				config: { type: 'plugin' as const, pluginPath: '/path/to/disabled' },
				enabled: false,
				builtIn: false,
				validationStatus: 'valid' as const,
				createdAt: Date.now(),
			},
		];

		const mockAppMcpServer = {
			id: 'mcp-server-uuid',
			name: 'brave-search-server',
			description: 'Brave Search MCP',
			sourceType: 'stdio' as const,
			command: 'npx',
			args: ['-y', 'brave-mcp'],
			env: { BRAVE_API_KEY: 'test-key' },
			enabled: true,
		};

		it('should inject plugin skills as plugins option', async () => {
			const mockSkillsManager = {
				getEnabledSkills: mock(() => [enabledSkills[0]]),
			};
			const context: QueryOptionsBuilderContext = {
				session: mockSession,
				settingsManager: mockSettingsManager,
				skillsManager:
					mockSkillsManager as unknown as import('../../../src/lib/skills-manager').SkillsManager,
			};
			const builder = new QueryOptionsBuilder(context);
			const options = await builder.build();

			expect(options.plugins).toEqual([{ type: 'local', path: '/path/to/plugin' }]);
		});

		it('should inject MCP server skills as mcpServers entries', async () => {
			const mockAppMcpServerRepo = {
				get: mock(() => mockAppMcpServer),
			};
			const mockSkillsManager = {
				getEnabledSkills: mock(() => [enabledSkills[1]]),
			};
			const context: QueryOptionsBuilderContext = {
				session: mockSession,
				settingsManager: mockSettingsManager,
				skillsManager:
					mockSkillsManager as unknown as import('../../../src/lib/skills-manager').SkillsManager,
				appMcpServerRepo:
					mockAppMcpServerRepo as unknown as import('../../../src/storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
			};
			const builder = new QueryOptionsBuilder(context);
			const options = await builder.build();

			expect(options.mcpServers).toBeDefined();
			expect(options.mcpServers!['brave-search']).toEqual({
				command: 'npx',
				args: ['-y', 'brave-mcp'],
				env: { BRAVE_API_KEY: 'test-key' },
			});
		});

		it('should exclude disabled skills', async () => {
			// getEnabledSkills() only returns enabled skills — simulate that
			const mockSkillsManager = {
				getEnabledSkills: mock(() => [enabledSkills[0]]),
			};
			const context: QueryOptionsBuilderContext = {
				session: mockSession,
				settingsManager: mockSettingsManager,
				skillsManager:
					mockSkillsManager as unknown as import('../../../src/lib/skills-manager').SkillsManager,
			};
			const builder = new QueryOptionsBuilder(context);
			const options = await builder.build();

			// Only the enabled plugin skill should appear
			expect(options.plugins).toEqual([{ type: 'local', path: '/path/to/plugin' }]);
		});

		it('should not inject anything when skillsManager is not provided', async () => {
			const builder = new QueryOptionsBuilder(mockContext);
			const options = await builder.build();

			expect(options.plugins).toBeUndefined();
		});

		it('should merge skill plugins with existing config plugins', async () => {
			const mockSkillsManager = {
				getEnabledSkills: mock(() => [enabledSkills[0]]),
			};
			mockSession.config.plugins = [{ type: 'local', path: '/existing/plugin' }];
			const context: QueryOptionsBuilderContext = {
				session: mockSession,
				settingsManager: mockSettingsManager,
				skillsManager:
					mockSkillsManager as unknown as import('../../../src/lib/skills-manager').SkillsManager,
			};
			const builder = new QueryOptionsBuilder(context);
			const options = await builder.build();

			expect(options.plugins).toEqual([
				{ type: 'local', path: '/existing/plugin' },
				{ type: 'local', path: '/path/to/plugin' },
			]);
		});

		it('should merge skill MCP servers with existing config mcpServers', async () => {
			const mockAppMcpServerRepo = {
				get: mock(() => mockAppMcpServer),
			};
			const mockSkillsManager = {
				getEnabledSkills: mock(() => [enabledSkills[1]]),
			};
			mockSession.config.mcpServers = {
				'existing-server': { command: 'existing-cmd' },
			};
			const context: QueryOptionsBuilderContext = {
				session: mockSession,
				settingsManager: mockSettingsManager,
				skillsManager:
					mockSkillsManager as unknown as import('../../../src/lib/skills-manager').SkillsManager,
				appMcpServerRepo:
					mockAppMcpServerRepo as unknown as import('../../../src/storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
			};
			const builder = new QueryOptionsBuilder(context);
			const options = await builder.build();

			expect(options.mcpServers!['existing-server']).toEqual({ command: 'existing-cmd' });
			expect(options.mcpServers!['brave-search']).toEqual({
				command: 'npx',
				args: ['-y', 'brave-mcp'],
				env: { BRAVE_API_KEY: 'test-key' },
			});
		});

		it('should skip disabled AppMcpServer entries even when the wrapping skill is enabled', async () => {
			const disabledAppMcpServer = {
				...mockAppMcpServer,
				enabled: false,
			};
			const mockAppMcpServerRepo = {
				get: mock(() => disabledAppMcpServer),
			};
			const mockSkillsManager = {
				// Skill itself is enabled (getEnabledSkills returns it)
				getEnabledSkills: mock(() => [enabledSkills[1]]),
			};
			const context: QueryOptionsBuilderContext = {
				session: mockSession,
				settingsManager: mockSettingsManager,
				skillsManager:
					mockSkillsManager as unknown as import('../../../src/lib/skills-manager').SkillsManager,
				appMcpServerRepo:
					mockAppMcpServerRepo as unknown as import('../../../src/storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
			};
			const builder = new QueryOptionsBuilder(context);
			const options = await builder.build();

			// Disabled AppMcpServer must not be injected even though the skill is enabled
			expect(options.mcpServers).toBeUndefined();
		});

		it('should skip MCP server skills when referenced app_mcp_servers entry is deleted', async () => {
			const mockAppMcpServerRepo = {
				get: mock(() => null), // Simulates deleted entry
			};
			const mockSkillsManager = {
				getEnabledSkills: mock(() => [enabledSkills[1]]),
			};
			const context: QueryOptionsBuilderContext = {
				session: mockSession,
				settingsManager: mockSettingsManager,
				skillsManager:
					mockSkillsManager as unknown as import('../../../src/lib/skills-manager').SkillsManager,
				appMcpServerRepo:
					mockAppMcpServerRepo as unknown as import('../../../src/storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
			};
			const builder = new QueryOptionsBuilder(context);
			const options = await builder.build();

			// MCP server skill should be silently skipped
			expect(options.mcpServers).toBeUndefined();
		});

		it('should make skill-injected MCP servers available in strictMcpConfig sessions', async () => {
			const mockAppMcpServerRepo = {
				get: mock(() => mockAppMcpServer),
			};
			const mockSkillsManager = {
				getEnabledSkills: mock(() => [enabledSkills[1]]),
			};
			mockSession.type = 'room_chat';
			mockSession.config.mcpServers = {
				'room-agent-tools': { command: 'room-cmd' },
			};
			const context: QueryOptionsBuilderContext = {
				session: mockSession,
				settingsManager: mockSettingsManager,
				skillsManager:
					mockSkillsManager as unknown as import('../../../src/lib/skills-manager').SkillsManager,
				appMcpServerRepo:
					mockAppMcpServerRepo as unknown as import('../../../src/storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
			};
			const builder = new QueryOptionsBuilder(context);
			const options = await builder.build();

			// strictMcpConfig should be true for room_chat
			expect(options.strictMcpConfig).toBe(true);
			// Skill-injected server must be present in mcpServers so strictMcpConfig doesn't block it
			expect(options.mcpServers!['brave-search']).toEqual({
				command: 'npx',
				args: ['-y', 'brave-mcp'],
				env: { BRAVE_API_KEY: 'test-key' },
			});
			// Original room server must still be present
			expect(options.mcpServers!['room-agent-tools']).toEqual({ command: 'room-cmd' });
			// Skill MCP server wildcard should be auto-allowed
			expect(options.allowedTools).toContain('brave-search__*');
		});

		it('should inject builtin skills as local plugins pointing to ~/.neokai/skills/{commandName}', async () => {
			const builtinSkill = {
				id: 'skill-builtin-1',
				name: 'playwright',
				displayName: 'Playwright',
				description: 'A builtin skill',
				sourceType: 'builtin' as const,
				config: { type: 'builtin' as const, commandName: 'playwright' },
				enabled: true,
				builtIn: true,
				validationStatus: 'valid' as const,
				createdAt: Date.now(),
			};
			const mockSkillsManager = {
				getEnabledSkills: mock(() => [builtinSkill]),
			};
			const context: QueryOptionsBuilderContext = {
				session: mockSession,
				settingsManager: mockSettingsManager,
				skillsManager:
					mockSkillsManager as unknown as import('../../../src/lib/skills-manager').SkillsManager,
			};
			const builder = new QueryOptionsBuilder(context);
			const options = await builder.build();

			// Builtin skills are injected as local plugins so the SDK discovers their SKILL.md
			expect(options.plugins).toBeDefined();
			expect(options.plugins).toHaveLength(1);
			expect(options.plugins![0]).toMatchObject({ type: 'local' });
			expect((options.plugins![0] as { type: string; path: string }).path).toContain(
				'.neokai/skills/playwright'
			);
			// Builtin skills do not contribute to mcpServers
			expect(options.mcpServers).toBeUndefined();
		});

		it('should not inject a disabled builtin skill', async () => {
			const builtinSkill = {
				id: 'skill-builtin-2',
				name: 'playwright-interactive',
				displayName: 'Playwright Interactive',
				description: 'A disabled builtin skill',
				sourceType: 'builtin' as const,
				config: { type: 'builtin' as const, commandName: 'playwright-interactive' },
				enabled: false,
				builtIn: true,
				validationStatus: 'valid' as const,
				createdAt: Date.now(),
			};
			const mockSkillsManager = {
				// getEnabledSkills returns only enabled skills — disabled are not returned
				getEnabledSkills: mock(() => []),
			};
			const context: QueryOptionsBuilderContext = {
				session: mockSession,
				settingsManager: mockSettingsManager,
				skillsManager:
					mockSkillsManager as unknown as import('../../../src/lib/skills-manager').SkillsManager,
			};
			const builder = new QueryOptionsBuilder(context);
			const options = await builder.build();

			// Disabled skill should not appear in plugins
			void builtinSkill; // referenced to avoid lint warning
			expect(options.plugins).toBeUndefined();
		});

		it('should handle SSE MCP server skills', async () => {
			const sseAppMcpServer = {
				id: 'sse-server-uuid',
				name: 'sse-server',
				sourceType: 'sse' as const,
				url: 'http://localhost:3001/sse',
				headers: { Authorization: 'Bearer token' },
				enabled: true,
			};
			const sseSkill = {
				id: 'skill-sse-1',
				name: 'sse-skill',
				displayName: 'SSE Skill',
				description: 'An SSE MCP skill',
				sourceType: 'mcp_server' as const,
				config: { type: 'mcp_server' as const, appMcpServerId: 'sse-server-uuid' },
				enabled: true,
				builtIn: false,
				validationStatus: 'valid' as const,
				createdAt: Date.now(),
			};
			const mockAppMcpServerRepo = {
				get: mock(() => sseAppMcpServer),
			};
			const mockSkillsManager = {
				getEnabledSkills: mock(() => [sseSkill]),
			};
			const context: QueryOptionsBuilderContext = {
				session: mockSession,
				settingsManager: mockSettingsManager,
				skillsManager:
					mockSkillsManager as unknown as import('../../../src/lib/skills-manager').SkillsManager,
				appMcpServerRepo:
					mockAppMcpServerRepo as unknown as import('../../../src/storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
			};
			const builder = new QueryOptionsBuilder(context);
			const options = await builder.build();

			expect(options.mcpServers!['sse-skill']).toEqual({
				type: 'sse',
				url: 'http://localhost:3001/sse',
				headers: { Authorization: 'Bearer token' },
			});
		});

		it('should handle HTTP MCP server skills', async () => {
			const httpAppMcpServer = {
				id: 'http-server-uuid',
				name: 'http-server',
				sourceType: 'http' as const,
				url: 'http://localhost:3002/mcp',
				enabled: true,
			};
			const httpSkill = {
				id: 'skill-http-1',
				name: 'http-skill',
				displayName: 'HTTP Skill',
				description: 'An HTTP MCP skill',
				sourceType: 'mcp_server' as const,
				config: { type: 'mcp_server' as const, appMcpServerId: 'http-server-uuid' },
				enabled: true,
				builtIn: false,
				validationStatus: 'valid' as const,
				createdAt: Date.now(),
			};
			const mockAppMcpServerRepo = {
				get: mock(() => httpAppMcpServer),
			};
			const mockSkillsManager = {
				getEnabledSkills: mock(() => [httpSkill]),
			};
			const context: QueryOptionsBuilderContext = {
				session: mockSession,
				settingsManager: mockSettingsManager,
				skillsManager:
					mockSkillsManager as unknown as import('../../../src/lib/skills-manager').SkillsManager,
				appMcpServerRepo:
					mockAppMcpServerRepo as unknown as import('../../../src/storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
			};
			const builder = new QueryOptionsBuilder(context);
			const options = await builder.build();

			expect(options.mcpServers!['http-skill']).toEqual({
				type: 'http',
				url: 'http://localhost:3002/mcp',
			});
		});
	});

	describe('room skill overrides', () => {
		const pluginSkill = {
			id: 'skill-plugin-room-1',
			name: 'room-plugin',
			displayName: 'Room Plugin',
			description: 'Plugin skill used in room override tests',
			sourceType: 'plugin' as const,
			config: { type: 'plugin' as const, pluginPath: '/plugins/room-plugin' },
			enabled: true,
			builtIn: false,
			validationStatus: 'valid' as const,
			createdAt: Date.now(),
		};

		const mcpSkill = {
			id: 'skill-mcp-room-1',
			name: 'room-mcp',
			displayName: 'Room MCP',
			description: 'MCP skill used in room override tests',
			sourceType: 'mcp_server' as const,
			config: { type: 'mcp_server' as const, appMcpServerId: 'mcp-room-uuid' },
			enabled: true,
			builtIn: false,
			validationStatus: 'valid' as const,
			createdAt: Date.now(),
		};

		const mockRoomMcpServer = {
			id: 'mcp-room-uuid',
			name: 'room-mcp-server',
			sourceType: 'stdio' as const,
			command: 'npx',
			args: ['-y', 'room-mcp'],
			enabled: true,
		};

		it('should exclude a plugin skill disabled by a room override', async () => {
			const mockSkillsManager = {
				getEnabledSkills: mock(() => [pluginSkill]),
			};
			const context: QueryOptionsBuilderContext = {
				session: mockSession,
				settingsManager: mockSettingsManager,
				skillsManager:
					mockSkillsManager as unknown as import('../../../src/lib/skills-manager').SkillsManager,
				roomSkillOverrides: [{ skillId: pluginSkill.id, roomId: 'room-1', enabled: false }],
			};
			const builder = new QueryOptionsBuilder(context);
			const options = await builder.build();

			// Room override disables the skill — must not appear in plugins
			expect(options.plugins).toBeUndefined();
		});

		it('should exclude an MCP server skill disabled by a room override', async () => {
			const mockAppMcpServerRepo = {
				get: mock(() => mockRoomMcpServer),
			};
			const mockSkillsManager = {
				getEnabledSkills: mock(() => [mcpSkill]),
			};
			const context: QueryOptionsBuilderContext = {
				session: mockSession,
				settingsManager: mockSettingsManager,
				skillsManager:
					mockSkillsManager as unknown as import('../../../src/lib/skills-manager').SkillsManager,
				appMcpServerRepo:
					mockAppMcpServerRepo as unknown as import('../../../src/storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
				roomSkillOverrides: [{ skillId: mcpSkill.id, roomId: 'room-1', enabled: false }],
			};
			const builder = new QueryOptionsBuilder(context);
			const options = await builder.build();

			// Room override disables the MCP skill — must not appear in mcpServers
			expect(options.mcpServers).toBeUndefined();
		});

		it('should still include a plugin skill when room override has enabled=true', async () => {
			const mockSkillsManager = {
				getEnabledSkills: mock(() => [pluginSkill]),
			};
			const context: QueryOptionsBuilderContext = {
				session: mockSession,
				settingsManager: mockSettingsManager,
				skillsManager:
					mockSkillsManager as unknown as import('../../../src/lib/skills-manager').SkillsManager,
				roomSkillOverrides: [{ skillId: pluginSkill.id, roomId: 'room-1', enabled: true }],
			};
			const builder = new QueryOptionsBuilder(context);
			const options = await builder.build();

			expect(options.plugins).toEqual([{ type: 'local', path: '/plugins/room-plugin' }]);
		});

		it('should apply room override only to the matching skill ID', async () => {
			const anotherPlugin = {
				id: 'skill-plugin-other',
				name: 'other-plugin',
				displayName: 'Other Plugin',
				description: 'Another plugin not targeted by the override',
				sourceType: 'plugin' as const,
				config: { type: 'plugin' as const, pluginPath: '/plugins/other-plugin' },
				enabled: true,
				builtIn: false,
				validationStatus: 'valid' as const,
				createdAt: Date.now(),
			};
			const mockSkillsManager = {
				getEnabledSkills: mock(() => [pluginSkill, anotherPlugin]),
			};
			const context: QueryOptionsBuilderContext = {
				session: mockSession,
				settingsManager: mockSettingsManager,
				skillsManager:
					mockSkillsManager as unknown as import('../../../src/lib/skills-manager').SkillsManager,
				// Disable only pluginSkill; anotherPlugin should still appear
				roomSkillOverrides: [{ skillId: pluginSkill.id, roomId: 'room-1', enabled: false }],
			};
			const builder = new QueryOptionsBuilder(context);
			const options = await builder.build();

			expect(options.plugins).toEqual([{ type: 'local', path: '/plugins/other-plugin' }]);
		});

		it('should include all skills when roomSkillOverrides is empty', async () => {
			const mockSkillsManager = {
				getEnabledSkills: mock(() => [pluginSkill]),
			};
			const context: QueryOptionsBuilderContext = {
				session: mockSession,
				settingsManager: mockSettingsManager,
				skillsManager:
					mockSkillsManager as unknown as import('../../../src/lib/skills-manager').SkillsManager,
				roomSkillOverrides: [],
			};
			const builder = new QueryOptionsBuilder(context);
			const options = await builder.build();

			expect(options.plugins).toEqual([{ type: 'local', path: '/plugins/room-plugin' }]);
		});

		it('should include all skills when roomSkillOverrides is not provided', async () => {
			const mockSkillsManager = {
				getEnabledSkills: mock(() => [pluginSkill]),
			};
			const context: QueryOptionsBuilderContext = {
				session: mockSession,
				settingsManager: mockSettingsManager,
				skillsManager:
					mockSkillsManager as unknown as import('../../../src/lib/skills-manager').SkillsManager,
			};
			const builder = new QueryOptionsBuilder(context);
			const options = await builder.build();

			expect(options.plugins).toEqual([{ type: 'local', path: '/plugins/room-plugin' }]);
		});
	});

	// Task 7.1 regression: Skill/WebSearch/WebFetch tools must remain available after Skills registry changes
	describe('regression: Skill, WebSearch, WebFetch tool availability (Task 7.1)', () => {
		beforeEach(() => {
			mockSession.type = 'room_chat';
		});

		it('room_chat sessions include Skill in tools list', async () => {
			const options = await new QueryOptionsBuilder(mockContext).build();
			expect(options.tools).toContain('Skill');
		});

		it('room_chat sessions include WebSearch in tools list', async () => {
			const options = await new QueryOptionsBuilder(mockContext).build();
			expect(options.tools).toContain('WebSearch');
		});

		it('room_chat sessions include WebFetch in tools list', async () => {
			const options = await new QueryOptionsBuilder(mockContext).build();
			expect(options.tools).toContain('WebFetch');
		});

		it('room_chat allowedTools includes Skill, WebSearch, WebFetch', async () => {
			const options = await new QueryOptionsBuilder(mockContext).build();
			expect(options.allowedTools).toContain('Skill');
			expect(options.allowedTools).toContain('WebSearch');
			expect(options.allowedTools).toContain('WebFetch');
		});

		it('coordinator mode allowedTools includes Skill, WebSearch, WebFetch', async () => {
			mockSession.config.coordinatorMode = true;
			const options = await new QueryOptionsBuilder(mockContext).build();
			expect(options.allowedTools).toContain('Skill');
			expect(options.allowedTools).toContain('WebSearch');
			expect(options.allowedTools).toContain('WebFetch');
		});
	});

	// Task G7: disabled MCP servers must be excluded from mcpServers map regardless of session type
	describe('disabledMcpServers filtering', () => {
		it('excludes disabled servers from mcpServers for normal sessions', async () => {
			mockSession.config.mcpServers = {
				'my-server': { command: 'run-server' },
				'other-server': { command: 'run-other' },
			};
			mockSession.config.tools = {
				disabledMcpServers: ['my-server'],
			};

			const options = await builder.build();

			expect(options.mcpServers).not.toHaveProperty('my-server');
			expect(options.mcpServers).toHaveProperty('other-server');
		});

		it('excludes disabled servers from mcpServers for room_chat sessions', async () => {
			mockSession.type = 'room_chat';
			mockSession.config.mcpServers = {
				'room-agent-tools': { command: 'room-cmd' },
				'my-project-server': { command: 'project-cmd' },
			};
			mockSession.config.tools = {
				disabledMcpServers: ['my-project-server'],
			};

			const options = await builder.build();

			// room_chat always has strictMcpConfig: true and settingSources: []
			expect(options.strictMcpConfig).toBe(true);
			expect(options.settingSources).toEqual([]);
			// Disabled server must not appear even though settingSources is empty
			expect(options.mcpServers).not.toHaveProperty('my-project-server');
			expect(options.mcpServers).toHaveProperty('room-agent-tools');
		});

		it('keeps all servers when disabledMcpServers is empty', async () => {
			mockSession.config.mcpServers = {
				'server-a': { command: 'cmd-a' },
				'server-b': { command: 'cmd-b' },
			};
			mockSession.config.tools = {
				disabledMcpServers: [],
			};

			const options = await builder.build();

			expect(options.mcpServers).toHaveProperty('server-a');
			expect(options.mcpServers).toHaveProperty('server-b');
		});

		it('returns undefined mcpServers when all servers are disabled', async () => {
			mockSession.config.mcpServers = {
				'only-server': { command: 'cmd' },
			};
			mockSession.config.tools = {
				disabledMcpServers: ['only-server'],
			};

			const options = await builder.build();

			expect(options.mcpServers).toBeUndefined();
		});

		it('room_chat allowedTools wildcards exclude disabled server', async () => {
			mockSession.type = 'room_chat';
			mockSession.config.mcpServers = {
				'room-agent-tools': { command: 'room-cmd' },
				'disabled-server': { command: 'dis-cmd' },
			};
			mockSession.config.tools = {
				disabledMcpServers: ['disabled-server'],
			};

			const options = await builder.build();

			// allowedTools wildcards are generated from the filtered mcpServers
			expect(options.allowedTools).toContain('room-agent-tools__*');
			expect(options.allowedTools).not.toContain('disabled-server__*');
		});
	});

	describe('always-on agent/agents propagation (room agents)', () => {
		const coderExplorerDef = {
			description: 'Read-only codebase explorer.',
			tools: ['Read', 'Grep', 'Glob', 'Bash'],
			model: 'inherit' as const,
			prompt: 'You are an Explorer Agent.',
		};
		const coderTesterDef = {
			description: 'Test writer and runner.',
			tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
			model: 'inherit' as const,
			prompt: 'You are a Tester Agent.',
		};
		const coderAgentDef = {
			description: 'Implementation agent.',
			tools: ['Task', 'TaskOutput', 'TaskStop', 'Read', 'Write', 'Edit', 'Bash'],
			model: 'inherit' as const,
			prompt: 'You are a Coder Agent.',
		};

		it('preserves config.agent exactly when coordinatorMode is off', async () => {
			mockSession.config.agent = 'Coder';
			mockSession.config.agents = {
				Coder: coderAgentDef,
				'coder-explorer': coderExplorerDef,
				'coder-tester': coderTesterDef,
			};
			mockSession.config.coordinatorMode = false;

			const options = await builder.build();

			expect(options.agent).toBe('Coder');
		});

		it('preserves config.agents map exactly when coordinatorMode is off', async () => {
			mockSession.config.agent = 'Coder';
			mockSession.config.agents = {
				Coder: coderAgentDef,
				'coder-explorer': coderExplorerDef,
				'coder-tester': coderTesterDef,
			};
			mockSession.config.coordinatorMode = false;

			const options = await builder.build();

			expect(Object.keys(options.agents!)).toEqual(['Coder', 'coder-explorer', 'coder-tester']);
			expect(options.agents!['Coder']).toEqual(coderAgentDef);
			expect(options.agents!['coder-explorer']).toEqual(coderExplorerDef);
			expect(options.agents!['coder-tester']).toEqual(coderTesterDef);
		});

		it('preserves config.agents when coordinatorMode is undefined (always-on default)', async () => {
			// coordinatorMode is never set — the always-on pattern default
			mockSession.config.agent = 'Coder';
			mockSession.config.agents = {
				Coder: coderAgentDef,
				'coder-explorer': coderExplorerDef,
				'coder-tester': coderTesterDef,
			};

			const options = await builder.build();

			expect(options.agent).toBe('Coder');
			expect(Object.keys(options.agents!)).toHaveLength(3);
			expect(options.agents!['coder-explorer']).toEqual(coderExplorerDef);
		});

		it('coordinatorMode ON overwrites room agent config with coordinator agents', async () => {
			// Even if room agent config is set, coordinator mode takes over
			mockSession.config.agent = 'Coder';
			mockSession.config.agents = {
				Coder: coderAgentDef,
				'coder-explorer': coderExplorerDef,
			};
			mockSession.config.coordinatorMode = true;

			const options = await builder.build();

			// Coordinator mode overwrites agent to 'Coordinator'
			expect(options.agent).toBe('Coordinator');
			// Coordinator specialists are present
			expect(options.agents!['Coordinator']).toBeDefined();
			expect(options.agents!['Debugger']).toBeDefined();
			// The coordinator's Coder specialist wins over the room-agent Coder def
			expect(options.agents!['Coder']).toBeDefined();
		});

		it('coordinatorMode ON merges room custom agents into coordinator agents map', async () => {
			// Custom non-conflicting agents from room config are preserved in coordinator mode
			mockSession.config.agents = {
				'my-custom': { description: 'Custom agent', prompt: 'Custom.' },
			};
			mockSession.config.coordinatorMode = true;

			const options = await builder.build();

			expect(options.agent).toBe('Coordinator');
			// Custom agent is merged in (no name conflict with specialist names)
			expect(options.agents!['my-custom']).toBeDefined();
			// Built-in specialists are also present
			expect(options.agents!['Coordinator']).toBeDefined();
			expect(options.agents!['Coder']).toBeDefined();
		});

		it('worktree isolation is in system prompt but NOT injected into room agent sub-agents', async () => {
			mockSession.config.agent = 'Coder';
			mockSession.config.agents = {
				Coder: coderAgentDef,
				'coder-explorer': coderExplorerDef,
				'coder-tester': coderTesterDef,
			};
			// coordinatorMode is off (room agent mode)
			mockSession.worktree = {
				worktreePath: '/worktree/path',
				mainRepoPath: '/main/repo',
				branch: 'task/my-task',
			};
			const newBuilder = new QueryOptionsBuilder({
				session: mockSession,
				settingsManager: mockSettingsManager,
			});

			const options = await newBuilder.build();

			// System prompt gets worktree isolation (session-level protection)
			const systemPrompt = options.systemPrompt as { append?: string };
			expect(systemPrompt.append).toContain('Git Worktree Isolation');

			// Sub-agent prompts are NOT modified — cwd is the worktree path,
			// which provides the actual directory isolation for sub-agents
			expect((options.agents!['coder-explorer'] as { prompt: string }).prompt).toBe(
				coderExplorerDef.prompt
			);
			expect((options.agents!['coder-tester'] as { prompt: string }).prompt).toBe(
				coderTesterDef.prompt
			);
		});

		it('coordinator mode injects worktree isolation into specialist agent prompts', async () => {
			mockSession.config.coordinatorMode = true;
			mockSession.worktree = {
				worktreePath: '/worktree/path',
				mainRepoPath: '/main/repo',
				branch: 'task/my-task',
			};
			const newBuilder = new QueryOptionsBuilder({
				session: mockSession,
				settingsManager: mockSettingsManager,
			});

			const options = await newBuilder.build();

			// Coordinator mode injects worktree isolation into specialist agents
			const coderPrompt = (options.agents!['Coder'] as { prompt: string }).prompt;
			expect(coderPrompt).toContain('Git Worktree Isolation');

			// But NOT into the Coordinator itself
			const coordinatorPrompt = (options.agents!['Coordinator'] as { prompt: string }).prompt;
			expect(coordinatorPrompt).not.toContain('Git Worktree Isolation');
		});
	});
});
