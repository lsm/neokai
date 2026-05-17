/**
 * Custom Endpoint RPC Handlers
 *
 * CRUD over user-defined OpenAI-compatible API endpoints. Each mutation
 * writes the full list back to `settings.customEndpoints` and re-syncs the
 * provider registry so changes take effect immediately without a daemon
 * restart.
 */

import type { MessageHub } from '@neokai/shared';
import type { CustomEndpointConfig } from '@neokai/shared';
import type { SettingsManager } from '../settings-manager';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';

function validateEndpoint(config: CustomEndpointConfig): void {
	if (!config?.id || typeof config.id !== 'string')
		throw new Error('Custom endpoint id is required');
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(config.id))
		throw new Error(
			`Custom endpoint id '${config.id}' is invalid (allowed: letters, digits, '.', '_', '-')`
		);
	if (!config.name || typeof config.name !== 'string')
		throw new Error(`Custom endpoint '${config.id}': name is required`);
	if (!config.baseUrl || typeof config.baseUrl !== 'string')
		throw new Error(`Custom endpoint '${config.id}': baseUrl is required`);
	try {
		const url = new URL(config.baseUrl);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new Error('baseUrl must use http:// or https://');
		}
	} catch (err) {
		throw new Error(
			`Custom endpoint '${config.id}': invalid baseUrl — ${err instanceof Error ? err.message : String(err)}`
		);
	}
	if (!Array.isArray(config.models) || config.models.length === 0)
		throw new Error(`Custom endpoint '${config.id}': at least one model is required`);
	const seen = new Set<string>();
	for (const model of config.models) {
		if (!model?.id || typeof model.id !== 'string')
			throw new Error(`Custom endpoint '${config.id}': every model must have an id`);
		if (seen.has(model.id))
			throw new Error(`Custom endpoint '${config.id}': duplicate model id '${model.id}'`);
		seen.add(model.id);
	}
	if (config.defaultModelId && !seen.has(config.defaultModelId)) {
		throw new Error(
			`Custom endpoint '${config.id}': defaultModelId '${config.defaultModelId}' not in models[]`
		);
	}
}

async function persistAndSync(
	settingsManager: SettingsManager,
	internalEventBus: InternalEventBus<DaemonInternalEventMap>,
	endpoints: CustomEndpointConfig[]
): Promise<void> {
	const updated = settingsManager.updateGlobalSettings({ customEndpoints: endpoints });
	const { syncCustomEndpointProviders } = await import('../providers/factory.js');
	await syncCustomEndpointProviders(endpoints);
	internalEventBus.publishAsync('settings.updated', {
		namespaceId: 'global',
		settings: updated,
	});
}

export function registerCustomEndpointHandlers(
	messageHub: MessageHub,
	settingsManager: SettingsManager,
	internalEventBus: InternalEventBus<DaemonInternalEventMap>
): void {
	/** List all configured custom endpoints. */
	messageHub.onRequest('customEndpoints.list', async () => {
		return { endpoints: settingsManager.getGlobalSettings().customEndpoints ?? [] };
	});

	/** Add a new custom endpoint. Rejects when the id already exists. */
	messageHub.onRequest('customEndpoints.add', async (data: { endpoint: CustomEndpointConfig }) => {
		validateEndpoint(data.endpoint);
		const current = settingsManager.getGlobalSettings().customEndpoints ?? [];
		if (current.some((e) => e.id === data.endpoint.id)) {
			throw new Error(`Custom endpoint '${data.endpoint.id}' already exists`);
		}
		const next = [...current, data.endpoint];
		await persistAndSync(settingsManager, internalEventBus, next);
		return { success: true, endpoint: data.endpoint };
	});

	/** Update an existing custom endpoint. Replaces the entry by id. */
	messageHub.onRequest(
		'customEndpoints.update',
		async (data: { endpoint: CustomEndpointConfig }) => {
			validateEndpoint(data.endpoint);
			const current = settingsManager.getGlobalSettings().customEndpoints ?? [];
			const index = current.findIndex((e) => e.id === data.endpoint.id);
			if (index === -1) throw new Error(`Custom endpoint '${data.endpoint.id}' not found`);
			const next = [...current.slice(0, index), data.endpoint, ...current.slice(index + 1)];
			await persistAndSync(settingsManager, internalEventBus, next);
			return { success: true, endpoint: data.endpoint };
		}
	);

	/** Remove a custom endpoint by id. */
	messageHub.onRequest('customEndpoints.remove', async (data: { id: string }) => {
		const current = settingsManager.getGlobalSettings().customEndpoints ?? [];
		const next = current.filter((e) => e.id !== data.id);
		if (next.length === current.length) {
			throw new Error(`Custom endpoint '${data.id}' not found`);
		}
		await persistAndSync(settingsManager, internalEventBus, next);
		return { success: true };
	});
}
