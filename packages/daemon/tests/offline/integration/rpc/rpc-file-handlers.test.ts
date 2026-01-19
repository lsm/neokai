/**
 * File RPC Handlers Tests
 */

import { describe, expect, it, beforeAll, afterAll, mock } from 'bun:test';
import { setupFileHandlers } from '../../../../src/lib/rpc-handlers/file-handlers';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('File RPC Handlers', () => {
	let testWorkspace: string;
	let handlers: Map<string, Function>;
	let mockSessionManager: {
		getSessionAsync: ReturnType<typeof mock>;
	};
	let mockMessageHub: {
		handle: ReturnType<typeof mock>;
	};

	beforeAll(async () => {
		// Create test workspace
		testWorkspace = join(tmpdir(), `file-rpc-test-${Date.now()}`);
		await mkdir(testWorkspace, { recursive: true });
		await mkdir(join(testWorkspace, 'subdir'), { recursive: true });
		await writeFile(join(testWorkspace, 'test.txt'), 'Hello File');
		await writeFile(join(testWorkspace, 'subdir/nested.txt'), 'Nested');

		// Setup mocks
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
						getSessionData: () => ({
							workspacePath: testWorkspace,
						}),
					};
				}
				return null;
			}),
		};

		setupFileHandlers(mockMessageHub, mockSessionManager);
	});

	afterAll(async () => {
		await rm(testWorkspace, { recursive: true, force: true });
	});

	describe('file.read', () => {
		it('should register handler', () => {
			expect(handlers.has('file.read')).toBe(true);
		});

		it('should read file with utf-8 encoding', async () => {
			const handler = handlers.get('file.read')!;
			const result = await handler({
				sessionId: 'valid-session',
				path: 'test.txt',
				encoding: 'utf-8',
			});

			expect(result.content).toBe('Hello File');
			expect(result.encoding).toBe('utf-8');
		});

		it('should read file with base64 encoding', async () => {
			const handler = handlers.get('file.read')!;
			const result = await handler({
				sessionId: 'valid-session',
				path: 'test.txt',
				encoding: 'base64',
			});

			expect(result.encoding).toBe('base64');
		});

		it('should throw for invalid session', async () => {
			const handler = handlers.get('file.read')!;
			await expect(
				handler({
					sessionId: 'invalid',
					path: 'test.txt',
				})
			).rejects.toThrow('Session not found');
		});
	});

	describe('file.list', () => {
		it('should register handler', () => {
			expect(handlers.has('file.list')).toBe(true);
		});

		it('should list files', async () => {
			const handler = handlers.get('file.list')!;
			const result = await handler({
				sessionId: 'valid-session',
				path: '.',
			});

			expect(result.files).toBeDefined();
			expect(Array.isArray(result.files)).toBe(true);
		});

		it('should list recursively', async () => {
			const handler = handlers.get('file.list')!;
			const result = await handler({
				sessionId: 'valid-session',
				path: '.',
				recursive: true,
			});

			expect(result.files).toBeDefined();
		});

		it('should throw for invalid session', async () => {
			const handler = handlers.get('file.list')!;
			await expect(
				handler({
					sessionId: 'invalid',
					path: '.',
				})
			).rejects.toThrow('Session not found');
		});
	});

	describe('file.tree', () => {
		it('should register handler', () => {
			expect(handlers.has('file.tree')).toBe(true);
		});

		it('should get file tree', async () => {
			const handler = handlers.get('file.tree')!;
			const result = await handler({
				sessionId: 'valid-session',
				path: '.',
			});

			expect(result.tree).toBeDefined();
			expect(result.tree.type).toBe('directory');
		});

		it('should use maxDepth', async () => {
			const handler = handlers.get('file.tree')!;
			const result = await handler({
				sessionId: 'valid-session',
				path: '.',
				maxDepth: 2,
			});

			expect(result.tree).toBeDefined();
		});

		it('should throw for invalid session', async () => {
			const handler = handlers.get('file.tree')!;
			await expect(
				handler({
					sessionId: 'invalid',
				})
			).rejects.toThrow('Session not found');
		});
	});
});
