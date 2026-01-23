/**
 * Integration test for MCP tools enable/disable functionality
 *
 * Tests the file-based approach:
 * 1. Create session with MCP server available
 * 2. Disable server via disabledMcpServers → verify written to settings.local.json
 * 3. Enable server (remove from disabled list) → verify file updated
 *
 * Key insight: The SDK reads .claude/settings.local.json at query initialization.
 * Query restart is required for changes to take effect (implemented in updateToolsConfig).
 *
 * REQUIREMENTS:
 * - Requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
 * - Makes real API calls (costs money, uses rate limits)
 * - Tests will FAIL if credentials are not available (no skip)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { DaemonServerContext } from '../helpers/daemon-server-helper';
import { spawnDaemonServer } from '../helpers/daemon-server-helper';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '@liuboer/shared';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('MCP Tools Toggle Integration', () => {
	let daemon: DaemonServerContext;
	let workspacePath: string;

	beforeEach(async () => {
		daemon = await spawnDaemonServer();
	}, 30000);

	beforeEach(async () => {
		workspacePath = join(TMP_DIR, `liuboer-test-mcp-${Date.now()}`);

		// Setup: Create dummy MCP config in workspace root (project-level .mcp.json)
		mkdirSync(workspacePath, { recursive: true });
		const mcpConfig = {
			mcpServers: {
				'dummy-test-server': {
					command: 'echo',
					args: ['test-server'],
				},
				'another-server': {
					command: 'echo',
					args: ['another'],
				},
			},
		};
		writeFileSync(join(workspacePath, '.mcp.json'), JSON.stringify(mcpConfig, null, 2));
	});

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	});

	test(
		'disabledMcpServers is written to settings.local.json',
		async () => {
			// Step 1: Create session
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'MCP Tools Toggle Test',
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Verify session has proper setting sources
			const session1 = (await daemon.messageHub.call('session.get', {
				sessionId,
			})) as { session: Session };
			expect(session1.session.config.tools?.settingSources).toContain('user');
			expect(session1.session.config.tools?.settingSources).toContain('project');
			expect(session1.session.config.tools?.settingSources).toContain('local');

			// Step 2: Verify MCP servers are available from settings
			const mcpServers = (await daemon.messageHub.call('settings.mcp.listFromSources', {
				sessionId,
			})) as {
				servers: Record<string, Array<{ name: string }>>;
			};

			console.log('[Test] MCP servers from sources:', JSON.stringify(mcpServers, null, 2));

			const projectServers = mcpServers.servers.project || [];
			expect(projectServers.some((s) => s.name === 'dummy-test-server')).toBe(true);
			expect(projectServers.some((s) => s.name === 'another-server')).toBe(true);

			// Step 3: Disable dummy-test-server (add to disabled list)
			console.log('[Test] Disabling dummy-test-server via disabledMcpServers');
			const disableResult = (await daemon.messageHub.call('tools.save', {
				sessionId,
				tools: {
					useClaudeCodePreset: true,
					settingSources: ['user', 'project', 'local'],
					// NEW APPROACH: List of disabled servers (unchecked in UI)
					disabledMcpServers: ['dummy-test-server'],
					liuboerTools: { memory: false },
				},
			})) as { success: boolean };
			expect(disableResult.success).toBe(true);

			// Step 4: Verify settings.local.json was written correctly
			const settingsLocalPath = join(workspacePath, '.claude', 'settings.local.json');
			expect(existsSync(settingsLocalPath)).toBe(true);

			const settingsContent = readFileSync(settingsLocalPath, 'utf-8');
			const settings = JSON.parse(settingsContent);
			console.log('[Test] settings.local.json content:', JSON.stringify(settings, null, 2));

			// Verify disabledMcpjsonServers contains dummy-test-server
			expect(settings.disabledMcpjsonServers).toContain('dummy-test-server');
			// another-server should NOT be in the disabled list
			expect(settings.disabledMcpjsonServers).not.toContain('another-server');

			// Step 5: Enable dummy-test-server (remove from disabled list)
			console.log('[Test] Enabling dummy-test-server (removing from disabled list)');
			const enableResult = (await daemon.messageHub.call('tools.save', {
				sessionId,
				tools: {
					useClaudeCodePreset: true,
					settingSources: ['user', 'project', 'local'],
					// Empty list = all servers enabled
					disabledMcpServers: [],
					liuboerTools: { memory: false },
				},
			})) as { success: boolean };
			expect(enableResult.success).toBe(true);

			// Step 6: Verify settings.local.json was updated
			const settingsContent2 = readFileSync(settingsLocalPath, 'utf-8');
			const settings2 = JSON.parse(settingsContent2);
			console.log('[Test] Updated settings.local.json:', JSON.stringify(settings2, null, 2));

			// Verify disabledMcpjsonServers is now empty
			expect(settings2.disabledMcpjsonServers).toEqual([]);

			console.log('[Test] File-based MCP control test passed!');
		},
		{ timeout: 30000 }
	);

	test(
		'session config stores disabledMcpServers correctly',
		async () => {
			// Step 1: Create session
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'MCP Config Storage Test',
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Step 2: Save tools config with disabled servers
			await daemon.messageHub.call('tools.save', {
				sessionId,
				tools: {
					useClaudeCodePreset: true,
					settingSources: ['user', 'project', 'local'],
					disabledMcpServers: ['dummy-test-server', 'another-server'],
					liuboerTools: { memory: false },
				},
			});

			// Step 3: Get session and verify config is stored
			const session = (await daemon.messageHub.call('session.get', {
				sessionId,
			})) as { session: Session };

			console.log(
				'[Test] Session config tools:',
				JSON.stringify(session.session.config.tools, null, 2)
			);

			expect(session.session.config.tools?.disabledMcpServers).toEqual([
				'dummy-test-server',
				'another-server',
			]);
		},
		{ timeout: 15000 }
	);
});
