import { useEffect, useState } from 'preact/hooks';
import { lobbyStore } from '../lib/lobby-store';
import { navigateToRoom } from '../lib/router';
import { createRoomModalSignal } from '../lib/signals';
import { RoomGrid } from '../components/lobby/RoomGrid';
import { CreateRoomModal } from '../components/lobby/CreateRoomModal';
import { MobileMenuButton } from '../components/ui/MobileMenuButton';

export function RoomsPage() {
	const [initialLoad, setInitialLoad] = useState(true);
	const isCreateRoomModalOpen = createRoomModalSignal.value;

	useEffect(() => {
		createRoomModalSignal.value = false;
		lobbyStore.initialize().finally(() => setInitialLoad(false));
		return () => {
			createRoomModalSignal.value = false;
		};
	}, []);

	const rooms = lobbyStore.rooms.value;

	return (
		<div class="flex-1 flex flex-col bg-dark-900 overflow-hidden">
			{/* Mobile menu button */}
			<div class="md:hidden px-4 py-2 border-b border-dark-700">
				<MobileMenuButton />
			</div>

			{/* Grid */}
			<div class="flex-1 overflow-y-auto p-6">
				{initialLoad ? null : (
					<RoomGrid
						rooms={rooms}
						onRoomClick={(room) => navigateToRoom(room.id)}
						onCreateRoom={() => (createRoomModalSignal.value = true)}
					/>
				)}
			</div>

			<CreateRoomModal
				isOpen={isCreateRoomModalOpen}
				onClose={() => (createRoomModalSignal.value = false)}
				onSubmit={async (params) => {
					const room = await lobbyStore.createRoom({
						name: params.name,
						background: params.background,
						templateId: params.templateId,
						templateVariables: params.templateVariables,
					});
					if (room) {
						createRoomModalSignal.value = false;
						navigateToRoom(room.id);
					}
				}}
				templates={lobbyStore.roomTemplates.value}
			/>
		</div>
	);
}
