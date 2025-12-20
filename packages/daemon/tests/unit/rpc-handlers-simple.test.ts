import { describe, test, expect } from 'bun:test';
import { MessageHub, EventBus } from '@liuboer/shared';
import { setupRPCHandlers } from '../../src/lib/rpc-handlers';
import { getConfig } from '../../src/config';
import { Database } from '../../src/storage/database';
import { AuthManager } from '../../src/lib/auth-manager';
import { SessionManager } from '../../src/lib/session-manager';
import { SettingsManager } from '../../src/lib/settings-manager';

describe('setupRPCHandlers - Handler Registration', () => {
	test('should register all RPC handlers without needing a class', async () => {
		// Setup minimal dependencies
		const config = getConfig({ workspace: '/test/workspace' });
		const db = new Database(':memory:');
		await db.initialize();

		const authManager = new AuthManager(db, config);
		await authManager.initialize();

		const settingsManager = new SettingsManager(db, config.workspaceRoot);

		const messageHub = new MessageHub({ defaultSessionId: 'global' });
		const eventBus = new EventBus({ debug: false });

		const sessionManager = new SessionManager(
			db,
			messageHub,
			authManager,
			settingsManager,
			eventBus,
			{
				defaultModel: config.defaultModel,
				maxTokens: config.maxTokens,
				temperature: config.temperature,
				workspaceRoot: config.workspaceRoot,
			}
		);

		// Get initial handler count
		const initialHandlers = (messageHub as unknown).rpcHandlers.size;

		// Setup handlers - FUNCTIONAL APPROACH (no class instantiation!)
		setupRPCHandlers({
			messageHub,
			sessionManager,
			authManager,
			config,
		});

		// Verify handlers were registered
		const finalHandlers = (messageHub as unknown).rpcHandlers.size;
		expect(finalHandlers).toBeGreaterThan(initialHandlers);

		// Should have at least 14 handlers
		expect(finalHandlers).toBeGreaterThanOrEqual(14);

		// Cleanup
		db.close();
	});

	test('should register expected handler methods', async () => {
		const config = getConfig({ workspace: '/test/workspace' });
		const db = new Database(':memory:');
		await db.initialize();

		const authManager = new AuthManager(db, config);
		await authManager.initialize();

		const settingsManager = new SettingsManager(db, config.workspaceRoot);

		const messageHub = new MessageHub({ defaultSessionId: 'global' });
		const eventBus = new EventBus({ debug: false });

		const sessionManager = new SessionManager(
			db,
			messageHub,
			authManager,
			settingsManager,
			eventBus,
			{
				defaultModel: config.defaultModel,
				maxTokens: config.maxTokens,
				temperature: config.temperature,
				workspaceRoot: config.workspaceRoot,
			}
		);

		// Setup handlers
		setupRPCHandlers({
			messageHub,
			sessionManager,
			authManager,
			config,
		});

		const handlers = (messageHub as unknown).rpcHandlers;

		// Session handlers
		expect(handlers.has('session.create')).toBe(true);
		expect(handlers.has('session.list')).toBe(true);
		expect(handlers.has('session.get')).toBe(true);
		expect(handlers.has('session.update')).toBe(true);
		expect(handlers.has('session.delete')).toBe(true);

		// Message handlers
		expect(handlers.has('message.sdkMessages')).toBe(true);
		expect(handlers.has('message.count')).toBe(true);

		// Command handlers
		expect(handlers.has('commands.list')).toBe(true);

		// File handlers
		expect(handlers.has('file.read')).toBe(true);
		expect(handlers.has('file.list')).toBe(true);
		expect(handlers.has('file.tree')).toBe(true);

		// System handlers
		expect(handlers.has('system.health')).toBe(true);
		expect(handlers.has('system.config')).toBe(true);

		// Auth handlers
		expect(handlers.has('auth.status')).toBe(true);

		// Cleanup
		db.close();
	});
});
