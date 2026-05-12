import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store';
import { MessageHub } from '@neokai/shared/message-hub/message-hub.ts';
import { ExternalEventExtensionManager } from '../../../../src/lib/external-events/extension-manager';
import type {
	ExternalEventExtension,
	ExternalEventExtensionContext,
	RpcExternalEventExtension,
} from '../../../../src/lib/external-events/types';

let db: Database;
let config: ExternalEventExtensionConfigStore;
let context: ExternalEventExtensionContext;
let manager: ExternalEventExtensionManager;

beforeEach(() => {
	db = new Database(':memory:');
	config = new ExternalEventExtensionConfigStore(db);
	context = {
		publisher: { publish: async () => ({ outcome: 'published', eventId: 'evt-1' }) },
		config,
		onSourceConfigChanged() {},
	};
	manager = new ExternalEventExtensionManager();
});

describe('ExternalEventExtensionManager', () => {
	test('registers and unregisters extensions', () => {
		const extension = createExtension('github');

		manager.register(extension);
		expect(manager.getExtension('github')).toBe(extension);

		manager.unregister('github');
		expect(manager.getExtension('github')).toBeUndefined();
	});

	test('rejects duplicate registrations', () => {
		manager.register(createExtension('github'));
		expect(() => manager.register(createExtension('github'))).toThrow('already registered');
	});

	test('rejects source IDs with edge whitespace', () => {
		expect(() => manager.register(createExtension(' github '))).toThrow('edge whitespace');
	});

	test('does not start globally disabled extensions', async () => {
		const extension = createExtension('github');
		manager.register(extension);

		await manager.startExtension('github', context);

		expect(extension.starts).toBe(0);
		expect(extension.stops).toBe(0);
	});

	test('starts and stops globally enabled extensions once', async () => {
		const extension = createExtension('github');
		manager.register(extension);
		await config.setGlobalConfig('github', {
			source: 'github',
			globallyEnabled: true,
			capabilities: { webhooks: true },
		});

		await manager.startExtension('github', context);
		await manager.startExtension('github', context);
		expect(extension.starts).toBe(1);

		await manager.stopExtension('github');
		await manager.stopExtension('github');
		expect(extension.stops).toBe(1);
	});

	test('allows restart after stop when still globally enabled', async () => {
		const extension = createExtension('github');
		manager.register(extension);
		await config.setGlobalConfig('github', {
			source: 'github',
			globallyEnabled: true,
			capabilities: {},
		});

		await manager.startExtension('github', context);
		await manager.stopExtension('github');
		await manager.startExtension('github', context);

		expect(extension.starts).toBe(2);
		expect(extension.stops).toBe(1);
	});

	test('removes registered routes for source-owned route arrays on unregister', () => {
		const routes = [
			{
				method: 'POST' as const,
				path: '/webhooks/github',
				handle: async () => new Response('ok'),
			},
		];
		manager.register({
			sourceId: 'github',
			routes,
			async start() {},
			async stop() {},
		});

		manager.registerRoutes(routes, context);
		expect(manager.getRegisteredRoutes()).toHaveLength(1);
		expect(manager.getRegisteredRoutes()[0]!.sourceId).toBe('github');

		manager.unregister('github');
		expect(manager.getRegisteredRoutes()).toHaveLength(0);
	});

	test('assigns source ownership for cloned route arrays by method and path', () => {
		const routes = [
			{
				method: 'POST' as const,
				path: '/webhooks/github',
				handle: async () => new Response('ok'),
			},
		];
		manager.register({
			sourceId: 'github',
			routes,
			async start() {},
			async stop() {},
		});

		manager.registerRoutes(
			routes.map((route) => ({ ...route })),
			context
		);
		expect(manager.getRegisteredRoutes()).toHaveLength(1);
		expect(manager.getRegisteredRoutes()[0]!.sourceId).toBe('github');
	});

	test('deduplicates route handlers when routes are registered repeatedly', () => {
		const routes = [
			{
				method: 'POST' as const,
				path: '/webhooks/github',
				handle: async () => new Response('ok'),
			},
		];
		manager.register({
			sourceId: 'github',
			routes,
			async start() {},
			async stop() {},
		});

		manager.registerRoutes(routes, context);
		manager.registerRoutes(routes, context);
		expect(manager.getRegisteredRoutes()).toHaveLength(1);
	});

	test('throws when cloned route signatures match multiple extensions', () => {
		const githubRoutes = [
			{
				method: 'POST' as const,
				path: '/webhooks/events',
				handle: async () => new Response('github'),
			},
		];
		const slackRoutes = [
			{
				method: 'POST' as const,
				path: '/webhooks/events',
				handle: async () => new Response('slack'),
			},
		];
		manager.register({
			sourceId: 'github',
			routes: githubRoutes,
			async start() {},
			async stop() {},
		});
		manager.register({
			sourceId: 'slack',
			routes: slackRoutes,
			async start() {},
			async stop() {},
		});

		expect(() =>
			manager.registerRoutes(
				[
					{
						method: 'POST' as const,
						path: '/webhooks/events',
						handle: async () => new Response('clone'),
					},
				],
				context
			)
		).toThrow('multiple sources');

		manager.registerRoutes(slackRoutes, context);
		expect(manager.getRegisteredRoutes()).toHaveLength(1);
		expect(manager.getRegisteredRoutes()[0]!.sourceId).toBe('slack');
	});

	test('removes source route handlers on stop', async () => {
		const routes = [
			{
				method: 'POST' as const,
				path: '/webhooks/github',
				handle: async () => new Response('ok'),
			},
		];
		manager.register({
			sourceId: 'github',
			routes,
			async start() {},
			async stop() {},
		});
		await config.setGlobalConfig('github', {
			source: 'github',
			globallyEnabled: true,
			capabilities: { webhooks: true },
		});

		await manager.startExtension('github', context);
		manager.registerRoutes(routes, context);
		await manager.stopExtension('github');

		expect(manager.getRegisteredRoutes()).toHaveLength(0);
	});

	test('registers and unregisters RPC handlers through tracked unsubscribe callbacks', () => {
		const calls: string[] = [];
		const hub = new MessageHub();
		const originalOnRequest = hub.onRequest.bind(hub);
		hub.onRequest = ((method, handler) => {
			calls.push(`register:${method}`);
			const unsubscribe = originalOnRequest(method, handler);
			return () => {
				calls.push(`unregister:${method}`);
				unsubscribe();
			};
		}) as MessageHub['onRequest'];
		const extension: RpcExternalEventExtension = {
			sourceId: 'github',
			async start() {},
			async stop() {},
			registerRpcHandlers(hubLike) {
				hubLike.onRequest('space.github.watchRepo', () => ({ ok: true }));
				hubLike.onRequest('space.github.pollOnce', () => ({ ok: true }));
			},
		};
		manager.register(extension);

		manager.registerRpcHandlers('github', hub, context);
		expect(calls).toEqual(['register:space.github.watchRepo', 'register:space.github.pollOnce']);

		manager.registerRpcHandlers('github', hub, context);
		expect(calls).toEqual([
			'register:space.github.watchRepo',
			'register:space.github.pollOnce',
			'unregister:space.github.watchRepo',
			'unregister:space.github.pollOnce',
			'register:space.github.watchRepo',
			'register:space.github.pollOnce',
		]);

		manager.unregister('github');
		expect(calls.slice(-2)).toEqual([
			'unregister:space.github.watchRepo',
			'unregister:space.github.pollOnce',
		]);
	});

	test('cleans up partially registered RPC handlers when extension registration throws', () => {
		const calls: string[] = [];
		const hub = new MessageHub();
		const originalOnRequest = hub.onRequest.bind(hub);
		hub.onRequest = ((method, handler) => {
			calls.push(`register:${method}`);
			const unsubscribe = originalOnRequest(method, handler);
			return () => {
				calls.push(`unregister:${method}`);
				unsubscribe();
			};
		}) as MessageHub['onRequest'];
		const extension: RpcExternalEventExtension = {
			sourceId: 'github',
			async start() {},
			async stop() {},
			registerRpcHandlers(hubLike) {
				hubLike.onRequest('space.github.watchRepo', () => ({ ok: true }));
				throw new Error('registration failed');
			},
		};
		manager.register(extension);

		expect(() => manager.registerRpcHandlers('github', hub, context)).toThrow(
			'registration failed'
		);
		expect(calls).toEqual(['register:space.github.watchRepo', 'unregister:space.github.watchRepo']);
	});
});

interface TestExtension extends ExternalEventExtension {
	starts: number;
	stops: number;
}

function createExtension(sourceId: string): TestExtension {
	return {
		sourceId,
		starts: 0,
		stops: 0,
		async start() {
			this.starts += 1;
		},
		async stop() {
			this.stops += 1;
		},
	};
}
