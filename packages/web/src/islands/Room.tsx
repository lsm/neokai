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
import { Skeleton } from '../components/ui/Skeleton';
import { Button } from '../components/ui/Button';
import { IconButton } from '../components/ui/IconButton';
import { neoChatOpenSignal } from '../lib/signals';

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
					<IconButton
						onClick={() => (neoChatOpenSignal.value = !neoChatOpenSignal.value)}
						title={neoChatOpenSignal.value ? 'Hide Neo Chat' : 'Show Neo Chat'}
						variant={neoChatOpenSignal.value ? 'solid' : 'ghost'}
					>
						<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
							/>
						</svg>
					</IconButton>
					<Button variant="ghost" size="sm" onClick={() => navigateToHome()}>
						Leave Room
					</Button>
				</div>
			</div>

			{/* Main content - full width dashboard */}
			<div class="flex-1 overflow-y-auto">
				<RoomDashboard />
			</div>
		</div>
	);
}
