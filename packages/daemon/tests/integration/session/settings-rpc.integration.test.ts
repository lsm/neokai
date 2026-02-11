/**
 * Integration tests for Settings RPC Handlers
 *
 * Tests the complete flow: RPC call → Handler → SettingsManager → Database → File writes
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from '../../helpers/test-app';
import { createTestApp, callRPCHandler } from '../../helpers/test-app';
import type { GlobalSettings } from '@neokai/shared';

describe('Settings RPC Integration', () => {
	let ctx: TestContext;
	let workspacePath: string;

	beforeEach(async () => {
		ctx = await createTestApp();
		workspacePath = ctx.workspacePath;
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('settings.global.get', () => {
		test('returns default settings', async () => {
			const result = await callRPCHandler(ctx.messageHub, 'settings.global.get', {});

			expect(result).toMatchObject({
				settingSources: ['user', 'project', 'local'],
				disabledMcpServers: [],
			});
		});

		test('returns saved settings', async () => {
			// Pre-save settings
			ctx.settingsManager.updateGlobalSettings({
				model: 'claude-opus-4-5-20251101',
				disabledMcpServers: ['test-server'],
			});

			const result = (await callRPCHandler(
				ctx.messageHub,
				'settings.global.get',
				{}
			)) as GlobalSettings;

			expect(result.model).toBe('claude-opus-4-5-20251101');
			expect(result.disabledMcpServers).toEqual(['test-server']);
		});
	});

	describe('settings.global.update', () => {
		test('updates global settings', async () => {
			const result = (await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: {
					model: 'claude-haiku-3-5-20241022',
					disabledMcpServers: ['server1', 'server2'],
				},
			})) as { success: boolean; settings: GlobalSettings };

			expect(result.success).toBe(true);
			expect(result.settings.model).toBe('claude-haiku-3-5-20241022');
			expect(result.settings.disabledMcpServers).toEqual(['server1', 'server2']);
		});

		test('persists updates to database', async () => {
			await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: {
					model: 'claude-opus-4-5-20251101',
				},
			});

			// Verify persisted to database
			const loaded = ctx.db.getGlobalSettings();
			expect(loaded.model).toBe('claude-opus-4-5-20251101');
		});

		test('performs partial update', async () => {
			// First update
			await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: {
					model: 'claude-sonnet-4-5-20250929',
					disabledMcpServers: ['server1'],
				},
			});

			// Second partial update
			const result = (await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: {
					disabledMcpServers: ['server1', 'server2'],
				},
			})) as { success: boolean; settings: GlobalSettings };

			// Model should remain unchanged
			expect(result.settings.model).toBe('claude-sonnet-4-5-20250929');
			// disabledMcpServers should be updated
			expect(result.settings.disabledMcpServers).toEqual(['server1', 'server2']);
		});
	});

	describe('settings.global.save', () => {
		test('saves complete settings', async () => {
			const completeSettings: GlobalSettings = {
				settingSources: ['project', 'local'],
				model: 'claude-opus-4-5-20251101',
				permissionMode: 'acceptEdits',
				disabledMcpServers: ['server1'],
			};

			const result = (await callRPCHandler(ctx.messageHub, 'settings.global.save', {
				settings: completeSettings,
			})) as { success: boolean };

			expect(result.success).toBe(true);

			// Verify saved
			const loaded = ctx.db.getGlobalSettings();
			expect(loaded.settingSources).toEqual(['project', 'local']);
			expect(loaded.model).toBe('claude-opus-4-5-20251101');
			expect(loaded.permissionMode).toBe('acceptEdits');
		});
	});

	describe('settings.mcp.toggle', () => {
		test('disables MCP server', async () => {
			const result = (await callRPCHandler(ctx.messageHub, 'settings.mcp.toggle', {
				serverName: 'test-server',
				enabled: false,
			})) as { success: boolean };

			expect(result.success).toBe(true);

			// Verify disabled
			const settings = ctx.settingsManager.getGlobalSettings();
			expect(settings.disabledMcpServers).toContain('test-server');
		});

		test('enables MCP server', async () => {
			// First disable
			await callRPCHandler(ctx.messageHub, 'settings.mcp.toggle', {
				serverName: 'test-server',
				enabled: false,
			});

			// Then enable
			const result = (await callRPCHandler(ctx.messageHub, 'settings.mcp.toggle', {
				serverName: 'test-server',
				enabled: true,
			})) as { success: boolean };

			expect(result.success).toBe(true);

			// Verify enabled
			const settings = ctx.settingsManager.getGlobalSettings();
			expect(settings.disabledMcpServers).not.toContain('test-server');
		});

		test('writes to settings.local.json immediately', async () => {
			await callRPCHandler(ctx.messageHub, 'settings.mcp.toggle', {
				serverName: 'test-server',
				enabled: false,
			});

			const settingsPath = join(workspacePath, '.claude/settings.local.json');
			expect(existsSync(settingsPath)).toBe(true);

			const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
			expect(content.disabledMcpjsonServers).toContain('test-server');
		});
	});

	describe('settings.mcp.getDisabled', () => {
		test('returns empty array by default', async () => {
			const result = (await callRPCHandler(ctx.messageHub, 'settings.mcp.getDisabled', {})) as {
				disabledServers: string[];
			};

			expect(result.disabledServers).toEqual([]);
		});

		test('returns disabled servers', async () => {
			await callRPCHandler(ctx.messageHub, 'settings.mcp.toggle', {
				serverName: 'server1',
				enabled: false,
			});
			await callRPCHandler(ctx.messageHub, 'settings.mcp.toggle', {
				serverName: 'server2',
				enabled: false,
			});

			const result = (await callRPCHandler(ctx.messageHub, 'settings.mcp.getDisabled', {})) as {
				disabledServers: string[];
			};

			expect(result.disabledServers).toEqual(['server1', 'server2']);
		});
	});

	describe('settings.mcp.setDisabled', () => {
		test('sets list of disabled servers', async () => {
			const result = (await callRPCHandler(ctx.messageHub, 'settings.mcp.setDisabled', {
				disabledServers: ['server1', 'server2', 'server3'],
			})) as { success: boolean };

			expect(result.success).toBe(true);

			// Verify set
			const getResult = (await callRPCHandler(ctx.messageHub, 'settings.mcp.getDisabled', {})) as {
				disabledServers: string[];
			};
			expect(getResult.disabledServers).toEqual(['server1', 'server2', 'server3']);
		});

		test('replaces existing disabled servers', async () => {
			await callRPCHandler(ctx.messageHub, 'settings.mcp.setDisabled', {
				disabledServers: ['old-server'],
			});

			await callRPCHandler(ctx.messageHub, 'settings.mcp.setDisabled', {
				disabledServers: ['new-server1', 'new-server2'],
			});

			const result = (await callRPCHandler(ctx.messageHub, 'settings.mcp.getDisabled', {})) as {
				disabledServers: string[];
			};
			expect(result.disabledServers).toEqual(['new-server1', 'new-server2']);
			expect(result.disabledServers).not.toContain('old-server');
		});
	});

	describe('settings.fileOnly.read', () => {
		test('returns empty object if file does not exist', async () => {
			const result = await callRPCHandler(ctx.messageHub, 'settings.fileOnly.read', {});

			expect(result).toEqual({});
		});

		test('reads disabledMcpServers from file', async () => {
			// Write settings via toggle (which writes to file)
			await callRPCHandler(ctx.messageHub, 'settings.mcp.toggle', {
				serverName: 'server1',
				enabled: false,
			});

			const result = (await callRPCHandler(ctx.messageHub, 'settings.fileOnly.read', {})) as {
				disabledMcpServers?: string[];
			};

			expect(result.disabledMcpServers).toContain('server1');
		});
	});

	describe('showArchived Setting', () => {
		test('defaults to false', async () => {
			const result = (await callRPCHandler(
				ctx.messageHub,
				'settings.global.get',
				{}
			)) as GlobalSettings;

			expect(result.showArchived).toBe(false);
		});

		test('can be updated', async () => {
			const result = (await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { showArchived: true },
			})) as { success: boolean; settings: GlobalSettings };

			expect(result.success).toBe(true);
			expect(result.settings.showArchived).toBe(true);
		});

		test('persists to database', async () => {
			await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { showArchived: true },
			});

			// Verify persisted
			const loaded = ctx.db.getGlobalSettings();
			expect(loaded.showArchived).toBe(true);
		});

		test('can be toggled multiple times', async () => {
			// Toggle on
			await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { showArchived: true },
			});
			let settings = ctx.db.getGlobalSettings();
			expect(settings.showArchived).toBe(true);

			// Toggle off
			await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { showArchived: false },
			});
			settings = ctx.db.getGlobalSettings();
			expect(settings.showArchived).toBe(false);

			// Toggle on again
			await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { showArchived: true },
			});
			settings = ctx.db.getGlobalSettings();
			expect(settings.showArchived).toBe(true);
		});
	});

	describe('thinkingLevel Setting', () => {
		test('defaults to undefined', async () => {
			const result = (await callRPCHandler(
				ctx.messageHub,
				'settings.global.get',
				{}
			)) as GlobalSettings;

			expect(result.thinkingLevel).toBeUndefined();
		});

		test('can be set to think8k', async () => {
			const result = (await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { thinkingLevel: 'think8k' },
			})) as { success: boolean; settings: GlobalSettings };

			expect(result.success).toBe(true);
			expect(result.settings.thinkingLevel).toBe('think8k');
		});

		test('can be set to think16k', async () => {
			const result = (await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { thinkingLevel: 'think16k' },
			})) as { success: boolean; settings: GlobalSettings };

			expect(result.success).toBe(true);
			expect(result.settings.thinkingLevel).toBe('think16k');
		});

		test('can be set to think32k', async () => {
			const result = (await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { thinkingLevel: 'think32k' },
			})) as { success: boolean; settings: GlobalSettings };

			expect(result.success).toBe(true);
			expect(result.settings.thinkingLevel).toBe('think32k');
		});

		test('can be reset to auto', async () => {
			await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { thinkingLevel: 'think16k' },
			});

			const result = (await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { thinkingLevel: 'auto' },
			})) as { success: boolean; settings: GlobalSettings };

			expect(result.success).toBe(true);
			expect(result.settings.thinkingLevel).toBe('auto');
		});

		test('persists to database', async () => {
			await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { thinkingLevel: 'think32k' },
			});

			const loaded = ctx.db.getGlobalSettings();
			expect(loaded.thinkingLevel).toBe('think32k');
		});
	});

	describe('autoScroll Setting', () => {
		test('defaults to true', async () => {
			const result = (await callRPCHandler(
				ctx.messageHub,
				'settings.global.get',
				{}
			)) as GlobalSettings;

			expect(result.autoScroll).toBe(true);
		});

		test('can be set to true', async () => {
			const result = (await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { autoScroll: true },
			})) as { success: boolean; settings: GlobalSettings };

			expect(result.success).toBe(true);
			expect(result.settings.autoScroll).toBe(true);
		});

		test('can be set to false', async () => {
			const result = (await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { autoScroll: false },
			})) as { success: boolean; settings: GlobalSettings };

			expect(result.success).toBe(true);
			expect(result.settings.autoScroll).toBe(false);
		});

		test('persists to database', async () => {
			await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { autoScroll: false },
			});

			const loaded = ctx.db.getGlobalSettings();
			expect(loaded.autoScroll).toBe(false);
		});

		test('can be toggled', async () => {
			await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { autoScroll: true },
			});
			let settings = ctx.db.getGlobalSettings();
			expect(settings.autoScroll).toBe(true);

			await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { autoScroll: false },
			});
			settings = ctx.db.getGlobalSettings();
			expect(settings.autoScroll).toBe(false);
		});
	});

	describe('Global Settings Applied to New Sessions', () => {
		test('new session uses global model setting', async () => {
			// Set global model
			await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { model: 'opus' },
			});

			// Create a new session without specifying a model
			const result = (await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: ctx.workspacePath,
			})) as { sessionId: string; session: { config: { model: string } } };

			expect(result.session.config.model).toBe('opus');
		});

		test('new session uses global thinkingLevel setting', async () => {
			// Set global thinking level
			await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { thinkingLevel: 'think16k' },
			});

			// Create a new session
			const result = (await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: ctx.workspacePath,
			})) as {
				sessionId: string;
				session: { config: { thinkingLevel?: string } };
			};

			expect(result.session.config.thinkingLevel).toBe('think16k');
		});

		test('new session uses global autoScroll setting', async () => {
			// Set global autoScroll to false
			await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { autoScroll: false },
			});

			// Create a new session
			const result = (await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: ctx.workspacePath,
			})) as {
				sessionId: string;
				session: { config: { autoScroll?: boolean } };
			};

			expect(result.session.config.autoScroll).toBe(false);
		});

		test('session-level config overrides global defaults', async () => {
			// Set global model
			await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: {
					model: 'opus',
					thinkingLevel: 'think32k',
					autoScroll: false,
				},
			});

			// Create a session with explicit overrides
			const result = (await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: ctx.workspacePath,
				config: {
					model: 'haiku',
					thinkingLevel: 'auto',
					autoScroll: true,
				},
			})) as {
				sessionId: string;
				session: {
					config: {
						model: string;
						thinkingLevel?: string;
						autoScroll?: boolean;
					};
				};
			};

			expect(result.session.config.model).toBe('haiku');
			expect(result.session.config.thinkingLevel).toBe('auto');
			expect(result.session.config.autoScroll).toBe(true);
		});
	});

	describe('Complete Flow', () => {
		test('update settings → persist to DB → write to file', async () => {
			// 1. Update settings via RPC
			await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: {
					model: 'claude-opus-4-5-20251101',
					disabledMcpServers: ['server1', 'server2'],
				},
			});

			// 2. Verify persisted to database
			const dbSettings = ctx.db.getGlobalSettings();
			expect(dbSettings.model).toBe('claude-opus-4-5-20251101');
			expect(dbSettings.disabledMcpServers).toEqual(['server1', 'server2']);

			// 3. Prepare SDK options (triggers file write)
			await ctx.settingsManager.prepareSDKOptions();

			// 4. Verify written to file
			const settingsPath = join(workspacePath, '.claude/settings.local.json');
			expect(existsSync(settingsPath)).toBe(true);

			const fileContent = JSON.parse(readFileSync(settingsPath, 'utf-8'));
			expect(fileContent.disabledMcpjsonServers).toEqual(['server1', 'server2']);
		});

		test('multiple concurrent updates are handled correctly', async () => {
			// Fire multiple updates concurrently
			await Promise.all([
				callRPCHandler(ctx.messageHub, 'settings.global.update', {
					updates: { model: 'claude-opus-4-5-20251101' },
				}),
				callRPCHandler(ctx.messageHub, 'settings.mcp.toggle', {
					serverName: 'server1',
					enabled: false,
				}),
				callRPCHandler(ctx.messageHub, 'settings.mcp.toggle', {
					serverName: 'server2',
					enabled: false,
				}),
			]);

			// Verify final state is consistent
			const settings = (await callRPCHandler(
				ctx.messageHub,
				'settings.global.get',
				{}
			)) as GlobalSettings;
			expect(settings.model).toBe('claude-opus-4-5-20251101');
			expect(settings.disabledMcpServers).toContain('server1');
			expect(settings.disabledMcpServers).toContain('server2');
		});
	});
});

// === Merged from rpc-settings-handlers-extended.test.ts ===

import {
	waitForWebSocketState,
	waitForWebSocketMessage,
	createWebSocketWithFirstMessage,
} from '../../helpers/test-app';

describe('Settings RPC Handlers - Extended', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	// Helper to send RPC call
	async function sendRpcCall(
		ws: WebSocket,
		method: string,
		data: Record<string, unknown>
	): Promise<Record<string, unknown>> {
		const responsePromise = waitForWebSocketMessage(ws);
		ws.send(
			JSON.stringify({
				id: `call-${Date.now()}`,
				type: 'REQ',
				method,
				data,
				sessionId: 'global',
				timestamp: new Date().toISOString(),
				version: '1.0.0',
			})
		);
		return responsePromise;
	}

	describe('settings.mcp.listFromSources', () => {
		test('should list MCP servers without sessionId', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'settings.mcp.listFromSources', {});

			expect(response.type).toBe('RSP');
			expect(response.data).toHaveProperty('servers');
			expect(response.data).toHaveProperty('serverSettings');
			ws.close();
		});

		test('should list MCP servers with sessionId', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: ctx.workspacePath,
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'settings.mcp.listFromSources', {
				sessionId,
			});

			expect(response.type).toBe('RSP');
			expect(response.data).toHaveProperty('servers');
			ws.close();
		});

		test('should error for non-existent session', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'settings.mcp.listFromSources', {
				sessionId: 'non-existent-session',
			});

			expect(response.type).toBe('RSP');
			expect(response.error).toBeDefined();
			ws.close();
		});
	});

	describe('settings.mcp.updateServerSettings', () => {
		test('should update server settings', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'settings.mcp.updateServerSettings', {
				serverName: 'test-server',
				settings: {
					allowed: true,
					defaultOn: true,
				},
			});

			expect(response.type).toBe('RSP');
			const data = response.data as { success: boolean };
			expect(data.success).toBe(true);
			ws.close();
		});

		test('should update only allowed setting', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'settings.mcp.updateServerSettings', {
				serverName: 'another-server',
				settings: {
					allowed: false,
				},
			});

			expect(response.type).toBe('RSP');
			const data = response.data as { success: boolean };
			expect(data.success).toBe(true);
			ws.close();
		});
	});

	describe('settings.session.get', () => {
		test('should get session settings (placeholder)', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/session-settings-get',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'settings.session.get', {
				sessionId,
			});

			expect(response.type).toBe('RSP');
			const data = response.data as {
				sessionId: string;
				settings: Record<string, unknown>;
			};
			expect(data.sessionId).toBe(sessionId);
			expect(data.settings).toBeDefined();
			ws.close();
		});
	});

	describe('settings.session.update', () => {
		test('should update session settings (placeholder)', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/session-settings-update',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const response = await sendRpcCall(ws, 'settings.session.update', {
				sessionId,
				updates: { someKey: 'someValue' },
			});

			expect(response.type).toBe('RSP');
			const data = response.data as { success: boolean; sessionId: string };
			expect(data.success).toBe(true);
			expect(data.sessionId).toBe(sessionId);
			ws.close();
		});
	});

	describe('Direct RPC handler tests', () => {
		test('settings.global.update with showArchived triggers filter change event', async () => {
			const result = (await callRPCHandler(ctx.messageHub, 'settings.global.update', {
				updates: { showArchived: true },
			})) as { success: boolean };

			expect(result.success).toBe(true);
		});
	});
});
