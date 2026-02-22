/**
 * RPC Handlers for Telemetry and Feature Flags
 *
 * PHASE 3: RPC endpoints for:
 * - Viewing worker telemetry metrics
 * - Managing feature flags
 * - Rollout control
 */

import type { DaemonHub } from '../daemon-hub';
import type { MessageHub } from '@neokai/shared';
import type { FeatureFlagService } from '../config/feature-flags';
import type { WorkerTelemetry } from '../telemetry/worker-telemetry';

/**
 * Register telemetry and feature flag RPC handlers
 */
export function registerTelemetryHandlers(params: {
	messageHub: MessageHub;
	daemonHub: DaemonHub;
	featureFlagService: FeatureFlagService;
	workerTelemetry: WorkerTelemetry;
}): void {
	const { messageHub, daemonHub, featureFlagService, workerTelemetry } = params;

	// Feature flag management

	messageHub.onRequest('feature_flag.get', async ({ flagName }: { flagName: string }) => {
		const flag = featureFlagService.getFlag(flagName);
		if (!flag) {
			throw new Error(`Feature flag not found: ${flagName}`);
		}
		return {
			name: flag.name,
			description: flag.description,
			enabled: flag.enabled,
			rolloutPercentage: flag.rolloutPercentage,
			whitelistedRooms: Array.from(flag.whitelistedRooms),
			blacklistedRooms: Array.from(flag.blacklistedRooms),
			type: flag.type,
		};
	});

	messageHub.onRequest('feature_flag.list', async () => {
		const flags = featureFlagService.getAllFlags();
		return flags.map((flag) => ({
			name: flag.name,
			description: flag.description,
			enabled: flag.enabled,
			rolloutPercentage: flag.rolloutPercentage,
			whitelistedRooms: flag.whitelistedRooms.size,
			blacklistedRooms: flag.blacklistedRooms.size,
			type: flag.type,
		}));
	});

	messageHub.onRequest(
		'feature_flag.isEnabled',
		async ({ flagName, roomId }: { flagName: string; roomId?: string }) => {
			return {
				enabled: featureFlagService.isEnabled(flagName, roomId),
			};
		}
	);

	messageHub.onRequest(
		'feature_flag.update',
		async ({
			flagName,
			updates,
		}: {
			flagName: string;
			updates: { enabled?: boolean; rolloutPercentage?: number };
		}) => {
			const success = featureFlagService.updateFlag(flagName, updates);
			if (!success) {
				throw new Error(`Failed to update feature flag: ${flagName}`);
			}

			// Emit event for monitoring
			await daemonHub.emit('featureFlag.updated', {
				sessionId: 'system',
				flagName,
				updates,
			});

			return { success: true };
		}
	);

	messageHub.onRequest(
		'feature_flag.setRollout',
		async ({ flagName, percentage }: { flagName: string; percentage: number }) => {
			const success = featureFlagService.setRolloutPercentage(flagName, percentage);
			if (!success) {
				throw new Error(`Failed to set rollout for feature flag: ${flagName}`);
			}

			await daemonHub.emit('featureFlag.rolloutChanged', {
				sessionId: 'system',
				flagName,
				percentage,
			});

			return { success: true, newPercentage: percentage };
		}
	);

	messageHub.onRequest(
		'feature_flag.increaseRollout',
		async ({ flagName, increment }: { flagName: string; increment?: number }) => {
			const newPercentage = featureFlagService.increaseRollout(flagName, increment);
			if (newPercentage === null) {
				throw new Error(`Failed to increase rollout for feature flag: ${flagName}`);
			}

			await daemonHub.emit('featureFlag.rolloutChanged', {
				sessionId: 'system',
				flagName,
				percentage: newPercentage,
			});

			return { success: true, newPercentage };
		}
	);

	messageHub.onRequest(
		'feature_flag.whitelistRoom',
		async ({ flagName, roomId }: { flagName: string; roomId: string }) => {
			const success = featureFlagService.whitelistRoom(flagName, roomId);
			if (!success) {
				throw new Error(`Failed to whitelist room for feature flag: ${flagName}`);
			}

			await daemonHub.emit('featureFlag.roomWhitelisted', {
				sessionId: 'system',
				flagName,
				roomId,
			});

			return { success: true };
		}
	);

	messageHub.onRequest(
		'feature_flag.blacklistRoom',
		async ({ flagName, roomId }: { flagName: string; roomId: string }) => {
			const success = featureFlagService.blacklistRoom(flagName, roomId);
			if (!success) {
				throw new Error(`Failed to blacklist room for feature flag: ${flagName}`);
			}

			await daemonHub.emit('featureFlag.roomBlacklisted', {
				sessionId: 'system',
				flagName,
				roomId,
			});

			return { success: true };
		}
	);

	// Telemetry queries

	messageHub.onRequest('telemetry.getRoomMetrics', async ({ roomId }: { roomId: string }) => {
		const metrics = workerTelemetry.getRoomMetrics(roomId);
		if (!metrics) {
			return { roomId, metrics: null };
		}

		return {
			roomId,
			metrics: {
				workerOnly: {
					totalTasks: metrics.workerOnly.totalTasks,
					completedTasks: metrics.workerOnly.completedTasks,
					failedTasks: metrics.workerOnly.failedTasks,
					successRate:
						metrics.workerOnly.totalTasks > 0
							? (metrics.workerOnly.completedTasks / metrics.workerOnly.totalTasks) * 100
							: 0,
					avgDurationMs: metrics.workerOnly.avgDurationMs,
				},
				managerWorker: {
					totalTasks: metrics.managerWorker.totalTasks,
					completedTasks: metrics.managerWorker.completedTasks,
					failedTasks: metrics.managerWorker.failedTasks,
					successRate:
						metrics.managerWorker.totalTasks > 0
							? (metrics.managerWorker.completedTasks / metrics.managerWorker.totalTasks) * 100
							: 0,
					avgDurationMs: metrics.managerWorker.avgDurationMs,
				},
			},
		};
	});

	messageHub.onRequest(
		'telemetry.getRoomEvents',
		async ({ roomId, limit }: { roomId: string; limit?: number }) => {
			const events = workerTelemetry.getRoomLifecycleEvents(roomId);
			return {
				roomId,
				events: limit ? events.slice(-limit) : events,
			};
		}
	);

	messageHub.onRequest('telemetry.getRecentEvents', async ({ limit }: { limit?: number }) => {
		const events = workerTelemetry.getRecentEvents(limit);
		return { events };
	});

	messageHub.onRequest('telemetry.getSummary', async () => {
		const summary = workerTelemetry.getSummary();
		return summary;
	});

	messageHub.onRequest(
		'telemetry.clearMetrics',
		async ({ olderThanMs }: { olderThanMs?: number }) => {
			const cleared = workerTelemetry.clearMetrics(olderThanMs);
			return { cleared };
		}
	);

	// Combined rollout status and metrics

	messageHub.onRequest('telemetry.getRolloutStatus', async ({ flagName }: { flagName: string }) => {
		const status = featureFlagService.getRolloutStatus(flagName);
		if (!status) {
			throw new Error(`Feature flag not found: ${flagName}`);
		}

		// Get telemetry summary for context
		const summary = workerTelemetry.getSummary();

		return {
			flag: status,
			telemetry: {
				totalTasksTracked: summary.totalTasksTracked,
				workerOnlyTasks: summary.workerOnlyTasks,
				managerWorkerTasks: summary.managerWorkerTasks,
				roomsTracked: summary.roomsTracked,
			},
		};
	});
}
