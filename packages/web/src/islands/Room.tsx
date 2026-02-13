/**
 * Room Island Component
 *
 * Main room page component with:
 * - Room dashboard showing sessions and tasks
 * - Neo chat sidebar for AI orchestration
 * - Real-time updates via state channels
 */

import { useEffect, useState } from 'preact/hooks';
import { roomStore } from '../lib/room-store';
import { navigateToHome } from '../lib/router';
import { RoomDashboard } from '../components/room/RoomDashboard';
import { NeoChat } from '../components/room/NeoChat';
import { Skeleton } from '../components/ui/Skeleton';
import { Button } from '../components/ui/Button';

interface RoomProps {
	roomId: string;
}

export default function Room({ roomId }: RoomProps) {
	const [initialLoad, setInitialLoad] = useState(true);

	useEffect(() => {
		roomStore.select(roomId).finally(() => setInitialLoad(false));
		return () => {
			roomStore.select(null);
		};
	}, [roomId]);

	const loading = roomStore.loading.value;
	const error = roomStore.error.value;
	const room = roomStore.room.value;

	if (loading && initialLoad) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<div class="text-center">
					<Skeleton width="200px" height={24} class="mb-4" />
					<Skeleton width="400px" height={16} />
				</div>
			</div>
		);
	}

	if (error && !room) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<div class="text-center">
					<h3 class="text-lg font-semibold text-gray-100 mb-2">Failed to load room</h3>
					<p class="text-gray-400 mb-4">{error}</p>
					<Button onClick={() => roomStore.select(roomId)}>Retry</Button>
				</div>
			</div>
		);
	}

	if (!room) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<div class="text-center">
					<h3 class="text-lg font-semibold text-gray-100 mb-2">Room not found</h3>
					<Button onClick={() => navigateToHome()}>Go Home</Button>
				</div>
			</div>
		);
	}

	return (
		<div class="flex-1 flex flex-col bg-dark-900 overflow-hidden">
			{/* Header */}
			<div class="bg-dark-850/50 backdrop-blur-sm border-b border-dark-700 p-4 flex items-center justify-between">
				<div>
					<h2 class="text-xl font-bold text-gray-100">{room.name}</h2>
					{room.description && <p class="text-sm text-gray-400 mt-1">{room.description}</p>}
				</div>
				<div class="flex gap-2">
					<Button variant="ghost" size="sm" onClick={() => navigateToHome()}>
						Leave Room
					</Button>
				</div>
			</div>

			{/* Main content - split layout */}
			<div class="flex-1 flex overflow-hidden">
				{/* Dashboard - sessions and tasks */}
				<div class="flex-1 overflow-y-auto">
					<RoomDashboard roomId={roomId} />
				</div>

				{/* Neo chat - right sidebar */}
				<div class="w-96 border-l border-dark-700 flex flex-col">
					<NeoChat roomId={roomId} />
				</div>
			</div>
		</div>
	);
}
