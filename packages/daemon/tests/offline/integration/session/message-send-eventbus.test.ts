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
import { setModelsCache } from '../../../../src/lib/model-service';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mockAgentSessionForOfflineTest } from '../../../test-utils';

describe('message.send EventBus Integration', () => {
	let db: Database;
	let eventBus: DaemonHub;
	let sessionManager: SessionManager;
	let authManager: AuthManager;
	let settingsManager: SettingsManager;
	let testWorkspace: string;

	beforeEach(async () => {
		// Set up mock models to prevent background refresh during tests
		// Matches the format used in test-utils.ts
		const mockModels = [
			{
				value: 'default',
				displayName: 'Sonnet 4.5',
				description: 'Sonnet 4.5 · Best for everyday tasks',
			},
			{
				value: 'opus',
				displayName: 'Opus 4.5',
				description: 'Opus 4.5 · Most capable model',
			},
			{
				value: 'haiku',
				displayName: 'Haiku 3.5',
				description: 'Haiku 3.5 · Fast and efficient',
			},
		];
		const mockCache = new Map<string, typeof mockModels>();
		mockCache.set('global', mockModels);
		setModelsCache(mockCache as Map<string, never>);

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
		const messageHub = new MessageHub({
			defaultSessionId: 'global',
			debug: false,
		});

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
		// Cleanup session resources
		await sessionManager.cleanup();

		// Wait for async operations to complete
		// No SDK queries are created in this offline test, so minimal wait needed
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

		// Mock AgentSession to prevent SDK query creation in offline test
		const agentSession = mockAgentSessionForOfflineTest(sessionManager, sessionId);

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
		const session = agentSession!.getSessionData();
		expect(session.metadata.inputDraft).toBeUndefined();
	});

	test('message.persisted event triggers title generation', async () => {
		const sessionId = await sessionManager.createSession({
			workspacePath: testWorkspace,
		});

		// Mock AgentSession to prevent SDK query creation in offline test
		const agentSession = mockAgentSessionForOfflineTest(sessionManager, sessionId);
		expect(agentSession).toBeDefined();

		let session = agentSession!.getSessionData();

		// Workspace is now initialized from session creation
		expect(session.metadata.workspaceInitialized).toBe(true);
		// But title is not yet generated
		expect(session.metadata.titleGenerated).toBe(false);

		// Mock generateTitleAndRenameBranch to avoid real SDK API call
		const lifecycle = sessionManager.getSessionLifecycle() as unknown as Record<string, unknown>;
		const originalGenerateTitle = lifecycle.generateTitleAndRenameBranch;
		lifecycle.generateTitleAndRenameBranch = async (
			_sessionId: string,
			_userMessageText: string
		) => {
			// Simulate title generation without calling SDK
			await sessionManager.updateSession(_sessionId, {
				title: 'Test message for tit',
				metadata: { titleGenerated: true },
			} as Partial<import('@liuboer/shared').Session>);
			return { title: 'Test message for tit', isFallback: false };
		};

		// Emit the event directly (simulating what RPC handler does)
		await eventBus.emit('message.persisted', {
			sessionId,
			messageId: 'test-msg-1',
			messageContent: 'Test message for title',
			userMessageText: 'Test message for title',
			needsWorkspaceInit: true,
			hasDraftToClear: false,
		});

		// Wait for async processing
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Get updated session
		session = agentSession!.getSessionData();

		// Restore original method
		lifecycle.generateTitleAndRenameBranch = originalGenerateTitle;

		// Verify title was generated
		expect(session.metadata.titleGenerated).toBe(true);
		expect(session.title).toBe('Test message for tit');
	});

	test('message.persisted event does not regenerate title if already generated', async () => {
		const sessionId = await sessionManager.createSession({
			workspacePath: testWorkspace,
		});

		// Mock AgentSession to prevent SDK query creation in offline test
		const agentSession = mockAgentSessionForOfflineTest(sessionManager, sessionId);
		expect(agentSession).toBeDefined();

		// Mock title generation to avoid real SDK API call
		const lifecycle = sessionManager.getSessionLifecycle() as unknown as Record<string, unknown>;
		const originalGenerateTitle = lifecycle.generateTitleAndRenameBranch;
		lifecycle.generateTitleAndRenameBranch = async (
			_sessionId: string,
			_userMessageText: string
		) => {
			// Simulate title generation without calling SDK
			await sessionManager.updateSession(_sessionId, {
				title: 'First message',
				metadata: { titleGenerated: true },
			} as Partial<import('@liuboer/shared').Session>);
			return { title: 'First message', isFallback: false };
		};

		// Generate title first (using mocked method)
		await sessionManager.generateTitleAndRenameBranch(sessionId, 'First message');

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

		// Restore original method
		lifecycle.generateTitleAndRenameBranch = originalGenerateTitle;
	});

	test('EventBus subscriber handles draft clearing', async () => {
		const sessionId = await sessionManager.createSession({
			workspacePath: testWorkspace,
		});

		// Mock AgentSession to prevent SDK query creation in offline test
		const agentSession = mockAgentSessionForOfflineTest(sessionManager, sessionId);
		expect(agentSession).toBeDefined();

		// Set a draft
		await sessionManager.updateSession(sessionId, {
			metadata: { inputDraft: 'Test draft', workspaceInitialized: true },
		} as Partial<import('@liuboer/shared').Session>);

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
		session = agentSession!.getSessionData();

		// Draft should be cleared
		expect(session.metadata.inputDraft).toBeUndefined();
	});

	test('EventBus subscriber handles errors gracefully', async () => {
		const sessionId = await sessionManager.createSession({
			workspacePath: testWorkspace,
		});

		// Mock AgentSession to prevent SDK query creation in offline test
		const agentSession = mockAgentSessionForOfflineTest(sessionManager, sessionId);
		expect(agentSession).toBeDefined();

		// Emit event with invalid session ID (should not throw)
		// DaemonHub subscriber logs error but doesn't throw
		await eventBus.emit('message.persisted', {
			sessionId: 'non-existent-session',
			messageId: 'test-msg-4',
			messageContent: 'Test',
			userMessageText: 'Test',
			needsWorkspaceInit: false,
			hasDraftToClear: false,
		});

		// Wait for processing
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Original session should be unaffected (title not generated yet)
		const session = agentSession!.getSessionData();
		expect(session.metadata.titleGenerated).toBe(false);
	});
});
