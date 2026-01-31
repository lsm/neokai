/**
 * SDK CLI Path Resolver Tests
 */

import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	isBundledBinary,
	setEmbeddedCliPath,
	resolveSDKCliPath,
	_resetForTesting,
} from '../../../src/lib/agent/sdk-cli-resolver';

describe('sdk-cli-resolver', () => {
	beforeEach(() => {
		_resetForTesting();
	});

	describe('isBundledBinary', () => {
		it('returns false in non-bundled environment', () => {
			expect(isBundledBinary()).toBe(false);
		});
	});

	describe('setEmbeddedCliPath', () => {
		it('accepts a path without throwing', () => {
			expect(() => setEmbeddedCliPath('/virtual/path/cli.js')).not.toThrow();
		});
	});

	describe('resolveSDKCliPath', () => {
		it('resolves cli.js from node_modules in dev mode', () => {
			const result = resolveSDKCliPath();
			expect(result).toBeDefined();
			expect(result!).toContain('cli.js');
			expect(result!).toContain('@anthropic-ai');
		});

		it('caches the resolved path on subsequent calls', () => {
			const first = resolveSDKCliPath();
			const second = resolveSDKCliPath();
			expect(first).toBe(second);
		});

		describe('embedded CLI extraction', () => {
			let existsSyncSpy: ReturnType<typeof spyOn>;
			let readFileSyncSpy: ReturnType<typeof spyOn>;
			let writeFileSyncSpy: ReturnType<typeof spyOn>;
			let mkdirSyncSpy: ReturnType<typeof spyOn>;
			let testFile: string;
			const testContent = 'console.log("test cli");\n';

			beforeEach(() => {
				_resetForTesting();

				// Create a real test file to act as embedded CLI
				testFile = join(tmpdir(), `neokai-test-embedded-${Date.now()}.js`);
				fs.writeFileSync(testFile, testContent);
			});

			afterEach(() => {
				existsSyncSpy?.mockRestore();
				readFileSyncSpy?.mockRestore();
				writeFileSyncSpy?.mockRestore();
				mkdirSyncSpy?.mockRestore();
				try {
					fs.unlinkSync(testFile);
				} catch {
					// ignore
				}
			});

			it('extracts embedded CLI when node_modules is unavailable', () => {
				const originalExistsSync = fs.existsSync.bind(fs);
				const originalReadFileSync = fs.readFileSync.bind(fs);
				const writtenFiles: string[] = [];

				existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
					const p = String(path);
					// Block node_modules resolution
					if (p.includes('node_modules')) return false;
					return originalExistsSync(p);
				});

				readFileSyncSpy = spyOn(fs, 'readFileSync').mockImplementation(
					(path: fs.PathOrFileDescriptor, options?: unknown) => {
						return originalReadFileSync(path, options as undefined);
					}
				);

				mkdirSyncSpy = spyOn(fs, 'mkdirSync').mockImplementation(
					() => undefined as unknown as string
				);

				writeFileSyncSpy = spyOn(fs, 'writeFileSync').mockImplementation(
					(path: fs.PathOrFileDescriptor) => {
						writtenFiles.push(String(path));
					}
				);

				setEmbeddedCliPath(testFile);
				const result = resolveSDKCliPath();

				expect(result).toBeDefined();
				expect(result!).toContain('neokai-sdk');
				expect(result!).toEndWith('cli.js');
			});

			it('returns cached extracted path on subsequent calls', () => {
				const originalExistsSync = fs.existsSync.bind(fs);
				const originalReadFileSync = fs.readFileSync.bind(fs);

				existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
					const p = String(path);
					if (p.includes('node_modules')) return false;
					return originalExistsSync(p);
				});

				readFileSyncSpy = spyOn(fs, 'readFileSync').mockImplementation(
					(path: fs.PathOrFileDescriptor, options?: unknown) => {
						return originalReadFileSync(path, options as undefined);
					}
				);

				mkdirSyncSpy = spyOn(fs, 'mkdirSync').mockImplementation(
					() => undefined as unknown as string
				);
				writeFileSyncSpy = spyOn(fs, 'writeFileSync').mockImplementation(() => {});

				setEmbeddedCliPath(testFile);
				const first = resolveSDKCliPath();
				const second = resolveSDKCliPath();

				expect(first).toBe(second);
			});

			it('returns undefined when no embedded path and no node_modules', () => {
				existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(false);

				const result = resolveSDKCliPath();
				expect(result).toBeUndefined();
			});

			it('returns undefined when embedded path reading fails', () => {
				existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
				readFileSyncSpy = spyOn(fs, 'readFileSync').mockImplementation(() => {
					throw new Error('ENOENT');
				});

				setEmbeddedCliPath('/non-existent/path/cli.js');
				const result = resolveSDKCliPath();
				expect(result).toBeUndefined();
			});

			it('reuses already-extracted file without re-writing', () => {
				const originalExistsSync = fs.existsSync.bind(fs);
				const originalReadFileSync = fs.readFileSync.bind(fs);

				existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
					const p = String(path);
					if (p.includes('node_modules')) return false;
					// Pretend the extracted file already exists
					if (p.includes('neokai-sdk') && p.endsWith('cli.js')) return true;
					return originalExistsSync(p);
				});

				readFileSyncSpy = spyOn(fs, 'readFileSync').mockImplementation(
					(path: fs.PathOrFileDescriptor, options?: unknown) => {
						return originalReadFileSync(path, options as undefined);
					}
				);

				mkdirSyncSpy = spyOn(fs, 'mkdirSync');
				writeFileSyncSpy = spyOn(fs, 'writeFileSync');

				setEmbeddedCliPath(testFile);
				const result = resolveSDKCliPath();

				expect(result).toBeDefined();
				expect(result!).toContain('neokai-sdk');
				// Should NOT have called mkdirSync or writeFileSync since file already exists
				expect(mkdirSyncSpy).not.toHaveBeenCalled();
				expect(writeFileSyncSpy).not.toHaveBeenCalled();
			});
		});
	});

	describe('_resetForTesting', () => {
		it('clears cached CLI path', () => {
			// Resolve once to populate cache
			const first = resolveSDKCliPath();
			expect(first).toBeDefined();

			// Reset and mock to prevent node_modules resolution
			_resetForTesting();
			const existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(false);

			// Should return undefined now (cache cleared, no resolution possible)
			const result = resolveSDKCliPath();
			expect(result).toBeUndefined();

			existsSyncSpy.mockRestore();
		});

		it('clears embedded CLI path', () => {
			setEmbeddedCliPath('/some/path/cli.js');
			_resetForTesting();

			// Mock to prevent node_modules resolution
			const existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(false);

			// Should return undefined (embedded path was cleared)
			const result = resolveSDKCliPath();
			expect(result).toBeUndefined();

			existsSyncSpy.mockRestore();
		});
	});
});
