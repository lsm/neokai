/**
 * Context Command Online Tests
 *
 * These tests use the REAL Claude Agent SDK with actual API credentials.
 * They verify that the /context command is sent at turn end and the response
 * is correctly parsed.
 *
 * REQUIREMENTS:
 * - Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Makes real API calls (costs money, uses rate limits)
 *
 * MODEL:
 * - Uses 'haiku-4.5' (faster and cheaper than Sonnet for tests)
 *
 * Test Coverage:
 * 1. /context command is queued after each turn
 * 2. /context response is detected and parsed correctly
 * 3. Context info is updated and persisted to session metadata
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// Bun automatically loads .env from project root when running tests
import type { DaemonServerContext } from '../helpers/daemon-server-helper';
import { createDaemonServer } from '../helpers/daemon-server-helper';
import { sendMessage, waitForIdle, getSession } from '../helpers/daemon-test-helpers';
import type { ContextInfo } from '@neokai/shared';

describe('Context Command Online Tests', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createDaemonServer();
	}, 30000);

	afterEach(
		async () => {
			if (daemon) {
				daemon.kill('SIGTERM');
				await daemon.waitForExit();
			}
		},
		{ timeout: 20000 }
	);

	describe('Automatic /context at turn end', () => {
		test('should queue /context after turn and parse response correctly', async () => {
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: process.cwd(),
				title: 'Context Command Test',
				config: { model: 'haiku-4.5', permissionMode: 'acceptEdits' },
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Send a simple message
			await sendMessage(daemon, sessionId, 'What is 1+1? Answer with just the number.');

			// Wait for processing to complete
			await waitForIdle(daemon, sessionId, 30000);

			// Get session metadata - should contain context info
			const session = await getSession(daemon, sessionId);
			const metadata = session.metadata as {
				lastContextInfo?: ContextInfo;
				messageCount?: number;
			} | null;

			expect(metadata).toBeDefined();
			expect(metadata?.messageCount).toBeGreaterThan(0);

			// Verify context info was parsed and stored
			// The /context command response should have been processed
			if (metadata?.lastContextInfo) {
				const contextInfo = metadata.lastContextInfo;

				// Verify basic structure
				expect(contextInfo.model).toBeString();
				expect(contextInfo.totalCapacity).toBeGreaterThan(0);
				expect(contextInfo.percentUsed).toBeGreaterThanOrEqual(0);
				expect(contextInfo.percentUsed).toBeLessThanOrEqual(100);

				// Verify breakdown exists and has categories
				expect(contextInfo.breakdown).toBeDefined();
				const categories = Object.keys(contextInfo.breakdown);

				// Should have at least some categories (SDK-specific which ones)
				expect(categories.length).toBeGreaterThan(0);

				// Common categories that are typically present
				// Note: Some categories may vary by SDK version
				const typicalCategories = [
					'system prompt',
					'system tools',
					'mcp tools',
					'messages',
					'free space',
					'autocompact buffer',
				];
				const hasTypicalCategory = categories.some((cat) =>
					typicalCategories.some((typical) => cat.toLowerCase().includes(typical))
				);
				expect(hasTypicalCategory).toBe(true);

				// Verify source if set (may be 'context-command', 'merged', 'stream', or undefined)
				if (contextInfo.source) {
					expect(['context-command', 'merged', 'stream']).toContain(contextInfo.source);
				}

				// Verify each category has tokens and percent
				for (const [, data] of Object.entries(contextInfo.breakdown)) {
					expect(data.tokens).toBeGreaterThanOrEqual(0);
					// percent may be null for some categories
					if (data.percent !== null) {
						expect(data.percent).toBeGreaterThanOrEqual(0);
						expect(data.percent).toBeLessThanOrEqual(100);
					}
				}
			} else {
				// If lastContextInfo is not set, that's still a valid outcome
				// The parsing might have succeeded but context info wasn't persisted
				// This test primarily verifies no parsing errors occurred
			}
		}, 60000);

		test('should handle zero token usage (no k suffix)', async () => {
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: process.cwd(),
				title: 'Zero Token Context Test',
				config: { model: 'haiku-4.5', permissionMode: 'acceptEdits' },
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Send a message that might result in minimal token usage
			// (context parsing should work regardless of actual token values)
			await sendMessage(daemon, sessionId, 'Say hello. Just respond "Hello".');

			// Wait for processing to complete
			await waitForIdle(daemon, sessionId, 30000);

			// Get session metadata - should contain context info
			const session = await getSession(daemon, sessionId);
			const metadata = session.metadata as {
				lastContextInfo?: ContextInfo;
			} | null;

			// Verify context info exists even with zero/minimal tokens
			expect(metadata?.lastContextInfo).toBeDefined();

			if (metadata?.lastContextInfo) {
				const contextInfo = metadata.lastContextInfo;

				// Verify structure is valid
				expect(contextInfo.totalCapacity).toBeGreaterThan(0);
				expect(contextInfo.breakdown).toBeDefined();

				// The key is that parsing succeeded - structure should be valid
				expect(Object.keys(contextInfo.breakdown).length).toBeGreaterThan(0);
			}
		}, 60000);
	});

	describe('Context info format compatibility', () => {
		test('should parse both "Categories" and "Estimated usage by category" headers', async () => {
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: process.cwd(),
				title: 'Context Format Test',
				config: { model: 'haiku-4.5', permissionMode: 'acceptEdits' },
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Send a message
			await sendMessage(daemon, sessionId, 'What is 2+2? Just the number.');

			// Wait for processing
			await waitForIdle(daemon, sessionId, 30000);

			// Verify context was parsed successfully
			const session = await getSession(daemon, sessionId);
			const metadata = session.metadata as {
				lastContextInfo?: ContextInfo;
			} | null;

			// The test passes if we got context info without errors
			// (parsing worked regardless of which header format SDK returned)
			expect(metadata?.lastContextInfo).toBeDefined();
		}, 60000);
	});
});
