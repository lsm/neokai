/**
 * Tests for the custom-endpoint handling inside settings.global.update and
 * settings.global.save. These paths must stay consistent with the dedicated
 * customEndpoints.* RPCs: validate before persist, sync registry, clear
 * model cache — and crucially NOT clobber the registry when the payload
 * omits `customEndpoints` entirely.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import type { CustomEndpointConfig, GlobalSettings } from '@neokai/shared';
import { registerSettingsHandlers } from '../../../../src/lib/rpc-handlers/settings-handlers';
import type { SettingsManager } from '../../../../src/lib/settings-manager';
import type { Database } from '../../../../src/storage/database';
import type {
	DaemonInternalEventMap,
	InternalEventBus,
} from '../../../../src/lib/internal-event-bus';

const syncCalls: Array<CustomEndpointConfig[] | undefined> = [];
mock.module('../../../../src/lib/providers/factory', () => ({
	syncCustomEndpointProviders: mock(async (configs: CustomEndpointConfig[] | undefined) => {
		syncCalls.push(configs);
	}),
}));

const clearModelsCacheCalls: Array<string | undefined> = [];
mock.module('../../../../src/lib/model-service', () => ({
	clearModelsCache: mock((cacheKey?: string) => {
		clearModelsCacheCalls.push(cacheKey);
	}),
}));

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockMessageHub(): { hub: MessageHub; handlers: Map<string, RequestHandler> } {
	const handlers = new Map<string, RequestHandler>();
	const hub = {
		onRequest: mock((method: string, handler: RequestHandler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		}),
	} as unknown as MessageHub;
	return { hub, handlers };
}

function makeSettings(initial: GlobalSettings): {
	manager: SettingsManager;
	state: { settings: GlobalSettings };
} {
	const state = { settings: initial };
	const manager = {
		getGlobalSettings: mock(() => state.settings),
		updateGlobalSettings: mock((updates: Partial<GlobalSettings>) => {
			state.settings = { ...state.settings, ...updates };
			return state.settings;
		}),
		saveGlobalSettings: mock((settings: GlobalSettings) => {
			state.settings = settings;
		}),
		readFileOnlySettings: mock(() => ({})),
		listMcpServersFromSources: mock(() => []),
	} as unknown as SettingsManager;
	return { manager, state };
}

const validEndpoint: CustomEndpointConfig = {
	id: 'lmstudio',
	name: 'LM Studio',
	baseUrl: 'http://localhost:1234/v1',
	models: [{ id: 'qwen2.5-7b' }],
};

describe('settings handlers — custom endpoints integration', () => {
	let hubData: ReturnType<typeof createMockMessageHub>;
	let settings: ReturnType<typeof makeSettings>;
	let eventBus: InternalEventBus<DaemonInternalEventMap>;
	let db: Database;

	beforeEach(() => {
		syncCalls.splice(0);
		clearModelsCacheCalls.splice(0);
		hubData = createMockMessageHub();
		settings = makeSettings({ customEndpoints: [validEndpoint] } as unknown as GlobalSettings);
		eventBus = {
			publish: mock(async () => {}),
			publishAsync: mock(() => {}),
			subscribe: mock(() => () => {}),
		} as unknown as InternalEventBus<DaemonInternalEventMap>;
		db = {
			getSession: mock(() => null),
			workspaceHistory: { list: mock(() => []) },
			getDatabase: mock(() => ({ prepare: mock(() => ({ get: () => ({}), all: () => [] })) })),
		} as unknown as Database;
		registerSettingsHandlers(hubData.hub, settings.manager, eventBus, db);
	});

	afterEach(() => {
		mock.restore();
	});

	describe('settings.global.update', () => {
		it('validates customEndpoints before persisting', async () => {
			const handler = hubData.handlers.get('settings.global.update')!;
			await expect(
				handler({ updates: { customEndpoints: [{ ...validEndpoint, baseUrl: 'ftp://nope' }] } }, {})
			).rejects.toThrow(/baseUrl/);
			// Persist should not have happened.
			expect(syncCalls).toHaveLength(0);
		});

		it('syncs and clears cache when customEndpoints provided', async () => {
			const handler = hubData.handlers.get('settings.global.update')!;
			await handler({ updates: { customEndpoints: [validEndpoint] } }, {});
			expect(syncCalls).toHaveLength(1);
			expect(clearModelsCacheCalls).toHaveLength(1);
		});

		it('does not sync when customEndpoints omitted', async () => {
			const handler = hubData.handlers.get('settings.global.update')!;
			await handler({ updates: { showArchived: true } }, {});
			expect(syncCalls).toHaveLength(0);
			expect(clearModelsCacheCalls).toHaveLength(0);
		});
	});

	describe('settings.global.save', () => {
		it('preserves existing custom endpoints when payload omits the field', async () => {
			const handler = hubData.handlers.get('settings.global.save')!;
			// Payload missing customEndpoints entirely (legacy partial save).
			await handler({ settings: {} as GlobalSettings }, {});
			// Must not unregister any custom provider.
			expect(syncCalls).toHaveLength(0);
			expect(clearModelsCacheCalls).toHaveLength(0);
		});

		it('explicitly clears endpoints when payload sets customEndpoints to []', async () => {
			const handler = hubData.handlers.get('settings.global.save')!;
			await handler({ settings: { customEndpoints: [] } as unknown as GlobalSettings }, {});
			expect(syncCalls).toEqual([[]]);
			expect(clearModelsCacheCalls).toHaveLength(1);
		});

		it('validates customEndpoints before persisting on save', async () => {
			const handler = hubData.handlers.get('settings.global.save')!;
			await expect(
				handler(
					{
						settings: {
							customEndpoints: [{ ...validEndpoint, id: 'bad/id' }],
						} as unknown as GlobalSettings,
					},
					{}
				)
			).rejects.toThrow(/invalid/);
			expect(syncCalls).toHaveLength(0);
		});
	});
});
