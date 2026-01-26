/**
 * File Handlers Tests
 *
 * Tests for file RPC handlers.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { setupFileHandlers } from '../../../../src/lib/rpc-handlers/file-handlers';
import type { MessageHub, Session } from '@liuboer/shared';
import type { SessionManager } from '../../../../src/lib/session-manager';

// Mock the FileManager module
mock.module('../../../../src/lib/file-manager', () => ({
	FileManager: class MockFileManager {
		workspacePath: string;

		constructor(workspacePath: string) {
			this.workspacePath = workspacePath;
		}

		async readFile(path: string, encoding?: string) {
			return {
				content: `Content of ${path}`,
				encoding: encoding || 'utf-8',
				size: 100,
				mimeType: 'text/plain',
			};
		}

		async listDirectory(_path: string, _recursive?: boolean) {
			return [
				{ name: 'file1.txt', type: 'file', size: 100 },
				{ name: 'dir1', type: 'directory', size: 0 },
			];
		}

		async getFileTree(filePath: string, _maxDepth?: number) {
			return {
				name: filePath,
				type: 'directory',
				children: [
					{ name: 'file1.txt', type: 'file' },
					{
						name: 'subdir',
						type: 'directory',
						children: [{ name: 'file2.txt', type: 'file' }],
					},
				],
			};
		}
	},
}));

describe('File Handlers', () => {
	let mockMessageHub: MessageHub;
	let mockSessionManager: SessionManager;
	let handlers: Map<string, (data: unknown) => Promise<unknown>>;
	let mockSession: Session;
	let mockAgentSession: {
		getSessionData: ReturnType<typeof mock>;
	};

	beforeEach(() => {
		handlers = new Map();

		// Mock MessageHub
		mockMessageHub = {
			handle: mock((name: string, handler: (data: unknown) => Promise<unknown>) => {
				handlers.set(name, handler);
			}),
		} as unknown as MessageHub;

		// Mock session data
		mockSession = {
			id: 'test-session-id',
			title: 'Test Session',
			workspacePath: '/test/workspace',
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'active',
			config: {
				model: 'claude-sonnet-4-20250514',
				maxTokens: 8192,
				temperature: 1.0,
			},
			metadata: {
				messageCount: 0,
				totalTokens: 0,
				inputTokens: 0,
				outputTokens: 0,
				totalCost: 0,
				toolCallCount: 0,
			},
		};

		// Mock AgentSession
		mockAgentSession = {
			getSessionData: mock(() => mockSession),
		};

		// Mock SessionManager
		mockSessionManager = {
			getSessionAsync: mock(async () => mockAgentSession),
		} as unknown as SessionManager;

		// Setup handlers
		setupFileHandlers(mockMessageHub, mockSessionManager);
	});

	async function callHandler(name: string, data: unknown): Promise<unknown> {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`Handler ${name} not found`);
		return handler(data);
	}

	describe('setup', () => {
		it('should register all file handlers', () => {
			expect(handlers.has('file.read')).toBe(true);
			expect(handlers.has('file.list')).toBe(true);
			expect(handlers.has('file.tree')).toBe(true);
		});
	});

	describe('file.read', () => {
		it('should read file content', async () => {
			const result = await callHandler('file.read', {
				sessionId: 'test-session-id',
				path: 'test.txt',
			});

			expect(result).toEqual({
				content: 'Content of test.txt',
				encoding: 'utf-8',
				size: 100,
				mimeType: 'text/plain',
			});
			expect(mockSessionManager.getSessionAsync).toHaveBeenCalledWith('test-session-id');
			expect(mockAgentSession.getSessionData).toHaveBeenCalled();
		});

		it('should read file with custom encoding', async () => {
			const result = await callHandler('file.read', {
				sessionId: 'test-session-id',
				path: 'binary.bin',
				encoding: 'base64',
			});

			expect(result).toEqual({
				content: 'Content of binary.bin',
				encoding: 'base64',
				size: 100,
				mimeType: 'text/plain',
			});
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(
				callHandler('file.read', {
					sessionId: 'nonexistent',
					path: 'test.txt',
				})
			).rejects.toThrow('Session not found');
		});
	});

	describe('file.list', () => {
		it('should list directory contents', async () => {
			const result = await callHandler('file.list', {
				sessionId: 'test-session-id',
				path: 'src',
			});

			expect(result).toEqual({
				files: [
					{ name: 'file1.txt', type: 'file', size: 100 },
					{ name: 'dir1', type: 'directory', size: 0 },
				],
			});
			expect(mockSessionManager.getSessionAsync).toHaveBeenCalledWith('test-session-id');
		});

		it('should list with recursive option', async () => {
			const result = await callHandler('file.list', {
				sessionId: 'test-session-id',
				path: 'src',
				recursive: true,
			});

			expect(result).toHaveProperty('files');
		});

		it('should use current directory as default path', async () => {
			const result = await callHandler('file.list', {
				sessionId: 'test-session-id',
			});

			expect(result).toHaveProperty('files');
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(
				callHandler('file.list', {
					sessionId: 'nonexistent',
					path: 'src',
				})
			).rejects.toThrow('Session not found');
		});
	});

	describe('file.tree', () => {
		it('should return file tree', async () => {
			const result = (await callHandler('file.tree', {
				sessionId: 'test-session-id',
				path: 'src',
			})) as { tree: Record<string, unknown> };

			expect(result.tree).toHaveProperty('name', 'src');
			expect(result.tree).toHaveProperty('type', 'directory');
			expect(result.tree).toHaveProperty('children');
			expect(mockSessionManager.getSessionAsync).toHaveBeenCalledWith('test-session-id');
		});

		it('should use custom max depth', async () => {
			const result = await callHandler('file.tree', {
				sessionId: 'test-session-id',
				path: 'src',
				maxDepth: 5,
			});

			expect(result).toHaveProperty('tree');
		});

		it('should use default path and depth', async () => {
			const result = await callHandler('file.tree', {
				sessionId: 'test-session-id',
			});

			expect(result).toHaveProperty('tree');
		});

		it('should throw if session not found', async () => {
			(mockSessionManager.getSessionAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(
				callHandler('file.tree', {
					sessionId: 'nonexistent',
					path: 'src',
				})
			).rejects.toThrow('Session not found');
		});
	});
});
