/**
 * SDK CLI Path Resolver Tests
 */

import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
	isBundledBinary,
	isRunningUnderBun,
	resolveSDKCliPath,
	getPlatformPackageName,
	getCliBinaryName,
	_resetForTesting,
} from '../../../../src/lib/agent/sdk-cli-resolver';

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
			expect(isRunningUnderBun()).toBe(true);
		});
	});

	describe('getPlatformPackageName', () => {
		it('returns a platform package name for current platform', () => {
			const result = getPlatformPackageName();
			expect(result).toBeDefined();
			expect(result!).toContain('@anthropic-ai/claude-agent-sdk-');
		});
	});

	describe('getCliBinaryName', () => {
		it('returns claude on non-Windows', () => {
			if (process.platform !== 'win32') {
				expect(getCliBinaryName()).toBe('claude');
			}
		});
	});

	describe('resolveSDKCliPath', () => {
		it('resolves CLI from node_modules in dev mode', () => {
			const result = resolveSDKCliPath();
			expect(result).toBeDefined();
			expect(result!).toContain('@anthropic-ai');
			const hasCli =
				result!.endsWith('claude') || result!.endsWith('claude.exe') || result!.includes('cli.js');
			expect(hasCli).toBe(true);
		});

		it('caches the resolved path on subsequent calls', () => {
			const first = resolveSDKCliPath();
			const second = resolveSDKCliPath();
			expect(first).toBe(second);
		});

		it('returns undefined when no resolution strategy works', () => {
			const existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
			const execSyncSpy = spyOn(childProcess, 'execSync').mockImplementation(() => {
				throw new Error('not found');
			});

			const result = resolveSDKCliPath();

			expect(result).toBeUndefined();
			existsSyncSpy.mockRestore();
			execSyncSpy.mockRestore();
		});
	});

	describe('cache resolution', () => {
		let existsSyncSpy: ReturnType<typeof spyOn>;
		let execSyncSpy: ReturnType<typeof spyOn>;
		let lstatSyncSpy: ReturnType<typeof spyOn>;

		beforeEach(() => {
			_resetForTesting();
		});

		afterEach(() => {
			existsSyncSpy?.mockRestore();
			execSyncSpy?.mockRestore();
			lstatSyncSpy?.mockRestore();
		});

		it('resolves from cache when node_modules is unavailable', () => {
			const originalExistsSync = fs.existsSync.bind(fs);
			const binaryName = getCliBinaryName();

			lstatSyncSpy = spyOn(fs, 'lstatSync').mockImplementation((path: fs.PathLike) => {
				const p = String(path);
				if (p.includes('.neokai/sdk') && p.endsWith(binaryName)) {
					return { isFile: () => true, size: 200000000 } as unknown as fs.Stats;
				}
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: p });
			});

			existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
				const p = String(path);
				// Block node_modules resolution
				if (p.includes('node_modules')) return false;
				// Block system rg paths
				if (p.endsWith('/rg')) return false;
				// Simulate cached binary exists
				if (p.includes('.neokai/sdk') && p.endsWith(binaryName)) return true;
				return originalExistsSync(p);
			});

			execSyncSpy = spyOn(childProcess, 'execSync').mockImplementation(() => {
				throw new Error('should not download');
			});

			const result = resolveSDKCliPath();

			expect(result).toBeDefined();
			expect(result!).toContain('.neokai/sdk');
		});
	});

	describe('auto-download', () => {
		let existsSyncSpy: ReturnType<typeof spyOn>;
		let execSyncSpy: ReturnType<typeof spyOn>;
		let mkdirSyncSpy: ReturnType<typeof spyOn>;
		let renameSyncSpy: ReturnType<typeof spyOn>;
		let chmodSyncSpy: ReturnType<typeof spyOn>;

		beforeEach(() => {
			_resetForTesting();
			chmodSyncSpy = spyOn(fs, 'chmodSync').mockImplementation(() => {});
			renameSyncSpy = spyOn(fs, 'renameSync').mockImplementation(() => {});
			mkdirSyncSpy = spyOn(fs, 'mkdirSync').mockImplementation(
				() => undefined as unknown as string
			);
		});

		afterEach(() => {
			existsSyncSpy?.mockRestore();
			execSyncSpy?.mockRestore();
			mkdirSyncSpy.mockRestore();
			renameSyncSpy.mockRestore();
			chmodSyncSpy.mockRestore();
		});

		it('attempts download when node_modules and cache are empty', () => {
			const originalExistsSync = fs.existsSync.bind(fs);

			existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
				const p = String(path);
				if (p.includes('node_modules')) return false;
				if (p.includes('.neokai/sdk')) return false;
				return originalExistsSync(p);
			});

			let packCalled = false;
			execSyncSpy = spyOn(childProcess, 'execSync').mockImplementation((cmd: string) => {
				const c = String(cmd);
				if (c.includes('npm pack')) {
					packCalled = true;
					throw new Error('network error simulating download failure');
				}
				throw new Error(`unexpected execSync: ${cmd}`);
			});

			const result = resolveSDKCliPath();

			expect(packCalled).toBe(true);
			expect(result).toBeUndefined();
		});
	});

	describe('_resetForTesting', () => {
		it('clears cached CLI path', () => {
			const first = resolveSDKCliPath();
			expect(first).toBeDefined();

			_resetForTesting();
			const existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
			const execSyncSpy = spyOn(childProcess, 'execSync').mockImplementation(() => {
				throw new Error('not found');
			});

			const result = resolveSDKCliPath();
			expect(result).toBeUndefined();

			existsSyncSpy.mockRestore();
			execSyncSpy.mockRestore();
		});
	});
});
