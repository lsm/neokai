import { describe, expect, it, mock } from 'bun:test';
import type { MessageHub } from '@neokai/shared';
import { setupLegacyInboxCompatHandlers } from '../../../../src/lib/rpc-handlers/legacy-inbox-compat-handlers';
import type { Database } from '../../../../src/storage/database';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';
import type { RoomManager } from '../../../../src/lib/room/managers/room-manager';
import type { RoomRuntimeService } from '../../../../src/lib/room/runtime/room-runtime-service';

type RequestHandler = (data: unknown, context?: unknown) => Promise<unknown>;

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
	} as unknown as MessageHub;
	return { hub, handlers };
}

describe('legacy inbox compatibility handlers', () => {
	it('registers only the active Inbox review compatibility RPCs', async () => {
		const { hub, handlers } = createMockMessageHub();
		const roomManager = {
			listRooms: mock(() => []),
		} as unknown as RoomManager;

		setupLegacyInboxCompatHandlers(
			hub,
			roomManager,
			{ getDatabase: mock(() => ({})) } as unknown as Database,
			{} as ReactiveDatabase,
			{} as RoomRuntimeService
		);

		expect([...handlers.keys()].sort()).toEqual([
			'inbox.reviewTasks',
			'task.approve',
			'task.reject',
		]);
		await expect(handlers.get('inbox.reviewTasks')!({}, {})).resolves.toEqual({ tasks: [] });
		await expect(handlers.get('task.approve')!({}, {})).rejects.toThrow('Room ID is required');
		await expect(handlers.get('task.reject')!({}, {})).rejects.toThrow('Room ID is required');
	});
});
