/**
 * Config port resolution tests
 *
 * Tests for NEOKAI_PORT env var priority over PORT in getConfig().
 * Covers:
 * - NEOKAI_PORT takes priority over PORT
 * - PORT still works when NEOKAI_PORT is absent
 * - Default 9283 when neither is set
 * - overrides.port has highest priority over both env vars
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';

// Capture original env var values so we can restore them after each test
const ORIGINAL_NEOKAI_PORT = process.env.NEOKAI_PORT;
const ORIGINAL_PORT = process.env.PORT;
const ORIGINAL_WORKSPACE = process.env.NEOKAI_WORKSPACE_PATH;

// We need a dummy workspace so getConfig() doesn't throw on missing workspace
const DUMMY_WORKSPACE = '/tmp/test-workspace';

describe('getConfig port resolution', () => {
	beforeEach(() => {
		// Start each test with a clean slate for port-related vars
		delete process.env.NEOKAI_PORT;
		delete process.env.PORT;
		// Provide a workspace so the function doesn't throw
		process.env.NEOKAI_WORKSPACE_PATH = DUMMY_WORKSPACE;
	});

	afterEach(() => {
		// Restore original env vars
		if (ORIGINAL_NEOKAI_PORT !== undefined) {
			process.env.NEOKAI_PORT = ORIGINAL_NEOKAI_PORT;
		} else {
			delete process.env.NEOKAI_PORT;
		}
		if (ORIGINAL_PORT !== undefined) {
			process.env.PORT = ORIGINAL_PORT;
		} else {
			delete process.env.PORT;
		}
		if (ORIGINAL_WORKSPACE !== undefined) {
			process.env.NEOKAI_WORKSPACE_PATH = ORIGINAL_WORKSPACE;
		} else {
			delete process.env.NEOKAI_WORKSPACE_PATH;
		}
	});

	it('returns the default port 9283 when neither NEOKAI_PORT nor PORT is set', async () => {
		const { getConfig } = await import('../../src/config');
		const config = getConfig();
		expect(config.port).toBe(9283);
	});

	it('uses PORT env var when NEOKAI_PORT is absent', async () => {
		process.env.PORT = '8080';
		const { getConfig } = await import('../../src/config');
		const config = getConfig();
		expect(config.port).toBe(8080);
	});

	it('NEOKAI_PORT takes priority over PORT', async () => {
		process.env.NEOKAI_PORT = '7777';
		process.env.PORT = '8080';
		const { getConfig } = await import('../../src/config');
		const config = getConfig();
		expect(config.port).toBe(7777);
	});

	it('NEOKAI_PORT works alone when PORT is absent', async () => {
		process.env.NEOKAI_PORT = '6000';
		const { getConfig } = await import('../../src/config');
		const config = getConfig();
		expect(config.port).toBe(6000);
	});

	it('overrides.port has the highest priority over NEOKAI_PORT and PORT', async () => {
		process.env.NEOKAI_PORT = '7777';
		process.env.PORT = '8080';
		const { getConfig } = await import('../../src/config');
		const config = getConfig({ port: 5555, workspace: DUMMY_WORKSPACE });
		expect(config.port).toBe(5555);
	});

	it('overrides.port takes priority even when only PORT is set', async () => {
		process.env.PORT = '8080';
		const { getConfig } = await import('../../src/config');
		const config = getConfig({ port: 1234, workspace: DUMMY_WORKSPACE });
		expect(config.port).toBe(1234);
	});

	it('overrides.port takes priority over the default when no env vars are set', async () => {
		const { getConfig } = await import('../../src/config');
		const config = getConfig({ port: 3000, workspace: DUMMY_WORKSPACE });
		expect(config.port).toBe(3000);
	});

	it('throws when no workspace is configured', async () => {
		delete process.env.NEOKAI_WORKSPACE_PATH;
		const { getConfig } = await import('../../src/config');
		expect(() => getConfig()).toThrow(
			'Workspace path must be explicitly provided via --workspace flag or NEOKAI_WORKSPACE_PATH environment variable'
		);
	});
});
