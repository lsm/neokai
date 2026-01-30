/**
 * Database Facade Tests
 *
 * Tests for the Database facade class that delegates to repositories.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { Database } from '../../../src/storage/index';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Session, GlobalToolsConfig, GlobalSettings } from '@neokai/shared';

describe('Database Facade', () => {
	let tempDir: string;
	let db: Database;
	let dbPath: string;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), 'db-facade-test-'));
		dbPath = join(tempDir, 'test.db');
		db = new Database(dbPath);
		await db.initialize();
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			// Ignore close errors
		}
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe('initialize', () => {
		it('should initialize database and create repositories', async () => {
			const newDb = new Database(join(tempDir, 'new.db'));
			await newDb.initialize();

			// Verify database works by using a repository method
			const sessions = newDb.listSessions();
			expect(sessions).toEqual([]);

			newDb.close();
		});
	});

	describe('Session operations', () => {
		const testSession: Session = {
			id: 'test-session-id',
			title: 'Test Session',
			workspacePath: '/test/workspace',
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'active',
			config: {
				model: 'claude-sonnet-4-20250514',
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

		it('should create session', () => {
			db.createSession(testSession);
			const retrieved = db.getSession(testSession.id);
			expect(retrieved).not.toBeNull();
			expect(retrieved!.id).toBe(testSession.id);
		});

		it('should get session', () => {
			db.createSession(testSession);
			const retrieved = db.getSession(testSession.id);
			expect(retrieved).not.toBeNull();
			expect(retrieved!.title).toBe(testSession.title);
		});

		it('should return null for non-existent session', () => {
			const result = db.getSession('nonexistent');
			expect(result).toBeNull();
		});

		it('should list sessions', () => {
			db.createSession(testSession);
			db.createSession({
				...testSession,
				id: 'another-session',
				title: 'Another Session',
			});

			const sessions = db.listSessions();
			expect(sessions.length).toBe(2);
		});

		it('should update session', () => {
			db.createSession(testSession);
			db.updateSession(testSession.id, { title: 'Updated Title' });

			const retrieved = db.getSession(testSession.id);
			expect(retrieved!.title).toBe('Updated Title');
		});

		it('should delete session', () => {
			db.createSession(testSession);
			db.deleteSession(testSession.id);

			const retrieved = db.getSession(testSession.id);
			expect(retrieved).toBeNull();
		});
	});

	describe('SDK Message operations', () => {
		const testSession: Session = {
			id: 'msg-test-session',
			title: 'Message Test Session',
			workspacePath: '/test/workspace',
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'active',
			config: {
				model: 'claude-sonnet-4-20250514',
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

		beforeEach(() => {
			db.createSession(testSession);
		});

		it('should save SDK message', () => {
			const message = {
				type: 'assistant' as const,
				message: {
					type: 'message' as const,
					id: 'msg-1',
					role: 'assistant' as const,
					content: [{ type: 'text' as const, text: 'Hello' }],
					model: 'claude-sonnet-4-20250514',
					stop_reason: 'end_turn' as const,
					stop_sequence: null,
					usage: { input_tokens: 10, output_tokens: 20 },
				},
			};

			const result = db.saveSDKMessage(testSession.id, message);
			expect(result).toBe(true);
		});

		it('should get SDK messages', () => {
			const message = {
				type: 'assistant' as const,
				message: {
					type: 'message' as const,
					id: 'msg-1',
					role: 'assistant' as const,
					content: [{ type: 'text' as const, text: 'Hello' }],
					model: 'claude-sonnet-4-20250514',
					stop_reason: 'end_turn' as const,
					stop_sequence: null,
					usage: { input_tokens: 10, output_tokens: 20 },
				},
			};

			db.saveSDKMessage(testSession.id, message);
			const messages = db.getSDKMessages(testSession.id);
			expect(messages.length).toBe(1);
		});

		it('should get SDK messages by type', () => {
			const assistantMessage = {
				type: 'assistant' as const,
				message: {
					type: 'message' as const,
					id: 'msg-1',
					role: 'assistant' as const,
					content: [{ type: 'text' as const, text: 'Hello' }],
					model: 'claude-sonnet-4-20250514',
					stop_reason: 'end_turn' as const,
					stop_sequence: null,
					usage: { input_tokens: 10, output_tokens: 20 },
				},
			};

			const userMessage = {
				type: 'user' as const,
				message: {
					type: 'human' as const,
					content: 'Hello',
				},
			};

			db.saveSDKMessage(testSession.id, assistantMessage);
			db.saveSDKMessage(testSession.id, userMessage);

			const assistantMessages = db.getSDKMessagesByType(testSession.id, 'assistant');
			expect(assistantMessages.length).toBe(1);
		});

		it('should get SDK message count', () => {
			const message = {
				type: 'assistant' as const,
				message: {
					type: 'message' as const,
					id: 'msg-1',
					role: 'assistant' as const,
					content: [{ type: 'text' as const, text: 'Hello' }],
					model: 'claude-sonnet-4-20250514',
					stop_reason: 'end_turn' as const,
					stop_sequence: null,
					usage: { input_tokens: 10, output_tokens: 20 },
				},
			};

			db.saveSDKMessage(testSession.id, message);
			db.saveSDKMessage(testSession.id, message);

			const count = db.getSDKMessageCount(testSession.id);
			expect(count).toBe(2);
		});

		it('should save user message with send status', () => {
			const userMessage = {
				type: 'user' as const,
				message: {
					type: 'human' as const,
					content: 'Hello',
				},
			};

			const dbId = db.saveUserMessage(testSession.id, userMessage, 'queued');
			expect(dbId).toBeDefined();
			expect(typeof dbId).toBe('string');
		});

		it('should get messages by status', () => {
			const userMessage = {
				type: 'user' as const,
				message: {
					type: 'human' as const,
					content: 'Hello',
				},
			};

			db.saveUserMessage(testSession.id, userMessage, 'queued');
			const pendingMessages = db.getMessagesByStatus(testSession.id, 'queued');
			expect(pendingMessages.length).toBe(1);
		});

		it('should update message status', () => {
			const userMessage = {
				type: 'user' as const,
				message: {
					type: 'human' as const,
					content: 'Hello',
				},
			};

			const dbId = db.saveUserMessage(testSession.id, userMessage, 'queued');
			db.updateMessageStatus([dbId], 'sent');

			const pendingMessages = db.getMessagesByStatus(testSession.id, 'queued');
			expect(pendingMessages.length).toBe(0);

			const sentMessages = db.getMessagesByStatus(testSession.id, 'sent');
			expect(sentMessages.length).toBe(1);
		});

		it('should get message count by status', () => {
			const userMessage = {
				type: 'user' as const,
				message: {
					type: 'human' as const,
					content: 'Hello',
				},
			};

			db.saveUserMessage(testSession.id, userMessage, 'queued');
			db.saveUserMessage(testSession.id, userMessage, 'queued');
			db.saveUserMessage(testSession.id, userMessage, 'sent');

			const pendingCount = db.getMessageCountByStatus(testSession.id, 'queued');
			expect(pendingCount).toBe(2);

			const sentCount = db.getMessageCountByStatus(testSession.id, 'sent');
			expect(sentCount).toBe(1);
		});

		it('should delete messages after timestamp', async () => {
			const userMessage = {
				type: 'user' as const,
				message: {
					type: 'human' as const,
					content: 'Hello',
				},
			};

			db.saveUserMessage(testSession.id, userMessage, 'sent');
			const timestamp = Date.now();
			// Wait a bit to ensure next message has a later timestamp
			await new Promise((r) => setTimeout(r, 10));
			db.saveUserMessage(testSession.id, userMessage, 'sent');

			const deleted = db.deleteMessagesAfter(testSession.id, timestamp);
			expect(deleted).toBeGreaterThanOrEqual(1);
		});
	});

	describe('Global Configuration operations', () => {
		it('should get global tools config', () => {
			const config = db.getGlobalToolsConfig();
			expect(config).toBeDefined();
		});

		it('should save global tools config', () => {
			const config: GlobalToolsConfig = {
				systemPrompt: {
					claudeCodePreset: {
						allowed: false,
						defaultEnabled: false,
					},
				},
				settingSources: {
					project: {
						allowed: false,
						defaultEnabled: false,
					},
				},
				mcp: {
					allowProjectMcp: false,
					defaultProjectMcp: false,
				},
				kaiTools: {
					memory: {
						allowed: false,
						defaultEnabled: false,
					},
				},
			};

			db.saveGlobalToolsConfig(config);
			const retrieved = db.getGlobalToolsConfig();
			expect(retrieved.systemPrompt.claudeCodePreset.allowed).toBe(false);
			expect(retrieved.settingSources.project.allowed).toBe(false);
		});

		it('should get global settings', () => {
			const settings = db.getGlobalSettings();
			expect(settings).toBeDefined();
		});

		it('should save global settings', () => {
			const settings: GlobalSettings = {
				showArchived: true,
			};

			db.saveGlobalSettings(settings);
			const retrieved = db.getGlobalSettings();
			expect(retrieved.showArchived).toBe(true);
		});

		it('should update global settings', () => {
			db.saveGlobalSettings({ showArchived: false });
			const updated = db.updateGlobalSettings({ showArchived: true });
			expect(updated.showArchived).toBe(true);
		});
	});

	describe('Core operations', () => {
		it('should get database instance', () => {
			const bunDb = db.getDatabase();
			expect(bunDb).toBeDefined();
			expect(bunDb).toBeInstanceOf(BunDatabase);
		});

		it('should get database path', () => {
			const path = db.getDatabasePath();
			expect(path).toBe(dbPath);
		});

		it('should close database', () => {
			// Create a fresh database to close
			const newDb = new Database(join(tempDir, 'close-test.db'));

			// First initialize, then close
			newDb.initialize().then(() => {
				newDb.close();
				// After closing, operations should throw
				expect(() => newDb.listSessions()).toThrow();
			});
		});
	});
});
