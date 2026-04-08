/**
 * useRoomLiveQuery Hook
 *
 * Lifecycle adapter that manages LiveQuery subscriptions for a room.
 *
 * Responsibilities:
 * - Tasks LiveQuery: always subscribed (used by tasks tab, overview stats,
 *   and review notification banner).
 * - Goals LiveQuery: always subscribed. Although the full goals editor only
 *   renders on the goals tab, goal-derived signals (activeGoals, goalByTaskId)
 *   are consumed by RoomContextPanel (sidebar), RoomTasks (mission badges),
 *   TaskHeader (slide-over), and MissionDetail (slide-over). Making goals
 *   conditional would leave these consumers with stale or empty data.
 * - Skills LiveQuery: subscribed only when activeTab is 'agents' or 'settings',
 *   unsubscribed when leaving those tabs.
 *
 * The `activeTab` parameter must be passed from the parent (Room.tsx) rather
 * than read from a signal inside the hook. Preact Signals read inside a
 * useEffect dependency array will NOT automatically re-run when the signal
 * changes — the parent re-renders on signal change and passes the new value
 * as a prop, which correctly triggers the effect.
 *
 * The store owns the subscription handles and cleanup logic.
 * This hook is purely a lifecycle adapter between the Preact component
 * tree and the room store's LiveQuery methods.
 */

import { useEffect } from 'preact/hooks';
import { roomStore } from '../lib/room-store';

/**
 * Manages the LiveQuery subscription lifecycle for a room.
 *
 * Must be mounted inside or alongside a component that is unconditionally
 * rendered for the duration of the room view (e.g., the Room island).
 *
 * @param roomId - The ID of the room to subscribe to.
 * @param activeTab - The currently active room tab, passed from the parent
 *   component. Controls conditional subscriptions (skills).
 *
 * @example
 * ```tsx
 * export default function Room({ roomId }: { roomId: string }) {
 *   const activeTab = currentRoomActiveTabSignal.value ?? 'overview';
 *   useRoomLiveQuery(roomId, activeTab);
 *   // ...
 * }
 * ```
 */
export function useRoomLiveQuery(roomId: string, activeTab: string | null): void {
	// Tasks LiveQuery — always active for the room.
	useEffect(() => {
		roomStore.subscribeRoomTasks(roomId);
		return () => {
			roomStore.unsubscribeRoomTasks(roomId);
		};
	}, [roomId]);

	// Goals LiveQuery — always active.
	// See module-level JSDoc for the goals consumer audit rationale.
	useEffect(() => {
		roomStore.subscribeRoomGoals(roomId);
		return () => {
			roomStore.unsubscribeRoomGoals(roomId);
		};
	}, [roomId]);

	// Skills LiveQuery — active only when agents or settings tab is showing.
	useEffect(() => {
		if (activeTab === 'agents' || activeTab === 'settings') {
			roomStore.subscribeRoomSkills(roomId);
			return () => {
				roomStore.unsubscribeRoomSkills(roomId);
			};
		}
		return undefined;
	}, [roomId, activeTab]);
}
