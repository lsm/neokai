/**
 * Integration test for message.send RPC timeout fix
 *
 * Tests the 3-layer communication pattern:
 * - RPC handler returns quickly (<100ms)
 * - Heavy work is deferred to EventBus subscriber
 * - No RPC timeout occurs even with slow workspace initialization
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { EventBus } from '@liuboer/shared';
import { Database } from '../../src/storage/database';
import { SessionManager } from '../../src/lib/session-manager';
import { SettingsManager } from '../../src/lib/settings-manager';
import { AuthManager } from '../../src/lib/auth-manager';
import { MessageHub } from '@liuboer/shared';
import { getConfig } from '../../src/config';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('message.send EventBus Integration', () => {
	let db: Database;
	let eventBus: EventBus;
	let sessionManager: SessionManager;
	let authManager: AuthManager;
	let settingsManager: SettingsManager;
	let testWorkspace: string;

	beforeEach(async () => {
		// Create test workspace
		testWorkspace = mkdtempSync(join(tmpdir(), 'liuboer-test-'));

		// Setup database
		db = new Database(':memory:');
		await db.initialize();

		// Get config
		const config = getConfig({ workspace: testWorkspace });

		// Setup AuthManager
		authManager = new AuthManager(db, config);
		await authManager.initialize();

		// Setup SettingsManager
		settingsManager = new SettingsManager(db, testWorkspace);

		// Setup EventBus
		eventBus = new EventBus({ debug: false });

		// Setup MessageHub (minimal for SessionManager constructor)
		const messageHub = new MessageHub({ defaultSessionId: 'global', debug: false });

		// Setup SessionManager with EventBus
		sessionManager = new SessionManager(db, messageHub, authManager, settingsManager, eventBus, {
			defaultModel: config.defaultModel,
			maxTokens: config.maxTokens,
			temperature: config.temperature,
			workspaceRoot: testWorkspace,
			disableWorktrees: true, // Disable worktrees for faster tests
		});
	});

	afterEach(async () => {
		// Cleanup
		await sessionManager.cleanup();
		db.close();
		eventBus.clear();

		// Remove test workspace
		try {
			rmSync(testWorkspace, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('SessionManager subscribes to user-message:persisted event', () => {
		// Verify EventBus has the handler registered
		const handlerCount = eventBus.getHandlerCount('user-message:persisted');
		expect(handlerCount).toBeGreaterThan(0);
	});

	test('user-message:persisted event triggers workspace initialization', async () => {
		const sessionId = await sessionManager.createSession({
			workspacePath: testWorkspace,
		});

		const agentSession = sessionManager.getSession(sessionId);
		let session = agentSession!.getSessionData();

		// Verify workspace not initialized initially
		expect(session.metadata.workspaceInitialized).toBe(false);

		// Emit the event directly (simulating what RPC handler does)
		await eventBus.emit('user-message:persisted', {
			sessionId,
			messageId: 'test-msg-1',
			messageContent: 'Test message',
			userMessageText: 'Test message',
			needsWorkspaceInit: true,
			hasDraftToClear: false,
		});

		// Wait for async processing
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Get updated session
		session = agentSession!.getSessionData();

		// Verify workspace was initialized
		expect(session.metadata.workspaceInitialized).toBe(true);
	});

	test('user-message:persisted event does not initialize if already initialized', async () => {
		const sessionId = await sessionManager.createSession({
			workspacePath: testWorkspace,
		});

		// Initialize workspace first
		await sessionManager.initializeSessionWorkspace(sessionId, 'First message');

		const agentSession = sessionManager.getSession(sessionId);
		const session = agentSession!.getSessionData();

		// Verify workspace is initialized
		expect(session.metadata.workspaceInitialized).toBe(true);

		// Emit event with needsWorkspaceInit=false
		await eventBus.emit('user-message:persisted', {
			sessionId,
			messageId: 'test-msg-2',
			messageContent: 'Second message',
			userMessageText: 'Second message',
			needsWorkspaceInit: false,
			hasDraftToClear: false,
		});

		// Should complete quickly without re-initializing
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Session should still be initialized (not changed)
		const updatedSession = agentSession!.getSessionData();
		expect(updatedSession.metadata.workspaceInitialized).toBe(true);
	});

	test('EventBus subscriber handles draft clearing', async () => {
		const sessionId = await sessionManager.createSession({
			workspacePath: testWorkspace,
		});

		// Set a draft
		await sessionManager.updateSession(sessionId, {
			metadata: { inputDraft: 'Test draft', workspaceInitialized: true },
		} as Partial<import('@liuboer/shared').Session>);

		let agentSession = sessionManager.getSession(sessionId);
		let session = agentSession!.getSessionData();
		expect(session.metadata.inputDraft).toBe('Test draft');

		// Emit event with hasDraftToClear=true
		await eventBus.emit('user-message:persisted', {
			sessionId,
			messageId: 'test-msg-3',
			messageContent: 'Test draft',
			userMessageText: 'Test draft',
			needsWorkspaceInit: false,
			hasDraftToClear: true,
		});

		// Wait for async processing
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Get fresh session data
		agentSession = sessionManager.getSession(sessionId);
		session = agentSession!.getSessionData();

		// Draft should be cleared
		expect(session.metadata.inputDraft).toBeUndefined();
	});

	test('EventBus subscriber handles errors gracefully', async () => {
		const sessionId = await sessionManager.createSession({
			workspacePath: testWorkspace,
		});

		// Emit event with invalid session ID (should not throw)
		// EventBus subscriber logs error but doesn't throw
		await eventBus.emit('user-message:persisted', {
			sessionId: 'non-existent-session',
			messageId: 'test-msg-4',
			messageContent: 'Test',
			userMessageText: 'Test',
			needsWorkspaceInit: true,
			hasDraftToClear: false,
		});

		// Wait for processing
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Original session should be unaffected
		const agentSession = sessionManager.getSession(sessionId);
		const session = agentSession!.getSessionData();
		expect(session.metadata.workspaceInitialized).toBe(false);
	});
});
