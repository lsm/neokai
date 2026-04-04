/**
 * Tests for Space Task Message RPC Handlers
 *
 * Covers:
 * - space.task.sendMessage: happy path, missing params, task not found,
 *   no Task Agent session, TaskAgentManager error propagation,
 *   cross-space isolation, message length validation
 * - space.task.getMessages: happy path (live session), fallback to DB,
 *   cursor parsing, limit capping, missing params, task not found,
 *   no Task Agent session, cross-space isolation
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import type { SpaceTask } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk';
import {
	setupSpaceTaskMessageHandlers,
	type TaskAgentManagerInterface,
} from '../../../src/lib/rpc-handlers/space-task-message-handlers';
import type { Database } from '../../../src/storage/database';
import type { AgentSession } from '../../../src/lib/agent/agent-session';
import type { DaemonHub } from '../../../src/lib/daemon-hub';

type RequestHandler = (data: unknown) => Promise<unknown>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const NOW = Date.now();

const mockTaskWithSession: SpaceTask = {
	id: 'task-1',
	spaceId: 'space-1',
	taskNumber: 1,
	title: 'Test Task',
	description: 'A task description',
	status: 'in_progress',
	priority: 'normal',
	dependsOn: [],
	taskAgentSessionId: 'space:space-1:task:task-1',
	createdAt: NOW,
	updatedAt: NOW,
};

const mockTaskWithoutSession: SpaceTask = {
	id: 'task-2',
	spaceId: 'space-1',
	taskNumber: 2,
	title: 'Pending Task',
	description: 'Not yet spawned',
	status: 'pending',
	priority: 'normal',
	dependsOn: [],
	taskAgentSessionId: undefined,
	createdAt: NOW,
	updatedAt: NOW,
};

const mockSDKMessages: SDKMessage[] = [
	{
		type: 'user',
		uuid: 'msg-1' as import('crypto').UUID,
		session_id: 'space:space-1:task:task-1',
		parent_tool_use_id: null,
		message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
	},
] as unknown as SDKMessage[];

// ─── Mock helpers ────────────────────────────────────────────────────────────

function createMockMessageHub(): {
	hub: MessageHub;
	handlers: Map<string, RequestHandler>;
} {
	const handlers = new Map<string, RequestHandler>();
	const hub = {
		onRequest: mock((method: string, handler: RequestHandler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		}),
		onEvent: mock(() => () => {}),
		request: mock(async () => {}),
		event: mock(() => {}),
		joinChannel: mock(async () => {}),
		leaveChannel: mock(async () => {}),
		isConnected: mock(() => true),
		getState: mock(() => 'connected' as const),
		onConnection: mock(() => () => {}),
		onMessage: mock(() => () => {}),
		cleanup: mock(() => {}),
		registerTransport: mock(() => () => {}),
		registerRouter: mock(() => {}),
		getRouter: mock(() => null),
		getPendingCallCount: mock(() => 0),
	} as unknown as MessageHub;
	return { hub, handlers };
}

function createMockAgentSession(messages = mockSDKMessages): Partial<AgentSession> {
	return {
		getSDKMessages: mock((_limit?: number, _before?: number) => ({
			messages,
			hasMore: false,
		})),
	};
}

function createMockTaskAgentManager(
	liveSession: Partial<AgentSession> | null = null,
	ensuredTask: SpaceTask = mockTaskWithSession
): TaskAgentManagerInterface {
	return {
		ensureTaskAgentSession: mock(async (_taskId: string) => ensuredTask),
		injectTaskAgentMessage: mock(async (_taskId: string, _message: string) => {}),
		getTaskAgent: mock((_taskId: string) => (liveSession ?? undefined) as AgentSession | undefined),
	};
}

function createMockDatabase(
	task: SpaceTask | null,
	dbMessages: SDKMessage[] = mockSDKMessages
): Database {
	return {
		getDatabase: mock(() => ({
			prepare: mock((_sql: string) => ({
				get: mock((_id: string) => {
					if (!task) return undefined;
					// Simulate the repository row format
					return {
						id: task.id,
						space_id: task.spaceId,
						title: task.title,
						description: task.description,
						status: task.status,
						priority: task.priority,
						depends_on: '[]',
						task_agent_session_id: task.taskAgentSessionId ?? null,
						workflow_node_id: null,
						workflow_run_id: null,
						result: null,
						error: null,
						archived_at: null,
						created_at: task.createdAt,
						updated_at: task.updatedAt,
					};
				}),
			})),
		})),
		getSDKMessages: mock((_sessionId: string, _limit?: number, _before?: number) => ({
			messages: dbMessages,
			hasMore: false,
		})),
	} as unknown as Database;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('setupSpaceTaskMessageHandlers', () => {
	let hub: MessageHub;
	let handlers: Map<string, RequestHandler>;
	let taskAgentManager: TaskAgentManagerInterface;
	let db: Database;
	let daemonHub: DaemonHub;

	/**
	 * Sets up all mocks and registers handlers.
	 * @param task       Task to return from repository (null = "not found")
	 * @param liveSession Live AgentSession to return from getTaskAgent (null = not in memory)
	 */
	function setup(
		task: SpaceTask | null = mockTaskWithSession,
		liveSession: Partial<AgentSession> | null = null,
		ensuredTask: SpaceTask = mockTaskWithSession
	) {
		const mh = createMockMessageHub();
		hub = mh.hub;
		handlers = mh.handlers;
		taskAgentManager = createMockTaskAgentManager(liveSession, ensuredTask);
		db = createMockDatabase(task);
		daemonHub = {
			emit: mock(async () => {}),
		} as unknown as DaemonHub;
		setupSpaceTaskMessageHandlers(hub, taskAgentManager, db, daemonHub);
	}

	const call = (method: string, data: unknown) => {
		const handler = handlers.get(method);
		if (!handler) throw new Error(`No handler registered for ${method}`);
		return handler(data);
	};

	// ─── Registration ──────────────────────────────────────────────────────────

	describe('handler registration', () => {
		beforeEach(() => setup());

		it('registers space.task.sendMessage handler', () => {
			expect(handlers.has('space.task.sendMessage')).toBe(true);
		});

		it('registers space.task.getMessages handler', () => {
			expect(handlers.has('space.task.getMessages')).toBe(true);
		});

		it('registers space.task.ensureAgentSession handler', () => {
			expect(handlers.has('space.task.ensureAgentSession')).toBe(true);
		});
	});

	// ─── space.task.ensureAgentSession ─────────────────────────────────────────

	describe('space.task.ensureAgentSession', () => {
		beforeEach(() => setup());

		it('ensures a task session and returns session metadata', async () => {
			const result = await call('space.task.ensureAgentSession', {
				spaceId: 'space-1',
				taskId: 'task-1',
			});

			expect(result).toMatchObject({
				taskId: 'task-1',
				sessionId: 'space:space-1:task:task-1',
			});
			expect(taskAgentManager.ensureTaskAgentSession).toHaveBeenCalledWith('task-1');
			expect((daemonHub.emit as ReturnType<typeof mock>).mock.calls[0]?.[0]).toBe(
				'space.task.updated'
			);
		});

		it('throws when spaceId is missing', async () => {
			await expect(call('space.task.ensureAgentSession', { taskId: 'task-1' })).rejects.toThrow(
				'spaceId is required'
			);
		});

		it('throws when taskId is missing', async () => {
			await expect(call('space.task.ensureAgentSession', { spaceId: 'space-1' })).rejects.toThrow(
				'taskId is required'
			);
		});

		it('throws when task is not found', async () => {
			setup(null);
			await expect(
				call('space.task.ensureAgentSession', { spaceId: 'space-1', taskId: 'ghost' })
			).rejects.toThrow('Task not found: ghost');
		});

		it('throws for cross-space task access', async () => {
			await expect(
				call('space.task.ensureAgentSession', { spaceId: 'space-other', taskId: 'task-1' })
			).rejects.toThrow('Task not found: task-1');
		});
	});

	// ─── space.task.sendMessage ────────────────────────────────────────────────

	describe('space.task.sendMessage', () => {
		beforeEach(() => setup());

		it('injects a message and returns { ok: true }', async () => {
			const result = await call('space.task.sendMessage', {
				spaceId: 'space-1',
				taskId: 'task-1',
				message: 'Please continue',
			});

			expect(result).toEqual({ ok: true });
			expect(taskAgentManager.ensureTaskAgentSession).toHaveBeenCalledWith('task-1');
			expect(taskAgentManager.injectTaskAgentMessage).toHaveBeenCalledWith(
				'task-1',
				'Please continue'
			);
		});

		it('throws when spaceId is missing', async () => {
			await expect(
				call('space.task.sendMessage', { taskId: 'task-1', message: 'Hello' })
			).rejects.toThrow('spaceId is required');
		});

		it('throws when taskId is missing', async () => {
			await expect(
				call('space.task.sendMessage', { spaceId: 'space-1', message: 'Hello' })
			).rejects.toThrow('taskId is required');
		});

		it('throws when message is missing', async () => {
			await expect(
				call('space.task.sendMessage', { spaceId: 'space-1', taskId: 'task-1' })
			).rejects.toThrow('message is required');
		});

		it('throws when message is whitespace-only', async () => {
			await expect(
				call('space.task.sendMessage', { spaceId: 'space-1', taskId: 'task-1', message: '   ' })
			).rejects.toThrow('message is required');
		});

		it('throws when message exceeds 10,000 characters', async () => {
			const longMessage = 'x'.repeat(10_001);
			await expect(
				call('space.task.sendMessage', {
					spaceId: 'space-1',
					taskId: 'task-1',
					message: longMessage,
				})
			).rejects.toThrow('Message is too long');
		});

		it('throws when task is not found', async () => {
			setup(null);
			await expect(
				call('space.task.sendMessage', { spaceId: 'space-1', taskId: 'ghost', message: 'Hello' })
			).rejects.toThrow('Task not found: ghost');
			expect(taskAgentManager.injectTaskAgentMessage).not.toHaveBeenCalled();
		});

		it('throws when taskId belongs to a different space (cross-space isolation)', async () => {
			await expect(
				call('space.task.sendMessage', {
					spaceId: 'space-other',
					taskId: 'task-1',
					message: 'Hello',
				})
			).rejects.toThrow('Task not found: task-1');
			expect(taskAgentManager.injectTaskAgentMessage).not.toHaveBeenCalled();
		});

		it('auto-ensures Task Agent session when task has no taskAgentSessionId yet', async () => {
			setup(mockTaskWithoutSession, null, {
				...mockTaskWithoutSession,
				taskAgentSessionId: 'space:space-1:task:task-2',
				status: 'in_progress',
			});

			const result = await call('space.task.sendMessage', {
				spaceId: 'space-1',
				taskId: 'task-2',
				message: 'Hello',
			});

			expect(result).toEqual({ ok: true });
			expect(taskAgentManager.ensureTaskAgentSession).toHaveBeenCalledWith('task-2');
			expect(taskAgentManager.injectTaskAgentMessage).toHaveBeenCalledWith('task-2', 'Hello');
			expect((daemonHub.emit as ReturnType<typeof mock>).mock.calls[0]?.[0]).toBe(
				'space.task.updated'
			);
		});

		it('propagates errors from TaskAgentManager', async () => {
			(taskAgentManager.injectTaskAgentMessage as ReturnType<typeof mock>).mockRejectedValue(
				new Error('Task Agent session not found for task task-1')
			);

			await expect(
				call('space.task.sendMessage', { spaceId: 'space-1', taskId: 'task-1', message: 'Hello' })
			).rejects.toThrow('Task Agent session not found');
		});

		it('propagates ensureTaskAgentSession failure when task has no session', async () => {
			setup(mockTaskWithoutSession);
			(taskAgentManager.ensureTaskAgentSession as ReturnType<typeof mock>).mockRejectedValue(
				new Error('Failed to spawn task agent: workspace not configured')
			);

			await expect(
				call('space.task.sendMessage', { spaceId: 'space-1', taskId: 'task-2', message: 'Hello' })
			).rejects.toThrow('Failed to spawn task agent');
			expect(taskAgentManager.injectTaskAgentMessage).not.toHaveBeenCalled();
		});

		it('message injected via sendMessage is visible in getMessages response', async () => {
			const injectedMessage: SDKMessage = {
				type: 'user',
				uuid: 'msg-injected' as import('crypto').UUID,
				session_id: 'space:space-1:task:task-1',
				parent_tool_use_id: null,
				message: { role: 'user', content: [{ type: 'text', text: 'Please continue the work' }] },
			} as unknown as SDKMessage;

			const liveSession = createMockAgentSession([...mockSDKMessages, injectedMessage]);
			setup(mockTaskWithSession, liveSession);

			// Inject message
			const sendResult = await call('space.task.sendMessage', {
				spaceId: 'space-1',
				taskId: 'task-1',
				message: 'Please continue the work',
			});
			expect(sendResult).toEqual({ ok: true });

			// Retrieve messages — the injected message should appear in the unified thread
			const getResult = (await call('space.task.getMessages', {
				spaceId: 'space-1',
				taskId: 'task-1',
			})) as { messages: SDKMessage[]; hasMore: boolean; sessionId: string };

			expect(getResult.sessionId).toBe('space:space-1:task:task-1');
			expect(getResult.messages).toContainEqual(expect.objectContaining({ uuid: 'msg-injected' }));
		});

		it('emits space.task.updated after injecting message when session was missing', async () => {
			const updatedTask: SpaceTask = {
				...mockTaskWithoutSession,
				taskAgentSessionId: 'space:space-1:task:task-2',
				status: 'in_progress',
			};
			setup(mockTaskWithoutSession, null, updatedTask);

			await call('space.task.sendMessage', {
				spaceId: 'space-1',
				taskId: 'task-2',
				message: 'Hello',
			});

			const emitCalls = (daemonHub.emit as ReturnType<typeof mock>).mock.calls;
			expect(emitCalls.length).toBeGreaterThan(0);
			expect(emitCalls[0]?.[0]).toBe('space.task.updated');
			expect(emitCalls[0]?.[1]).toMatchObject({ task: expect.objectContaining({ id: 'task-2' }) });
		});
	});

	// ─── space.task.getMessages ────────────────────────────────────────────────

	describe('space.task.getMessages', () => {
		it('returns messages from live session when Task Agent is active', async () => {
			const liveSession = createMockAgentSession(mockSDKMessages);
			setup(mockTaskWithSession, liveSession);

			const result = await call('space.task.getMessages', {
				spaceId: 'space-1',
				taskId: 'task-1',
			});

			expect(result).toMatchObject({
				messages: mockSDKMessages,
				hasMore: false,
				sessionId: 'space:space-1:task:task-1',
			});
			expect(liveSession.getSDKMessages).toHaveBeenCalledWith(50, undefined);
			expect(db.getSDKMessages).not.toHaveBeenCalled();
		});

		it('falls back to DB when Task Agent session is not in memory', async () => {
			setup(mockTaskWithSession, null);
			const dbMessages = mockSDKMessages;
			(db.getSDKMessages as ReturnType<typeof mock>).mockReturnValue({
				messages: dbMessages,
				hasMore: false,
			});

			const result = await call('space.task.getMessages', {
				spaceId: 'space-1',
				taskId: 'task-1',
			});

			expect(result).toMatchObject({
				messages: dbMessages,
				hasMore: false,
				sessionId: 'space:space-1:task:task-1',
			});
			expect(db.getSDKMessages).toHaveBeenCalledWith('space:space-1:task:task-1', 50, undefined);
		});

		it('uses default limit of 50 when not provided', async () => {
			const liveSession = createMockAgentSession();
			setup(mockTaskWithSession, liveSession);

			await call('space.task.getMessages', { spaceId: 'space-1', taskId: 'task-1' });

			expect(liveSession.getSDKMessages).toHaveBeenCalledWith(50, undefined);
		});

		it('passes limit parameter to session', async () => {
			const liveSession = createMockAgentSession();
			setup(mockTaskWithSession, liveSession);

			await call('space.task.getMessages', { spaceId: 'space-1', taskId: 'task-1', limit: 10 });

			expect(liveSession.getSDKMessages).toHaveBeenCalledWith(10, undefined);
		});

		it('caps limit at 200', async () => {
			const liveSession = createMockAgentSession();
			setup(mockTaskWithSession, liveSession);

			await call('space.task.getMessages', { spaceId: 'space-1', taskId: 'task-1', limit: 999 });

			expect(liveSession.getSDKMessages).toHaveBeenCalledWith(200, undefined);
		});

		it('enforces minimum limit of 1', async () => {
			const liveSession = createMockAgentSession();
			setup(mockTaskWithSession, liveSession);

			await call('space.task.getMessages', { spaceId: 'space-1', taskId: 'task-1', limit: 0 });

			expect(liveSession.getSDKMessages).toHaveBeenCalledWith(1, undefined);
		});

		it('parses numeric cursor and passes as before timestamp', async () => {
			const liveSession = createMockAgentSession();
			setup(mockTaskWithSession, liveSession);

			await call('space.task.getMessages', {
				spaceId: 'space-1',
				taskId: 'task-1',
				cursor: '1700000000000',
			});

			expect(liveSession.getSDKMessages).toHaveBeenCalledWith(50, 1700000000000);
		});

		it('ignores non-numeric cursor', async () => {
			const liveSession = createMockAgentSession();
			setup(mockTaskWithSession, liveSession);

			await call('space.task.getMessages', {
				spaceId: 'space-1',
				taskId: 'task-1',
				cursor: 'invalid',
			});

			expect(liveSession.getSDKMessages).toHaveBeenCalledWith(50, undefined);
		});

		it('returns hasMore: true when session has more messages', async () => {
			const liveSession: Partial<AgentSession> = {
				getSDKMessages: mock(() => ({
					messages: mockSDKMessages,
					hasMore: true,
				})),
			};
			setup(mockTaskWithSession, liveSession);

			const result = (await call('space.task.getMessages', {
				spaceId: 'space-1',
				taskId: 'task-1',
			})) as { hasMore: boolean };

			expect(result.hasMore).toBe(true);
		});

		it('throws when spaceId is missing', async () => {
			setup(mockTaskWithSession);
			await expect(call('space.task.getMessages', { taskId: 'task-1' })).rejects.toThrow(
				'spaceId is required'
			);
		});

		it('throws when taskId is missing', async () => {
			setup(mockTaskWithSession);
			await expect(call('space.task.getMessages', { spaceId: 'space-1' })).rejects.toThrow(
				'taskId is required'
			);
		});

		it('throws when task is not found', async () => {
			setup(null);
			await expect(
				call('space.task.getMessages', { spaceId: 'space-1', taskId: 'ghost' })
			).rejects.toThrow('Task not found: ghost');
		});

		it('throws when taskId belongs to a different space (cross-space isolation)', async () => {
			await expect(
				call('space.task.getMessages', { spaceId: 'space-other', taskId: 'task-1' })
			).rejects.toThrow('Task not found: task-1');
		});

		it('throws when Task Agent session is not started (no taskAgentSessionId)', async () => {
			setup(mockTaskWithoutSession);
			await expect(
				call('space.task.getMessages', { spaceId: 'space-1', taskId: 'task-2' })
			).rejects.toThrow('Task Agent session not started for task: task-2');
		});
	});
});
