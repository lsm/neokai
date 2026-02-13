/**
 * Lobby Island Component
 *
 * Main lobby page component with:
 * - Global status stats
 * - Room grid with cards
 * - Create Room modal
 * - Real-time updates via WebSocket subscriptions
 */

import { useEffect, useState } from 'preact/hooks';
import { lobbyStore } from '../lib/lobby-store';
import { navigateToRoom } from '../lib/router';
import { GlobalStatus } from '../components/lobby/GlobalStatus';
import { RoomGrid } from '../components/lobby/RoomGrid';
import { CreateRoomModal } from '../components/lobby/CreateRoomModal';
import { Skeleton } from '../components/ui/Skeleton';
import { Button } from '../components/ui/Button';
import { useModal } from '../hooks/useModal';

export default function Lobby() {
	const [initialLoad, setInitialLoad] = useState(true);
	const createRoomModal = useModal();

	useEffect(() => {
		lobbyStore.initialize().finally(() => setInitialLoad(false));
		return () => {
			// Cleanup on unmount is optional - lobby store is a singleton
		};
	}, []);

	const loading = lobbyStore.loading.value;
	const rooms = lobbyStore.rooms.value;
	const error = lobbyStore.error.value;

	if (loading && initialLoad) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<div class="text-center">
					<Skeleton width="300px" height={24} class="mb-4" />
					<Skeleton width="500px" height={16} />
				</div>
			</div>
		);
	}

	if (error && rooms.length === 0) {
		return (
			<div class="flex-1 flex items-center justify-center bg-dark-900">
				<div class="text-center">
					<h3 class="text-lg font-semibold text-gray-100 mb-2">Failed to load lobby</h3>
					<p class="text-gray-400 mb-4">{error}</p>
					<Button onClick={() => lobbyStore.refresh()}>Retry</Button>
				</div>
			</div>
		);
	}

	return (
		<div class="flex-1 flex flex-col bg-dark-900 overflow-hidden">
			{/* Header */}
			<div class="bg-dark-850/50 backdrop-blur-sm border-b border-dark-700 p-4 flex items-center justify-between">
				<div>
					<h2 class="text-xl font-bold text-gray-100">Neo Lobby</h2>
					<p class="text-sm text-gray-400">Manage your AI-powered workspaces</p>
				</div>
				<Button onClick={createRoomModal.open} icon="+">
					Create Room
				</Button>
			</div>

			{/* Global Status */}
			<GlobalStatus />

			{/* Room Grid */}
			<div class="flex-1 overflow-y-auto p-6">
				<RoomGrid
					rooms={rooms}
					onRoomClick={(room) => navigateToRoom(room.id)}
					onCreateRoom={createRoomModal.open}
				/>
			</div>

			{/* Create Room Modal */}
			<CreateRoomModal
				isOpen={createRoomModal.isOpen}
				onClose={createRoomModal.close}
				onSubmit={async (params) => {
					const room = await lobbyStore.createRoom(params);
					if (room) {
						createRoomModal.close();
						navigateToRoom(room.id);
					}
				}}
			/>
		</div>
	);
}
