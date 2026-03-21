/**
 * Tests for space.task.sendMessage RPC handler
 *
 * Covers:
 * - Happy path: message injected into active Task Agent session
 * - Error: missing taskId
 * - Error: empty / whitespace-only message
 * - Error: no active Task Agent session (injectTaskAgentMessage throws)
 * - No TOCTOU pre-check: handler delegates entirely to injectTaskAgentMessage
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import { setupSpaceTaskSendMessageHandler } from '../../../src/lib/rpc-handlers/space-task-message-handlers';
import type { TaskAgentManager } from '../../../src/lib/space/runtime/task-agent-manager';

type RequestHandler = (data: unknown) => Promise<unknown>;

function createMockMessageHub(): {
	hub: MessageHub;
	handlers: Map<string, RequestHandler>;
} {
	const handlers = new Map<string, RequestHandler>();
	const hub = {
		onRequest: (name: string, handler: RequestHandler) => {
			handlers.set(name, handler);
		},
	} as unknown as MessageHub;
	return { hub, handlers };
}

function createMockTaskAgentManager(overrides?: Partial<TaskAgentManager>): TaskAgentManager {
	return {
		injectTaskAgentMessage: mock(() => Promise.resolve()),
		...overrides,
	} as unknown as TaskAgentManager;
}

describe('setupSpaceTaskSendMessageHandler', () => {
	let hub: MessageHub;
	let handlers: Map<string, RequestHandler>;
	let taskAgentManager: TaskAgentManager;

	beforeEach(() => {
		({ hub, handlers } = createMockMessageHub());
		taskAgentManager = createMockTaskAgentManager();
		setupSpaceTaskSendMessageHandler(hub, taskAgentManager);
	});

	it('registers space.task.sendMessage handler', () => {
		expect(handlers.has('space.task.sendMessage')).toBe(true);
	});

	it('injects message and returns { ok: true }', async () => {
		const handler = handlers.get('space.task.sendMessage')!;
		const result = await handler({ taskId: 'task-1', message: 'hello' });

		expect(result).toEqual({ ok: true });
		expect(taskAgentManager.injectTaskAgentMessage).toHaveBeenCalledWith('task-1', 'hello');
	});

	it('does not call isTaskAgentAlive (no TOCTOU pre-check)', async () => {
		// The handler must not call isTaskAgentAlive — the single authoritative gate
		// is injectTaskAgentMessage itself, which avoids a TOCTOU race with cleanupAll().
		const isAliveMock = mock(() => true);
		taskAgentManager = createMockTaskAgentManager({
			isTaskAgentAlive: isAliveMock,
		});
		const { hub: hub2, handlers: handlers2 } = createMockMessageHub();
		setupSpaceTaskSendMessageHandler(hub2, taskAgentManager);

		await handlers2.get('space.task.sendMessage')!({ taskId: 'task-1', message: 'hi' });
		expect(isAliveMock).not.toHaveBeenCalled();
	});

	it('throws when taskId is missing', async () => {
		const handler = handlers.get('space.task.sendMessage')!;
		await expect(handler({ message: 'hello' })).rejects.toThrow('taskId is required');
	});

	it('throws when message is empty', async () => {
		const handler = handlers.get('space.task.sendMessage')!;
		await expect(handler({ taskId: 'task-1', message: '' })).rejects.toThrow('message is required');
	});

	it('throws when message is whitespace only', async () => {
		const handler = handlers.get('space.task.sendMessage')!;
		await expect(handler({ taskId: 'task-1', message: '   ' })).rejects.toThrow(
			'message is required'
		);
	});

	it('propagates error from injectTaskAgentMessage when session does not exist', async () => {
		// The authoritative error comes from injectTaskAgentMessage, not a pre-check.
		taskAgentManager = createMockTaskAgentManager({
			injectTaskAgentMessage: mock(() =>
				Promise.reject(new Error('Task Agent session not found for task task-missing'))
			),
		});
		const { hub: hub2, handlers: handlers2 } = createMockMessageHub();
		setupSpaceTaskSendMessageHandler(hub2, taskAgentManager);

		const handler = handlers2.get('space.task.sendMessage')!;
		await expect(handler({ taskId: 'task-missing', message: 'hello' })).rejects.toThrow(
			'Task Agent session not found for task task-missing'
		);
	});
});
