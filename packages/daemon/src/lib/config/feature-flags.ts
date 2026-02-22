/**
 * Feature Flags - Gradual rollout control for new features
 *
 * PHASE 3: Feature flag infrastructure for manager-less architecture rollout
 *
 * Supports:
 * - Global on/off flags
 * - Room-specific enablement
 * - Percentage-based rollout
 * - A/B testing groups
 */

import type { Database } from '../../storage';

/**
 * Feature flag definition
 */
export interface FeatureFlag {
	/** Unique flag identifier */
	name: string;
	/** Human-readable description */
	description: string;
	/** Global enabled state (default) */
	enabled: boolean;
	/** Percentage of users who should see this feature (0-100) */
	rolloutPercentage: number;
	/** Specific rooms that are opted in */
	whitelistedRooms: Set<string>;
	/** Specific rooms that are opted out */
	blacklistedRooms: Set<string>;
	/** Feature flag type */
	type: 'boolean' | 'rollout' | 'experiment';
}

/**
 * Feature flag values
 */
export const FeatureFlags = {
	/**
	 * Manager-less Architecture: Direct worker orchestration (PHASE 6 COMPLETE)
	 *
	 * Manager-worker pairs have been removed. WorkerManager is now the only mode.
	 * This flag is kept for historical reference but is always enabled.
	 *
	 * Previous behavior:
	 * - false: Use SessionPairManager (manager-worker pairs) [REMOVED]
	 * - true: Use WorkerManager (worker-only) [CURRENT]
	 */
	WORKER_ONLY_ORCHESTRATION: 'worker_only_orchestration',

	/**
	 * Enable enhanced worker metrics collection
	 */
	ENHANCED_WORKER_TELEMETRY: 'enhanced_worker_telemetry',

	/**
	 * Enable room:chat agent to use worker orchestration (PHASE 5 COMPLETE)
	 *
	 * Both room:chat and room:self now use the same WorkerManager orchestration.
	 * This flag is kept for historical reference but is always enabled.
	 */
	ROOM_CHAT_WORKER_SPAWNING: 'room_chat_worker_spawning',
} as const;

export type FeatureFlagName = (typeof FeatureFlags)[keyof typeof FeatureFlags];

/**
 * Feature flag service
 */
export class FeatureFlagService {
	private flags: Map<string, FeatureFlag> = new Map();

	constructor(_db?: Database) {
		this.initializeFlags();
		// TODO: Load persisted flag values from database if provided
	}

	/**
	 * Initialize default feature flags
	 */
	private initializeFlags(): void {
		// PHASE 6: Worker-only orchestration - Now the default (manager removed)
		this.flags.set(FeatureFlags.WORKER_ONLY_ORCHESTRATION, {
			name: FeatureFlags.WORKER_ONLY_ORCHESTRATION,
			description:
				'Use direct worker orchestration (PHASE 6: Manager removed, this is now the only mode)',
			enabled: true, // PHASE 6: Always enabled
			rolloutPercentage: 100, // PHASE 6: Fully rolled out
			whitelistedRooms: new Set(),
			blacklistedRooms: new Set(),
			type: 'boolean', // PHASE 6: Changed from 'rollout' to 'boolean'
		});

		// Enhanced telemetry - ON by default for data collection
		this.flags.set(FeatureFlags.ENHANCED_WORKER_TELEMETRY, {
			name: FeatureFlags.ENHANCED_WORKER_TELEMETRY,
			description: 'Enable enhanced metrics collection for worker orchestration',
			enabled: true,
			rolloutPercentage: 100,
			whitelistedRooms: new Set(),
			blacklistedRooms: new Set(),
			type: 'boolean',
		});

		// Room:chat worker spawning - Now always enabled (PHASE 5: Unified architecture)
		this.flags.set(FeatureFlags.ROOM_CHAT_WORKER_SPAWNING, {
			name: FeatureFlags.ROOM_CHAT_WORKER_SPAWNING,
			description:
				'Enable room:chat to spawn workers directly (PHASE 5: Both room modes use same orchestration)',
			enabled: true, // PHASE 5: Always enabled after unification
			rolloutPercentage: 100,
			whitelistedRooms: new Set(),
			blacklistedRooms: new Set(),
			type: 'boolean', // PHASE 5: Changed from 'rollout' to 'boolean'
		});
	}

	/**
	 * Check if a feature flag is enabled for a specific room
	 *
	 * Priority order:
	 * 1. Blacklisted rooms (always false)
	 * 2. Whitelisted rooms (always true)
	 * 3. Rollout percentage (hash-based)
	 * 4. Global enabled state
	 */
	isEnabled(flagName: string, roomId?: string): boolean {
		const flag = this.flags.get(flagName);
		if (!flag) {
			return false;
		}

		// Check blacklist first (highest priority)
		if (roomId && flag.blacklistedRooms.has(roomId)) {
			return false;
		}

		// Check whitelist
		if (roomId && flag.whitelistedRooms.has(roomId)) {
			return true;
		}

		// For rollout/experiment flags, use percentage-based rollout
		if (flag.type === 'rollout' && roomId && flag.rolloutPercentage > 0) {
			return this.isRoomInRollout(roomId, flag.rolloutPercentage);
		}

		// Fall back to global enabled state
		return flag.enabled;
	}

	/**
	 * Determine if a room is in the rollout percentage
	 *
	 * Uses a hash of the room ID for consistent assignment
	 */
	private isRoomInRollout(roomId: string, percentage: number): boolean {
		// Simple hash function for room ID
		let hash = 0;
		for (let i = 0; i < roomId.length; i++) {
			const char = roomId.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash; // Convert to 32-bit integer
		}

		// Use absolute value of hash modulo 100 to get 0-99
		const bucket = Math.abs(hash) % 100;
		return bucket < percentage;
	}

	/**
	 * Get a feature flag by name
	 */
	getFlag(flagName: string): FeatureFlag | undefined {
		return this.flags.get(flagName);
	}

	/**
	 * Get all feature flags
	 */
	getAllFlags(): FeatureFlag[] {
		return Array.from(this.flags.values());
	}

	/**
	 * Update a feature flag
	 */
	updateFlag(
		flagName: string,
		updates: Partial<Pick<FeatureFlag, 'enabled' | 'rolloutPercentage' | 'type'>>
	): boolean {
		const flag = this.flags.get(flagName);
		if (!flag) {
			return false;
		}

		Object.assign(flag, updates);
		return true;
	}

	/**
	 * Add a room to the whitelist for a flag
	 */
	whitelistRoom(flagName: string, roomId: string): boolean {
		const flag = this.flags.get(flagName);
		if (!flag) {
			return false;
		}

		flag.whitelistedRooms.add(roomId);
		return true;
	}

	/**
	 * Remove a room from the whitelist for a flag
	 */
	unwhitelistRoom(flagName: string, roomId: string): boolean {
		const flag = this.flags.get(flagName);
		if (!flag) {
			return false;
		}

		return flag.whitelistedRooms.delete(roomId);
	}

	/**
	 * Add a room to the blacklist for a flag
	 */
	blacklistRoom(flagName: string, roomId: string): boolean {
		const flag = this.flags.get(flagName);
		if (!flag) {
			return false;
		}

		flag.blacklistedRooms.add(roomId);
		return true;
	}

	/**
	 * Remove a room from the blacklist for a flag
	 */
	unblacklistRoom(flagName: string, roomId: string): boolean {
		const flag = this.flags.get(flagName);
		if (!flag) {
			return false;
		}

		return flag.blacklistedRooms.delete(roomId);
	}

	/**
	 * Get the rollout status for a flag
	 */
	getRolloutStatus(flagName: string): {
		enabled: boolean;
		rolloutPercentage: number;
		whitelistedRooms: string[];
		blacklistedRooms: string[];
		type: string;
	} | null {
		const flag = this.flags.get(flagName);
		if (!flag) {
			return null;
		}

		return {
			enabled: flag.enabled,
			rolloutPercentage: flag.rolloutPercentage,
			whitelistedRooms: Array.from(flag.whitelistedRooms),
			blacklistedRooms: Array.from(flag.blacklistedRooms),
			type: flag.type,
		};
	}

	/**
	 * Increase rollout percentage for a flag
	 *
	 * Returns the new percentage, or null if flag not found
	 */
	increaseRollout(flagName: string, increment: number = 10): number | null {
		const flag = this.flags.get(flagName);
		if (!flag) {
			return null;
		}

		flag.rolloutPercentage = Math.min(100, flag.rolloutPercentage + increment);
		return flag.rolloutPercentage;
	}

	/**
	 * Set rollout percentage for a flag
	 */
	setRolloutPercentage(flagName: string, percentage: number): boolean {
		const flag = this.flags.get(flagName);
		if (!flag) {
			return false;
		}

		if (percentage < 0 || percentage > 100) {
			return false;
		}

		flag.rolloutPercentage = percentage;
		return true;
	}
}

/**
 * Singleton instance for the application
 */
let globalFeatureFlagService: FeatureFlagService | null = null;

export function getFeatureFlagService(db?: Database): FeatureFlagService {
	if (!globalFeatureFlagService) {
		globalFeatureFlagService = new FeatureFlagService(db);
	}
	return globalFeatureFlagService;
}
