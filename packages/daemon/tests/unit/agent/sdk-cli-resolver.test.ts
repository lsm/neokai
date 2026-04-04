/**
 * SDK CLI Path Resolver Tests
 */

import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	isBundledBinary,
	isRunningUnderBun,
	setEmbeddedCliPath,
	resolveSDKCliPath,
	_resetForTesting,
} from '../../../src/lib/agent/sdk-cli-resolver';

// Helper: build a predictable existsSync mock that blocks node_modules resolution
// but delegates everything else to the real fs.existsSync.
function makeBlockNodeModulesExistsMock(extras: Record<string, boolean> = {}) {
	const originalExistsSync = fs.existsSync.bind(fs);
	return (path: fs.PathLike): boolean => {
		const p = String(path);
		if (p.includes('node_modules')) return false;
		if (Object.prototype.hasOwnProperty.call(extras, p)) return extras[p];
		return originalExistsSync(p);
	};
}

describe('sdk-cli-resolver', () => {
	beforeEach(() => {
		_resetForTesting();
	});

	describe('isBundledBinary', () => {
		it('returns false in non-bundled environment', () => {
			expect(isBundledBinary()).toBe(false);
		});
	});

	describe('isRunningUnderBun', () => {
		it('returns true when running under Bun (bun test)', () => {
			// This test runs via `bun test`, so Bun global is present
			expect(isRunningUnderBun()).toBe(true);
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
			let symlinkSyncSpy: ReturnType<typeof spyOn>;
			let testFile: string;
			const testContent = 'console.log("test cli");\n';

			beforeEach(() => {
				_resetForTesting();

				// Create a real test file to act as embedded CLI
				testFile = join(tmpdir(), `neokai-test-embedded-${Date.now()}.js`);
				fs.writeFileSync(testFile, testContent);

				// Always stub symlinkSync so tests don't create real symlinks and
				// vendor-ripgrep linking doesn't interfere with cli.js write assertions.
				symlinkSyncSpy = spyOn(fs, 'symlinkSync').mockImplementation(() => {});
			});

			afterEach(() => {
				existsSyncSpy?.mockRestore();
				readFileSyncSpy?.mockRestore();
				writeFileSyncSpy?.mockRestore();
				mkdirSyncSpy?.mockRestore();
				symlinkSyncSpy?.mockRestore();
				try {
					fs.unlinkSync(testFile);
				} catch {
					// ignore
				}
			});

			it('extracts embedded CLI when node_modules is unavailable', () => {
				const originalReadFileSync = fs.readFileSync.bind(fs);
				const originalExistsSync = fs.existsSync.bind(fs);
				const writtenFiles: string[] = [];

				existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
					const p = String(path);
					if (p.includes('node_modules')) return false;
					// Prevent ripgrep linking so writeFileSync is only called for cli.js
					if (p.includes('vendor') && p.includes('ripgrep')) return false;
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
				const originalReadFileSync = fs.readFileSync.bind(fs);

				existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation(
					makeBlockNodeModulesExistsMock()
				);

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

			it('reuses already-extracted file without re-writing cli.js', () => {
				const originalReadFileSync = fs.readFileSync.bind(fs);

				// cli.js is already extracted; all other paths (system rg, vendor dir) are missing
				// so linkSystemRipgrepToVendor exits early without calling mkdirSync.
				existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
					const p = String(path);
					if (p.includes('node_modules')) return false;
					if (p.includes('neokai-sdk') && p.endsWith('cli.js')) return true;
					return false;
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
				// cli.js was already extracted — must NOT rewrite it.
				expect(writeFileSyncSpy).not.toHaveBeenCalled();
				// No system rg found → vendor dir must NOT be created.
				expect(mkdirSyncSpy).not.toHaveBeenCalled();
			});

			it('links system ripgrep to vendor path when system rg is available', () => {
				const originalReadFileSync = fs.readFileSync.bind(fs);
				const fakeSystemRg = '/usr/bin/rg';

				existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
					const p = String(path);
					if (p.includes('node_modules')) return false;
					// cli.js not yet extracted
					if (p.includes('neokai-sdk') && p.endsWith('cli.js')) return false;
					// Vendor ripgrep symlink not yet created
					if (p.includes('vendor') && p.includes('ripgrep')) return false;
					// System ripgrep is available
					if (p === fakeSystemRg) return true;
					return false;
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
				resolveSDKCliPath();

				// symlinkSync should have been called to link system rg into the vendor dir
				expect(symlinkSyncSpy).toHaveBeenCalledTimes(1);
				const [target, linkPath] = symlinkSyncSpy.mock.calls[0] as [string, string];
				expect(target).toBe(fakeSystemRg);
				expect(linkPath).toContain('vendor');
				expect(linkPath).toContain('ripgrep');
				expect(linkPath).toEndWith('rg');
			});

			it('skips vendor ripgrep linking when system rg is not available', () => {
				const originalReadFileSync = fs.readFileSync.bind(fs);

				existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
					const p = String(path);
					if (p.includes('node_modules')) return false;
					// All paths return false — simulates environment without system ripgrep
					return false;
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
				resolveSDKCliPath();

				// symlinkSync must NOT be called when no system ripgrep is found
				expect(symlinkSyncSpy).not.toHaveBeenCalled();
			});

			it('skips vendor ripgrep linking when vendor symlink already exists', () => {
				const originalReadFileSync = fs.readFileSync.bind(fs);
				const fakeSystemRg = '/usr/bin/rg';

				existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
					const p = String(path);
					if (p.includes('node_modules')) return false;
					// cli.js is already extracted
					if (p.includes('neokai-sdk') && p.endsWith('cli.js')) return true;
					// Vendor ripgrep symlink already exists
					if (p.includes('vendor') && p.endsWith('/rg')) return true;
					// System rg available (but should not be used since vendor link exists)
					if (p === fakeSystemRg) return true;
					return false;
				});

				readFileSyncSpy = spyOn(fs, 'readFileSync').mockImplementation(
					(path: fs.PathOrFileDescriptor, options?: unknown) => {
						return originalReadFileSync(path, options as undefined);
					}
				);

				mkdirSyncSpy = spyOn(fs, 'mkdirSync');
				writeFileSyncSpy = spyOn(fs, 'writeFileSync');

				setEmbeddedCliPath(testFile);
				resolveSDKCliPath();

				// Symlink already exists — must NOT call symlinkSync again
				expect(symlinkSyncSpy).not.toHaveBeenCalled();
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
