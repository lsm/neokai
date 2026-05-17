import { describe, test, expect } from 'bun:test';
import { setupAgentMemoryHandlers } from '../../../../src/lib/rpc-handlers/agent-memory-handlers.ts';

function createMessageHubStub() {
	const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
	return {
		messageHub: {
			onRequest(name: string, handler: (payload: unknown) => Promise<unknown>) {
				handlers.set(name, handler);
			},
		},
		handlers,
	};
}

describe('agent memory RPC handlers', () => {
	test('rejects non-finite numeric params', async () => {
		const { messageHub, handlers } = createMessageHubStub();
		setupAgentMemoryHandlers(messageHub as never, {
			memoryRepo: {
				list: () => [],
			} as never,
		});

		await expect(
			handlers.get('agentMemory.list')?.({ spaceId: 'space-a', offset: Infinity })
		).rejects.toThrow('offset must be a finite number.');
	});
});
