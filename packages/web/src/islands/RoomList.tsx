import type { Room } from '@neokai/shared';
import { lobbyStore } from '../lib/lobby-store.ts';
import { roomStore } from '../lib/room-store.ts';
import { navigateToRoom } from '../lib/router.ts';

interface RoomListProps {
	/** Called when a room is selected (for mobile drawer close) */
	onRoomSelect?: () => void;
}

export function RoomList({ onRoomSelect }: RoomListProps) {
	const rooms = lobbyStore.rooms.value;
	const activeRoomId = roomStore.roomId.value;
	const reviewTaskCount = roomStore.reviewTaskCount.value;

	const handleRoomClick = (roomId: string) => {
		navigateToRoom(roomId);
		onRoomSelect?.();
	};

	return (
		<div class="flex-1 overflow-y-auto">
			{rooms.length === 0 && (
				<div class="p-6 text-center">
					<div class="text-4xl mb-3">🏢</div>
					<p class="text-sm text-gray-400">No rooms yet.</p>
					<p class="text-xs text-gray-500 mt-1">Create a room to organize your work!</p>
				</div>
			)}

			{rooms.map((room) => (
				<RoomListItem
					key={room.id}
					room={room}
					onClick={() => handleRoomClick(room.id)}
					reviewCount={activeRoomId === room.id ? reviewTaskCount : 0}
				/>
			))}
		</div>
	);
}

interface RoomListItemProps {
	room: Room;
	onClick: () => void;
	reviewCount?: number;
}

function RoomListItem({ room, onClick, reviewCount }: RoomListItemProps) {
	const sessionCount = room.sessionIds.length;
	const isArchived = room.status === 'archived';
	const hasReview = (reviewCount ?? 0) > 0;

	return (
		<button
			type="button"
			onClick={onClick}
			disabled={isArchived}
			class={`w-full px-4 py-3 text-left border-b border-dark-700 transition-colors
				${isArchived ? 'opacity-50 cursor-not-allowed' : 'hover:bg-dark-800'}`}
		>
			<div class="flex items-center justify-between">
				<h3 class="font-medium text-gray-100 truncate text-sm">{room.name}</h3>
				<div class="flex items-center gap-1.5 flex-shrink-0">
					{hasReview && (
						<span class="text-xs bg-purple-800/60 text-purple-300 px-1.5 py-0.5 rounded-full font-medium">
							{reviewCount} review{reviewCount !== 1 ? 's' : ''}
						</span>
					)}
					{isArchived && (
						<span class="text-xs bg-dark-700 text-gray-400 px-2 py-0.5 rounded">Archived</span>
					)}
				</div>
			</div>
			{room.background && <p class="text-xs text-gray-500 mt-1 truncate">{room.background}</p>}
			<div class="flex items-center gap-3 mt-2 text-xs text-gray-400">
				<div class="flex items-center gap-1.5">
					<div
						class={`w-1.5 h-1.5 rounded-full ${sessionCount > 0 ? 'bg-green-500' : 'bg-gray-500'}`}
					/>
					<span>
						{sessionCount} session{sessionCount !== 1 ? 's' : ''}
					</span>
				</div>
			</div>
		</button>
	);
}
