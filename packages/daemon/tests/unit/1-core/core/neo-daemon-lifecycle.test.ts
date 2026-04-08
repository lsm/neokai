/**
 * Neo Daemon Lifecycle Tests
 *
 * Integration tests verifying that NeoAgentManager is correctly wired into
 * createDaemonApp:
 *
 * - neoAgentManager is present in DaemonAppContext
 * - Neo session is NOT provisioned in test mode (default)
 * - Neo session IS provisioned when NEOKAI_ENABLE_NEO_AGENT=1
 * - neoAgentManager.cleanup() is called during shutdown
 *
 * OFFLINE TESTS — No API calls required.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { createDaemonApp } from '../../../../src/app';
import { NeoAgentManager, NEO_SESSION_ID } from '../../../../src/lib/neo/neo-agent-manager';
import type { Config } from '../../../../src/config';

/** Build a minimal test config using an in-memory database. */
function makeConfig(suffix = Date.now()): Config {
	const tmpDir = process.env.TMPDIR || '/tmp';
	return {
		host: 'localhost',
		port: 0,
		defaultModel: 'claude-sonnet-4-5-20250929',
		maxTokens: 8192,
		temperature: 1.0,
		dbPath: ':memory:',
		maxSessions: 10,
		nodeEnv: 'test',
		workspaceRoot: `${tmpDir}/neokai-test-neo-lifecycle-${suffix}`,
		disableWorktrees: true,
	};
}

describe('Neo Daemon Lifecycle', () => {
	let bunServeSpy: ReturnType<typeof spyOn> | null = null;
	let originalNeoAgent: string | undefined;
	let originalNodeEnv: string | undefined;
	// Silence console noise from createDaemonApp startup logs.
	let originalConsoleLog: typeof console.log;
	let originalConsoleError: typeof console.error;

	beforeEach(() => {
		originalNeoAgent = process.env.NEOKAI_ENABLE_NEO_AGENT;
		delete process.env.NEOKAI_ENABLE_NEO_AGENT;

		// Ensure NODE_ENV=test so the Neo provisioning guard skips by default.
		originalNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = 'test';

		originalConsoleLog = console.log;
		originalConsoleError = console.error;
		console.log = () => {};
		console.error = () => {};

		// Avoid real socket binding in unit tests.
		bunServeSpy = spyOn(Bun, 'serve').mockImplementation(
			(_opts: Parameters<typeof Bun.serve>[0]) =>
				({
					stop() {},
				}) as never
		);
	});

	afterEach(() => {
		if (originalNeoAgent !== undefined) {
			process.env.NEOKAI_ENABLE_NEO_AGENT = originalNeoAgent;
		} else {
			delete process.env.NEOKAI_ENABLE_NEO_AGENT;
		}

		if (originalNodeEnv !== undefined) {
			process.env.NODE_ENV = originalNodeEnv;
		} else {
			delete process.env.NODE_ENV;
		}
		console.log = originalConsoleLog;
		console.error = originalConsoleError;
		if (bunServeSpy) {
			bunServeSpy.mockRestore();
			bunServeSpy = null;
		}
	});

	test('neoAgentManager is present in DaemonAppContext', async () => {
		const ctx = await createDaemonApp({ config: makeConfig(), verbose: false });
		try {
			expect(ctx.neoAgentManager).toBeInstanceOf(NeoAgentManager);
		} finally {
			await ctx.cleanup();
		}
	});

	test('Neo session is NOT provisioned in test mode by default', async () => {
		// NODE_ENV=test and NEOKAI_ENABLE_NEO_AGENT is unset → provision() must not run.
		const ctx = await createDaemonApp({ config: makeConfig(), verbose: false });
		try {
			// getSession() returns null because provision() was skipped.
			expect(ctx.neoAgentManager.getSession()).toBeNull();
		} finally {
			await ctx.cleanup();
		}
	});

	test('Neo session IS provisioned when NEOKAI_ENABLE_NEO_AGENT=1', async () => {
		process.env.NEOKAI_ENABLE_NEO_AGENT = '1';

		const ctx = await createDaemonApp({ config: makeConfig(), verbose: false });
		try {
			// After provision() the session is live in memory.
			const session = ctx.neoAgentManager.getSession();
			expect(session).not.toBeNull();
			expect(session!.session.id).toBe(NEO_SESSION_ID);
		} finally {
			await ctx.cleanup();
		}
	});

	test('Neo session persists in DB and is re-attached on a second startup', async () => {
		process.env.NEOKAI_ENABLE_NEO_AGENT = '1';

		// Use a shared on-disk DB so the session persists across two daemon instances.
		const tmpDir = process.env.TMPDIR || '/tmp';
		const dbPath = `${tmpDir}/neokai-test-neo-restart-${Date.now()}.db`;
		const workspaceRoot = `${tmpDir}/neokai-test-neo-restart-ws-${Date.now()}`;
		const sharedConfig: Config = {
			host: 'localhost',
			port: 0,
			defaultModel: 'claude-sonnet-4-5-20250929',
			maxTokens: 8192,
			temperature: 1.0,
			dbPath,
			maxSessions: 10,
			nodeEnv: 'test',
			workspaceRoot,
			disableWorktrees: true,
		};

		// First startup — Neo session is created.
		const ctx1 = await createDaemonApp({ config: sharedConfig, verbose: false });
		const session1 = ctx1.neoAgentManager.getSession();
		expect(session1).not.toBeNull();
		expect(session1!.session.id).toBe(NEO_SESSION_ID);
		await ctx1.cleanup();

		// Second startup — Neo session should be re-attached from DB, not re-created.
		const ctx2 = await createDaemonApp({ config: sharedConfig, verbose: false });
		try {
			const session2 = ctx2.neoAgentManager.getSession();
			expect(session2).not.toBeNull();
			expect(session2!.session.id).toBe(NEO_SESSION_ID);
		} finally {
			await ctx2.cleanup();
		}

		// Clean up on-disk DB.
		try {
			await Bun.file(dbPath).arrayBuffer(); // exists check
			const fs = await import('fs/promises');
			await fs.unlink(dbPath);
		} catch {
			// ignore if file doesn't exist
		}
	});

	test('cleanup() shuts down Neo agent without error', async () => {
		process.env.NEOKAI_ENABLE_NEO_AGENT = '1';

		const ctx = await createDaemonApp({ config: makeConfig(), verbose: false });

		// Spy is attached here (before ctx.cleanup() runs), so it captures
		// the single cleanup() call that ctx.cleanup() delegates to.
		// It does NOT retroactively track any calls made before this line.
		const cleanupSpy = spyOn(ctx.neoAgentManager, 'cleanup');

		await ctx.cleanup();

		expect(cleanupSpy).toHaveBeenCalledTimes(1);
	});

	test('neoAgentManager.getSecurityMode() defaults to balanced', async () => {
		const ctx = await createDaemonApp({ config: makeConfig(), verbose: false });
		try {
			expect(ctx.neoAgentManager.getSecurityMode()).toBe('balanced');
		} finally {
			await ctx.cleanup();
		}
	});
});
