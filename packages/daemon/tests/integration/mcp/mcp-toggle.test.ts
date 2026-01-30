/**
 * MCP Toggle Integration Tests
 *
 * Tests for MCP (Model Context Protocol) toggle functionality.
 * Uses the new disabledMcpServers approach:
 * - Empty disabledMcpServers = all servers enabled
 * - Server name in disabledMcpServers = that server disabled
 *
 * This is a direct 1:1 UI→SDK mapping where disabledMcpServers is written
 * to .claude/settings.local.json as disabledMcpjsonServers.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../test-utils';
import { createTestApp, callRPCHandler } from '../../test-utils';
import type { ToolsConfig } from '@neokai/shared';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('MCP Toggle Integration', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('tools.save RPC', () => {
		test('should save tools config with all servers enabled (empty disabledMcpServers)', async () => {
			// Create a session
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/mcp-test-1` }
			);

			// Save tools config with all servers enabled (empty disabled list)
			const toolsConfig: ToolsConfig = {
				useClaudeCodePreset: true,
				disabledMcpServers: [], // Empty = all enabled
				kaiTools: { memory: false },
			};

			const result = await callRPCHandler<{ success: boolean }>(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: toolsConfig,
			});

			expect(result.success).toBe(true);

			// Verify config was saved to database
			const session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.disabledMcpServers).toEqual([]);
		});

		test('should save tools config with specific servers disabled', async () => {
			// Create a session
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/mcp-test-2` }
			);

			// Save tools config with specific servers disabled
			const toolsConfig: ToolsConfig = {
				useClaudeCodePreset: true,
				disabledMcpServers: ['chrome-devtools', 'filesystem'],
				kaiTools: { memory: false },
			};

			const result = await callRPCHandler<{ success: boolean }>(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: toolsConfig,
			});

			expect(result.success).toBe(true);

			// Verify config was saved
			const session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.disabledMcpServers).toEqual(['chrome-devtools', 'filesystem']);
		});

		test('should toggle server from enabled to disabled', async () => {
			// Create a session
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/mcp-test-3` }
			);

			// Start with all enabled
			await callRPCHandler<{ success: boolean }>(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: { disabledMcpServers: [] },
			});

			let session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.disabledMcpServers).toEqual([]);

			// Disable chrome-devtools
			await callRPCHandler<{ success: boolean }>(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: { disabledMcpServers: ['chrome-devtools'] },
			});

			session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.disabledMcpServers).toEqual(['chrome-devtools']);
		});

		test('should toggle server from disabled to enabled', async () => {
			// Create a session
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/mcp-test-4` }
			);

			// Start with chrome-devtools disabled
			await callRPCHandler<{ success: boolean }>(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: { disabledMcpServers: ['chrome-devtools'] },
			});

			let session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.disabledMcpServers).toEqual(['chrome-devtools']);

			// Enable chrome-devtools (remove from disabled list)
			await callRPCHandler<{ success: boolean }>(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: { disabledMcpServers: [] },
			});

			session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.disabledMcpServers).toEqual([]);
		});
	});

	describe('mcp.updateDisabledServers RPC', () => {
		test('should update disabled servers list', async () => {
			// Create a session
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/mcp-test-5` }
			);

			// Use the new RPC method to update disabled servers
			const result = await callRPCHandler<{ success: boolean }>(
				ctx.messageHub,
				'mcp.updateDisabledServers',
				{
					sessionId,
					disabledServers: ['chrome-devtools', 'github'],
				}
			);

			expect(result.success).toBe(true);

			// Verify via mcp.getDisabledServers
			const getResult = await callRPCHandler<{ disabledServers: string[] }>(
				ctx.messageHub,
				'mcp.getDisabledServers',
				{ sessionId }
			);

			expect(getResult.disabledServers).toEqual(['chrome-devtools', 'github']);
		});

		test('should enable all servers by setting empty disabled list', async () => {
			// Create a session
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/mcp-test-6` }
			);

			// First disable some servers
			await callRPCHandler<{ success: boolean }>(ctx.messageHub, 'mcp.updateDisabledServers', {
				sessionId,
				disabledServers: ['chrome-devtools'],
			});

			// Then enable all by setting empty list
			await callRPCHandler<{ success: boolean }>(ctx.messageHub, 'mcp.updateDisabledServers', {
				sessionId,
				disabledServers: [],
			});

			const getResult = await callRPCHandler<{ disabledServers: string[] }>(
				ctx.messageHub,
				'mcp.getDisabledServers',
				{ sessionId }
			);

			expect(getResult.disabledServers).toEqual([]);
		});
	});

	describe('Default session configuration', () => {
		test('should create session with empty disabledMcpServers by default', async () => {
			// Create a session without specifying tools config
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/mcp-test-7` }
			);

			// New sessions should have all servers enabled (empty disabled list)
			const session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.disabledMcpServers).toEqual([]);
		});
	});

	describe('Multiple server management', () => {
		test('should handle multiple servers being disabled', async () => {
			// Create a session
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/mcp-test-8` }
			);

			// Disable multiple servers
			await callRPCHandler<{ success: boolean }>(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: {
					disabledMcpServers: ['chrome-devtools', 'filesystem', 'github'],
				},
			});

			let session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.disabledMcpServers?.length).toBe(3);
			expect(session?.config.tools?.disabledMcpServers).toContain('chrome-devtools');
			expect(session?.config.tools?.disabledMcpServers).toContain('filesystem');
			expect(session?.config.tools?.disabledMcpServers).toContain('github');

			// Remove one server from disabled list (enable it)
			await callRPCHandler<{ success: boolean }>(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: {
					disabledMcpServers: ['filesystem', 'github'],
				},
			});

			session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.disabledMcpServers?.length).toBe(2);
			expect(session?.config.tools?.disabledMcpServers).not.toContain('chrome-devtools');
		});

		test('should preserve other tools config when updating disabledMcpServers', async () => {
			// Create a session
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/mcp-test-9` }
			);

			// Set initial config with various options
			await callRPCHandler<{ success: boolean }>(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: {
					useClaudeCodePreset: true,
					disabledMcpServers: [],
					kaiTools: { memory: true },
				},
			});

			// Update only disabledMcpServers
			await callRPCHandler<{ success: boolean }>(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: {
					useClaudeCodePreset: true,
					disabledMcpServers: ['chrome-devtools'],
					kaiTools: { memory: true },
				},
			});

			const session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.useClaudeCodePreset).toBe(true);
			expect(session?.config.tools?.disabledMcpServers).toEqual(['chrome-devtools']);
			expect(session?.config.tools?.kaiTools?.memory).toBe(true);
		});
	});
});
