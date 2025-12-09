/**
 * FileManager Tests
 *
 * Tests file system operations with security validation.
 */

import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { FileManager } from '../../src/lib/file-manager';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('FileManager', () => {
	let testWorkspace: string;
	let fileManager: FileManager;

	beforeAll(async () => {
		// Create temporary workspace for testing
		testWorkspace = join(tmpdir(), `file-manager-test-${Date.now()}`);
		await mkdir(testWorkspace, { recursive: true });

		// Create test directory structure
		await mkdir(join(testWorkspace, 'subdir'), { recursive: true });
		await mkdir(join(testWorkspace, 'emptydir'), { recursive: true });
		await writeFile(join(testWorkspace, 'file1.txt'), 'Hello World');
		await writeFile(join(testWorkspace, 'file2.md'), '# Markdown');
		await writeFile(join(testWorkspace, 'subdir', 'nested.txt'), 'Nested content');

		fileManager = new FileManager(testWorkspace);
	});

	afterAll(async () => {
		// Cleanup test workspace
		await rm(testWorkspace, { recursive: true, force: true });
	});

	describe('constructor', () => {
		it('should create FileManager with workspace path', () => {
			const fm = new FileManager('/test/workspace');
			expect(fm.getWorkspacePath()).toBe('/test/workspace');
		});
	});

	describe('getWorkspacePath', () => {
		it('should return workspace path', () => {
			expect(fileManager.getWorkspacePath()).toBe(testWorkspace);
		});
	});

	describe('path traversal protection', () => {
		it('should reject path traversal attempts with ..', async () => {
			await expect(fileManager.readFile('../../../etc/passwd')).rejects.toThrow(
				'Path traversal detected'
			);
		});

		it('should reject absolute paths outside workspace', async () => {
			// Absolute paths outside workspace should be rejected or not found
			await expect(fileManager.readFile('/etc/passwd')).rejects.toThrow();
		});

		it('should allow valid paths within workspace', async () => {
			// Should not throw
			await expect(fileManager.pathExists('file1.txt')).resolves.toBe(true);
		});

		it('should allow subdirectory access', async () => {
			await expect(fileManager.pathExists('subdir/nested.txt')).resolves.toBe(true);
		});
	});

	describe('readFile', () => {
		it('should read file with utf-8 encoding by default', async () => {
			const result = await fileManager.readFile('file1.txt');

			expect(result.content).toBe('Hello World');
			expect(result.encoding).toBe('utf-8');
			expect(result.path).toBe('file1.txt');
			expect(result.size).toBeGreaterThan(0);
			expect(result.mtime).toBeDefined();
		});

		it('should read file with base64 encoding', async () => {
			const result = await fileManager.readFile('file1.txt', 'base64');

			expect(result.encoding).toBe('base64');
			expect(result.content).toBe(Buffer.from('Hello World').toString('base64'));
		});

		it('should read file from subdirectory', async () => {
			const result = await fileManager.readFile('subdir/nested.txt');

			expect(result.content).toBe('Nested content');
		});

		it('should throw error for non-existent file', async () => {
			await expect(fileManager.readFile('nonexistent.txt')).rejects.toThrow('File not found');
		});

		it('should throw error when trying to read directory', async () => {
			await expect(fileManager.readFile('subdir')).rejects.toThrow('Path is a directory');
		});

		it('should include file metadata', async () => {
			const result = await fileManager.readFile('file1.txt');

			expect(result.size).toBe('Hello World'.length);
			expect(new Date(result.mtime)).toBeInstanceOf(Date);
		});
	});

	describe('listDirectory', () => {
		it('should list directory contents', async () => {
			const files = await fileManager.listDirectory('.');

			expect(files.length).toBeGreaterThan(0);
			expect(files.some((f) => f.name === 'file1.txt')).toBe(true);
			expect(files.some((f) => f.name === 'subdir')).toBe(true);
		});

		it('should sort directories before files', async () => {
			const files = await fileManager.listDirectory('.');

			// Find first directory and first file
			const firstDir = files.find((f) => f.type === 'directory');
			const firstFile = files.find((f) => f.type === 'file');

			if (firstDir && firstFile) {
				const dirIndex = files.indexOf(firstDir);
				const fileIndex = files.indexOf(firstFile);
				expect(dirIndex).toBeLessThan(fileIndex);
			}
		});

		it('should list subdirectory contents', async () => {
			const files = await fileManager.listDirectory('subdir');

			expect(files.length).toBe(1);
			expect(files[0].name).toBe('nested.txt');
			expect(files[0].type).toBe('file');
		});

		it('should include file metadata', async () => {
			const files = await fileManager.listDirectory('.');
			const file = files.find((f) => f.name === 'file1.txt');

			expect(file).toBeDefined();
			expect(file!.size).toBeGreaterThan(0);
			expect(file!.mtime).toBeDefined();
		});

		it('should not include size for directories', async () => {
			const files = await fileManager.listDirectory('.');
			const dir = files.find((f) => f.type === 'directory');

			expect(dir).toBeDefined();
			expect(dir!.size).toBeUndefined();
		});

		it('should throw error for non-existent directory', async () => {
			await expect(fileManager.listDirectory('nonexistent')).rejects.toThrow('Directory not found');
		});

		it('should throw error when trying to list a file', async () => {
			await expect(fileManager.listDirectory('file1.txt')).rejects.toThrow(
				'Path is not a directory'
			);
		});

		it('should list recursively when recursive=true', async () => {
			const files = await fileManager.listDirectory('.', true);

			expect(files.some((f) => f.path.includes('subdir/nested.txt'))).toBe(true);
			expect(files.length).toBeGreaterThan(3); // Should include nested files
		});

		it('should handle empty directory', async () => {
			const files = await fileManager.listDirectory('emptydir');
			expect(files.length).toBe(0);
		});
	});

	describe('getFileTree', () => {
		it('should return tree structure for directory', async () => {
			const tree = await fileManager.getFileTree('.');

			expect(tree.type).toBe('directory');
			expect(tree.children).toBeDefined();
			expect(tree.children!.length).toBeGreaterThan(0);
		});

		it('should return file node for file', async () => {
			const tree = await fileManager.getFileTree('file1.txt');

			expect(tree.type).toBe('file');
			expect(tree.name).toBe('file1.txt');
			expect(tree.children).toBeUndefined();
		});

		it('should respect max depth', async () => {
			const tree = await fileManager.getFileTree('.', 1);

			// Should include direct children
			const subdir = tree.children?.find((c) => c.name === 'subdir');
			expect(subdir).toBeDefined();

			// But subdirectory should have no children (max depth reached)
			expect(subdir!.children).toEqual([]);
		});

		it('should skip hidden files', async () => {
			// Create a hidden file
			await writeFile(join(testWorkspace, '.hidden'), 'secret');

			const tree = await fileManager.getFileTree('.');

			expect(tree.children?.some((c) => c.name === '.hidden')).toBe(false);
		});

		it('should skip common ignore patterns', async () => {
			// Create ignored directories
			await mkdir(join(testWorkspace, 'node_modules'), { recursive: true });
			await mkdir(join(testWorkspace, 'dist'), { recursive: true });

			const tree = await fileManager.getFileTree('.');

			expect(tree.children?.some((c) => c.name === 'node_modules')).toBe(false);
			expect(tree.children?.some((c) => c.name === 'dist')).toBe(false);
		});

		it('should sort directories before files', async () => {
			const tree = await fileManager.getFileTree('.');

			const children = tree.children || [];
			const types = children.map((c) => c.type);

			// Find indices of first directory and first file
			const firstDirIdx = types.indexOf('directory');
			const firstFileIdx = types.indexOf('file');

			if (firstDirIdx !== -1 && firstFileIdx !== -1) {
				expect(firstDirIdx).toBeLessThan(firstFileIdx);
			}
		});

		it('should throw error for non-existent path', async () => {
			await expect(fileManager.getFileTree('nonexistent')).rejects.toThrow('Path not found');
		});

		it('should handle nested directories', async () => {
			const tree = await fileManager.getFileTree('.', 5);

			const subdir = tree.children?.find((c) => c.name === 'subdir');
			expect(subdir).toBeDefined();
			expect(subdir!.type).toBe('directory');
			expect(subdir!.children).toBeDefined();
		});
	});

	describe('pathExists', () => {
		it('should return true for existing file', async () => {
			expect(await fileManager.pathExists('file1.txt')).toBe(true);
		});

		it('should return true for existing directory', async () => {
			expect(await fileManager.pathExists('subdir')).toBe(true);
		});

		it('should return false for non-existent path', async () => {
			expect(await fileManager.pathExists('nonexistent.txt')).toBe(false);
		});

		it('should return false for path traversal attempts', async () => {
			expect(await fileManager.pathExists('../../../etc/passwd')).toBe(false);
		});

		it('should return true for nested paths', async () => {
			expect(await fileManager.pathExists('subdir/nested.txt')).toBe(true);
		});
	});

	describe('edge cases', () => {
		it('should handle root directory path', async () => {
			const files = await fileManager.listDirectory('.');
			expect(files).toBeDefined();
			expect(Array.isArray(files)).toBe(true);
		});

		it('should handle paths with trailing slashes', async () => {
			const files = await fileManager.listDirectory('subdir/');
			expect(files.length).toBeGreaterThan(0);
		});

		it('should handle relative paths correctly', async () => {
			const result = await fileManager.readFile('./file1.txt');
			expect(result.content).toBe('Hello World');
		});
	});
});
