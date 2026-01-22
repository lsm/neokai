/**
 * Command RPC Handlers Tests
 */

import { describe, expect, it, beforeAll, mock } from 'bun:test';
import { setupCommandHandlers } from '../../../src/lib/rpc-handlers/command-handlers';

describe('Command RPC Handlers', () => {
	let handlers: Map<string, Function>;
	let mockMessageHub: {
		handle: ReturnType<typeof mock>;
	};
	let mockSessionManager: {
		getSessionAsync: ReturnType<typeof mock>;
	};

	beforeAll(() => {
		handlers = new Map();
		mockMessageHub = {
			handle: mock((method: string, handler: Function) => {
				handlers.set(method, handler);
			}),
		};

		mockSessionManager = {
			getSessionAsync: mock(async (sessionId: string) => {
				if (sessionId === 'valid-session') {
					return {
						getSlashCommands: mock(async () => ['clear', 'help', 'context']),
					};
				}
				return null;
			}),
		};

		setupCommandHandlers(mockMessageHub, mockSessionManager);
	});

	describe('commands.list', () => {
		it('should register handler', () => {
			expect(handlers.has('commands.list')).toBe(true);
		});

		it('should list available commands', async () => {
			const handler = handlers.get('commands.list')!;
			const result = await handler({
				sessionId: 'valid-session',
			});

			expect(result.commands).toBeDefined();
			expect(Array.isArray(result.commands)).toBe(true);
			expect(result.commands).toContain('clear');
			expect(result.commands).toContain('help');
		});

		it('should throw for invalid session', async () => {
			const handler = handlers.get('commands.list')!;
			await expect(
				handler({
					sessionId: 'invalid',
				})
			).rejects.toThrow('Session not found');
		});

		it('should call SessionManager.getSessionAsync', async () => {
			const handler = handlers.get('commands.list')!;
			await handler({
				sessionId: 'valid-session',
			});

			expect(mockSessionManager.getSessionAsync).toHaveBeenCalledWith('valid-session');
		});
	});
});
