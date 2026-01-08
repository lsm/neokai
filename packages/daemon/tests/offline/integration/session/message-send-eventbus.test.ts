/**
 * Integration test for message.send RPC timeout fix
 *
 * Tests the 3-layer communication pattern:
 * - RPC handler returns quickly (<100ms)
 * - Heavy work is deferred to EventBus subscriber (title generation, SDK query)
 * - No RPC timeout occurs even with slow title generation
 *
 * Note: With the new flow, workspaceInitialized is true from session creation
 * (worktree created immediately). The EventBus now handles title generation
 * and branch renaming on first message.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createDaemonHub, type DaemonHub } from '../../../../src/lib/daemon-hub';
import { Database } from '../../../../src/storage/database';
import { SessionManager } from '../../../../src/lib/session-manager';
import { SettingsManager } from '../../../../src/lib/settings-manager';
import { AuthManager } from '../../../../src/lib/auth-manager';
import { MessageHub } from '@liuboer/shared';
import { getConfig } from '../../../../src/config';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('message.send EventBus Integration', () => {
	let db: Database;
	let eventBus: DaemonHub;
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

		// Setup DaemonHub
		eventBus = createDaemonHub('test-hub');
		await eventBus.initialize();

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
		// Cleanup session resources (interrupts SDK queries)
		await sessionManager.cleanup();

		// Wait for async operations to complete after interrupt
		// This prevents "Cannot use a closed database" errors
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Now safe to close database
		db.close();
		await eventBus.close();

		// Remove test workspace
		try {
			rmSync(testWorkspace, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('SessionManager subscribes to message.persisted event', async () => {
		// Create a session to test with
		const sessionId = await sessionManager.createSession({
			workspacePath: testWorkspace,
		});

		// Verify the handler works by emitting an event with hasDraftToClear
		// If the handler is registered, it should process the event and clear the draft
		await sessionManager.updateSession(sessionId, {
			metadata: { inputDraft: 'verify-handler', workspaceInitialized: true },
		} as Partial<import('@liuboer/shared').Session>);

		await eventBus.emit('message.persisted', {
			sessionId,
			messageId: 'handler-test',
			messageContent: 'Test',
			userMessageText: 'Test',
			needsWorkspaceInit: false,
			hasDraftToClear: true,
		});

		// Wait for handler to process
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Verify handler ran by checking draft was cleared
		const agentSession = sessionManager.getSession(sessionId);
		const session = agentSession!.getSessionData();
		expect(session.metadata.inputDraft).toBeUndefined();
	});

	test('message.persisted event triggers title generation', async () => {
		const sessionId = await sessionManager.createSession({
			workspacePath: testWorkspace,
		});

		const agentSession = sessionManager.getSession(sessionId);
		let session = agentSession!.getSessionData();

		// Workspace is now initialized from session creation
		expect(session.metadata.workspaceInitialized).toBe(true);
		// But title is not yet generated
		expect(session.metadata.titleGenerated).toBe(false);

		// Mock the title generation to avoid API call
		// After refactoring, generateTitleFromMessage is on SessionLifecycle
		const lifecycle = sessionManager.getSessionLifecycle() as unknown as Record<string, unknown>;
		lifecycle.generateTitleFromMessage = async (text: string) => {
			return text.substring(0, 20);
		};

		// Emit the event directly (simulating what RPC handler does)
		await eventBus.emit('message.persisted', {
			sessionId,
			messageId: 'test-msg-1',
			messageContent: 'Test message for title',
			userMessageText: 'Test message for title',
			needsWorkspaceInit: true, // This now triggers title generation
			hasDraftToClear: false,
		});

		// Wait for async processing
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Get updated session
		session = agentSession!.getSessionData();

		// Verify title was generated
		expect(session.metadata.titleGenerated).toBe(true);
		expect(session.title).toBe('Test message for tit'); // First 20 chars
	});

	test('message.persisted event does not regenerate title if already generated', async () => {
		const sessionId = await sessionManager.createSession({
			workspacePath: testWorkspace,
		});

		// Mock title generation
		// After refactoring, generateTitleFromMessage is on SessionLifecycle
		const lifecycle = sessionManager.getSessionLifecycle() as unknown as Record<string, unknown>;
		lifecycle.generateTitleFromMessage = async (text: string) => {
			return text.substring(0, 20);
		};

		// Generate title first
		await sessionManager.generateTitleAndRenameBranch(sessionId, 'First message');

		const agentSession = sessionManager.getSession(sessionId);
		const session = agentSession!.getSessionData();

		// Verify title is generated
		expect(session.metadata.titleGenerated).toBe(true);
		const originalTitle = session.title;

		// Emit event with needsWorkspaceInit=false (title already generated)
		await eventBus.emit('message.persisted', {
			sessionId,
			messageId: 'test-msg-2',
			messageContent: 'Second message',
			userMessageText: 'Second message',
			needsWorkspaceInit: false,
			hasDraftToClear: false,
		});

		// Should complete quickly without re-generating title
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Title should remain the same
		const updatedSession = agentSession!.getSessionData();
		expect(updatedSession.metadata.titleGenerated).toBe(true);
		expect(updatedSession.title).toBe(originalTitle);
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
		await eventBus.emit('message.persisted', {
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
		// DaemonHub subscriber logs error but doesn't throw
		await eventBus.emit('message.persisted', {
			sessionId: 'non-existent-session',
			messageId: 'test-msg-4',
			messageContent: 'Test',
			userMessageText: 'Test',
			needsWorkspaceInit: true,
			hasDraftToClear: false,
		});

		// Wait for processing
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Original session should be unaffected (title not generated yet)
		const agentSession = sessionManager.getSession(sessionId);
		const session = agentSession!.getSessionData();
		expect(session.metadata.titleGenerated).toBe(false);
	});
});
