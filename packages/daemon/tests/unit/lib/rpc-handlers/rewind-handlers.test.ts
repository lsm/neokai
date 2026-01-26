/**
 * Rewind Handlers Tests
 *
 * Tests for rewind RPC handlers.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { setupRewindHandlers } from '../../../../src/lib/rpc-handlers/rewind-handlers';
import type { MessageHub } from '@liuboer/shared';
import type { DaemonHub } from '../../../../src/lib/daemon-hub';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { RewindMode, Checkpoint, RewindPreview, RewindResult } from '@liuboer/shared';

describe('Rewind Handlers', () => {
	let mockMessageHub: MessageHub;
	let mockSessionManager: SessionManager;
	let mockDaemonHub: DaemonHub;
	let handlers: Map<string, (data: unknown) => Promise<unknown>>;
	let mockAgentSession: {
		getCheckpoints: ReturnType<typeof mock>;
		previewRewind: ReturnType<typeof mock>;
		executeRewind: ReturnType<typeof mock>;
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
			getCheckpoints: mock(() => []),
			previewRewind: mock(async () => ({ canRewind: true })),
			executeRewind: mock(async () => ({ success: true })),
		};

		// Mock SessionManager
		mockSessionManager = {
			getSessionAsync: mock(async () => mockAgentSession),
		} as unknown as SessionManager;

		// Mock DaemonHub
		mockDaemonHub = {
			emit: mock(async () => {}),
		} as unknown as DaemonHub;

		// Setup handlers
		setupRewindHandlers(mockMessageHub, mockSessionManager, mockDaemonHub);
	});

	async function callHandler(name: string, data: unknown): Promise<unknown> {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`Handler ${name} not found`);
		return handler(data);
	}

	describe('setup', () => {
		it('should register all rewind handlers', () => {
			expect(handlers.has('rewind.checkpoints')).toBe(true);
			expect(handlers.has('rewind.preview')).toBe(true);
			expect(handlers.has('rewind.execute')).toBe(true);
		});
	});

	describe('rewind.checkpoints', () => {
		it('should return checkpoints for a session', async () => {
			const mockCheckpoints: Checkpoint[] = [
				{
					id: 'cp-1',
					timestamp: Date.now() - 60000,
					messageUuid: 'msg-1',
					label: 'User message 1',
				},
				{
					id: 'cp-2',
					timestamp: Date.now(),
					messageUuid: 'msg-2',
					label: 'User message 2',
				},
			];
			mockAgentSession.getCheckpoints.mockReturnValue(mockCheckpoints);

			const result = (await callHandler('rewind.checkpoints', {
				sessionId: 'test-session-id',
			})) as { checkpoints: Checkpoint[] };

			expect(result.checkpoints).toEqual(mockCheckpoints);
			expect(mockAgentSession.getCheckpoints).toHaveBeenCalled();
		});

		it('should return empty checkpoints with error if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			const result = (await callHandler('rewind.checkpoints', {
				sessionId: 'nonexistent',
			})) as { checkpoints: Checkpoint[]; error?: string };

			expect(result.checkpoints).toEqual([]);
			expect(result.error).toBe('Session not found');
		});
	});

	describe('rewind.preview', () => {
		it('should return preview for a checkpoint', async () => {
			const mockPreview: RewindPreview = {
				canRewind: true,
				messagesAfterCheckpoint: 5,
				filesToRestore: ['/path/to/file1.ts', '/path/to/file2.ts'],
			};
			mockAgentSession.previewRewind.mockResolvedValue(mockPreview);

			const result = (await callHandler('rewind.preview', {
				sessionId: 'test-session-id',
				checkpointId: 'cp-1',
			})) as { preview: RewindPreview };

			expect(result.preview).toEqual(mockPreview);
			expect(mockAgentSession.previewRewind).toHaveBeenCalledWith('cp-1');
		});

		it('should return error preview if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			const result = (await callHandler('rewind.preview', {
				sessionId: 'nonexistent',
				checkpointId: 'cp-1',
			})) as { preview: RewindPreview };

			expect(result.preview.canRewind).toBe(false);
			expect(result.preview.error).toBe('Session not found');
		});

		it('should return preview with canRewind false if checkpoint not found', async () => {
			mockAgentSession.previewRewind.mockResolvedValue({
				canRewind: false,
				error: 'Checkpoint not found',
			});

			const result = (await callHandler('rewind.preview', {
				sessionId: 'test-session-id',
				checkpointId: 'invalid-cp',
			})) as { preview: RewindPreview };

			expect(result.preview.canRewind).toBe(false);
			expect(result.preview.error).toBe('Checkpoint not found');
		});
	});

	describe('rewind.execute', () => {
		it('should execute rewind with default mode (files)', async () => {
			const mockResult: RewindResult = {
				success: true,
				restoredFiles: ['/path/to/file.ts'],
			};
			mockAgentSession.executeRewind.mockResolvedValue(mockResult);

			const result = (await callHandler('rewind.execute', {
				sessionId: 'test-session-id',
				checkpointId: 'cp-1',
			})) as { result: RewindResult };

			expect(result.result).toEqual(mockResult);
			expect(mockAgentSession.executeRewind).toHaveBeenCalledWith('cp-1', 'files');
		});

		it('should execute rewind with conversation mode', async () => {
			const mockResult: RewindResult = {
				success: true,
				deletedMessageCount: 10,
			};
			mockAgentSession.executeRewind.mockResolvedValue(mockResult);

			const result = (await callHandler('rewind.execute', {
				sessionId: 'test-session-id',
				checkpointId: 'cp-1',
				mode: 'conversation' as RewindMode,
			})) as { result: RewindResult };

			expect(result.result).toEqual(mockResult);
			expect(mockAgentSession.executeRewind).toHaveBeenCalledWith('cp-1', 'conversation');
		});

		it('should execute rewind with both mode', async () => {
			const mockResult: RewindResult = {
				success: true,
				restoredFiles: ['/path/to/file.ts'],
				deletedMessageCount: 5,
			};
			mockAgentSession.executeRewind.mockResolvedValue(mockResult);

			const result = (await callHandler('rewind.execute', {
				sessionId: 'test-session-id',
				checkpointId: 'cp-1',
				mode: 'both' as RewindMode,
			})) as { result: RewindResult };

			expect(result.result).toEqual(mockResult);
			expect(mockAgentSession.executeRewind).toHaveBeenCalledWith('cp-1', 'both');
		});

		it('should return error result if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			const result = (await callHandler('rewind.execute', {
				sessionId: 'nonexistent',
				checkpointId: 'cp-1',
			})) as { result: RewindResult };

			expect(result.result.success).toBe(false);
			expect(result.result.error).toBe('Session not found');
		});

		it('should return error result if rewind fails', async () => {
			mockAgentSession.executeRewind.mockResolvedValue({
				success: false,
				error: 'Failed to restore files',
			});

			const result = (await callHandler('rewind.execute', {
				sessionId: 'test-session-id',
				checkpointId: 'cp-1',
			})) as { result: RewindResult };

			expect(result.result.success).toBe(false);
			expect(result.result.error).toBe('Failed to restore files');
		});
	});
});
