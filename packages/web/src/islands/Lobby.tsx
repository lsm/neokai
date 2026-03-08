/**
 * Lobby Island Component
 *
 * Main lobby page component with:
 * - Global status stats
 * - Recent sessions section
 * - Room grid with cards
 * - Lobby chat for instance-level AI interaction (unified session architecture)
 * - Create Room modal
 * - New Session modal
 * - Real-time updates via WebSocket subscriptions
 *
 * Unified Session Architecture:
 * - Lobby chat uses ChatContainer with sessionId='lobby:default'
 * - Feature flags disabled for lobby sessions
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
import { createRoomModalSignal } from '../lib/signals';
import { isUserSession } from '../lib/session-utils';
import { MobileMenuButton } from '../components/ui/MobileMenuButton';
import { t } from '../lib/i18n.ts';

export default function Lobby() {
	const [initialLoad, setInitialLoad] = useState(true);
	const isCreateRoomModalOpen = createRoomModalSignal.value;
	const newSessionModal = useModal();

	useEffect(() => {
		// Reset modal signal on mount to clear any stale open state set while Lobby was unmounted
		createRoomModalSignal.value = false;
		lobbyStore.initialize().finally(() => setInitialLoad(false));

		return () => {
			// Reset modal signal on unmount so the signal is clean for subsequent mounts
			createRoomModalSignal.value = false;
		};
	}, []);

	const loading = lobbyStore.loading.value;
	const rooms = lobbyStore.rooms.value;
	const error = lobbyStore.error.value;
	// Only show user-created sessions (not internal Room Runtime agents)
	const recentSessions = globalStore.activeSessions.value.filter(isUserSession).slice(0, 5);
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
					<h3 class="text-lg font-semibold text-gray-100 mb-2">{t('lobby.failedToLoad')}</h3>
					<p class="text-gray-400 mb-4">{error}</p>
					<Button onClick={() => lobbyStore.refresh()}>Retry</Button>
				</div>
			</div>
		);
	}

	return (
		<div class="flex-1 flex flex-col bg-dark-900 overflow-hidden">
			{/* Header - compact on mobile, expanded on desktop */}
			<div class="bg-dark-850/50 backdrop-blur-sm border-b border-dark-700 px-3 py-2 md:px-4 md:py-4">
				<div class="flex items-center justify-between gap-2">
					<MobileMenuButton />
					{/* Mobile: title only (no subtitle to save space) */}
					<div class="min-w-0 flex-1">
						<h2 class="text-lg md:text-xl font-bold text-gray-100 truncate">Neo Lobby</h2>
						<p class="hidden md:block text-sm text-gray-400 mt-0.5">Your agent command center</p>
					</div>
					{/* Desktop: full buttons with text */}
					<div class="hidden md:flex gap-2 shrink-0">
						<Button
							variant="secondary"
							onClick={() => {
								createRoomModalSignal.value = false;
								newSessionModal.open();
							}}
						>
							New Session
						</Button>
						<Button
							onClick={() => {
								newSessionModal.close();
								createRoomModalSignal.value = true;
							}}
						>
							Create Room
						</Button>
					</div>
					{/* Mobile: icon-only buttons */}
					<div class="flex md:hidden gap-1.5 shrink-0">
						<button
							onClick={() => {
								createRoomModalSignal.value = false;
								newSessionModal.open();
							}}
							class="p-1.5 rounded-md bg-dark-800 hover:bg-dark-700 text-gray-400 hover:text-gray-100 transition-colors"
							title={t('lobby.newSession')}
						>
							<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M12 4v16m8-8H4"
								/>
							</svg>
						</button>
						<button
							onClick={() => {
								newSessionModal.close();
								createRoomModalSignal.value = true;
							}}
							class="p-1.5 rounded-md bg-blue-600 hover:bg-blue-500 text-white transition-colors"
							title={t('lobby.createRoom')}
						>
							<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
								/>
							</svg>
						</button>
					</div>
				</div>
			</div>

			{/* Global Status */}
			<GlobalStatus />

			{/* Content */}
			<div class="flex-1 overflow-hidden">
				<div class="h-full overflow-y-auto p-6">
					{/* Recent Sessions Section */}
					{recentSessions.length > 0 && (
						<div class="mb-8">
							<div class="flex items-center justify-between mb-4">
								<h3 class="text-lg font-semibold text-gray-100">{t('lobby.recentSessions')}</h3>
							</div>
							<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
								{recentSessions.map((session) => {
									return (
										<button
											key={session.id}
											data-session-id={session.id}
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
							<h3 class="text-lg font-semibold text-gray-100">{t('common.rooms')}</h3>
						</div>
						<RoomGrid
							rooms={rooms}
							onRoomClick={(room) => navigateToRoom(room.id)}
							onCreateRoom={() => {
								newSessionModal.close();
								createRoomModalSignal.value = true;
							}}
						/>
					</div>
				</div>
			</div>

			{/* Create Room Modal */}
			<CreateRoomModal
				isOpen={isCreateRoomModalOpen}
				onClose={() => (createRoomModalSignal.value = false)}
				onSubmit={async (params) => {
					const room = await lobbyStore.createRoom(params);
					if (room) {
						createRoomModalSignal.value = false;
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
		</div>
	);
}
