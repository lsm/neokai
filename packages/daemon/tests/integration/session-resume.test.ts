/**
 * Session Resume Integration Tests
 *
 * Tests the full flow of SDK session resumption after daemon restart.
 * Verifies that SDK session IDs are captured and used for resuming sessions.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import type { TestContext } from '../test-utils';
import { createTestApp, callRPCHandler } from '../test-utils';
import type { Session } from '@liuboer/shared';
import { generateUUID } from '@liuboer/shared';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Session Resume Integration', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	test('should capture SDK session ID on first message', async () => {
		// Create a new session
		const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
			workspacePath: `${TMP_DIR}/test-session-resume`,
		});

		expect(sessionId).toBeDefined();

		// Get session from database - initially no SDK session ID
		let session = ctx.db.getSession(sessionId);
		expect(session).toBeDefined();
		expect(session?.sdkSessionId).toBeUndefined();

		// Set up a promise that resolves when SDK session ID is captured
		const sdkSessionIdCaptured = new Promise<void>((resolve) => {
			const checkInterval = setInterval(() => {
				const updatedSession = ctx.db.getSession(sessionId);
				if (updatedSession?.sdkSessionId) {
					clearInterval(checkInterval);
					resolve();
				}
			}, 100);

			// Timeout after 5 seconds
			setTimeout(() => {
				clearInterval(checkInterval);
				resolve();
			}, 5000);
		});

		// Send a message to trigger SDK initialization
		await callRPCHandler(ctx.messageHub, 'message.send', {
			sessionId,
			content: 'Hello',
		});

		// Wait for SDK session ID to be captured
		await sdkSessionIdCaptured;

		// Retrieve session from database - SDK session ID should now be captured
		session = ctx.db.getSession(sessionId);
		expect(session?.sdkSessionId).toBeDefined();
		expect(typeof session?.sdkSessionId).toBe('string');
	}, 30000);

	test('should preserve SDK session ID when loading existing session', async () => {
		// Create a session with pre-existing SDK session ID in database
		const mockSdkSessionId = 'mock-sdk-session-id-' + generateUUID();
		const testSession: Session = {
			id: generateUUID(),
			title: 'Resume Test Session',
			workspacePath: `${TMP_DIR}/test-session-resume-2`,
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'active',
			config: {
				model: 'default',
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
			sdkSessionId: mockSdkSessionId,
		};

		ctx.db.createSession(testSession);

		// Retrieve via RPC - SDK session ID should be preserved
		const { session } = await callRPCHandler(ctx.messageHub, 'session.get', {
			sessionId: testSession.id,
		});

		expect(session).toBeDefined();
		expect(session.sdkSessionId).toBe(mockSdkSessionId);
	});

	test('should handle sessions without SDK session ID gracefully', async () => {
		// Create a session without SDK session ID (simulating old sessions)
		const testSession: Session = {
			id: generateUUID(),
			title: 'Legacy Session',
			workspacePath: `${TMP_DIR}/test-session-resume-legacy`,
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'active',
			config: {
				model: 'default',
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
			// No sdkSessionId field
		};

		ctx.db.createSession(testSession);

		// Get session - should work normally without SDK session ID
		const { session } = await callRPCHandler(ctx.messageHub, 'session.get', {
			sessionId: testSession.id,
		});

		expect(session).toBeDefined();
		expect(session.sdkSessionId).toBeUndefined();
	});
});
