/**
 * Command Handlers Tests
 *
 * Tests for command RPC handlers.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { setupCommandHandlers } from '../../../../src/lib/rpc-handlers/command-handlers';
import type { MessageHub } from '@liuboer/shared';
import type { SessionManager } from '../../../../src/lib/session-manager';

describe('Command Handlers', () => {
	let mockMessageHub: MessageHub;
	let mockSessionManager: SessionManager;
	let handlers: Map<string, (data: unknown) => Promise<unknown>>;
	let mockAgentSession: {
		getSlashCommands: ReturnType<typeof mock>;
	};

	beforeEach(() => {
		handlers = new Map();

		// Mock MessageHub
		mockMessageHub = {
			handle: mock((name: string, handler: (data: unknown) => Promise<unknown>) => {
				handlers.set(name, handler);
			}),
		} as unknown as MessageHub;

		// Mock AgentSession
		mockAgentSession = {
			getSlashCommands: mock(async () => [
				{ name: '/help', description: 'Show help' },
				{ name: '/clear', description: 'Clear screen' },
			]),
		};

		// Mock SessionManager
		mockSessionManager = {
			getSessionAsync: mock(async () => mockAgentSession),
		} as unknown as SessionManager;

		// Setup handlers
		setupCommandHandlers(mockMessageHub, mockSessionManager);
	});

	async function callHandler(name: string, data: unknown): Promise<unknown> {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`Handler ${name} not found`);
		return handler(data);
	}

	describe('setup', () => {
		it('should register commands.list handler', () => {
			expect(handlers.has('commands.list')).toBe(true);
		});
	});

	describe('commands.list', () => {
		it('should return list of slash commands', async () => {
			const result = await callHandler('commands.list', {
				sessionId: 'test-session-id',
			});

			expect(result).toEqual({
				commands: [
					{ name: '/help', description: 'Show help' },
					{ name: '/clear', description: 'Clear screen' },
				],
			});
			expect(mockSessionManager.getSessionAsync).toHaveBeenCalledWith('test-session-id');
			expect(mockAgentSession.getSlashCommands).toHaveBeenCalled();
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(callHandler('commands.list', { sessionId: 'nonexistent' })).rejects.toThrow(
				'Session not found'
			);
		});

		it('should return empty array if no commands available', async () => {
			mockAgentSession.getSlashCommands.mockResolvedValue([]);

			const result = await callHandler('commands.list', {
				sessionId: 'test-session-id',
			});

			expect(result).toEqual({ commands: [] });
		});
	});
});
