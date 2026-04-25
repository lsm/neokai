/**
 * AutomationStore - owner-scoped automation registry for the frontend.
 *
 * Uses the MessageHub command protocol for mutations and LiveQuery for the
 * owner-scoped read model, matching the rest of the app's WebSocket-first data
 * flow.
 */

import { computed, signal } from '@preact/signals';
import type {
	AutomationOwnerType,
	AutomationRun,
	AutomationRunFilter,
	AutomationTask,
	CreateAutomationTaskParams,
	LiveQueryDeltaEvent,
	LiveQuerySnapshotEvent,
	UpdateAutomationTaskParams,
} from '@neokai/shared';
import { Logger } from '@neokai/shared';
import { connectionManager } from './connection-manager';
import { EntityStore } from './entity-store';

const logger = new Logger('kai:web:automation-store');

export interface AutomationOwnerRef {
	ownerType: AutomationOwnerType;
	ownerId: string | null;
}

function subscriptionIdForOwner(owner: AutomationOwnerRef): string {
	return `automations-${owner.ownerType}-${owner.ownerId ?? 'global'}`;
}

function ownerKey(owner: AutomationOwnerRef): string {
	return `${owner.ownerType}:${owner.ownerId ?? 'global'}`;
}

class AutomationStore {
	readonly automationStore = new EntityStore<AutomationTask>();

	readonly automations = computed(() => this.automationStore.toArray());

	readonly activeAutomations = computed(() =>
		this.automations.value.filter((automation) => automation.status === 'active')
	);

	readonly isLoading = this.automationStore.loading;
	readonly error = this.automationStore.error;
	readonly currentOwner = signal<AutomationOwnerRef | null>(null);

	private cleanups: Array<() => void> = [];
	private activeSubscriptionIds = new Set<string>();
	private subscribedOwnerKey: string | null = null;

	async subscribeOwner(owner: AutomationOwnerRef): Promise<void> {
		const key = ownerKey(owner);
		if (this.subscribedOwnerKey === key) return;
		this.unsubscribe();
		this.subscribedOwnerKey = key;
		this.currentOwner.value = owner;
		this.isLoading.value = true;

		const subscriptionId = subscriptionIdForOwner(owner);
		try {
			const hub = await connectionManager.getHub();
			if (this.subscribedOwnerKey !== key) return;

			this.activeSubscriptionIds.add(subscriptionId);
			this.cleanups.push(() => this.activeSubscriptionIds.delete(subscriptionId));

			const unsubSnapshot = hub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
				if (event.subscriptionId !== subscriptionId) return;
				if (!this.activeSubscriptionIds.has(subscriptionId)) return;
				this.automationStore.applySnapshot(event.rows as AutomationTask[]);
			});
			this.cleanups.push(unsubSnapshot);

			const unsubDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
				if (event.subscriptionId !== subscriptionId) return;
				if (!this.activeSubscriptionIds.has(subscriptionId)) return;
				this.automationStore.applyDelta(
					event as {
						added?: AutomationTask[];
						removed?: AutomationTask[];
						updated?: AutomationTask[];
					}
				);
			});
			this.cleanups.push(unsubDelta);

			const unsubReconnect = hub.onConnection((state) => {
				if (state !== 'connected') return;
				if (!this.activeSubscriptionIds.has(subscriptionId)) return;
				this.isLoading.value = true;
				hub
					.request('liveQuery.subscribe', {
						queryName: 'automations.byOwner',
						params: [owner.ownerType, owner.ownerId],
						subscriptionId,
					})
					.catch((err) => {
						logger.warn('AutomationStore LiveQuery re-subscribe failed:', err);
						this.isLoading.value = false;
					});
			});
			this.cleanups.push(unsubReconnect);

			await hub.request('liveQuery.subscribe', {
				queryName: 'automations.byOwner',
				params: [owner.ownerType, owner.ownerId],
				subscriptionId,
			});

			if (this.subscribedOwnerKey !== key) {
				this.teardownCleanly();
			}
		} catch (err) {
			this.error.value = err instanceof Error ? err.message : 'Failed to subscribe to automations';
			this.subscribedOwnerKey = null;
			this.currentOwner.value = null;
			this.teardownCleanly();
			logger.error('Failed to subscribe AutomationStore LiveQuery:', err);
			throw err;
		}
	}

	unsubscribe(): void {
		const owner = this.currentOwner.value;
		const subscriptionId = owner ? subscriptionIdForOwner(owner) : null;
		this.subscribedOwnerKey = null;
		this.currentOwner.value = null;
		this.teardownCleanly();
		if (subscriptionId) {
			const hub = connectionManager.getHubIfConnected();
			if (hub) {
				hub.request('liveQuery.unsubscribe', { subscriptionId }).catch(() => {});
			}
		}
		this.automationStore.clear();
	}

	async create(params: CreateAutomationTaskParams): Promise<AutomationTask> {
		const hub = await connectionManager.getHub();
		const response = await hub.request<{ automation: AutomationTask }>('automation.create', params);
		return response.automation;
	}

	async update(id: string, updates: UpdateAutomationTaskParams): Promise<AutomationTask> {
		const hub = await connectionManager.getHub();
		const response = await hub.request<{ automation: AutomationTask }>('automation.update', {
			id,
			updates,
		});
		return response.automation;
	}

	async archive(id: string): Promise<AutomationTask> {
		const hub = await connectionManager.getHub();
		const response = await hub.request<{ automation: AutomationTask }>('automation.archive', {
			id,
		});
		return response.automation;
	}

	async pause(id: string): Promise<AutomationTask> {
		const hub = await connectionManager.getHub();
		const response = await hub.request<{ automation: AutomationTask }>('automation.pause', { id });
		return response.automation;
	}

	async resume(id: string): Promise<AutomationTask> {
		const hub = await connectionManager.getHub();
		const response = await hub.request<{ automation: AutomationTask }>('automation.resume', { id });
		return response.automation;
	}

	async triggerNow(id: string): Promise<AutomationRun> {
		const hub = await connectionManager.getHub();
		const response = await hub.request<{ run: AutomationRun }>('automation.triggerNow', { id });
		return response.run;
	}

	async listRuns(filter: AutomationRunFilter): Promise<AutomationRun[]> {
		const hub = await connectionManager.getHub();
		const response = await hub.request<{ runs: AutomationRun[] }>('automation.listRuns', filter);
		return response.runs;
	}

	async setNextRunAt(id: string, nextRunAt: number | null): Promise<AutomationTask> {
		const hub = await connectionManager.getHub();
		const response = await hub.request<{ automation: AutomationTask }>('automation.setNextRunAt', {
			id,
			nextRunAt,
		});
		return response.automation;
	}

	private teardownCleanly(): void {
		for (const fn of this.cleanups) {
			try {
				fn();
			} catch {
				/* ignore */
			}
		}
		this.cleanups = [];
		this.activeSubscriptionIds.clear();
		this.isLoading.value = false;
	}
}

export const automationStore = new AutomationStore();
