/**
 * useRoomLiveQuery Hook
 *
 * Lifecycle adapter that manages LiveQuery subscriptions for a room.
 *
 * Responsibilities:
 * - On mount: call roomStore.subscribeRoom(roomId)
 * - On roomId change: call roomStore.unsubscribeRoom(oldRoomId) then
 *   roomStore.subscribeRoom(newRoomId)
 * - On unmount: call roomStore.unsubscribeRoom(roomId)
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
 *
 * @example
 * ```tsx
 * export default function Room({ roomId }: { roomId: string }) {
 *   useRoomLiveQuery(roomId);
 *   // ...
 * }
 * ```
 */
export function useRoomLiveQuery(roomId: string): void {
	useEffect(() => {
		roomStore.subscribeRoom(roomId);
		return () => {
			roomStore.unsubscribeRoom(roomId);
		};
	}, [roomId]);
}
