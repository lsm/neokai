/**
 * MCP Toggle Integration Tests
 *
 * Tests for MCP (Model Context Protocol) toggle functionality.
 * Verifies that:
 * 1. MCP tools can be enabled/disabled via tools.save RPC
 * 2. loadProjectMcp auto-syncs with enabledMcpPatterns
 * 3. Disabling all MCP patterns sets loadProjectMcp to false
 * 4. Session config correctly reflects MCP toggle state
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../test-utils';
import { createTestApp, callRPCHandler } from '../test-utils';
import type { ToolsConfig } from '@liuboer/shared';

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
		test('should save tools config with MCP patterns enabled', async () => {
			// Create a session
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/mcp-test-1` }
			);

			// Save tools config with MCP enabled
			const toolsConfig: ToolsConfig = {
				useClaudeCodePreset: true,
				loadSettingSources: true,
				loadProjectMcp: true,
				enabledMcpPatterns: ['mcp__chrome-devtools__*', 'mcp__filesystem__*'],
				liuboerTools: { memory: false },
			};

			const result = await callRPCHandler<{ success: boolean }>(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: toolsConfig,
			});

			expect(result.success).toBe(true);

			// Verify config was saved to database
			const session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.loadProjectMcp).toBe(true);
			expect(session?.config.tools?.enabledMcpPatterns).toEqual([
				'mcp__chrome-devtools__*',
				'mcp__filesystem__*',
			]);
		});

		test('should save tools config with MCP disabled (empty patterns)', async () => {
			// Create a session
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/mcp-test-2` }
			);

			// Save tools config with MCP disabled (empty patterns)
			const toolsConfig: ToolsConfig = {
				useClaudeCodePreset: true,
				loadSettingSources: true,
				loadProjectMcp: false, // Should be false when patterns are empty
				enabledMcpPatterns: [],
				liuboerTools: { memory: false },
			};

			const result = await callRPCHandler<{ success: boolean }>(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: toolsConfig,
			});

			expect(result.success).toBe(true);

			// Verify config was saved to database
			const session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.loadProjectMcp).toBe(false);
			expect(session?.config.tools?.enabledMcpPatterns).toEqual([]);
		});

		test('should handle transition from enabled to disabled MCP', async () => {
			// Create a session
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/mcp-test-3` }
			);

			// First enable MCP
			await callRPCHandler<{ success: boolean }>(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: {
					useClaudeCodePreset: true,
					loadSettingSources: true,
					loadProjectMcp: true,
					enabledMcpPatterns: ['mcp__chrome-devtools__*'],
					liuboerTools: { memory: false },
				},
			});

			// Verify MCP is enabled
			let session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.loadProjectMcp).toBe(true);
			expect(session?.config.tools?.enabledMcpPatterns?.length).toBe(1);

			// Now disable MCP by removing all patterns
			await callRPCHandler<{ success: boolean }>(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: {
					useClaudeCodePreset: true,
					loadSettingSources: true,
					loadProjectMcp: false, // Auto-synced with empty patterns
					enabledMcpPatterns: [],
					liuboerTools: { memory: false },
				},
			});

			// Verify MCP is disabled
			session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.loadProjectMcp).toBe(false);
			expect(session?.config.tools?.enabledMcpPatterns).toEqual([]);
		});

		test('should preserve other config when updating tools', async () => {
			// Create a session with specific config
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{
					workspacePath: `${TMP_DIR}/mcp-test-4`,
					config: {
						model: 'default',
						maxTokens: 4096,
						temperature: 0.7,
					},
				}
			);

			// Save tools config
			await callRPCHandler<{ success: boolean }>(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: {
					useClaudeCodePreset: true,
					loadSettingSources: true,
					loadProjectMcp: true,
					enabledMcpPatterns: ['mcp__test__*'],
					liuboerTools: { memory: true },
				},
			});

			// Verify other config values are preserved
			const session = ctx.db.getSession(sessionId);
			expect(session?.config.model).toBe('default');
			expect(session?.config.maxTokens).toBe(4096);
			expect(session?.config.temperature).toBe(0.7);
			// And tools config is set
			expect(session?.config.tools?.loadProjectMcp).toBe(true);
		});

		test('should throw error for non-existent session', async () => {
			await expect(
				callRPCHandler(ctx.messageHub, 'tools.save', {
					sessionId: 'non-existent-session',
					tools: {
						useClaudeCodePreset: true,
						loadSettingSources: true,
						loadProjectMcp: false,
						enabledMcpPatterns: [],
						liuboerTools: { memory: false },
					},
				})
			).rejects.toThrow('Session not found');
		});
	});

	describe('mcp.updateEnabledTools (legacy)', () => {
		test('should auto-sync loadProjectMcp when patterns are added', async () => {
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/mcp-legacy-1` }
			);

			// Use legacy handler to enable tools
			await callRPCHandler(ctx.messageHub, 'mcp.updateEnabledTools', {
				sessionId,
				enabledTools: ['mcp__chrome-devtools__*'],
			});

			// Verify loadProjectMcp is auto-synced to true
			const session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.loadProjectMcp).toBe(true);
			expect(session?.config.tools?.enabledMcpPatterns).toEqual(['mcp__chrome-devtools__*']);
		});

		test('should auto-sync loadProjectMcp when all patterns are removed', async () => {
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/mcp-legacy-2` }
			);

			// First enable some tools
			await callRPCHandler(ctx.messageHub, 'mcp.updateEnabledTools', {
				sessionId,
				enabledTools: ['mcp__chrome-devtools__*'],
			});

			// Then remove all tools
			await callRPCHandler(ctx.messageHub, 'mcp.updateEnabledTools', {
				sessionId,
				enabledTools: [],
			});

			// Verify loadProjectMcp is auto-synced to false
			const session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.loadProjectMcp).toBe(false);
			expect(session?.config.tools?.enabledMcpPatterns).toEqual([]);
		});
	});

	describe('mcp.getEnabledTools', () => {
		test('should return enabled tools patterns', async () => {
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/mcp-get-1` }
			);

			// Enable some tools
			await callRPCHandler(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: {
					useClaudeCodePreset: true,
					loadSettingSources: true,
					loadProjectMcp: true,
					enabledMcpPatterns: ['mcp__server1__*', 'mcp__server2__*'],
					liuboerTools: { memory: false },
				},
			});

			// Get enabled tools
			const result = await callRPCHandler<{ enabledTools: string[] }>(
				ctx.messageHub,
				'mcp.getEnabledTools',
				{ sessionId }
			);

			expect(result.enabledTools).toEqual(['mcp__server1__*', 'mcp__server2__*']);
		});

		test('should return empty array when no tools enabled', async () => {
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/mcp-get-2` }
			);

			// Get enabled tools for fresh session
			const result = await callRPCHandler<{ enabledTools: string[] }>(
				ctx.messageHub,
				'mcp.getEnabledTools',
				{ sessionId }
			);

			expect(result.enabledTools).toEqual([]);
		});
	});

	describe('session config tools state', () => {
		test('should have default tools config for new session', async () => {
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/mcp-state-1` }
			);

			const session = ctx.db.getSession(sessionId);
			// New sessions have default tools config initialized
			expect(session?.config.tools).toBeDefined();
			// Default config should have MCP disabled
			expect(session?.config.tools?.loadProjectMcp).toBe(false);
			expect(session?.config.tools?.enabledMcpPatterns).toEqual([]);
		});

		test('should correctly initialize tools config after first save', async () => {
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/mcp-state-2` }
			);

			// Save initial tools config
			await callRPCHandler(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: {
					useClaudeCodePreset: true,
					loadSettingSources: true,
					loadProjectMcp: false,
					enabledMcpPatterns: [],
					liuboerTools: { memory: false },
				},
			});

			const session = ctx.db.getSession(sessionId);
			expect(session?.config.tools).toBeDefined();
			expect(session?.config.tools?.useClaudeCodePreset).toBe(true);
			expect(session?.config.tools?.loadSettingSources).toBe(true);
			expect(session?.config.tools?.loadProjectMcp).toBe(false);
			expect(session?.config.tools?.enabledMcpPatterns).toEqual([]);
		});

		test('should maintain consistency between loadProjectMcp and enabledMcpPatterns', async () => {
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/mcp-state-3` }
			);

			// Test case 1: patterns exist, loadProjectMcp should be true
			await callRPCHandler(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: {
					useClaudeCodePreset: true,
					loadSettingSources: true,
					loadProjectMcp: true,
					enabledMcpPatterns: ['mcp__test__*'],
					liuboerTools: { memory: false },
				},
			});

			let session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.loadProjectMcp).toBe(true);
			expect(session?.config.tools?.enabledMcpPatterns?.length).toBeGreaterThan(0);

			// Test case 2: patterns empty, loadProjectMcp should be false
			await callRPCHandler(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: {
					useClaudeCodePreset: true,
					loadSettingSources: true,
					loadProjectMcp: false, // Should match empty patterns
					enabledMcpPatterns: [],
					liuboerTools: { memory: false },
				},
			});

			session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.loadProjectMcp).toBe(false);
			expect(session?.config.tools?.enabledMcpPatterns?.length).toBe(0);
		});
	});

	describe('edge cases', () => {
		test('should handle multiple MCP servers toggle', async () => {
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/mcp-edge-1` }
			);

			// Enable multiple servers
			await callRPCHandler(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: {
					useClaudeCodePreset: true,
					loadSettingSources: true,
					loadProjectMcp: true,
					enabledMcpPatterns: ['mcp__chrome-devtools__*', 'mcp__filesystem__*', 'mcp__github__*'],
					liuboerTools: { memory: false },
				},
			});

			let session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.enabledMcpPatterns?.length).toBe(3);

			// Disable one server (keep two)
			await callRPCHandler(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: {
					useClaudeCodePreset: true,
					loadSettingSources: true,
					loadProjectMcp: true, // Still true - we have patterns
					enabledMcpPatterns: ['mcp__filesystem__*', 'mcp__github__*'],
					liuboerTools: { memory: false },
				},
			});

			session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.loadProjectMcp).toBe(true);
			expect(session?.config.tools?.enabledMcpPatterns?.length).toBe(2);
			expect(session?.config.tools?.enabledMcpPatterns).not.toContain('mcp__chrome-devtools__*');

			// Disable all remaining servers
			await callRPCHandler(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: {
					useClaudeCodePreset: true,
					loadSettingSources: true,
					loadProjectMcp: false, // Now false - no patterns
					enabledMcpPatterns: [],
					liuboerTools: { memory: false },
				},
			});

			session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.loadProjectMcp).toBe(false);
			expect(session?.config.tools?.enabledMcpPatterns?.length).toBe(0);
		});

		test('should handle rapid toggle changes', async () => {
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/mcp-edge-2` }
			);

			// Rapid toggle on/off
			for (let i = 0; i < 5; i++) {
				const isEnabled = i % 2 === 0;
				await callRPCHandler(ctx.messageHub, 'tools.save', {
					sessionId,
					tools: {
						useClaudeCodePreset: true,
						loadSettingSources: true,
						loadProjectMcp: isEnabled,
						enabledMcpPatterns: isEnabled ? ['mcp__test__*'] : [],
						liuboerTools: { memory: false },
					},
				});
			}

			// Final state should be enabled (last iteration i=4, 4%2=0, isEnabled=true)
			const session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.loadProjectMcp).toBe(true);
			expect(session?.config.tools?.enabledMcpPatterns).toEqual(['mcp__test__*']);
		});

		test('should handle tools save with all options disabled', async () => {
			const { sessionId } = await callRPCHandler<{ sessionId: string }>(
				ctx.messageHub,
				'session.create',
				{ workspacePath: `${TMP_DIR}/mcp-edge-3` }
			);

			// Save with everything disabled
			await callRPCHandler(ctx.messageHub, 'tools.save', {
				sessionId,
				tools: {
					useClaudeCodePreset: false,
					loadSettingSources: false,
					loadProjectMcp: false,
					enabledMcpPatterns: [],
					liuboerTools: { memory: false },
				},
			});

			const session = ctx.db.getSession(sessionId);
			expect(session?.config.tools?.useClaudeCodePreset).toBe(false);
			expect(session?.config.tools?.loadSettingSources).toBe(false);
			expect(session?.config.tools?.loadProjectMcp).toBe(false);
			expect(session?.config.tools?.enabledMcpPatterns).toEqual([]);
			expect(session?.config.tools?.liuboerTools?.memory).toBe(false);
		});
	});
});
