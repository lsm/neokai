/**
 * Unit tests for bun-node-wrapper utilities.
 *
 * Tests cover:
 * - ensureBunNodeWrapper() creates the wrapper dir + symlink under Bun
 * - ensureBunNodeWrapper() is idempotent (re-uses existing symlink)
 * - ensureBunNodeWrapper() re-creates stale symlink pointing to wrong target
 * - buildCopilotEnv() prepends the wrapper dir to PATH under Bun
 * - buildCopilotEnv() preserves all other env vars
 */

import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test';
import * as nodefs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	ensureBunNodeWrapper,
	buildCopilotEnv,
} from '../../../../src/lib/providers/anthropic-copilot/bun-node-wrapper';

// The expected wrapper directory path (must match the implementation)
const WRAPPER_DIR = join(tmpdir(), 'neokai-bun-node-wrapper');
const NODE_LINK = join(WRAPPER_DIR, 'node');

describe('ensureBunNodeWrapper (running under Bun in bun test)', () => {
	afterEach(() => {
		// Clean up wrapper dir created by tests
		try {
			nodefs.unlinkSync(NODE_LINK);
		} catch {
			// Ignore
		}
		try {
			nodefs.rmdirSync(WRAPPER_DIR);
		} catch {
			// Ignore
		}
	});

	it('returns the wrapper directory path', () => {
		const dir = ensureBunNodeWrapper();
		expect(dir).toBe(WRAPPER_DIR);
	});

	it('creates the wrapper directory', () => {
		ensureBunNodeWrapper();
		expect(nodefs.existsSync(WRAPPER_DIR)).toBe(true);
	});

	it('creates a "node" symlink pointing to process.execPath (Bun binary)', () => {
		ensureBunNodeWrapper();
		const target = nodefs.readlinkSync(NODE_LINK);
		expect(target).toBe(process.execPath);
	});

	it('is idempotent — second call reuses the existing symlink', () => {
		ensureBunNodeWrapper();
		const first = nodefs.readlinkSync(NODE_LINK);
		ensureBunNodeWrapper();
		const second = nodefs.readlinkSync(NODE_LINK);
		expect(first).toBe(second);
	});

	it('re-creates a stale symlink pointing to a different path', () => {
		// Create the dir with a stale symlink
		nodefs.mkdirSync(WRAPPER_DIR, { recursive: true });
		nodefs.symlinkSync('/usr/bin/node', NODE_LINK);
		expect(nodefs.readlinkSync(NODE_LINK)).toBe('/usr/bin/node');

		// ensureBunNodeWrapper should fix it
		ensureBunNodeWrapper();
		expect(nodefs.readlinkSync(NODE_LINK)).toBe(process.execPath);
	});

	it('returns undefined when fs operations fail', () => {
		const spy = spyOn(nodefs, 'mkdirSync').mockImplementation(() => {
			throw new Error('EACCES: permission denied');
		});
		try {
			const result = ensureBunNodeWrapper();
			expect(result).toBeUndefined();
		} finally {
			spy.mockRestore();
		}
	});
});

// On Linux, buildCopilotEnv() returns the base env unchanged because Bun on
// Linux does not support node:sqlite.  Tests are split by platform so they
// assert the correct behaviour on both Linux CI and macOS dev machines.
const isLinux = process.platform === 'linux';

describe('buildCopilotEnv (running under Bun in bun test)', () => {
	afterEach(() => {
		// Clean up wrapper dir created by tests
		try {
			nodefs.unlinkSync(NODE_LINK);
		} catch {
			// Ignore
		}
		try {
			nodefs.rmdirSync(WRAPPER_DIR);
		} catch {
			// Ignore
		}
	});

	it('prepends the bun-node-wrapper dir to PATH (non-Linux only)', () => {
		if (isLinux) return; // wrapper disabled on Linux — tested separately
		const base = { PATH: '/usr/bin:/bin', OTHER: 'value' };
		const result = buildCopilotEnv(base);
		expect(result.PATH).toMatch(
			new RegExp(`^${WRAPPER_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`)
		);
	});

	it('returns base env unchanged on Linux (Bun lacks node:sqlite)', () => {
		if (!isLinux) return; // Linux-specific behaviour
		const base = { PATH: '/usr/bin:/bin', OTHER: 'value' };
		const result = buildCopilotEnv(base);
		expect(result).toBe(base); // exact same reference — no copy made
	});

	it('preserves the existing PATH after the wrapper dir (non-Linux only)', () => {
		if (isLinux) return;
		const base = { PATH: '/usr/bin:/bin' };
		const result = buildCopilotEnv(base);
		expect(result.PATH).toContain('/usr/bin:/bin');
	});

	it('preserves all other env vars unchanged (non-Linux only)', () => {
		if (isLinux) return;
		const base = { PATH: '/usr/bin', FOO: 'bar', BAZ: '42' };
		const result = buildCopilotEnv(base);
		expect(result.FOO).toBe('bar');
		expect(result.BAZ).toBe('42');
	});

	it('does not mutate the base env object (non-Linux only)', () => {
		if (isLinux) return;
		const base = { PATH: '/usr/bin' };
		buildCopilotEnv(base);
		expect(base.PATH).toBe('/usr/bin');
	});

	it('uses process.env.PATH as fallback when base.PATH is absent (non-Linux only)', () => {
		if (isLinux) return;
		const base: NodeJS.ProcessEnv = { FOO: 'bar' };
		const result = buildCopilotEnv(base);
		// PATH should start with the wrapper dir
		expect(result.PATH).toMatch(
			new RegExp(`^${WRAPPER_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`)
		);
	});
});
