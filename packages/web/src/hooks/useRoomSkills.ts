/**
 * useRoomSkills Hook
 *
 * Thin hook over roomStore.roomSkills signal.
 * Returns the effective per-room skill list (global enabled merged with room
 * overrides by the skills.byRoom LiveQuery JOIN) plus RPC helpers to set/clear
 * per-room overrides.
 *
 * Mutations are fire-and-forget at the call site: the LiveQuery delta will
 * deliver the update automatically so there is no need to refresh manually.
 */

import type { EffectiveRoomSkill } from '../lib/room-store';
import { roomStore } from '../lib/room-store';
import { connectionManager } from '../lib/connection-manager';

export interface UseRoomSkillsResult {
	skills: EffectiveRoomSkill[];
	setOverride: (skillId: string, enabled: boolean) => Promise<void>;
	clearOverride: (skillId: string) => Promise<void>;
}

/**
 * Returns the effective skills list for the current room plus mutation helpers.
 *
 * Reading `skills` inside a Preact component body (or render function) causes
 * Preact Signals to subscribe the component to `roomStore.roomSkills` — no
 * manual subscription wiring needed.
 *
 * @param roomId - The room whose skills to manage.
 *
 * @example
 * ```tsx
 * const { skills, setOverride, clearOverride } = useRoomSkills(roomId);
 * ```
 */
export function useRoomSkills(roomId: string): UseRoomSkillsResult {
	// Reactive read: Preact tracks this .value access and re-renders the
	// component whenever roomStore.roomSkills changes.
	const skills = roomStore.roomSkills.value;

	const setOverride = async (skillId: string, enabled: boolean): Promise<void> => {
		const hub = await connectionManager.getHub();
		await hub.request('room.setSkillOverride', { roomId, skillId, enabled });
	};

	const clearOverride = async (skillId: string): Promise<void> => {
		const hub = await connectionManager.getHub();
		await hub.request('room.clearSkillOverride', { roomId, skillId });
	};

	return { skills, setOverride, clearOverride };
}
