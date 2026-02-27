/**
 * Message RPC Handlers Tests
 *
 * Tests message-related RPC operations via WebSocket:
 * - session.export (markdown and JSON formats)
 * - message.sdkMessages (pagination)
 * - message.count
 * - message.send error handling
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle } from '../../helpers/daemon-actions';

// Tests that send messages to mock SDK need longer timeout on CI
const TIMEOUT = 15000;

describe('Message RPC Handlers', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createDaemonServer();
	});

	afterEach(async () => {
		await daemon.waitForExit();
	});

	async function createSession(workspacePath: string): Promise<string> {
		const { sessionId } = (await daemon.messageHub.request('session.create', {
			workspacePath,
		})) as { sessionId: string };
		daemon.trackSession(sessionId);
		return sessionId;
	}

	async function createSessionWithMessages(): Promise<string> {
		const sessionId = await createSession(
			`/test/msg-handler-${Date.now()}-${Math.random().toString(36).slice(2)}`
		);

		// Send a message — mock SDK will respond with assistant text + result
		await sendMessage(daemon, sessionId, 'Hello, world!');
		await waitForIdle(daemon, sessionId);

		return sessionId;
	}

	describe('message.sdkMessages', () => {
		test(
			'should get SDK messages for a session',
			async () => {
				const sessionId = await createSessionWithMessages();

				const result = (await daemon.messageHub.request('message.sdkMessages', {
					sessionId,
				})) as { sdkMessages: Array<Record<string, unknown>>; hasMore: boolean };

				expect(result.sdkMessages).toBeDefined();
				expect(Array.isArray(result.sdkMessages)).toBe(true);
				expect(result.sdkMessages.length).toBeGreaterThan(0);
			},
			TIMEOUT
		);

		test(
			'should support limit parameter',
			async () => {
				const sessionId = await createSessionWithMessages();

				const result = (await daemon.messageHub.request('message.sdkMessages', {
					sessionId,
					limit: 1,
				})) as { sdkMessages: Array<Record<string, unknown>>; hasMore: boolean };

				expect(result.sdkMessages).toBeDefined();
				expect(result.sdkMessages.length).toBeLessThanOrEqual(1);
			},
			TIMEOUT
		);

		test('should throw for invalid session', async () => {
			await expect(
				daemon.messageHub.request('message.sdkMessages', {
					sessionId: 'invalid-session',
				})
			).rejects.toThrow('Session not found');
		});
	});

	describe('message.count', () => {
		test(
			'should get message count',
			async () => {
				const sessionId = await createSessionWithMessages();

				const result = (await daemon.messageHub.request('message.count', {
					sessionId,
				})) as { count: number };

				expect(result.count).toBeDefined();
				expect(result.count).toBeGreaterThan(0);
			},
			TIMEOUT
		);

		test('should throw for invalid session', async () => {
			await expect(
				daemon.messageHub.request('message.count', {
					sessionId: 'invalid-session',
				})
			).rejects.toThrow('Session not found');
		});
	});

	describe('session.export', () => {
		test(
			'should export session as markdown by default',
			async () => {
				const sessionId = await createSessionWithMessages();

				// Set a title first for the export
				await daemon.messageHub.request('session.update', {
					sessionId,
					title: 'Test Export Session',
				});

				const result = (await daemon.messageHub.request('session.export', {
					sessionId,
				})) as { markdown: string };

				expect(result.markdown).toBeDefined();
				expect(typeof result.markdown).toBe('string');
				expect(result.markdown).toContain('# Test Export Session');
				expect(result.markdown).toContain('**Session ID:**');
			},
			TIMEOUT
		);

		test(
			'should export session as markdown explicitly',
			async () => {
				const sessionId = await createSessionWithMessages();

				const result = (await daemon.messageHub.request('session.export', {
					sessionId,
					format: 'markdown',
				})) as { markdown: string };

				expect(result.markdown).toBeDefined();
				expect(typeof result.markdown).toBe('string');
			},
			TIMEOUT
		);

		test(
			'should export session as JSON',
			async () => {
				const sessionId = await createSessionWithMessages();

				const result = (await daemon.messageHub.request('session.export', {
					sessionId,
					format: 'json',
				})) as {
					session: Record<string, unknown>;
					messages: Array<Record<string, unknown>>;
				};

				expect(result.session).toBeDefined();
				expect(result.messages).toBeDefined();
				expect(Array.isArray(result.messages)).toBe(true);
			},
			TIMEOUT
		);

		test(
			'should include assistant response in markdown export',
			async () => {
				const sessionId = await createSessionWithMessages();

				const result = (await daemon.messageHub.request('session.export', {
					sessionId,
					format: 'markdown',
				})) as { markdown: string };

				// Mock SDK responds with 'mock response' by default
				expect(result.markdown).toContain('## Assistant');
				expect(result.markdown).toContain('mock response');
			},
			TIMEOUT
		);

		test('should throw for invalid session', async () => {
			await expect(
				daemon.messageHub.request('session.export', {
					sessionId: 'invalid-session',
				})
			).rejects.toThrow('Session not found');
		});
	});

	describe('message.send error handling', () => {
		test('should return error for non-existent session', async () => {
			await expect(
				daemon.messageHub.request('message.send', {
					sessionId: 'non-existent',
					content: 'Hello',
				})
			).rejects.toThrow();
		});
	});
});
