/**
 * Rewind Handlers Tests
 *
 * Tests for rewind RPC handlers.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { setupRewindHandlers } from '../../../../src/lib/rpc-handlers/rewind-handlers';
import type { MessageHub } from '@neokai/shared';
import type { DaemonHub } from '../../../../src/lib/daemon-hub';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { RewindMode, RewindPreview, RewindResult, RewindPoint } from '@neokai/shared';

describe('Rewind Handlers', () => {
	let mockMessageHub: MessageHub;
	let mockSessionManager: SessionManager;
	let mockDaemonHub: DaemonHub;
	let handlers: Map<string, (data: unknown) => Promise<unknown>>;
	let mockAgentSession: {
		getRewindPoints: ReturnType<typeof mock>;
		previewRewind: ReturnType<typeof mock>;
		executeRewind: ReturnType<typeof mock>;
		previewSelectiveRewind: ReturnType<typeof mock>;
		executeSelectiveRewind: ReturnType<typeof mock>;
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
			getRewindPoints: mock(() => []),
			previewRewind: mock(async () => ({ canRewind: true })),
			executeRewind: mock(async () => ({ success: true })),
			previewSelectiveRewind: mock(async () => ({
				canRewind: true,
				messagesToDelete: 0,
				filesToRevert: [],
			})),
			executeSelectiveRewind: mock(async () => ({
				success: true,
				messagesDeleted: 0,
				filesReverted: [],
			})),
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
			expect(handlers.has('rewind.previewSelective')).toBe(true);
			expect(handlers.has('rewind.executeSelective')).toBe(true);
		});
	});

	describe('rewind.checkpoints', () => {
		it('should return rewind points for a session', async () => {
			const mockRewindPoints: RewindPoint[] = [
				{
					uuid: 'msg-1',
					timestamp: Date.now() - 60000,
					content: 'User message 1',
					turnNumber: 1,
				},
				{
					uuid: 'msg-2',
					timestamp: Date.now(),
					content: 'User message 2',
					turnNumber: 2,
				},
			];
			mockAgentSession.getRewindPoints.mockReturnValue(mockRewindPoints);

			const result = (await callHandler('rewind.checkpoints', {
				sessionId: 'test-session-id',
			})) as { rewindPoints: RewindPoint[] };

			expect(result.rewindPoints).toEqual(mockRewindPoints);
			expect(mockAgentSession.getRewindPoints).toHaveBeenCalled();
		});

		it('should return empty rewindPoints with error if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			const result = (await callHandler('rewind.checkpoints', {
				sessionId: 'nonexistent',
			})) as { rewindPoints: RewindPoint[]; error?: string };

			expect(result.rewindPoints).toEqual([]);
			expect(result.error).toBe('Session not found');
		});
	});

	describe('rewind.preview', () => {
		it('should return preview for a checkpoint', async () => {
			const mockPreview: RewindPreview = {
				canRewind: true,
				messagesAffected: 5,
				filesChanged: ['/path/to/file1.ts', '/path/to/file2.ts'],
				insertions: 10,
				deletions: 5,
			};
			mockAgentSession.previewRewind.mockResolvedValue(mockPreview);

			const result = (await callHandler('rewind.preview', {
				sessionId: 'test-session-id',
				checkpointId: 'msg-1',
			})) as { preview: RewindPreview };

			expect(result.preview).toEqual(mockPreview);
			expect(mockAgentSession.previewRewind).toHaveBeenCalledWith('msg-1');
		});

		it('should return error preview if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			const result = (await callHandler('rewind.preview', {
				sessionId: 'nonexistent',
				checkpointId: 'msg-1',
			})) as { preview: RewindPreview };

			expect(result.preview.canRewind).toBe(false);
			expect(result.preview.error).toBe('Session not found');
		});

		it('should return preview with canRewind false if checkpoint not found', async () => {
			mockAgentSession.previewRewind.mockResolvedValue({
				canRewind: false,
				error: 'Rewind point not found',
			});

			const result = (await callHandler('rewind.preview', {
				sessionId: 'test-session-id',
				checkpointId: 'invalid-msg',
			})) as { preview: RewindPreview };

			expect(result.preview.canRewind).toBe(false);
			expect(result.preview.error).toBe('Rewind point not found');
		});
	});

	describe('rewind.execute', () => {
		it('should execute rewind with default mode (files)', async () => {
			const mockResult: RewindResult = {
				success: true,
				filesChanged: ['/path/to/file.ts'],
			};
			mockAgentSession.executeRewind.mockResolvedValue(mockResult);

			const result = (await callHandler('rewind.execute', {
				sessionId: 'test-session-id',
				checkpointId: 'msg-1',
			})) as { result: RewindResult };

			expect(result.result).toEqual(mockResult);
			expect(mockAgentSession.executeRewind).toHaveBeenCalledWith('msg-1', 'files');
		});

		it('should execute rewind with conversation mode', async () => {
			const mockResult: RewindResult = {
				success: true,
				messagesDeleted: 10,
			};
			mockAgentSession.executeRewind.mockResolvedValue(mockResult);

			const result = (await callHandler('rewind.execute', {
				sessionId: 'test-session-id',
				checkpointId: 'msg-1',
				mode: 'conversation' as RewindMode,
			})) as { result: RewindResult };

			expect(result.result).toEqual(mockResult);
			expect(mockAgentSession.executeRewind).toHaveBeenCalledWith('msg-1', 'conversation');
		});

		it('should execute rewind with both mode', async () => {
			const mockResult: RewindResult = {
				success: true,
				filesChanged: ['/path/to/file.ts'],
				messagesDeleted: 5,
			};
			mockAgentSession.executeRewind.mockResolvedValue(mockResult);

			const result = (await callHandler('rewind.execute', {
				sessionId: 'test-session-id',
				checkpointId: 'msg-1',
				mode: 'both' as RewindMode,
			})) as { result: RewindResult };

			expect(result.result).toEqual(mockResult);
			expect(mockAgentSession.executeRewind).toHaveBeenCalledWith('msg-1', 'both');
		});

		it('should return error result if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			const result = (await callHandler('rewind.execute', {
				sessionId: 'nonexistent',
				checkpointId: 'msg-1',
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
				checkpointId: 'msg-1',
			})) as { result: RewindResult };

			expect(result.result.success).toBe(false);
			expect(result.result.error).toBe('Failed to restore files');
		});
	});

	describe('rewind.previewSelective', () => {
		it('should return preview for selective rewind', async () => {
			const mockPreview = {
				canRewind: true,
				messagesToDelete: 3,
				filesToRevert: [{ path: '/path/to/file.ts', hasCheckpoint: true, hasEditDiff: false }],
			};
			mockAgentSession.previewSelectiveRewind.mockResolvedValue(mockPreview);

			const result = (await callHandler('rewind.previewSelective', {
				sessionId: 'test-session-id',
				messageIds: ['msg-1', 'msg-2'],
			})) as { preview: typeof mockPreview };

			expect(result.preview).toEqual(mockPreview);
			expect(mockAgentSession.previewSelectiveRewind).toHaveBeenCalledWith(['msg-1', 'msg-2']);
		});

		it('should return error if no messages selected', async () => {
			const result = (await callHandler('rewind.previewSelective', {
				sessionId: 'test-session-id',
				messageIds: [],
			})) as { preview: typeof mockPreview };

			expect(result.preview.canRewind).toBe(false);
			expect(result.preview.error).toBe('No messages selected');
		});

		it('should return error if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			const result = (await callHandler('rewind.previewSelective', {
				sessionId: 'nonexistent',
				messageIds: ['msg-1'],
			})) as { preview: typeof mockPreview };

			expect(result.preview.canRewind).toBe(false);
			expect(result.preview.error).toBe('Session not found');
		});
	});

	describe('rewind.executeSelective', () => {
		it('should execute selective rewind', async () => {
			const mockResult = {
				success: true,
				messagesDeleted: 3,
				filesReverted: ['/path/to/file.ts'],
			};
			mockAgentSession.executeSelectiveRewind.mockResolvedValue(mockResult);

			const result = (await callHandler('rewind.executeSelective', {
				sessionId: 'test-session-id',
				messageIds: ['msg-1', 'msg-2'],
			})) as { result: typeof mockResult };

			expect(result.result).toEqual(mockResult);
			expect(mockAgentSession.executeSelectiveRewind).toHaveBeenCalledWith(['msg-1', 'msg-2']);
		});

		it('should return error if no messages selected', async () => {
			const result = (await callHandler('rewind.executeSelective', {
				sessionId: 'test-session-id',
				messageIds: [],
			})) as { result: typeof mockResult };

			expect(result.result.success).toBe(false);
			expect(result.result.error).toBe('No messages selected');
		});

		it('should return error if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			const result = (await callHandler('rewind.executeSelective', {
				sessionId: 'nonexistent',
				messageIds: ['msg-1'],
			})) as { result: typeof mockResult };

			expect(result.result.success).toBe(false);
			expect(result.result.error).toBe('Session not found');
		});
	});
});
