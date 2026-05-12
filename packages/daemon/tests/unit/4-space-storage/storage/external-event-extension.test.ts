import { Database as BunDatabase } from 'bun:sqlite';
import { MessageHub, type RequestHandler, generateUUID } from '@neokai/shared';
import { beforeEach, describe, expect, test } from 'bun:test';
import { ExternalEventService } from '../../../../src/lib/external-events/external-event-service';
import { ExternalEventStore } from '../../../../src/lib/external-events/external-event-store';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store';
import {
	ExternalEventExtensionManager,
	InMemoryExternalEventRouteRegistry,
	isHttpExternalEventExtension,
	isRpcExternalEventExtension,
} from '../../../../src/lib/external-events/extension-manager';
import { GitHubEventExtension } from '../../../../src/lib/external-events/github';
import {
	createInternalEventBus,
	type InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import { createTables, runMigrations } from '../../../../src/storage/schema';

async function createSignature(payload: string, secret: string): Promise<string> {
	const encoder = new TextEncoder();
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const buffer = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(payload));
	return `sha256=${Array.from(new Uint8Array(buffer))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')}`;
}

function setupDb(): BunDatabase {
	const db = new BunDatabase(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	createTables(db);
	runMigrations(db, () => {});
	db.prepare(
		`UPDATE external_event_extension_configs
		 SET globally_enabled = 1, capabilities_json = ?
		 WHERE source = 'github'`
	).run(JSON.stringify({ webhooks: true, polling: true, rpcConfig: true }));
	db.prepare(
		`INSERT INTO spaces (id, slug, name, workspace_path, status, created_at, updated_at)
		 VALUES ('space-1', 'space-1', 'Space', '/tmp', 'active', 1, 1)`
	).run();
	return db;
}

function getRequestHandler(hub: MessageHub, method: string): RequestHandler | undefined {
	return (hub as unknown as { requestHandlers: Map<string, RequestHandler> }).requestHandlers.get(
		method
	);
}

function githubPayload(): unknown {
	return {
		action: 'created',
		repository: {
			id: 1,
			name: 'widgets',
			full_name: 'acme/widgets',
			owner: { login: 'acme' },
		},
		sender: { login: 'bot', type: 'Bot' },
		issue: { number: 7, title: 'PR', pull_request: { url: 'api' } },
		comment: {
			id: 101,
			body: 'looks good',
			html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-101',
			user: { login: 'bot', type: 'Bot' },
			created_at: '2026-01-01T00:00:00Z',
		},
	};
}

describe('external event extension startup primitives', () => {
	let db: BunDatabase;
	let bus: InternalEventBus<Record<string, unknown>>;
	let service: ExternalEventService;
	let config: ExternalEventExtensionConfigStore;

	beforeEach(() => {
		db = setupDb();
		bus = createInternalEventBus<Record<string, unknown>>();
		service = new ExternalEventService(new ExternalEventStore(db), bus);
		config = new ExternalEventExtensionConfigStore(db);
	});

	test('registers GitHub routes and RPC handlers when globally enabled', async () => {
		const manager = new ExternalEventExtensionManager();
		const extension = new GitHubEventExtension(db);
		manager.register(extension);
		const routeRegistry = new InMemoryExternalEventRouteRegistry();
		const hub = new MessageHub({ defaultSessionId: 'global' });
		const changes: Array<{ source: string; spaceId?: string; kind: string }> = [];
		const context = {
			publisher: service,
			config,
			routeRegistry,
			onSourceConfigChanged(change: { source: string; spaceId?: string; kind: string }) {
				changes.push(change);
			},
		};

		for (const registered of manager.getAll()) {
			const globalConfig = await context.config.getGlobalConfig(registered.sourceId);
			if (!globalConfig.globallyEnabled) continue;
			if (isHttpExternalEventExtension(registered)) {
				context.routeRegistry.register(registered.routes, context);
			}
			if (isRpcExternalEventExtension(registered)) {
				registered.registerRpcHandlers(hub, context);
			}
			await registered.start(context);
		}

		const watchRepo = getRequestHandler(hub, 'space.github.watchRepo');
		expect(watchRepo).toBeDefined();
		const watchResult = (await watchRepo!({
			spaceId: 'space-1',
			owner: 'acme',
			repo: 'widgets',
			webhookSecret: 'secret',
		})) as { webhookUrl: string };
		expect(watchResult.webhookUrl).toBe('/webhook/github/space');
		expect(changes).toEqual([
			{ source: 'github', spaceId: 'space-1', kind: 'watched_repo_changed' },
		]);

		const payload = githubPayload();
		const raw = JSON.stringify(payload);
		const response = await routeRegistry.handle(
			new Request('http://localhost/webhook/github/space', {
				method: 'POST',
				headers: {
					'X-Hub-Signature-256': await createSignature(raw, 'secret'),
					'X-GitHub-Event': 'issue_comment',
					'X-GitHub-Delivery': generateUUID(),
				},
				body: raw,
			})
		);
		expect(response?.status).toBe(200);

		const stored = db.prepare(`SELECT source, topic, state FROM space_external_events`).get() as {
			source: string;
			topic: string;
			state: string;
		};
		expect(stored).toEqual({
			source: 'github',
			topic: 'github/acme/widgets/pull_request.comment_created',
			state: 'published',
		});
		await extension.stop();
	});

	test('does not register disabled extension routes or RPC handlers', async () => {
		db.prepare(
			`UPDATE external_event_extension_configs SET globally_enabled = 0 WHERE source = 'github'`
		).run();
		const manager = new ExternalEventExtensionManager();
		manager.register(new GitHubEventExtension(db));
		const routeRegistry = new InMemoryExternalEventRouteRegistry();
		const hub = new MessageHub({ defaultSessionId: 'global' });
		const context = {
			publisher: service,
			config,
			routeRegistry,
			onSourceConfigChanged() {},
		};

		for (const registered of manager.getAll()) {
			const globalConfig = await context.config.getGlobalConfig(registered.sourceId);
			if (!globalConfig.globallyEnabled) continue;
			if (isHttpExternalEventExtension(registered)) {
				context.routeRegistry.register(registered.routes, context);
			}
			if (isRpcExternalEventExtension(registered)) {
				registered.registerRpcHandlers(hub, context);
			}
			await registered.start(context);
		}

		expect(
			await routeRegistry.handle(
				new Request('http://localhost/webhook/github/space', { method: 'POST' })
			)
		).toBeNull();
		expect(getRequestHandler(hub, 'space.github.pollOnce')).toBeUndefined();
	});
});
