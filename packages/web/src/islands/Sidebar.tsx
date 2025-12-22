import { useState, useEffect } from 'preact/hooks';
import { currentSessionIdSignal, sidebarOpenSignal } from '../lib/signals.ts';
import {
	sessions,
	authStatus,
	connectionState,
	apiConnectionStatus,
	globalSettings,
	hasArchivedSessions,
} from '../lib/state.ts';
import { createSession, updateGlobalSettings } from '../lib/api-helpers.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { toast } from '../lib/toast.ts';
import { borderColors } from '../lib/design-tokens.ts';
import { Button } from '../components/ui/Button.tsx';
import { SettingsModal } from '../components/SettingsModal.tsx';
import SessionListItem from '../components/SessionListItem.tsx';
import { ConnectionNotReadyError } from '../lib/errors.ts';

const SESSIONS_PER_PAGE = 20;

export default function Sidebar() {
	// Keep local UI state
	const [creatingSession, setCreatingSession] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [visibleCount, setVisibleCount] = useState(SESSIONS_PER_PAGE);

	// FIX: Access sessionsList once to prevent multiple subscriptions
	// But we need to keep currentSessionIdSignal reactive for active state
	const sessionsList = sessions.value;

	// Get showArchived setting from global settings (server-side filtering)
	const showArchived = globalSettings.value?.showArchived ?? false;

	// Pagination (no client-side filtering needed - server does it)
	const visibleSessions = sessionsList.slice(0, visibleCount);
	const hasMore = sessionsList.length > visibleCount;

	// Reset visible count when archive filter changes
	useEffect(() => {
		setVisibleCount(SESSIONS_PER_PAGE);
	}, [showArchived]);

	const handleCreateSession = async () => {
		// CONNECTION GUARD: Check connection before attempting to create session
		if (connectionState.value !== 'connected') {
			toast.error('Not connected to server. Please wait...');
			return;
		}

		setCreatingSession(true);

		try {
			const response = await createSession({
				workspacePath: undefined, // Let daemon use configured workspace root
			});

			if (!response?.sessionId) {
				console.error('[Sidebar] Invalid response from createSession:', response);
				toast.error('No sessionId in response');
				return;
			}

			console.log('[Sidebar] Session created successfully, sessionId:', response.sessionId);
			console.log('[Sidebar] Response includes session:', !!response.session);

			// Navigate immediately - the session will sync via state channels
			console.log('[Sidebar] Navigating to session:', response.sessionId);
			currentSessionIdSignal.value = response.sessionId;

			// Verify session appears in list after a short delay
			setTimeout(() => {
				const currentSessionIds = sessions.value.map((s) => s.id);
				if (!currentSessionIds.includes(response.sessionId)) {
					console.warn('[Sidebar] Session not in list after navigation - delta may be delayed');
				} else {
					console.log('[Sidebar] Session successfully appeared in list');
				}
			}, 1000);

			toast.success('Session created successfully');
		} catch (err) {
			console.error('[Sidebar] Error creating session:', err);

			// Handle connection-specific errors
			if (err instanceof ConnectionNotReadyError) {
				toast.error('Connection lost. Please try again.');
			} else {
				const message = err instanceof Error ? err.message : 'Failed to create session';
				toast.error(message);
			}
		} finally {
			setCreatingSession(false);
		}
	};

	const handleSessionClick = (sessionId: string) => {
		console.log('[Sidebar] Session clicked:', sessionId);
		console.log('[Sidebar] Current signal value before update:', currentSessionIdSignal.value);
		currentSessionIdSignal.value = sessionId;
		console.log('[Sidebar] Current signal value after update:', currentSessionIdSignal.value);
		// Close sidebar on mobile after selecting a session
		if (window.innerWidth < 768) {
			sidebarOpenSignal.value = false;
		}
	};

	const handleLoadMore = () => {
		setVisibleCount((prev) => prev + SESSIONS_PER_PAGE);
	};

	const handleToggleShowArchived = async () => {
		try {
			await updateGlobalSettings({ showArchived: !showArchived });
		} catch (err) {
			console.error('[Sidebar] Error toggling showArchived:', err);
			toast.error('Failed to toggle archived sessions visibility');
		}
	};

	return (
		<>
			{/* Mobile backdrop */}
			{sidebarOpenSignal.value && (
				<div
					class="fixed inset-0 bg-black/50 z-40 md:hidden"
					onClick={() => (sidebarOpenSignal.value = false)}
				/>
			)}
			<div
				class={`
        fixed md:relative
        h-screen w-80
        bg-dark-950 border-r ${borderColors.ui.default}
        flex flex-col
        z-50
        transition-transform duration-300 ease-in-out
        left-0 md:left-auto
        ${sidebarOpenSignal.value ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}
			>
				{/* Header */}
				<div class={`p-4 border-b ${borderColors.ui.default}`}>
					<div class="flex items-center gap-3 mb-4">
						<div class="text-2xl">🤖</div>
						<h1 class="text-xl font-bold text-gray-100 flex-1">Liuboer</h1>
						{/* Close button for mobile */}
						<button
							onClick={() => (sidebarOpenSignal.value = false)}
							class="md:hidden p-1.5 hover:bg-dark-800 rounded-lg transition-colors text-gray-400 hover:text-gray-100"
							title="Close sidebar"
						>
							<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M6 18L18 6M6 6l12 12"
								/>
							</svg>
						</button>
					</div>
					<Button
						onClick={handleCreateSession}
						loading={creatingSession}
						disabled={!authStatus.value?.isAuthenticated || connectionState.value !== 'connected'}
						fullWidth
						icon={
							<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M12 4v16m8-8H4"
								/>
							</svg>
						}
					>
						{connectionState.value !== 'connected' ? 'Connecting...' : 'New Session'}
					</Button>
				</div>

				{/* Archived Sessions Toggle - only show if there are any archived sessions */}
				{hasArchivedSessions.value && (
					<div class={`px-4 py-2 border-b ${borderColors.ui.default}`}>
						<button
							type="button"
							onClick={handleToggleShowArchived}
							class="text-xs text-gray-400 hover:text-gray-200 transition-colors flex items-center gap-2 w-full"
						>
							<svg
								class={`w-3 h-3 transition-transform ${showArchived ? 'rotate-90' : ''}`}
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M9 5l7 7-7 7"
								/>
							</svg>
							<span>{showArchived ? 'Hide archived' : 'Show archived'}</span>
						</button>
					</div>
				)}

				{/* Session List */}
				<div class="flex-1 overflow-y-auto">
					{sessionsList.length === 0 && (
						<div class="p-6 text-center">
							<div class="text-4xl mb-3">💬</div>
							<p class="text-sm text-gray-400">No sessions yet.</p>
							<p class="text-xs text-gray-500 mt-1">Create one to get started!</p>
						</div>
					)}

					{visibleSessions.map((session) => (
						<SessionListItem
							key={session.id}
							session={session}
							onSessionClick={handleSessionClick}
						/>
					))}

					{/* Load More Button */}
					{hasMore && (
						<div class="p-4">
							<button
								type="button"
								onClick={handleLoadMore}
								class="w-full py-2 px-4 text-sm text-gray-400 hover:text-gray-200 hover:bg-dark-800 rounded-lg transition-colors border border-dark-700 hover:border-dark-600"
							>
								Load More ({sessionsList.length - visibleCount} remaining)
							</button>
						</div>
					)}
				</div>

				{/* Footer - with safe area padding for mobile Safari */}
				<div
					class={`p-4 border-t ${borderColors.ui.default} space-y-3`}
					style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
				>
					{/* Auth Status */}
					<div class="flex items-center justify-between text-xs">
						<span class="text-gray-400">Authentication</span>
						<button
							onClick={() => setSettingsOpen(true)}
							class="flex items-center gap-2 hover:bg-dark-800 px-2 py-1 rounded transition-colors"
						>
							{authStatus.value?.isAuthenticated ? (
								<>
									<div class="relative">
										<span class="w-2 h-2 bg-green-500 rounded-full block" />
										<span class="absolute inset-0 w-2 h-2 bg-green-500 rounded-full animate-ping opacity-75" />
									</div>
									<span class="text-gray-300 flex items-center gap-1">
										{authStatus.value.method === 'oauth'
											? 'OAuth'
											: authStatus.value.method === 'oauth_token'
												? 'OAuth Token'
												: 'API Key'}
										{authStatus.value.source === 'env' && (
											<span class="text-[10px] px-1 bg-blue-500/20 text-blue-300 rounded">env</span>
										)}
									</span>
								</>
							) : (
								<>
									<div class="w-2 h-2 bg-yellow-500 rounded-full" />
									<span class="text-yellow-300">Not configured</span>
								</>
							)}
							<svg
								class="w-3 h-3 text-gray-500"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
								/>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
								/>
							</svg>
						</button>
					</div>

					{/* Connection Status */}
					<div class="space-y-2">
						{/* WebSocket Connection (Client <-> Daemon) */}
						<div class="flex items-center justify-between text-xs">
							<span class="text-gray-400">Daemon</span>
							<div class="flex items-center gap-2">
								{connectionState.value === 'connected' && (
									<>
										<div class="relative">
											<span class="w-2 h-2 bg-green-500 rounded-full block" />
											<span class="absolute inset-0 w-2 h-2 bg-green-500 rounded-full animate-ping opacity-75" />
										</div>
										<span class="text-gray-300">Connected</span>
									</>
								)}
								{connectionState.value === 'connecting' && (
									<>
										<div class="w-2 h-2 bg-yellow-500 rounded-full animate-pulse" />
										<span class="text-yellow-300">Connecting...</span>
									</>
								)}
								{connectionState.value === 'reconnecting' && (
									<>
										<div class="w-2 h-2 bg-yellow-500 rounded-full animate-pulse" />
										<span class="text-yellow-300">Reconnecting...</span>
									</>
								)}
								{connectionState.value === 'disconnected' && (
									<>
										<div class="w-2 h-2 bg-gray-500 rounded-full" />
										<span class="text-gray-500">Offline</span>
									</>
								)}
								{connectionState.value === 'error' && (
									<>
										<div class="w-2 h-2 bg-red-500 rounded-full" />
										<span class="text-red-400">Error</span>
									</>
								)}
								{connectionState.value === 'failed' && (
									<>
										<div class="w-2 h-2 bg-red-500 rounded-full" />
										<span class="text-red-400">Failed</span>
									</>
								)}
							</div>
						</div>

						{/* Reconnect Button - shown when offline/failed/error */}
						{(connectionState.value === 'disconnected' ||
							connectionState.value === 'error' ||
							connectionState.value === 'failed') && (
							<button
								onClick={() => connectionManager.reconnect()}
								class="w-full px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors"
							>
								Reconnect
							</button>
						)}

						{/* API Connection (Daemon <-> Claude API) */}
						<div class="flex items-center justify-between text-xs">
							<span class="text-gray-400">Claude API</span>
							<div class="flex items-center gap-2">
								{apiConnectionStatus.value?.status === 'connected' && (
									<>
										<div class="relative">
											<span class="w-2 h-2 bg-green-500 rounded-full block" />
											<span class="absolute inset-0 w-2 h-2 bg-green-500 rounded-full animate-ping opacity-75" />
										</div>
										<span class="text-gray-300">Connected</span>
									</>
								)}
								{apiConnectionStatus.value?.status === 'degraded' && (
									<>
										<div class="w-2 h-2 bg-yellow-500 rounded-full animate-pulse" />
										<span
											class="text-yellow-300"
											title={`${apiConnectionStatus.value.errorCount} errors`}
										>
											Degraded
										</span>
									</>
								)}
								{apiConnectionStatus.value?.status === 'disconnected' && (
									<>
										<div class="w-2 h-2 bg-red-500 rounded-full" />
										<span class="text-red-300" title={apiConnectionStatus.value.lastError}>
											Offline
										</span>
									</>
								)}
								{!apiConnectionStatus.value && (
									<>
										<div class="w-2 h-2 bg-gray-500 rounded-full" />
										<span class="text-gray-500">Unknown</span>
									</>
								)}
							</div>
						</div>
					</div>
				</div>
			</div>

			{/* Settings Modal */}
			<SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
		</>
	);
}
