/**
 * RoomGrid Component
 *
 * Displays a grid of room cards with:
 * - Room name and description
 * - Session count indicator
 * - Last updated time
 * - Click to enter room
 */

import type { Room } from '@neokai/shared';
import { RoomIcon, PlusIcon } from '../icons/index.tsx';
import { Button } from '../ui/Button';
import { t } from '../../lib/i18n.ts';

interface RoomGridProps {
	rooms: Room[];
	onRoomClick: (room: Room) => void;
	onCreateRoom: () => void;
}

export function RoomGrid({ rooms, onRoomClick, onCreateRoom }: RoomGridProps) {
	if (rooms.length === 0) {
		return (
			<div class="flex flex-col items-center justify-center py-16">
				<div class="text-center max-w-md">
					<RoomIcon className="w-14 h-14 text-gray-600 mx-auto mb-4" />
					<h3 class="text-lg font-semibold text-gray-100 mb-2">{t('rooms.empty.title')}</h3>
					<p class="text-gray-400 mb-4">
						{t('rooms.empty.desc')}
					</p>
					<p class="text-sm text-gray-500 mb-6">
						{t('rooms.empty.steps')}
					</p>
					<Button onClick={onCreateRoom} icon={<PlusIcon className="w-4 h-4" />}>
						{t('rooms.empty.cta')}
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
			{rooms.map((room) => (
				<RoomCard key={room.id} room={room} onClick={() => onRoomClick(room)} />
			))}
		</div>
	);
}

interface RoomCardProps {
	room: Room;
	onClick: () => void;
}

function RoomCard({ room, onClick }: RoomCardProps) {
	const sessionCount = room.sessionIds.length;
	const isArchived = room.status === 'archived';

	return (
		<button
			type="button"
			onClick={onClick}
			disabled={isArchived}
			class={`group bg-dark-850 border border-dark-700 rounded-lg p-5 text-left transition-all
        ${
					isArchived ? 'opacity-50 cursor-not-allowed' : 'hover:bg-dark-800 hover:border-dark-600'
				}`}
		>
			<div class="flex items-start justify-between mb-3">
				<h3 class="font-semibold text-gray-100 truncate">{room.name}</h3>
				{isArchived && (
					<span class="text-xs bg-dark-700 text-gray-400 px-2 py-0.5 rounded">{t('common.archived')}</span>
				)}
			</div>

			{room.background && <p class="text-sm text-gray-400 mb-4 line-clamp-2">{room.background}</p>}

			<div class="flex items-center gap-4 text-sm">
				<div class="flex items-center gap-1.5">
					<div
						class={`w-2 h-2 rounded-full ${sessionCount > 0 ? 'bg-green-500' : 'bg-gray-500'}`}
					/>
					<span class="text-gray-400">
						{sessionCount !== 1
						? t('common.sessionOther', { count: sessionCount })
						: t('common.sessionOne', { count: sessionCount })}
					</span>
				</div>
			</div>

			<div class="mt-4 pt-4 border-t border-dark-700 flex items-center justify-between">
				<span class="text-xs text-gray-500">{t('common.updated', { time: formatRelativeTime(room.updatedAt) })}</span>
				<span class="text-blue-400 text-sm opacity-0 group-hover:opacity-100 transition-opacity">
					{t('common.enter')}
				</span>
			</div>
		</button>
	);
}

/**
 * Format a timestamp as relative time
 */
function formatRelativeTime(timestamp: number): string {
	const seconds = Math.floor((Date.now() - timestamp) / 1000);
	if (seconds < 60) return t('common.timeJustNow');
	if (seconds < 3600) return t('common.timeMinutes', { count: Math.floor(seconds / 60) });
	if (seconds < 86400) return t('common.timeHours', { count: Math.floor(seconds / 3600) });
	return t('common.timeDays', { count: Math.floor(seconds / 86400) });
}
