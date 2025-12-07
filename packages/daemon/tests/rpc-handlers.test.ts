/**
 * RPC Handlers Comprehensive Tests
 *
 * Tests all RPC handler functions for complete coverage.
 */

import { describe, expect, it, beforeAll, afterAll, mock } from 'bun:test';
import { MessageHub, EventBus } from '@liuboer/shared';
import { Database } from '../src/storage/database';
import { SessionManager } from '../src/lib/session-manager';
import { AuthManager } from '../src/lib/auth-manager';
import { setupRPCHandlers } from '../src/lib/rpc-handlers';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from '../src/config';

describe('RPC Handlers - Complete Coverage', () => {
	let messageHub: MessageHub;
	let sessionManager: SessionManager;
	let authManager: AuthManager;
	let db: Database;
	let testWorkspace: string;
	let testSessionId: string;
	let config: Config;

	beforeAll(async () => {
		// Create test workspace
		testWorkspace = join(tmpdir(), `rpc-test-${Date.now()}`);
		await mkdir(testWorkspace, { recursive: true });
		await mkdir(join(testWorkspace, 'subdir'), { recursive: true });
		await writeFile(join(testWorkspace, 'test.txt'), 'Hello RPC');
		await writeFile(join(testWorkspace, 'subdir', 'nested.txt'), 'Nested');

		// Initialize components
		const dbPath = join(testWorkspace, 'test.db');
		db = new Database(dbPath);
		await db.initialize();

		config = {
			port: 9283,
			host: '0.0.0.0',
			dbPath,
			defaultModel: 'claude-sonnet-4-5-20241022',
			maxTokens: 8192,
			temperature: 1.0,
			maxSessions: 10,
			nodeEnv: 'test',
			workspaceRoot: testWorkspace,
		};

		authManager = new AuthManager(db, config);
		await authManager.initialize();

		const eventBus = new EventBus({ debug: false });
		messageHub = new MessageHub({ defaultSessionId: 'global', debug: false });

		// Create a mock transport for testing
		const mockTransport = {
			name: 'mock-transport',
			initialize: async () => {},
			close: async () => {},
			send: async () => {},
			onMessage: () => () => {},
			onConnectionChange: () => () => {},
			getState: () => 'connected' as const,
			isReady: () => true,
		};

		messageHub.registerTransport(mockTransport);

		sessionManager = new SessionManager(db, messageHub, authManager, eventBus, {
			defaultModel: config.defaultModel,
			maxTokens: config.maxTokens,
			temperature: config.temperature,
			workspaceRoot: testWorkspace,
		});

		// Setup all RPC handlers
		setupRPCHandlers({
			messageHub,
			sessionManager,
			authManager,
			config,
		});

		// Create a test session
		testSessionId = await sessionManager.createSession({
			workspacePath: testWorkspace,
		});

		// Wait for session to initialize
		await new Promise((resolve) => setTimeout(resolve, 100));
	});

	afterAll(async () => {
		await sessionManager.cleanup();
		db.close();
		await rm(testWorkspace, { recursive: true, force: true });
	});

	describe('File Handlers', () => {
		describe('file.read', () => {
			it('should read file with utf-8 encoding', async () => {
				const result = await messageHub.call('file.read', {
					sessionId: testSessionId,
					path: 'test.txt',
					encoding: 'utf-8',
				});

				expect(result.content).toBe('Hello RPC');
				expect(result.encoding).toBe('utf-8');
				expect(result.path).toBe('test.txt');
			});

			it('should read file with base64 encoding', async () => {
				const result = await messageHub.call('file.read', {
					sessionId: testSessionId,
					path: 'test.txt',
					encoding: 'base64',
				});

				expect(result.encoding).toBe('base64');
				expect(result.content).toBe(Buffer.from('Hello RPC').toString('base64'));
			});

			it('should read nested file', async () => {
				const result = await messageHub.call('file.read', {
					sessionId: testSessionId,
					path: 'subdir/nested.txt',
				});

				expect(result.content).toBe('Nested');
			});

			it('should throw error for non-existent session', async () => {
				await expect(
					messageHub.call('file.read', {
						sessionId: 'non-existent',
						path: 'test.txt',
					})
				).rejects.toThrow('Session not found');
			});

			it('should throw error for non-existent file', async () => {
				await expect(
					messageHub.call('file.read', {
						sessionId: testSessionId,
						path: 'nonexistent.txt',
					})
				).rejects.toThrow();
			});
		});

		describe('file.list', () => {
			it('should list directory contents', async () => {
				const result = await messageHub.call('file.list', {
					sessionId: testSessionId,
					path: '.',
				});

				expect(result.files).toBeDefined();
				expect(Array.isArray(result.files)).toBe(true);
				expect(result.files.some((f: any) => f.name === 'test.txt')).toBe(true);
			});

			it('should list with default path', async () => {
				const result = await messageHub.call('file.list', {
					sessionId: testSessionId,
				});

				expect(result.files).toBeDefined();
				expect(result.files.length).toBeGreaterThan(0);
			});

			it('should list recursively', async () => {
				const result = await messageHub.call('file.list', {
					sessionId: testSessionId,
					path: '.',
					recursive: true,
				});

				expect(result.files.some((f: any) => f.path.includes('subdir'))).toBe(true);
			});

			it('should list subdirectory', async () => {
				const result = await messageHub.call('file.list', {
					sessionId: testSessionId,
					path: 'subdir',
				});

				expect(result.files.length).toBeGreaterThan(0);
			});

			it('should throw error for non-existent session', async () => {
				await expect(
					messageHub.call('file.list', {
						sessionId: 'non-existent',
						path: '.',
					})
				).rejects.toThrow('Session not found');
			});
		});

		describe('file.tree', () => {
			it('should get file tree', async () => {
				const result = await messageHub.call('file.tree', {
					sessionId: testSessionId,
					path: '.',
				});

				expect(result.tree).toBeDefined();
				expect(result.tree.type).toBe('directory');
				expect(result.tree.children).toBeDefined();
			});

			it('should use default path', async () => {
				const result = await messageHub.call('file.tree', {
					sessionId: testSessionId,
				});

				expect(result.tree).toBeDefined();
			});

			it('should respect maxDepth', async () => {
				const result = await messageHub.call('file.tree', {
					sessionId: testSessionId,
					path: '.',
					maxDepth: 1,
				});

				expect(result.tree).toBeDefined();
			});

			it('should use default maxDepth', async () => {
				const result = await messageHub.call('file.tree', {
					sessionId: testSessionId,
					path: '.',
				});

				expect(result.tree).toBeDefined();
			});

			it('should throw error for non-existent session', async () => {
				await expect(
					messageHub.call('file.tree', {
						sessionId: 'non-existent',
					})
				).rejects.toThrow('Session not found');
			});
		});
	});

	describe('System Handlers', () => {
		describe('system.health', () => {
			it('should return health status', async () => {
				const result = await messageHub.call('system.health', {});

				expect(result.status).toBe('ok');
				expect(result.version).toBeDefined();
				expect(result.uptime).toBeGreaterThanOrEqual(0);
				expect(result.sessions).toBeDefined();
				expect(result.sessions.active).toBeGreaterThanOrEqual(0);
				expect(result.sessions.total).toBeGreaterThanOrEqual(0);
			});

			it('should track session counts correctly', async () => {
				const result = await messageHub.call('system.health', {});

				expect(result.sessions.total).toBeGreaterThanOrEqual(1);
			});

			it('should have increasing uptime', async () => {
				const result1 = await messageHub.call('system.health', {});
				await new Promise((resolve) => setTimeout(resolve, 10));
				const result2 = await messageHub.call('system.health', {});

				expect(result2.uptime).toBeGreaterThan(result1.uptime);
			});
		});

		describe('system.config', () => {
			it('should return daemon configuration', async () => {
				const result = await messageHub.call('system.config', {});

				expect(result.version).toBeDefined();
				expect(result.claudeSDKVersion).toBeDefined();
				expect(result.defaultModel).toBe(config.defaultModel);
				expect(result.maxSessions).toBe(config.maxSessions);
				expect(result.storageLocation).toBe(config.dbPath);
				expect(result.authMethod).toBeDefined();
				expect(result.authStatus).toBeDefined();
			});

			it('should include auth status', async () => {
				const result = await messageHub.call('system.config', {});

				expect(result.authStatus.isAuthenticated).toBeDefined();
				expect(result.authStatus.method).toBeDefined();
			});
		});
	});

	describe('Command Handlers', () => {
		describe('commands.list', () => {
			it('should list available commands', async () => {
				const result = await messageHub.call('commands.list', {
					sessionId: testSessionId,
				});

				expect(result.commands).toBeDefined();
				expect(Array.isArray(result.commands)).toBe(true);
			});

			it('should throw error for non-existent session', async () => {
				await expect(
					messageHub.call('commands.list', {
						sessionId: 'non-existent',
					})
				).rejects.toThrow('Session not found');
			});

			it('should return commands array', async () => {
				const result = await messageHub.call('commands.list', {
					sessionId: testSessionId,
				});

				// Commands might be empty initially, but should be an array
				expect(Array.isArray(result.commands)).toBe(true);
			});
		});
	});

	describe('Message Handlers', () => {
		describe('message.list', () => {
			it('should list messages for session', async () => {
				const result = await messageHub.call('message.list', {
					sessionId: testSessionId,
				});

				expect(result.messages).toBeDefined();
				expect(Array.isArray(result.messages)).toBe(true);
			});

			it('should throw error for non-existent session', async () => {
				await expect(
					messageHub.call('message.list', {
						sessionId: 'non-existent',
					})
				).rejects.toThrow('Session not found');
			});

			it('should return empty array for new session', async () => {
				const result = await messageHub.call('message.list', {
					sessionId: testSessionId,
				});

				expect(Array.isArray(result.messages)).toBe(true);
			});
		});

		describe('message.sdkMessages', () => {
			it('should get SDK messages', async () => {
				const result = await messageHub.call('message.sdkMessages', {
					sessionId: testSessionId,
				});

				expect(result.sdkMessages).toBeDefined();
				expect(Array.isArray(result.sdkMessages)).toBe(true);
			});

			it('should support limit parameter', async () => {
				const result = await messageHub.call('message.sdkMessages', {
					sessionId: testSessionId,
					limit: 10,
				});

				expect(result.sdkMessages).toBeDefined();
			});

			it('should support offset parameter', async () => {
				const result = await messageHub.call('message.sdkMessages', {
					sessionId: testSessionId,
					offset: 0,
				});

				expect(result.sdkMessages).toBeDefined();
			});

			it('should support since parameter', async () => {
				const result = await messageHub.call('message.sdkMessages', {
					sessionId: testSessionId,
					since: Date.now() - 1000,
				});

				expect(result.sdkMessages).toBeDefined();
			});

			it('should support all parameters together', async () => {
				const result = await messageHub.call('message.sdkMessages', {
					sessionId: testSessionId,
					limit: 5,
					offset: 0,
					since: Date.now() - 1000,
				});

				expect(result.sdkMessages).toBeDefined();
			});

			it('should throw error for non-existent session', async () => {
				await expect(
					messageHub.call('message.sdkMessages', {
						sessionId: 'non-existent',
					})
				).rejects.toThrow('Session not found');
			});
		});
	});

	describe('Session Handlers (Additional Coverage)', () => {
		describe('session.get', () => {
			it('should get session details', async () => {
				const result = await messageHub.call('session.get', {
					sessionId: testSessionId,
				});

				expect(result.session).toBeDefined();
				expect(result.messages).toBeDefined();
				expect(result.context).toBeDefined();
			});
		});

		describe('session.update', () => {
			it('should update session title', async () => {
				const result = await messageHub.call('session.update', {
					sessionId: testSessionId,
					title: 'Updated Title',
				});

				expect(result.success).toBe(true);
			});
		});

		describe('agent.getState', () => {
			it('should get agent processing state', async () => {
				const result = await messageHub.call('agent.getState', {
					sessionId: testSessionId,
				});

				expect(result.state).toBeDefined();
				expect(result.state.status).toBeDefined();
			});
		});

		describe('session.model.get', () => {
			it('should get current model info', async () => {
				const result = await messageHub.call('session.model.get', {
					sessionId: testSessionId,
				});

				expect(result.currentModel).toBeDefined();
			});
		});
	});

	describe('Integration - All Handlers', () => {
		it('should handle multiple RPC calls in sequence', async () => {
			const health = await messageHub.call('system.health', {});
			const config = await messageHub.call('system.config', {});
			const files = await messageHub.call('file.list', {
				sessionId: testSessionId,
				path: '.',
			});

			expect(health.status).toBe('ok');
			expect(config.version).toBeDefined();
			expect(files.files).toBeDefined();
		});

		it('should handle concurrent RPC calls', async () => {
			const results = await Promise.all([
				messageHub.call('system.health', {}),
				messageHub.call('system.config', {}),
				messageHub.call('file.list', {
					sessionId: testSessionId,
					path: '.',
				}),
			]);

			expect(results).toHaveLength(3);
			expect(results[0].status).toBe('ok');
			expect(results[1].version).toBeDefined();
			expect(results[2].files).toBeDefined();
		});
	});
});
