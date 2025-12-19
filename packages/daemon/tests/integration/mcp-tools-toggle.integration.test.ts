/**
 * Integration test for MCP tools enable/disable functionality
 *
 * Tests the file-based approach:
 * 1. Create session with MCP server available
 * 2. Disable server via disabledMcpServers → verify written to settings.local.json
 * 3. Enable server (remove from disabled list) → verify file updated
 *
 * Key insight: The SDK reads .claude/settings.local.json on each turn,
 * so changes take effect without session restart.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestApp, callRPCHandler, hasAnyCredentials, type TestContext } from '../test-utils';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session } from '@liuboer/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe.skipIf(!hasAnyCredentials())('MCP Tools Toggle Integration', () => {
	let ctx: TestContext;
	let sessionId: string;

	beforeEach(async () => {
		ctx = await createTestApp();

		// Setup: Create dummy MCP config in workspace root (project-level .mcp.json)
		mkdirSync(ctx.workspacePath, { recursive: true });
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
		writeFileSync(join(ctx.workspacePath, '.mcp.json'), JSON.stringify(mcpConfig, null, 2));
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	test(
		'disabledMcpServers is written to settings.local.json',
		async () => {
			// Step 1: Create session
			const createResult = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{
					workspacePath: ctx.workspacePath,
				}
			);
			sessionId = createResult.sessionId;

			// Verify session has proper setting sources
			const session1 = await callRPCHandler<{ session: Session }>(ctx.messageHub, 'session.get', {
				sessionId,
			});
			expect(session1.session.config.tools?.settingSources).toContain('user');
			expect(session1.session.config.tools?.settingSources).toContain('project');
			expect(session1.session.config.tools?.settingSources).toContain('local');

			// Step 2: Verify MCP servers are available from settings
			const mcpServers = await callRPCHandler<{
				servers: Record<string, Array<{ name: string }>>;
			}>(ctx.messageHub, 'settings.mcp.listFromSources', {});

			console.log('[Test] MCP servers from sources:', JSON.stringify(mcpServers, null, 2));

			const projectServers = mcpServers.servers.project || [];
			expect(projectServers.some((s) => s.name === 'dummy-test-server')).toBe(true);
			expect(projectServers.some((s) => s.name === 'another-server')).toBe(true);

			// Step 3: Disable dummy-test-server (add to disabled list)
			console.log('[Test] Disabling dummy-test-server via disabledMcpServers');
			const disableResult = await callRPCHandler<{ success: boolean }>(
				ctx.messageHub,
				'tools.save',
				{
					sessionId,
					tools: {
						useClaudeCodePreset: true,
						settingSources: ['user', 'project', 'local'],
						// NEW APPROACH: List of disabled servers (unchecked in UI)
						disabledMcpServers: ['dummy-test-server'],
						liuboerTools: { memory: false },
					},
				}
			);
			expect(disableResult.success).toBe(true);

			// Step 4: Verify settings.local.json was written correctly
			const settingsLocalPath = join(ctx.workspacePath, '.claude', 'settings.local.json');
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
			const enableResult = await callRPCHandler<{ success: boolean }>(
				ctx.messageHub,
				'tools.save',
				{
					sessionId,
					tools: {
						useClaudeCodePreset: true,
						settingSources: ['user', 'project', 'local'],
						// Empty list = all servers enabled
						disabledMcpServers: [],
						liuboerTools: { memory: false },
					},
				}
			);
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
			const createResult = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{
					workspacePath: ctx.workspacePath,
				}
			);
			sessionId = createResult.sessionId;

			// Step 2: Save tools config with disabled servers
			await callRPCHandler<{ success: boolean }>(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: {
					useClaudeCodePreset: true,
					settingSources: ['user', 'project', 'local'],
					disabledMcpServers: ['dummy-test-server', 'another-server'],
					liuboerTools: { memory: false },
				},
			});

			// Step 3: Get session and verify config is stored
			const session = await callRPCHandler<{ session: Session }>(ctx.messageHub, 'session.get', {
				sessionId,
			});

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
