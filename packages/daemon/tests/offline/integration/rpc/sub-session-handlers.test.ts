/**
 * Sub-Session RPC Handlers Tests
 *
 * Tests for sub-session-related RPC handlers:
 * - session.sub.create
 * - session.sub.list
 * - session.sub.delete
 * - session.sub.reorder
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../../test-utils';
import {
	createTestApp,
	waitForWebSocketState,
	waitForWebSocketMessage,
	createWebSocketWithFirstMessage,
} from '../../../test-utils';

describe('Sub-Session RPC Handlers', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('session.sub.create', () => {
		test('should return error when parentId is missing', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'sub-create-1',
					type: 'CALL',
					method: 'session.sub.create',
					data: {},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('ERROR');
			expect(response.error).toContain('parentId is required');

			ws.close();
		});

		test('should create sub-session under parent', async () => {
			// Create parent session first
			const parentId = await ctx.sessionManager.createSession({
				workspacePath: '/test/sub-create',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'sub-create-2',
					type: 'CALL',
					method: 'session.sub.create',
					data: {
						parentId,
						title: 'Test Sub-Session',
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.sessionId).toBeString();
			expect(response.data.session).toBeDefined();
			expect(response.data.session.parentId).toBe(parentId);
			expect(response.data.session.title).toBe('Test Sub-Session');

			ws.close();
		});

		test('should create sub-session with labels', async () => {
			const parentId = await ctx.sessionManager.createSession({
				workspacePath: '/test/sub-create-labels',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'sub-create-3',
					type: 'CALL',
					method: 'session.sub.create',
					data: {
						parentId,
						title: 'Labeled Sub-Session',
						subSessionConfig: {
							labels: ['research', 'phase-1'],
						},
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.session.labels).toEqual(['research', 'phase-1']);

			ws.close();
		});
	});

	describe('session.sub.list', () => {
		test('should return error when parentId is missing', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'sub-list-1',
					type: 'CALL',
					method: 'session.sub.list',
					data: {},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('ERROR');
			expect(response.error).toContain('parentId is required');

			ws.close();
		});

		test('should return empty array for parent with no sub-sessions', async () => {
			const parentId = await ctx.sessionManager.createSession({
				workspacePath: '/test/sub-list-empty',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'sub-list-2',
					type: 'CALL',
					method: 'session.sub.list',
					data: { parentId },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.subSessions).toBeArray();
			expect(response.data.subSessions).toHaveLength(0);

			ws.close();
		});

		test('should list all sub-sessions for parent', async () => {
			const parentId = await ctx.sessionManager.createSession({
				workspacePath: '/test/sub-list-all',
			});

			// Create sub-sessions via SessionManager directly
			await ctx.sessionManager.createSubSession({
				parentId,
				title: 'Sub 1',
			});
			await ctx.sessionManager.createSubSession({
				parentId,
				title: 'Sub 2',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'sub-list-3',
					type: 'CALL',
					method: 'session.sub.list',
					data: { parentId },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.subSessions).toHaveLength(2);

			ws.close();
		});

		test('should filter sub-sessions by labels', async () => {
			const parentId = await ctx.sessionManager.createSession({
				workspacePath: '/test/sub-list-filter',
			});

			// Create sub-sessions with different labels
			await ctx.sessionManager.createSubSession({
				parentId,
				title: 'Research Task',
				subSessionConfig: { labels: ['research'] },
			});
			await ctx.sessionManager.createSubSession({
				parentId,
				title: 'Development Task',
				subSessionConfig: { labels: ['dev'] },
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'sub-list-4',
					type: 'CALL',
					method: 'session.sub.list',
					data: {
						parentId,
						labels: ['research'],
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.subSessions).toHaveLength(1);
			expect(response.data.subSessions[0].title).toBe('Research Task');

			ws.close();
		});
	});

	describe('session.sub.delete', () => {
		test('should return error when sessionId is missing', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'sub-delete-1',
					type: 'CALL',
					method: 'session.sub.delete',
					data: {},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('ERROR');
			expect(response.error).toContain('sessionId is required');

			ws.close();
		});

		test('should delete sub-session', async () => {
			const parentId = await ctx.sessionManager.createSession({
				workspacePath: '/test/sub-delete',
			});

			const subId = await ctx.sessionManager.createSubSession({
				parentId,
				title: 'To Delete',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'sub-delete-2',
					type: 'CALL',
					method: 'session.sub.delete',
					data: { sessionId: subId },
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.success).toBe(true);

			// Verify sub-session is deleted
			const subSessions = ctx.sessionManager.getSubSessions(parentId);
			expect(subSessions).toHaveLength(0);

			ws.close();
		});
	});

	describe('session.sub.reorder', () => {
		test('should return error when parentId is missing', async () => {
			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'sub-reorder-1',
					type: 'CALL',
					method: 'session.sub.reorder',
					data: {
						orderedIds: ['a', 'b'],
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('ERROR');
			expect(response.error).toContain('parentId is required');

			ws.close();
		});

		test('should return error when orderedIds is not an array', async () => {
			const parentId = await ctx.sessionManager.createSession({
				workspacePath: '/test/sub-reorder-invalid',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			ws.send(
				JSON.stringify({
					id: 'sub-reorder-2',
					type: 'CALL',
					method: 'session.sub.reorder',
					data: {
						parentId,
						orderedIds: 'not-an-array',
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('ERROR');
			expect(response.error).toContain('orderedIds must be an array');

			ws.close();
		});

		test('should reorder sub-sessions', async () => {
			const parentId = await ctx.sessionManager.createSession({
				workspacePath: '/test/sub-reorder',
			});

			// Create sub-sessions
			const sub1 = await ctx.sessionManager.createSubSession({
				parentId,
				title: 'First',
			});
			const sub2 = await ctx.sessionManager.createSubSession({
				parentId,
				title: 'Second',
			});
			const sub3 = await ctx.sessionManager.createSubSession({
				parentId,
				title: 'Third',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise;

			const responsePromise = waitForWebSocketMessage(ws);

			// Reorder: Third, First, Second
			ws.send(
				JSON.stringify({
					id: 'sub-reorder-3',
					type: 'CALL',
					method: 'session.sub.reorder',
					data: {
						parentId,
						orderedIds: [sub3, sub1, sub2],
					},
					sessionId: 'global',
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			const response = await responsePromise;

			expect(response.type).toBe('RESULT');
			expect(response.data.success).toBe(true);

			// Verify order
			const subSessions = ctx.sessionManager.getSubSessions(parentId);
			expect(subSessions[0].id).toBe(sub3);
			expect(subSessions[1].id).toBe(sub1);
			expect(subSessions[2].id).toBe(sub2);

			ws.close();
		});
	});
});
