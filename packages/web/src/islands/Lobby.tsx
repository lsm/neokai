/**
 * Lobby Island Component
 *
 * Main lobby page component with:
 * - Global status stats
 * - Recent sessions section
 * - Room grid with cards
 * - Create Room modal
 * - New Session modal
 * - Real-time updates via WebSocket subscriptions
 */

import { useEffect, useState } from 'preact/hooks';
import { lobbyStore } from '../lib/lobby-store';
import { globalStore } from '../lib/global-store';
import { navigateToRoom, navigateToSession } from '../lib/router';
import { GlobalStatus } from '../components/lobby/GlobalStatus';
import { RoomGrid } from '../components/lobby/RoomGrid';
import { CreateRoomModal } from '../components/lobby/CreateRoomModal';
import { NewSessionModal } from '../components/lobby/NewSessionModal';
import { Skeleton } from '../components/ui/Skeleton';
import { Button } from '../components/ui/Button';
import { useModal } from '../hooks/useModal';
import { getRecentPaths, addRecentPath } from '../lib/recent-paths';
import { formatRelativeTime } from '../lib/utils';
import { createSession } from '../lib/api-helpers';
import { toast } from '../lib/toast';
import { lobbyManagerOpenSignal } from '../lib/signals';
import { LobbyManagerPanel } from './LobbyManagerPanel';

export default function Lobby() {
	const [initialLoad, setInitialLoad] = useState(true);
	const createRoomModal = useModal();
	const newSessionModal = useModal();

	useEffect(() => {
		lobbyStore.initialize().finally(() => setInitialLoad(false));

		return () => {
			// Cleanup on unmount is optional - lobby store is a singleton
		};
	}, []);

	const loading = lobbyStore.loading.value;
	const rooms = lobbyStore.rooms.value;
	const error = lobbyStore.error.value;
	// Use globalStore.recentSessions which is already fetched at app startup
	// and filtered to show active sessions sorted by lastActiveAt
	const recentSessions = globalStore.activeSessions.value.slice(0, 5);
	const recentPaths = getRecentPaths().map((p) => ({
		path: p.path,
		relativeTime: formatRelativeTime(p.usedAt),
		absoluteTime: p.usedAt,
	}));

	async function handleCreateSession(params: { workspacePath: string; roomId?: string }) {
		try {
			const { sessionId } = await createSession({
				workspacePath: params.workspacePath,
				roomId: params.roomId,
				createdBy: 'human',
			});

			// Add to recent paths
			addRecentPath(params.workspacePath);

			// Navigate to session
			navigateToSession(sessionId);
			newSessionModal.close();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to create session');
			throw err;
		}
	}

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
				<div class="flex gap-2">
					<Button
						variant="secondary"
						onClick={() => {
							lobbyManagerOpenSignal.value = !lobbyManagerOpenSignal.value;
						}}
						icon={
							<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
								/>
							</svg>
						}
					>
						Lobby Manager
					</Button>
					<Button variant="secondary" onClick={newSessionModal.open} icon="+">
						New Session
					</Button>
					<Button onClick={createRoomModal.open} icon="+">
						Create Room
					</Button>
				</div>
			</div>

			{/* Global Status */}
			<GlobalStatus />

			{/* Content */}
			<div class="flex-1 overflow-y-auto p-6">
				{/* Recent Sessions Section */}
				{recentSessions.length > 0 && (
					<div class="mb-8">
						<div class="flex items-center justify-between mb-4">
							<h3 class="text-lg font-semibold text-gray-100">Recent Sessions</h3>
						</div>
						<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
							{recentSessions.map((session) => {
								// Find room for this session
								const room = rooms.find((r) => r.sessionIds.includes(session.id));
								return (
									<button
										key={session.id}
										onClick={() => navigateToSession(session.id)}
										class="bg-dark-800 hover:bg-dark-750 border border-dark-700 rounded-lg p-4 text-left transition-colors"
									>
										<div class="flex items-start gap-3">
											<div class="flex-shrink-0 w-10 h-10 rounded-lg bg-blue-900/30 flex items-center justify-center">
												<svg
													class="w-5 h-5 text-blue-400"
													fill="none"
													viewBox="0 0 24 24"
													stroke="currentColor"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width={2}
														d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
													/>
												</svg>
											</div>
											<div class="flex-1 min-w-0">
												<div class="text-sm font-medium text-gray-100 truncate">
													{session.title}
												</div>
												<div class="text-xs text-gray-500 truncate mt-0.5">
													{session.workspacePath}
												</div>
												<div class="flex items-center gap-2 mt-2">
													{room && (
														<span class="text-xs px-2 py-0.5 rounded-full bg-purple-900/30 text-purple-400">
															{room.name}
														</span>
													)}
													<span class="text-xs text-gray-500">
														{formatRelativeTime(new Date(session.lastActiveAt))}
													</span>
												</div>
											</div>
										</div>
									</button>
								);
							})}
						</div>
					</div>
				)}

				{/* Room Grid */}
				<div>
					<div class="flex items-center justify-between mb-4">
						<h3 class="text-lg font-semibold text-gray-100">Rooms</h3>
					</div>
					<RoomGrid
						rooms={rooms}
						onRoomClick={(room) => navigateToRoom(room.id)}
						onCreateRoom={createRoomModal.open}
					/>
				</div>
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

			{/* New Session Modal */}
			<NewSessionModal
				isOpen={newSessionModal.isOpen}
				onClose={newSessionModal.close}
				onSubmit={handleCreateSession}
				recentPaths={recentPaths}
				rooms={rooms}
				onCreateRoom={async (params) => {
					const room = await lobbyStore.createRoom(params);
					return room;
				}}
			/>

			{/* Lobby Manager Panel */}
			<LobbyManagerPanel />
		</div>
	);
}
