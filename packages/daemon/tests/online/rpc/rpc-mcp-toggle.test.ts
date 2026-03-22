/**
 * MCP Toggle RPC Tests
 *
 * Tests MCP server enable/disable functionality via WebSocket:
 * - tools.save with disabledMcpServers
 * - mcp.updateDisabledServers / mcp.getDisabledServers
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';
import type { ToolsConfig } from '@neokai/shared';

describe('MCP Toggle', () => {
	let daemon: DaemonServerContext;
	let testDir: string;

	beforeEach(async () => {
		daemon = await createDaemonServer();
		testDir = `/tmp/mcp-toggle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		mkdirSync(testDir, { recursive: true });
	}, 30_000);

	afterEach(async () => {
		if (!daemon) return;
		await daemon.waitForExit();
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {}
	}, 15_000);

	async function createSession(suffix: string): Promise<string> {
		const workspacePath = `${testDir}/${suffix}`;
		mkdirSync(workspacePath, { recursive: true });
		const { sessionId } = (await daemon.messageHub.request('session.create', {
			workspacePath,
		})) as { sessionId: string };
		daemon.trackSession(sessionId);
		return sessionId;
	}

	async function getSessionConfig(sessionId: string) {
		const { session } = (await daemon.messageHub.request('session.get', {
			sessionId,
		})) as { session: { config: { tools?: ToolsConfig } } };
		return session.config;
	}

	describe('tools.save RPC', () => {
		test('should save tools config with all servers enabled (empty disabledMcpServers)', async () => {
			const sessionId = await createSession('mcp-toggle-1');

			const result = (await daemon.messageHub.request('tools.save', {
				sessionId,
				tools: {
					useClaudeCodePreset: true,
					disabledMcpServers: [],
					kaiTools: { memory: false },
				},
			})) as { success: boolean };

			expect(result.success).toBe(true);

			const config = await getSessionConfig(sessionId);
			expect(config.tools?.disabledMcpServers).toEqual([]);
		});

		test('should save tools config with specific servers disabled', async () => {
			const sessionId = await createSession('mcp-toggle-2');

			const result = (await daemon.messageHub.request('tools.save', {
				sessionId,
				tools: {
					useClaudeCodePreset: true,
					disabledMcpServers: ['chrome-devtools', 'filesystem'],
					kaiTools: { memory: false },
				},
			})) as { success: boolean };

			expect(result.success).toBe(true);

			const config = await getSessionConfig(sessionId);
			expect(config.tools?.disabledMcpServers).toEqual(['chrome-devtools', 'filesystem']);
		});

		test('should toggle server from enabled to disabled', async () => {
			const sessionId = await createSession('mcp-toggle-3');

			await daemon.messageHub.request('tools.save', {
				sessionId,
				tools: { disabledMcpServers: [] },
			});

			let config = await getSessionConfig(sessionId);
			expect(config.tools?.disabledMcpServers).toEqual([]);

			await daemon.messageHub.request('tools.save', {
				sessionId,
				tools: { disabledMcpServers: ['chrome-devtools'] },
			});

			config = await getSessionConfig(sessionId);
			expect(config.tools?.disabledMcpServers).toEqual(['chrome-devtools']);
		});

		test('should toggle server from disabled to enabled', async () => {
			const sessionId = await createSession('mcp-toggle-4');

			await daemon.messageHub.request('tools.save', {
				sessionId,
				tools: { disabledMcpServers: ['chrome-devtools'] },
			});

			let config = await getSessionConfig(sessionId);
			expect(config.tools?.disabledMcpServers).toEqual(['chrome-devtools']);

			await daemon.messageHub.request('tools.save', {
				sessionId,
				tools: { disabledMcpServers: [] },
			});

			config = await getSessionConfig(sessionId);
			expect(config.tools?.disabledMcpServers).toEqual([]);
		});
	});

	describe('mcp.updateDisabledServers RPC', () => {
		test('should update disabled servers list', async () => {
			const sessionId = await createSession('mcp-toggle-5');

			const result = (await daemon.messageHub.request('mcp.updateDisabledServers', {
				sessionId,
				disabledServers: ['chrome-devtools', 'github'],
			})) as { success: boolean };

			expect(result.success).toBe(true);

			const getResult = (await daemon.messageHub.request('mcp.getDisabledServers', {
				sessionId,
			})) as { disabledServers: string[] };

			expect(getResult.disabledServers).toEqual(['chrome-devtools', 'github']);
		});

		test('should enable all servers by setting empty disabled list', async () => {
			const sessionId = await createSession('mcp-toggle-6');

			await daemon.messageHub.request('mcp.updateDisabledServers', {
				sessionId,
				disabledServers: ['chrome-devtools'],
			});

			await daemon.messageHub.request('mcp.updateDisabledServers', {
				sessionId,
				disabledServers: [],
			});

			const getResult = (await daemon.messageHub.request('mcp.getDisabledServers', {
				sessionId,
			})) as { disabledServers: string[] };

			expect(getResult.disabledServers).toEqual([]);
		});
	});

	describe('Default session configuration', () => {
		test('should create session with empty disabledMcpServers by default', async () => {
			const sessionId = await createSession('mcp-toggle-7');

			const config = await getSessionConfig(sessionId);
			expect(config.tools?.disabledMcpServers).toEqual([]);
		});
	});

	describe('Multiple server management', () => {
		test('should handle multiple servers being disabled', async () => {
			const sessionId = await createSession('mcp-toggle-8');

			await daemon.messageHub.request('tools.save', {
				sessionId,
				tools: {
					disabledMcpServers: ['chrome-devtools', 'filesystem', 'github'],
				},
			});

			let config = await getSessionConfig(sessionId);
			expect(config.tools?.disabledMcpServers?.length).toBe(3);
			expect(config.tools?.disabledMcpServers).toContain('chrome-devtools');
			expect(config.tools?.disabledMcpServers).toContain('filesystem');
			expect(config.tools?.disabledMcpServers).toContain('github');

			await daemon.messageHub.request('tools.save', {
				sessionId,
				tools: {
					disabledMcpServers: ['filesystem', 'github'],
				},
			});

			config = await getSessionConfig(sessionId);
			expect(config.tools?.disabledMcpServers?.length).toBe(2);
			expect(config.tools?.disabledMcpServers).not.toContain('chrome-devtools');
		});

		test('should preserve other tools config when updating disabledMcpServers', async () => {
			const sessionId = await createSession('mcp-toggle-9');

			await daemon.messageHub.request('tools.save', {
				sessionId,
				tools: {
					useClaudeCodePreset: true,
					disabledMcpServers: [],
					kaiTools: { memory: true },
				},
			});

			await daemon.messageHub.request('tools.save', {
				sessionId,
				tools: {
					useClaudeCodePreset: true,
					disabledMcpServers: ['chrome-devtools'],
					kaiTools: { memory: true },
				},
			});

			const config = await getSessionConfig(sessionId);
			expect(config.tools?.useClaudeCodePreset).toBe(true);
			expect(config.tools?.disabledMcpServers).toEqual(['chrome-devtools']);
			expect(config.tools?.kaiTools?.memory).toBe(true);
		});
	});
});
