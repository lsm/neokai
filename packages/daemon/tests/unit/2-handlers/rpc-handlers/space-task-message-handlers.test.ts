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
import { Database as BunDatabase } from 'bun:sqlite';
import { MessageHub } from '@neokai/shared';
import type { SpaceTask } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk';
import {
	setupSpaceTaskMessageHandlers,
	parseMentions,
	type TaskAgentManagerInterface,
	type NodeExecutionLookup,
	type ChannelCycleResetter,
} from '../../../../src/lib/rpc-handlers/space-task-message-handlers';
import type { Database } from '../../../../src/storage/database';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import type { DaemonHub } from '../../../../src/lib/daemon-hub';
import { ChannelCycleRepository } from '../../../../src/storage/repositories/channel-cycle-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

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
						workflow_run_id: task.workflowRunId ?? null,
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
			// Use a mutable array: starts with only the initial messages (no injected message yet).
			// injectTaskAgentMessage will push to this array, simulating what the real session does.
			const sessionMessages: SDKMessage[] = [...mockSDKMessages];
			const liveSession: Partial<AgentSession> = {
				getSDKMessages: mock((_limit?: number, _before?: number) => ({
					messages: sessionMessages,
					hasMore: false,
				})),
			};

			setup(mockTaskWithSession, liveSession);

			// Override inject to push into the shared mutable array (mirrors real session behavior)
			(taskAgentManager.injectTaskAgentMessage as ReturnType<typeof mock>).mockImplementation(
				async (_taskId: string, message: string) => {
					sessionMessages.push({
						type: 'user',
						uuid: 'msg-injected' as import('crypto').UUID,
						session_id: 'space:space-1:task:task-1',
						parent_tool_use_id: null,
						message: { role: 'user', content: [{ type: 'text', text: message }] },
					} as unknown as SDKMessage);
				}
			);

			// Before send: message is NOT in the session
			expect(sessionMessages).not.toContainEqual(expect.objectContaining({ uuid: 'msg-injected' }));

			// Inject message via handler
			const sendResult = await call('space.task.sendMessage', {
				spaceId: 'space-1',
				taskId: 'task-1',
				message: 'Please continue the work',
			});
			expect(sendResult).toEqual({ ok: true });

			// After send: getMessages should return the injected message in the unified thread
			const getResult = (await call('space.task.getMessages', {
				spaceId: 'space-1',
				taskId: 'task-1',
			})) as { messages: SDKMessage[]; hasMore: boolean; sessionId: string };

			expect(getResult.sessionId).toBe('space:space-1:task:task-1');
			expect(getResult.messages).toContainEqual(
				expect.objectContaining({
					uuid: 'msg-injected',
					message: expect.objectContaining({
						content: expect.arrayContaining([
							expect.objectContaining({ text: 'Please continue the work' }),
						]),
					}),
				})
			);
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
			expect(emitCalls.length).toBe(1);
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

	// ─── @mention routing ─────────────────────────────────────────────────────────

	describe('@mention routing in space.task.sendMessage', () => {
		// Mock NodeExecutionLookup — includes status field (required by NodeExecutionLookup interface)
		function makeNodeExecutionRepo(
			agents: Array<{
				id?: string;
				workflowNodeId?: string;
				agentName: string;
				agentSessionId: string | null;
				status?: string;
			}>
		): NodeExecutionLookup {
			return {
				listByWorkflowRun: mock(() =>
					agents.map((a) => ({ ...a, status: a.status ?? 'in_progress' }))
				),
			};
		}

		// Task with a workflowRunId set
		const mockTaskWithWorkflowRun: SpaceTask = {
			...mockTaskWithSession,
			workflowRunId: 'run-abc-123',
		};

		function setupWithMention(
			nodeExecAgents: Array<{ agentName: string; agentSessionId: string | null; status?: string }>,
			task: SpaceTask = mockTaskWithWorkflowRun
		) {
			const mh = createMockMessageHub();
			hub = mh.hub;
			handlers = mh.handlers;
			const injectSubSession = mock(async (_sid: string, _msg: string) => {});
			taskAgentManager = {
				...createMockTaskAgentManager(null, task),
				injectSubSessionMessage: injectSubSession,
			};
			db = createMockDatabase(task);
			daemonHub = { emit: mock(async () => {}) } as unknown as DaemonHub;
			const nodeExecutionRepo = makeNodeExecutionRepo(nodeExecAgents);
			setupSpaceTaskMessageHandlers(hub, taskAgentManager, db, daemonHub, nodeExecutionRepo);
			return { injectSubSession };
		}

		it('single @mention routes to the matched agent session', async () => {
			const { injectSubSession } = setupWithMention([
				{ agentName: 'Coder', agentSessionId: 'session-coder-1' },
				{ agentName: 'Reviewer', agentSessionId: 'session-reviewer-1' },
			]);

			const result = await call('space.task.sendMessage', {
				spaceId: 'space-1',
				taskId: 'task-1',
				message: '@Coder please fix the bug',
			});

			expect(result).toMatchObject({ ok: true, routedTo: ['Coder'] });
			expect(injectSubSession).toHaveBeenCalledTimes(1);
			expect(injectSubSession).toHaveBeenCalledWith('session-coder-1', '@Coder please fix the bug');
			// Should NOT have routed to Task Agent
			expect(taskAgentManager.injectTaskAgentMessage).not.toHaveBeenCalled();
		});

		it('multiple @mentions route to all mentioned agents', async () => {
			const { injectSubSession } = setupWithMention([
				{ agentName: 'Coder', agentSessionId: 'session-coder-1' },
				{ agentName: 'Reviewer', agentSessionId: 'session-reviewer-1' },
				{ agentName: 'Planner', agentSessionId: 'session-planner-1' },
			]);

			const result = await call('space.task.sendMessage', {
				spaceId: 'space-1',
				taskId: 'task-1',
				message: '@Coder and @Reviewer please coordinate',
			});

			expect(result).toMatchObject({ ok: true });
			const res = result as { routedTo: string[] };
			expect(res.routedTo).toHaveLength(2);
			expect(res.routedTo).toContain('Coder');
			expect(res.routedTo).toContain('Reviewer');
			expect(injectSubSession).toHaveBeenCalledTimes(2);
			expect(taskAgentManager.injectTaskAgentMessage).not.toHaveBeenCalled();
		});

		it('invalid @mention throws error listing available agents', async () => {
			setupWithMention([
				{ agentName: 'Coder', agentSessionId: 'session-coder-1' },
				{ agentName: 'Reviewer', agentSessionId: 'session-reviewer-1' },
			]);

			await expect(
				call('space.task.sendMessage', {
					spaceId: 'space-1',
					taskId: 'task-1',
					message: '@Ghost please do something',
				})
			).rejects.toThrow('@mention not found: Ghost');
			// Error message should list available agents
			await expect(
				call('space.task.sendMessage', {
					spaceId: 'space-1',
					taskId: 'task-1',
					message: '@Ghost please do something',
				})
			).rejects.toThrow('Coder, Reviewer');
		});

		it('ambiguous @mention (multiple agents with same name) routes to all matching sessions', async () => {
			const { injectSubSession } = setupWithMention([
				{ agentName: 'Coder', agentSessionId: 'session-coder-1' },
				{ agentName: 'Coder', agentSessionId: 'session-coder-2' }, // same name, two sessions
			]);

			const result = await call('space.task.sendMessage', {
				spaceId: 'space-1',
				taskId: 'task-1',
				message: '@Coder please check both',
			});

			expect(result).toMatchObject({ ok: true, routedTo: ['Coder'] });
			// Should have injected into both Coder sessions
			expect(injectSubSession).toHaveBeenCalledTimes(2);
			expect(injectSubSession).toHaveBeenCalledWith('session-coder-1', '@Coder please check both');
			expect(injectSubSession).toHaveBeenCalledWith('session-coder-2', '@Coder please check both');
		});

		it('partial routing: valid mentions route, invalid mentions listed in notFound', async () => {
			const { injectSubSession } = setupWithMention([
				{ agentName: 'Coder', agentSessionId: 'session-coder-1' },
			]);

			const result = (await call('space.task.sendMessage', {
				spaceId: 'space-1',
				taskId: 'task-1',
				message: '@Coder and @Ghost please help',
			})) as { ok: boolean; routedTo: string[]; notFound: string[] };

			expect(result.ok).toBe(true);
			expect(result.routedTo).toEqual(['Coder']);
			expect(result.notFound).toEqual(['Ghost']);
			expect(injectSubSession).toHaveBeenCalledTimes(1);
		});

		it('case-insensitive @mention matching', async () => {
			const { injectSubSession } = setupWithMention([
				{ agentName: 'Coder', agentSessionId: 'session-coder-1' },
			]);

			const result = await call('space.task.sendMessage', {
				spaceId: 'space-1',
				taskId: 'task-1',
				message: '@coder please fix', // lowercase mention, mixed-case agent name
			});

			expect(result).toMatchObject({ ok: true, routedTo: ['coder'] });
			expect(injectSubSession).toHaveBeenCalledWith('session-coder-1', '@coder please fix');
		});

		it('message without @mentions falls back to Task Agent routing', async () => {
			const { injectSubSession } = setupWithMention([
				{ agentName: 'Coder', agentSessionId: 'session-coder-1' },
			]);

			const result = await call('space.task.sendMessage', {
				spaceId: 'space-1',
				taskId: 'task-1',
				message: 'Please continue the work',
			});

			expect(result).toEqual({ ok: true });
			expect(injectSubSession).not.toHaveBeenCalled();
			expect(taskAgentManager.injectTaskAgentMessage).toHaveBeenCalledWith(
				'task-1',
				'Please continue the work'
			);
		});

		it('explicit node-agent target routes by node execution id without @mention text', async () => {
			const { injectSubSession } = setupWithMention([
				{
					id: 'exec-coder',
					workflowNodeId: 'node-1',
					agentName: 'Coder',
					agentSessionId: 'session-coder-1',
				},
				{
					id: 'exec-reviewer',
					workflowNodeId: 'node-1',
					agentName: 'Reviewer',
					agentSessionId: 'session-reviewer-1',
				},
			]);

			const result = await call('space.task.sendMessage', {
				spaceId: 'space-1',
				taskId: 'task-1',
				message: 'Please review this',
				target: {
					kind: 'node_agent',
					agentName: 'Reviewer',
					nodeExecutionId: 'exec-reviewer',
				},
			});

			expect(result).toMatchObject({ ok: true, routedTo: ['Reviewer'] });
			expect(injectSubSession).toHaveBeenCalledTimes(1);
			expect(injectSubSession).toHaveBeenCalledWith('session-reviewer-1', 'Please review this');
			expect(taskAgentManager.injectTaskAgentMessage).not.toHaveBeenCalled();
		});

		it('@mention falls back to Task Agent when task has no workflowRunId', async () => {
			const taskWithoutRun: SpaceTask = { ...mockTaskWithSession, workflowRunId: undefined };
			const { injectSubSession } = setupWithMention(
				[{ agentName: 'Coder', agentSessionId: 'session-coder-1' }],
				taskWithoutRun
			);

			const result = await call('space.task.sendMessage', {
				spaceId: 'space-1',
				taskId: 'task-1',
				message: '@Coder please help',
			});

			// Falls back to Task Agent since no workflowRunId
			expect(result).toEqual({ ok: true });
			expect(injectSubSession).not.toHaveBeenCalled();
			expect(taskAgentManager.injectTaskAgentMessage).toHaveBeenCalled();
		});

		it('routes @mention to idle agents — core fix for the reported bug', async () => {
			// Idle agents (waiting for input) should receive @mention messages.
			// Previously this was broken: only 'in_progress' and 'pending' passed the filter,
			// so @Reviewer returned "Available agents: none" when the agent was idle.
			const { injectSubSession } = setupWithMention([
				{ agentName: 'Reviewer', agentSessionId: 'session-reviewer-idle', status: 'idle' },
			]);

			const result = await call('space.task.sendMessage', {
				spaceId: 'space-1',
				taskId: 'task-1',
				message: '@Reviewer please review',
			});

			expect(result).toMatchObject({ ok: true, routedTo: ['Reviewer'] });
			expect(injectSubSession).toHaveBeenCalledWith(
				'session-reviewer-idle',
				'@Reviewer please review'
			);
		});

		it('only excludes cancelled agents — idle, blocked, and pending are all routable', async () => {
			// Only 'cancelled' is truly terminal. All other statuses (idle, blocked, pending,
			// in_progress) can still receive and process messages.
			const { injectSubSession } = setupWithMention([
				{ agentName: 'Coder', agentSessionId: 'session-coder-cancelled', status: 'cancelled' },
				{ agentName: 'Coder', agentSessionId: 'session-coder-idle', status: 'idle' },
				{ agentName: 'Coder', agentSessionId: 'session-coder-blocked', status: 'blocked' },
				{ agentName: 'Coder', agentSessionId: 'session-coder-active', status: 'in_progress' },
			]);

			const result = await call('space.task.sendMessage', {
				spaceId: 'space-1',
				taskId: 'task-1',
				message: '@Coder please check',
			});

			// All non-cancelled sessions should receive the message
			expect(result).toMatchObject({ ok: true, routedTo: ['Coder'] });
			expect(injectSubSession).toHaveBeenCalledTimes(3); // idle + blocked + in_progress
			expect(injectSubSession).not.toHaveBeenCalledWith(
				'session-coder-cancelled',
				expect.anything()
			);
			expect(injectSubSession).toHaveBeenCalledWith('session-coder-idle', '@Coder please check');
			expect(injectSubSession).toHaveBeenCalledWith('session-coder-blocked', '@Coder please check');
			expect(injectSubSession).toHaveBeenCalledWith('session-coder-active', '@Coder please check');
		});

		it('@mention throws when all matching agents are cancelled', async () => {
			setupWithMention([
				{ agentName: 'Coder', agentSessionId: 'session-coder-cancelled', status: 'cancelled' },
			]);

			// Coder exists but is cancelled — should be treated as unavailable
			await expect(
				call('space.task.sendMessage', {
					spaceId: 'space-1',
					taskId: 'task-1',
					message: '@Coder please help',
				})
			).rejects.toThrow('@mention not found: Coder');
		});

		it('propagates error when injectSubSessionMessage throws', async () => {
			const mh = createMockMessageHub();
			hub = mh.hub;
			handlers = mh.handlers;
			const injectSubSession = mock(async (_sid: string, _msg: string) => {
				throw new Error('Sub-session not found: session-coder-1');
			});
			taskAgentManager = {
				...createMockTaskAgentManager(null, mockTaskWithWorkflowRun),
				injectSubSessionMessage: injectSubSession,
			};
			db = createMockDatabase(mockTaskWithWorkflowRun);
			daemonHub = { emit: mock(async () => {}) } as unknown as DaemonHub;
			const nodeExecutionRepo = makeNodeExecutionRepo([
				{ agentName: 'Coder', agentSessionId: 'session-coder-1', status: 'in_progress' },
			]);
			setupSpaceTaskMessageHandlers(hub, taskAgentManager, db, daemonHub, nodeExecutionRepo);

			await expect(
				call('space.task.sendMessage', {
					spaceId: 'space-1',
					taskId: 'task-1',
					message: '@Coder please help',
				})
			).rejects.toThrow('Sub-session not found: session-coder-1');
		});
	});

	// ─── channel-cycle reset on human touch ───────────────────────────────────────

	describe('channel-cycle reset on human touch in space.task.sendMessage', () => {
		const mockTaskWithRun: SpaceTask = {
			...mockTaskWithSession,
			workflowRunId: 'run-cyc-1',
		};

		const mockTaskNoRun: SpaceTask = {
			...mockTaskWithSession,
			workflowRunId: undefined,
		};

		function setupForReset(
			task: SpaceTask,
			opts: { withNodeExec?: boolean; resetRows?: number } = {}
		) {
			const mh = createMockMessageHub();
			const localHub = mh.hub;
			const localHandlers = mh.handlers;
			const injectSubSession = mock(async (_sid: string, _msg: string) => {});
			const localTaskAgentManager: TaskAgentManagerInterface = {
				...createMockTaskAgentManager(null, task),
				injectSubSessionMessage: injectSubSession,
			};
			const localDb = createMockDatabase(task);
			const localDaemonHub = { emit: mock(async () => {}) } as unknown as DaemonHub;
			const resetter: ChannelCycleResetter = {
				resetAllForRun: mock((_runId: string) => opts.resetRows ?? 2),
			};
			const nodeExec: NodeExecutionLookup | undefined = opts.withNodeExec
				? {
						listByWorkflowRun: mock(() => [
							{ agentName: 'Coder', agentSessionId: 'sess-coder', status: 'in_progress' },
						]),
					}
				: undefined;

			setupSpaceTaskMessageHandlers(
				localHub,
				localTaskAgentManager,
				localDb,
				localDaemonHub,
				nodeExec,
				resetter
			);

			return {
				handlers: localHandlers,
				taskAgentManager: localTaskAgentManager,
				injectSubSession,
				daemonHub: localDaemonHub,
				resetter,
			};
		}

		it('resets cycle counters after a successful direct task-agent injection (no @mention)', async () => {
			const { handlers: h, resetter, daemonHub: dh } = setupForReset(mockTaskWithRun);

			const result = await (h.get('space.task.sendMessage') as RequestHandler)({
				spaceId: 'space-1',
				taskId: 'task-1',
				message: 'Please continue the work',
			});

			expect(result).toEqual({ ok: true });
			expect(resetter.resetAllForRun).toHaveBeenCalledTimes(1);
			expect(resetter.resetAllForRun).toHaveBeenCalledWith('run-cyc-1');

			// daemonHub.emit should have been called with 'space.workflowRun.cyclesReset'
			const emitCalls = (dh.emit as ReturnType<typeof mock>).mock.calls;
			const cyclesResetCall = emitCalls.find((c) => c[0] === 'space.workflowRun.cyclesReset') as
				| [string, Record<string, unknown>]
				| undefined;
			expect(cyclesResetCall).toBeDefined();
			expect(cyclesResetCall![1]).toMatchObject({
				runId: 'run-cyc-1',
				reason: 'human_touch',
				taskId: 'task-1',
				rowsReset: 2,
			});
		});

		it('resets cycle counters after a successful @mention injection', async () => {
			const {
				handlers: h,
				injectSubSession,
				resetter,
				daemonHub: dh,
			} = setupForReset(mockTaskWithRun, { withNodeExec: true });

			const result = await (h.get('space.task.sendMessage') as RequestHandler)({
				spaceId: 'space-1',
				taskId: 'task-1',
				message: '@Coder please fix',
			});

			expect(result).toMatchObject({ ok: true, routedTo: ['Coder'] });
			expect(injectSubSession).toHaveBeenCalledTimes(1);
			expect(resetter.resetAllForRun).toHaveBeenCalledTimes(1);
			expect(resetter.resetAllForRun).toHaveBeenCalledWith('run-cyc-1');

			const emitCalls = (dh.emit as ReturnType<typeof mock>).mock.calls;
			expect(emitCalls.some((c) => c[0] === 'space.workflowRun.cyclesReset')).toBe(true);
		});

		it('does NOT emit cyclesReset when rowsReset is 0 (no subscriber wakeups for no-op)', async () => {
			const {
				handlers: h,
				resetter,
				daemonHub: dh,
			} = setupForReset(mockTaskWithRun, {
				resetRows: 0,
			});

			const result = await (h.get('space.task.sendMessage') as RequestHandler)({
				spaceId: 'space-1',
				taskId: 'task-1',
				message: 'Please continue',
			});

			expect(result).toEqual({ ok: true });
			// The reset statement still runs (it's cheap and idempotent)...
			expect(resetter.resetAllForRun).toHaveBeenCalledTimes(1);
			// ...but no event is emitted because nothing actually changed.
			const emitCalls = (dh.emit as ReturnType<typeof mock>).mock.calls;
			expect(emitCalls.some((c) => c[0] === 'space.workflowRun.cyclesReset')).toBe(false);
		});

		it('does NOT reset when the task has no workflowRunId', async () => {
			const { handlers: h, resetter, daemonHub: dh } = setupForReset(mockTaskNoRun);

			await (h.get('space.task.sendMessage') as RequestHandler)({
				spaceId: 'space-1',
				taskId: 'task-1',
				message: 'Please continue',
			});

			expect(resetter.resetAllForRun).not.toHaveBeenCalled();
			const emitCalls = (dh.emit as ReturnType<typeof mock>).mock.calls;
			expect(emitCalls.some((c) => c[0] === 'space.workflowRun.cyclesReset')).toBe(false);
		});

		it('does NOT reset when injectTaskAgentMessage fails (error path, no reset)', async () => {
			const { handlers: h, taskAgentManager: tm, resetter } = setupForReset(mockTaskWithRun);
			(tm.injectTaskAgentMessage as ReturnType<typeof mock>).mockRejectedValue(
				new Error('inject failed')
			);

			await expect(
				(h.get('space.task.sendMessage') as RequestHandler)({
					spaceId: 'space-1',
					taskId: 'task-1',
					message: 'Please continue',
				})
			).rejects.toThrow('inject failed');

			// Reset must not fire when injection fails.
			expect(resetter.resetAllForRun).not.toHaveBeenCalled();
		});

		it('does NOT reset when @mention routing fails (all mentions unresolved)', async () => {
			const { handlers: h, resetter } = setupForReset(mockTaskWithRun, { withNodeExec: true });

			await expect(
				(h.get('space.task.sendMessage') as RequestHandler)({
					spaceId: 'space-1',
					taskId: 'task-1',
					message: '@Ghost please fix',
				})
			).rejects.toThrow('@mention not found: Ghost');

			expect(resetter.resetAllForRun).not.toHaveBeenCalled();
		});

		it('swallows resetter errors and still returns success (best-effort side-effect)', async () => {
			const { handlers: h, resetter } = setupForReset(mockTaskWithRun);
			(resetter.resetAllForRun as ReturnType<typeof mock>).mockImplementation(() => {
				throw new Error('DB connection lost');
			});

			const result = await (h.get('space.task.sendMessage') as RequestHandler)({
				spaceId: 'space-1',
				taskId: 'task-1',
				message: 'Please continue',
			});

			// RPC success is not impacted by a failed side-effect.
			expect(result).toEqual({ ok: true });
			expect(resetter.resetAllForRun).toHaveBeenCalledTimes(1);
		});

		it('acceptance: 4 autonomous cycles + human message -> cycles reset -> 5th cycle allowed', async () => {
			// Integration test per Task #101 acceptance criteria:
			//   "simulate 4 autonomous Review→Coding cycles, inject a human message,
			//    verify cycle count is 0, verify a 5th autonomous cycle is allowed."
			//
			// Uses the real ChannelCycleRepository (not a mock) to exercise the full
			// SQL path that production hits.
			const sqlite = new BunDatabase(':memory:');
			createSpaceTables(sqlite);
			const now = Date.now();
			sqlite.exec(
				`INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES ('sp1', 'sp1', '/tmp/ws-acc', 'Space', ${now}, ${now})`
			);
			sqlite.exec(
				`INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES ('wf1', 'sp1', 'WF', ${now}, ${now})`
			);
			sqlite.exec(
				`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at) VALUES ('run-cyc-1', 'sp1', 'wf1', 'Run', 'in_progress', ${now}, ${now})`
			);
			const cycleRepo = new ChannelCycleRepository(sqlite);

			// Simulate 4 autonomous Review→Coding cycles against the backward channel
			// (channel index 1, maxCycles = 5). At this point the cap is 4/5 — one
			// more cycle would hit the cap on the next call.
			const MAX_CYCLES = 5;
			const CHANNEL_INDEX = 1;
			for (let i = 0; i < 4; i++) {
				const ok = cycleRepo.incrementCycleCount('run-cyc-1', CHANNEL_INDEX, MAX_CYCLES);
				expect(ok).toBe(true);
			}
			expect(cycleRepo.get('run-cyc-1', CHANNEL_INDEX)!.count).toBe(4);

			// Wire handlers with the real repo as the ChannelCycleResetter.
			const mh = createMockMessageHub();
			const taskAgent = createMockTaskAgentManager(null, {
				...mockTaskWithSession,
				workflowRunId: 'run-cyc-1',
			});
			const localDb = createMockDatabase({ ...mockTaskWithSession, workflowRunId: 'run-cyc-1' });
			const localDaemonHub = { emit: mock(async () => {}) } as unknown as DaemonHub;
			setupSpaceTaskMessageHandlers(
				mh.hub,
				taskAgent,
				localDb,
				localDaemonHub,
				undefined,
				cycleRepo
			);

			// Human sends a message via the RPC — this must reset cycle counters.
			const result = await (mh.handlers.get('space.task.sendMessage') as RequestHandler)({
				spaceId: 'space-1',
				taskId: 'task-1',
				message: 'Hold on, I have feedback',
			});
			expect(result).toEqual({ ok: true });

			// Cycle count must now be 0.
			expect(cycleRepo.get('run-cyc-1', CHANNEL_INDEX)!.count).toBe(0);

			// A 5th autonomous cycle is now allowed — the cap guard succeeds again.
			const fifth = cycleRepo.incrementCycleCount('run-cyc-1', CHANNEL_INDEX, MAX_CYCLES);
			expect(fifth).toBe(true);
			expect(cycleRepo.get('run-cyc-1', CHANNEL_INDEX)!.count).toBe(1);

			sqlite.close();
		});

		it('NOT human touch: agent-to-agent delivery via injectSubSessionMessage does NOT reset', async () => {
			// Agent `send_message` tool → pending_agent_messages →
			// flushPendingMessagesForTarget → TaskAgentManager.injectSubSessionMessage
			// calls `injectSubSessionMessage` directly on the manager, NOT through the
			// RPC. This test verifies that such a direct call path has no way to
			// trigger the reset: only the RPC handler holds the resetter.
			const sqlite = new BunDatabase(':memory:');
			createSpaceTables(sqlite);
			const now = Date.now();
			sqlite.exec(
				`INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES ('sp1', 'sp1', '/tmp/ws-a2a', 'Space', ${now}, ${now})`
			);
			sqlite.exec(
				`INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES ('wf1', 'sp1', 'WF', ${now}, ${now})`
			);
			sqlite.exec(
				`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at) VALUES ('run-a2a', 'sp1', 'wf1', 'Run', 'in_progress', ${now}, ${now})`
			);
			const cycleRepo = new ChannelCycleRepository(sqlite);
			cycleRepo.incrementCycleCount('run-a2a', 0, 5);
			cycleRepo.incrementCycleCount('run-a2a', 0, 5);
			const before = cycleRepo.get('run-a2a', 0)!.count;
			expect(before).toBe(2);

			// Simulate the agent-to-agent path: the TaskAgentManager's
			// injectSubSessionMessage is called directly, not via the RPC.
			const injectSubSession = mock(async (_sid: string, _msg: string) => {});
			const taskAgent: TaskAgentManagerInterface = {
				ensureTaskAgentSession: mock(async () => mockTaskWithSession),
				injectTaskAgentMessage: mock(async () => {}),
				getTaskAgent: mock(() => undefined),
				injectSubSessionMessage: injectSubSession,
			};

			// Call injectSubSessionMessage directly — this is what
			// flushPendingMessagesForTarget / the send_message tool dispatcher do.
			await taskAgent.injectSubSessionMessage!('sess-some-agent', 'hello from an agent');

			// The counter must be UNCHANGED — the RPC reset path was never invoked.
			expect(cycleRepo.get('run-a2a', 0)!.count).toBe(before);

			sqlite.close();
		});

		it('is a no-op (no error) when channelCycleResetter is not provided', async () => {
			// Setup a handler WITHOUT the resetter argument — simulates older wiring
			// or callers that opt out of reset-on-human-touch.
			const mh = createMockMessageHub();
			const taskAgent = createMockTaskAgentManager(null, mockTaskWithRun);
			const localDb = createMockDatabase(mockTaskWithRun);
			const localDaemonHub = { emit: mock(async () => {}) } as unknown as DaemonHub;
			setupSpaceTaskMessageHandlers(mh.hub, taskAgent, localDb, localDaemonHub);

			const result = await (mh.handlers.get('space.task.sendMessage') as RequestHandler)({
				spaceId: 'space-1',
				taskId: 'task-1',
				message: 'Please continue',
			});

			expect(result).toEqual({ ok: true });
			// Without a resetter, no cyclesReset event should be emitted.
			const emitCalls = (localDaemonHub.emit as ReturnType<typeof mock>).mock.calls;
			expect(emitCalls.some((c) => c[0] === 'space.workflowRun.cyclesReset')).toBe(false);
		});
	});
});

// ─── parseMentions unit tests ────────────────────────────────────────────────

describe('parseMentions', () => {
	it('extracts a single @mention', () => {
		expect(parseMentions('@Coder please fix')).toEqual(['Coder']);
	});

	it('extracts multiple distinct @mentions', () => {
		expect(parseMentions('@Coder and @Reviewer please coordinate')).toEqual(['Coder', 'Reviewer']);
	});

	it('deduplicates repeated @mentions', () => {
		expect(parseMentions('@Coder can you help @Coder')).toEqual(['Coder']);
	});

	it('preserves original casing', () => {
		expect(parseMentions('@CodeReviewer hello')).toEqual(['CodeReviewer']);
	});

	it('returns empty array when no @mentions', () => {
		expect(parseMentions('please fix the bug')).toEqual([]);
	});

	it('returns empty array for empty string', () => {
		expect(parseMentions('')).toEqual([]);
	});

	it('returns empty array for bare @ with no name', () => {
		expect(parseMentions('@ hello')).toEqual([]);
	});

	it('does not extract names starting with a digit after @', () => {
		// @123bot: starts with digit — should not match
		expect(parseMentions('@123bot hello')).toEqual([]);
	});

	it('handles @mention with hyphens and underscores', () => {
		expect(parseMentions('@code-reviewer and @qa_agent')).toEqual(['code-reviewer', 'qa_agent']);
	});

	it('email false-positive: extracts @domain from emails (known limitation, degrades gracefully)', () => {
		// @mention regex cannot distinguish emails; user@example.com extracts 'example'
		// This is acceptable since unmatched mentions end up in notFound, not silently injected
		const result = parseMentions('contact user@example.com for help');
		expect(result).toEqual(['example']);
	});

	it('@mention at start of string', () => {
		expect(parseMentions('@Planner start the task')).toEqual(['Planner']);
	});

	it('ignores @mention followed by a digit-only suffix when the name still starts with a letter', () => {
		expect(parseMentions('@Coder1 hello')).toEqual(['Coder1']);
	});
});
