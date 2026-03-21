/**
 * Tests for space.task.sendMessage RPC handler
 *
 * Covers:
 * - Happy path: message injected when Task Agent is alive
 * - Error: missing taskId
 * - Error: empty message
 * - Error: no active Task Agent session
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
		isTaskAgentAlive: mock(() => true),
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

	it('injects message when Task Agent is alive', async () => {
		const handler = handlers.get('space.task.sendMessage')!;
		const result = await handler({ taskId: 'task-1', message: 'hello' });

		expect(result).toEqual({ ok: true });
		expect(taskAgentManager.injectTaskAgentMessage).toHaveBeenCalledWith('task-1', 'hello');
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

	it('throws when no active Task Agent session exists', async () => {
		taskAgentManager = createMockTaskAgentManager({
			isTaskAgentAlive: mock(() => false),
		});
		const { hub: hub2, handlers: handlers2 } = createMockMessageHub();
		setupSpaceTaskSendMessageHandler(hub2, taskAgentManager);

		const handler = handlers2.get('space.task.sendMessage')!;
		await expect(handler({ taskId: 'task-missing', message: 'hello' })).rejects.toThrow(
			'No active Task Agent session for task: task-missing'
		);
	});
});
