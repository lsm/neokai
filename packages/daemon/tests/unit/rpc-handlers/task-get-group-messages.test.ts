import { describe, expect, it, mock } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import { setupTaskHandlers } from '../../../src/lib/rpc-handlers/task-handlers';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { RoomManager } from '../../../src/lib/room/managers/room-manager';
import type { Database } from '../../../src/storage/database';

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

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

function createMockDaemonHub(): DaemonHub {
	return {
		emit: mock(async () => {}),
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;
}

function makeGroupRow(): Record<string, unknown> {
	return {
		id: 'group-1',
		group_type: 'task',
		ref_id: 'task-1',
		state: 'awaiting_leader',
		version: 1,
		metadata: JSON.stringify({
			workerRole: 'coder',
			feedbackIteration: 2,
			leaderContractViolations: 0,
			leaderCalledTool: false,
			lastProcessedLeaderTurnId: null,
			lastForwardedMessageId: null,
			activeWorkStartedAt: null,
			activeWorkElapsed: 0,
			hibernatedAt: null,
			tokensUsed: 0,
			submittedForReview: false,
			approved: false,
		}),
		created_at: 1,
		completed_at: null,
		worker_session_id: 'worker-session',
		leader_session_id: 'leader-session',
	};
}

function makeDb(opts?: {
	groupRow?: Record<string, unknown> | null;
	sdkBySession?: Record<string, Array<{ sdk_message: string; timestamp: string; send_status: string | null }>>;
	events?: Array<{ id: number; group_id: string; kind: string; payload_json: string | null; created_at: number }>;
}): Database {
	const groupRow = opts?.groupRow ?? makeGroupRow();
	const sdkBySession = opts?.sdkBySession ?? {};
	const events = opts?.events ?? [];

	const rawDb = {
		prepare: mock((sql: string) => {
			if (sql.includes('FROM session_groups')) {
				return {
					get: mock(() => groupRow),
					all: mock(() => []),
					run: mock(() => ({ lastInsertRowid: 1 })),
				};
			}

			if (sql.includes('FROM sdk_messages')) {
				return {
					get: mock(() => null),
					all: mock((sessionId: string) => sdkBySession[sessionId] ?? []),
					run: mock(() => ({ lastInsertRowid: 1 })),
				};
			}

			if (sql.includes('FROM task_group_events')) {
				return {
					get: mock(() => null),
					all: mock((_groupId: string, _afterId: number, limit: number) => {
						return events.slice(0, limit);
					}),
					run: mock(() => ({ lastInsertRowid: 1 })),
				};
			}

			return {
				get: mock(() => null),
				all: mock(() => []),
				run: mock(() => ({ lastInsertRowid: 1 })),
			};
		}),
	};

	return { getDatabase: mock(() => rawDb) } as unknown as Database;
}

const mockRoomManager = { getRoomOverview: mock(() => null) } as unknown as RoomManager;

describe('task.getGroupMessages RPC handler', () => {
	it('returns empty result when group does not exist', async () => {
		const { hub, handlers } = createMockMessageHub();
		setupTaskHandlers(
			hub,
			mockRoomManager,
			createMockDaemonHub(),
			makeDb({ groupRow: null })
		);

		const handler = handlers.get('task.getGroupMessages');
		expect(handler).toBeDefined();

		const result = (await handler!({ groupId: 'missing' }, {})) as {
			messages: unknown[];
			hasMore: boolean;
		};
		expect(result.messages).toEqual([]);
		expect(result.hasMore).toBe(false);
	});

	it('merges worker + leader sdk messages with task_group_events in chronological order', async () => {
		const workerMsg = {
			type: 'assistant',
			uuid: 'w-1',
			message: { content: [] },
		};
		const leaderMsg = {
			type: 'assistant',
			uuid: 'l-1',
			message: { content: [] },
		};

		const { hub, handlers } = createMockMessageHub();
		setupTaskHandlers(
			hub,
			mockRoomManager,
			createMockDaemonHub(),
			makeDb({
				sdkBySession: {
					'worker-session': [
						{
							sdk_message: JSON.stringify(workerMsg),
							timestamp: new Date(1000).toISOString(),
							send_status: 'failed',
						},
					],
					'leader-session': [
						{
							sdk_message: JSON.stringify(leaderMsg),
							timestamp: new Date(3000).toISOString(),
							send_status: null,
						},
					],
				},
				events: [
					{
						id: 1,
						group_id: 'group-1',
						kind: 'status',
						payload_json: JSON.stringify({ text: 'Mid status marker' }),
						created_at: 2000,
					},
				],
			})
		);

		const handler = handlers.get('task.getGroupMessages');
		expect(handler).toBeDefined();

		const result = (await handler!({ groupId: 'group-1' }, {})) as {
			messages: Array<{ content: string; messageType: string }>;
			hasMore: boolean;
		};

		expect(result.hasMore).toBe(false);
		expect(result.messages.length).toBe(3);

		const first = JSON.parse(result.messages[0].content) as Record<string, unknown>;
		const second = result.messages[1];
		const third = JSON.parse(result.messages[2].content) as Record<string, unknown>;

		expect(first.uuid).toBe('w-1');
		expect(first.sendStatus).toBeUndefined();
		expect(second.messageType).toBe('status');
		expect(second.content).toBe('Mid status marker');
		expect(third.uuid).toBe('l-1');
	});

	it('paginates with cursor without skipping messages between pages', async () => {
		const workerMsg1 = { type: 'assistant', uuid: 'w-1', message: { content: [] } };
		const workerMsg2 = { type: 'assistant', uuid: 'w-2', message: { content: [] } };
		const leaderMsg = { type: 'assistant', uuid: 'l-1', message: { content: [] } };

		const { hub, handlers } = createMockMessageHub();
		setupTaskHandlers(
			hub,
			mockRoomManager,
			createMockDaemonHub(),
			makeDb({
				sdkBySession: {
					'worker-session': [
						{
							sdk_message: JSON.stringify(workerMsg1),
							timestamp: new Date(1000).toISOString(),
							send_status: null,
						},
						{
							sdk_message: JSON.stringify(workerMsg2),
							timestamp: new Date(2000).toISOString(),
							send_status: null,
						},
					],
					'leader-session': [
						{
							sdk_message: JSON.stringify(leaderMsg),
							timestamp: new Date(3000).toISOString(),
							send_status: null,
						},
					],
				},
			})
		);

		const handler = handlers.get('task.getGroupMessages');
		expect(handler).toBeDefined();

		const page1 = (await handler!({ groupId: 'group-1', limit: 2 }, {})) as {
			messages: Array<{ content: string }>;
			hasMore: boolean;
			nextCursor?: string | null;
		};
		expect(page1.messages.length).toBe(2);
		expect(page1.hasMore).toBe(true);
		expect(page1.nextCursor).toBeDefined();

		const uuidsPage1 = page1.messages.map((m) => JSON.parse(m.content).uuid as string);
		expect(uuidsPage1).toEqual(['w-1', 'w-2']);

		const page2 = (await handler!(
			{ groupId: 'group-1', limit: 2, cursor: page1.nextCursor },
			{}
		)) as {
			messages: Array<{ content: string }>;
			hasMore: boolean;
			nextCursor?: string | null;
		};
		expect(page2.messages.length).toBe(1);
		expect(page2.hasMore).toBe(false);
		const uuidsPage2 = page2.messages.map((m) => JSON.parse(m.content).uuid as string);
		expect(uuidsPage2).toEqual(['l-1']);
	});
});
