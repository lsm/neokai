/**
 * SDK CLI Path Resolver Tests
 */

import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
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
			let lstatSyncSpy: ReturnType<typeof spyOn>;
			let unlinkSyncSpy: ReturnType<typeof spyOn>;
			let readFileSyncSpy: ReturnType<typeof spyOn>;
			let writeFileSyncSpy: ReturnType<typeof spyOn>;
			let mkdirSyncSpy: ReturnType<typeof spyOn>;
			let copyFileSyncSpy: ReturnType<typeof spyOn>;
			let chmodSyncSpy: ReturnType<typeof spyOn>;
			let testFile: string;
			const testContent = 'console.log("test cli");\n';

			beforeEach(() => {
				_resetForTesting();

				// Create a real test file to act as embedded CLI
				testFile = join(tmpdir(), `neokai-test-embedded-${Date.now()}.js`);
				fs.writeFileSync(testFile, testContent);

				// Always stub copyFileSync, chmodSync, and unlinkSync so tests don't mutate
				// real files; vendor-ripgrep setup won't interfere with cli.js write assertions.
				copyFileSyncSpy = spyOn(fs, 'copyFileSync').mockImplementation(() => {});
				chmodSyncSpy = spyOn(fs, 'chmodSync').mockImplementation(() => {});
				unlinkSyncSpy = spyOn(fs, 'unlinkSync').mockImplementation(() => {});
				// Always stub lstatSync to throw ENOENT by default (ripgrep not yet copied).
				// Individual tests override this spy to simulate an already-present binary.
				lstatSyncSpy = spyOn(fs, 'lstatSync').mockImplementation((path: fs.PathLike) => {
					throw Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: String(path) });
				});
			});

			afterEach(() => {
				existsSyncSpy?.mockRestore();
				lstatSyncSpy?.mockRestore();
				unlinkSyncSpy?.mockRestore();
				readFileSyncSpy?.mockRestore();
				writeFileSyncSpy?.mockRestore();
				mkdirSyncSpy?.mockRestore();
				copyFileSyncSpy?.mockRestore();
				chmodSyncSpy?.mockRestore();
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
					// System rg not available — prevents ripgrep copy
					if (p.endsWith('/rg') || p === '/usr/bin/rg' || p === '/usr/local/bin/rg') return false;
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

			it('copies system ripgrep to vendor path when system rg is available', () => {
				const originalReadFileSync = fs.readFileSync.bind(fs);
				const fakeSystemRg = '/usr/bin/rg';

				existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
					const p = String(path);
					if (p.includes('node_modules')) return false;
					// cli.js not yet extracted
					if (p.includes('neokai-sdk') && p.endsWith('cli.js')) return false;
					// System ripgrep is available
					if (p === fakeSystemRg) return true;
					return false;
				});

				// lstatSyncSpy already throws ENOENT (from beforeEach) — vendor binary absent

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

				// copyFileSync should have been called to copy system rg into the vendor dir
				expect(copyFileSyncSpy).toHaveBeenCalledTimes(1);
				const [src, dest] = copyFileSyncSpy.mock.calls[0] as [string, string];
				expect(src).toBe(fakeSystemRg);
				expect(dest).toContain('vendor');
				expect(dest).toContain('ripgrep');
				expect(dest).toEndWith('rg');
				// chmodSync should also have been called to mark the copy executable
				expect(chmodSyncSpy).toHaveBeenCalledTimes(1);
			});

			it('skips vendor ripgrep copy when system rg is not available', () => {
				const originalReadFileSync = fs.readFileSync.bind(fs);

				existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
					const p = String(path);
					if (p.includes('node_modules')) return false;
					// All paths return false — simulates environment without system ripgrep
					// (also covers the `which rg` fallback path returned by execSync)
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

				// copyFileSync must NOT be called when no system ripgrep is found
				expect(copyFileSyncSpy).not.toHaveBeenCalled();
			});

			it('skips vendor ripgrep copy when vendor binary already exists', () => {
				const originalReadFileSync = fs.readFileSync.bind(fs);
				const fakeSystemRg = '/usr/bin/rg';

				existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
					const p = String(path);
					if (p.includes('node_modules')) return false;
					// cli.js is already extracted
					if (p.includes('neokai-sdk') && p.endsWith('cli.js')) return true;
					// System rg available (but should not be used since vendor copy exists)
					if (p === fakeSystemRg) return true;
					return false;
				});

				// Override the default lstatSync stub: vendor rg binary already present
				lstatSyncSpy.mockImplementation((path: fs.PathLike) => {
					const p = String(path);
					if (p.includes('vendor') && p.endsWith('/rg')) {
						return { isFile: () => true, size: 12345 } as unknown as fs.Stats;
					}
					throw Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: p });
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

				// Binary already exists — must NOT call copyFileSync again
				expect(copyFileSyncSpy).not.toHaveBeenCalled();
			});

			it('skips vendor ripgrep copy on Windows (win32 platform)', () => {
				const originalReadFileSync = fs.readFileSync.bind(fs);

				// Simulate Windows by temporarily overriding process.platform
				const originalPlatform = process.platform;
				Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

				existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
					const p = String(path);
					if (p.includes('node_modules')) return false;
					// cli.js not yet extracted
					if (p.includes('neokai-sdk') && p.endsWith('cli.js')) return false;
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

				try {
					setEmbeddedCliPath(testFile);
					resolveSDKCliPath();

					// On Windows, copySystemRipgrepToVendor no-ops — copyFileSync must NOT be called
					expect(copyFileSyncSpy).not.toHaveBeenCalled();
				} finally {
					Object.defineProperty(process, 'platform', {
						value: originalPlatform,
						configurable: true,
					});
				}
			});

			it('replaces broken symlink with real binary copy', () => {
				const originalReadFileSync = fs.readFileSync.bind(fs);
				const fakeSystemRg = '/usr/bin/rg';

				existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
					const p = String(path);
					if (p.includes('node_modules')) return false;
					if (p.includes('neokai-sdk') && p.endsWith('cli.js')) return false;
					if (p === fakeSystemRg) return true;
					return false;
				});

				// Simulate a dangling symlink at the vendor path (isFile()=false, i.e. a symlink)
				lstatSyncSpy.mockImplementation((path: fs.PathLike) => {
					const p = String(path);
					if (p.includes('vendor') && p.endsWith('/rg')) {
						// Symlink entry exists but is not a regular file (dangling symlink)
						return { isFile: () => false, size: 0 } as unknown as fs.Stats;
					}
					throw Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: p });
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

				// Broken symlink must be removed before copying
				expect(unlinkSyncSpy).toHaveBeenCalledTimes(1);
				const [unlinkedPath] = unlinkSyncSpy.mock.calls[0] as [string];
				expect(unlinkedPath).toContain('vendor');
				expect(unlinkedPath).toEndWith('rg');
				// Then the real binary must be copied in
				expect(copyFileSyncSpy).toHaveBeenCalledTimes(1);
				const [src] = copyFileSyncSpy.mock.calls[0] as [string];
				expect(src).toBe(fakeSystemRg);
			});

			it('uses which rg fallback when system rg is not at well-known paths', () => {
				const execSyncSpy = spyOn(childProcess, 'execSync').mockImplementation((cmd: string) => {
					if (String(cmd) === 'which rg') return '/custom/bin/rg\n' as unknown as Buffer;
					throw new Error(`unexpected execSync: ${cmd}`);
				});

				const originalReadFileSync = fs.readFileSync.bind(fs);
				const fakeSystemRg = '/custom/bin/rg';

				existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
					const p = String(path);
					if (p.includes('node_modules')) return false;
					if (p.includes('neokai-sdk') && p.endsWith('cli.js')) return false;
					// Well-known rg paths are absent — forces fallback to `which rg`
					if (p === '/usr/bin/rg' || p === '/usr/local/bin/rg') return false;
					// The path returned by `which rg` does exist
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

				try {
					setEmbeddedCliPath(testFile);
					resolveSDKCliPath();

					// `which rg` fallback was exercised and the binary was found at the custom path
					expect(execSyncSpy).toHaveBeenCalledWith('which rg', expect.anything());
					// copyFileSync should use the path returned by `which rg`
					expect(copyFileSyncSpy).toHaveBeenCalledTimes(1);
					const [src] = copyFileSyncSpy.mock.calls[0] as [string];
					expect(src).toBe(fakeSystemRg);
				} finally {
					execSyncSpy.mockRestore();
				}
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
