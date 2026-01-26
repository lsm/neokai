/**
 * FileManager Tests
 *
 * Tests for file system operations with security.
 */

import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test';
import { FileManager } from '../../../src/lib/file-manager';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';

describe('FileManager', () => {
	let manager: FileManager;
	let existsSyncSpy: ReturnType<typeof spyOn>;
	let statSpy: ReturnType<typeof spyOn>;
	let readFileSpy: ReturnType<typeof spyOn>;
	let readdirSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		manager = new FileManager('/test/workspace');

		// Mock existsSync
		existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(true);

		// Mock stat
		statSpy = spyOn(fsPromises, 'stat').mockResolvedValue({
			isDirectory: () => false,
			isFile: () => true,
			size: 100,
			mtime: new Date('2024-01-01T00:00:00Z'),
		} as unknown as fs.Stats);

		// Mock readFile
		readFileSpy = spyOn(fsPromises, 'readFile').mockResolvedValue('file content');

		// Mock readdir
		readdirSpy = spyOn(fsPromises, 'readdir').mockResolvedValue([]);
	});

	afterEach(() => {
		existsSyncSpy.mockRestore();
		statSpy.mockRestore();
		readFileSpy.mockRestore();
		readdirSpy.mockRestore();
	});

	describe('constructor', () => {
		it('should create manager with workspace path', () => {
			expect(manager).toBeDefined();
			expect(manager.getWorkspacePath()).toBe('/test/workspace');
		});
	});

	describe('validatePath', () => {
		it('should allow valid paths within workspace', async () => {
			// Access validatePath indirectly through readFile
			existsSyncSpy.mockReturnValue(true);

			const result = await manager.readFile('subdir/file.txt');

			expect(result.path).toBe('subdir/file.txt');
		});

		it('should throw on path traversal with ..', async () => {
			await expect(manager.readFile('../outside/file.txt')).rejects.toThrow(
				'Path traversal detected'
			);
		});

		it('should throw on path traversal with nested ..', async () => {
			await expect(manager.readFile('subdir/../../outside/file.txt')).rejects.toThrow(
				'Path traversal detected'
			);
		});
	});

	describe('readFile', () => {
		it('should read file with utf-8 encoding', async () => {
			readFileSpy.mockResolvedValue('test content');

			const result = await manager.readFile('test.txt');

			expect(result).toEqual({
				path: 'test.txt',
				content: 'test content',
				encoding: 'utf-8',
				size: 100,
				mtime: '2024-01-01T00:00:00.000Z',
			});
		});

		it('should read file with base64 encoding', async () => {
			readFileSpy.mockResolvedValue(Buffer.from('binary content'));

			const result = await manager.readFile('image.png', 'base64');

			expect(result.encoding).toBe('base64');
			expect(result.content).toBe(Buffer.from('binary content').toString('base64'));
		});

		it('should throw if file not found', async () => {
			existsSyncSpy.mockReturnValue(false);

			await expect(manager.readFile('nonexistent.txt')).rejects.toThrow('File not found');
		});

		it('should throw if path is a directory', async () => {
			statSpy.mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as unknown as fs.Stats);

			await expect(manager.readFile('somedir')).rejects.toThrow('Path is a directory');
		});
	});

	describe('listDirectory', () => {
		it('should list directory contents', async () => {
			statSpy.mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
				size: 0,
				mtime: new Date('2024-01-01T00:00:00Z'),
			} as unknown as fs.Stats);

			readdirSpy.mockResolvedValue([
				{
					name: 'file1.txt',
					isDirectory: () => false,
					isFile: () => true,
				},
				{
					name: 'subdir',
					isDirectory: () => true,
					isFile: () => false,
				},
			] as unknown as fs.Dirent[]);

			const result = await manager.listDirectory('.');

			expect(result).toHaveLength(2);
			// Directories first
			expect(result[0].name).toBe('subdir');
			expect(result[0].type).toBe('directory');
			expect(result[1].name).toBe('file1.txt');
			expect(result[1].type).toBe('file');
		});

		it('should throw if directory not found', async () => {
			existsSyncSpy.mockReturnValue(false);

			await expect(manager.listDirectory('nonexistent')).rejects.toThrow('Directory not found');
		});

		it('should throw if path is not a directory', async () => {
			statSpy.mockResolvedValue({
				isDirectory: () => false,
				isFile: () => true,
			} as unknown as fs.Stats);

			await expect(manager.listDirectory('file.txt')).rejects.toThrow('Path is not a directory');
		});

		it('should list directory recursively', async () => {
			// First call - check if directory
			statSpy
				.mockResolvedValueOnce({
					isDirectory: () => true,
					isFile: () => false,
					size: 0,
					mtime: new Date('2024-01-01T00:00:00Z'),
				} as unknown as fs.Stats)
				// For file1.txt
				.mockResolvedValueOnce({
					isDirectory: () => false,
					isFile: () => true,
					size: 100,
					mtime: new Date('2024-01-01T00:00:00Z'),
				} as unknown as fs.Stats)
				// For subdir
				.mockResolvedValueOnce({
					isDirectory: () => true,
					isFile: () => false,
					size: 0,
					mtime: new Date('2024-01-01T00:00:00Z'),
				} as unknown as fs.Stats)
				// For nested file
				.mockResolvedValueOnce({
					isDirectory: () => false,
					isFile: () => true,
					size: 50,
					mtime: new Date('2024-01-01T00:00:00Z'),
				} as unknown as fs.Stats);

			readdirSpy
				.mockResolvedValueOnce([
					{ name: 'file1.txt', isDirectory: () => false, isFile: () => true },
					{ name: 'subdir', isDirectory: () => true, isFile: () => false },
				] as unknown as fs.Dirent[])
				.mockResolvedValueOnce([
					{ name: 'nested.txt', isDirectory: () => false, isFile: () => true },
				] as unknown as fs.Dirent[]);

			const result = await manager.listDirectory('.', true);

			expect(result.length).toBeGreaterThanOrEqual(2);
		});

		it('should sort results with directories first', async () => {
			statSpy.mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
				size: 0,
				mtime: new Date('2024-01-01T00:00:00Z'),
			} as unknown as fs.Stats);

			readdirSpy.mockResolvedValue([
				{ name: 'zebra.txt', isDirectory: () => false, isFile: () => true },
				{ name: 'alpha', isDirectory: () => true, isFile: () => false },
				{ name: 'beta.txt', isDirectory: () => false, isFile: () => true },
			] as unknown as fs.Dirent[]);

			const result = await manager.listDirectory('.');

			expect(result[0].name).toBe('alpha');
			expect(result[0].type).toBe('directory');
			expect(result[1].name).toBe('beta.txt');
			expect(result[2].name).toBe('zebra.txt');
		});
	});

	describe('getFileTree', () => {
		it('should get file tree for file', async () => {
			statSpy.mockResolvedValue({
				isDirectory: () => false,
				isFile: () => true,
			} as unknown as fs.Stats);

			const result = await manager.getFileTree('file.txt');

			expect(result).toEqual({
				name: 'file.txt',
				path: 'file.txt',
				type: 'file',
			});
		});

		it('should get file tree for directory', async () => {
			statSpy.mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as unknown as fs.Stats);

			readdirSpy.mockResolvedValue([
				{ name: 'file.txt', isDirectory: () => false, isFile: () => true },
			] as unknown as fs.Dirent[]);

			const result = await manager.getFileTree('subdir');

			expect(result.type).toBe('directory');
			expect(result.children).toBeDefined();
		});

		it('should throw if path not found', async () => {
			existsSyncSpy.mockReturnValue(false);

			await expect(manager.getFileTree('nonexistent')).rejects.toThrow('Path not found');
		});

		it('should stop at max depth', async () => {
			statSpy.mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as unknown as fs.Stats);

			readdirSpy.mockResolvedValue([]);

			const result = await manager.getFileTree('.', 0, 0);

			// At depth 0, should return directory without recursing
			expect(result.type).toBe('directory');
		});

		it('should skip hidden files', async () => {
			statSpy.mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as unknown as fs.Stats);

			readdirSpy.mockResolvedValue([
				{ name: '.hidden', isDirectory: () => false, isFile: () => true },
				{ name: 'visible.txt', isDirectory: () => false, isFile: () => true },
			] as unknown as fs.Dirent[]);

			const result = await manager.getFileTree('.');

			expect(result.children).toHaveLength(1);
			expect(result.children![0].name).toBe('visible.txt');
		});

		it('should skip common ignore patterns', async () => {
			statSpy.mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as unknown as fs.Stats);

			readdirSpy.mockResolvedValue([
				{ name: 'node_modules', isDirectory: () => true, isFile: () => false },
				{ name: 'dist', isDirectory: () => true, isFile: () => false },
				{ name: 'build', isDirectory: () => true, isFile: () => false },
				{ name: 'coverage', isDirectory: () => true, isFile: () => false },
				{ name: 'src', isDirectory: () => true, isFile: () => false },
			] as unknown as fs.Dirent[]);

			const result = await manager.getFileTree('.');

			expect(result.children).toHaveLength(1);
			expect(result.children![0].name).toBe('src');
		});

		it('should sort children with directories first', async () => {
			statSpy.mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as unknown as fs.Stats);

			readdirSpy.mockResolvedValue([
				{ name: 'zebra.txt', isDirectory: () => false, isFile: () => true },
				{ name: 'alpha', isDirectory: () => true, isFile: () => false },
			] as unknown as fs.Dirent[]);

			const result = await manager.getFileTree('.');

			expect(result.children![0].name).toBe('alpha');
			expect(result.children![0].type).toBe('directory');
			expect(result.children![1].name).toBe('zebra.txt');
		});

		it('should use workspace name for root', async () => {
			statSpy.mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as unknown as fs.Stats);

			readdirSpy.mockResolvedValue([]);

			const result = await manager.getFileTree('.');

			expect(result.name).toBe('workspace');
		});
	});

	describe('pathExists', () => {
		it('should return true if path exists', async () => {
			existsSyncSpy.mockReturnValue(true);

			const result = await manager.pathExists('file.txt');

			expect(result).toBe(true);
		});

		it('should return false if path does not exist', async () => {
			existsSyncSpy.mockReturnValue(false);

			const result = await manager.pathExists('nonexistent.txt');

			expect(result).toBe(false);
		});

		it('should return false on path traversal attempt', async () => {
			const result = await manager.pathExists('../outside.txt');

			expect(result).toBe(false);
		});
	});

	describe('getWorkspacePath', () => {
		it('should return workspace path', () => {
			const result = manager.getWorkspacePath();

			expect(result).toBe('/test/workspace');
		});
	});
});
