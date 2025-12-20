import type { Session } from '@liuboer/shared';
import { currentSessionIdSignal, sidebarOpenSignal } from '../lib/signals.ts';
import { formatRelativeTime, formatTokens } from '../lib/utils.ts';
import { borderColors } from '../lib/design-tokens.ts';

interface RecentSessionsProps {
	sessions: Session[];
}

export default function RecentSessions({ sessions }: RecentSessionsProps) {
	// Get the 5 most recent sessions
	const recentSessions = [...sessions]
		.sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
		.slice(0, 5);

	const handleSessionClick = (sessionId: string) => {
		currentSessionIdSignal.value = sessionId;
		// Close sidebar on mobile after selecting a session
		if (window.innerWidth < 768) {
			sidebarOpenSignal.value = false;
		}
	};

	const handleMenuClick = () => {
		sidebarOpenSignal.value = true;
	};

	return (
		<div class="flex-1 flex flex-col bg-dark-900 overflow-hidden">
			{/* Header with hamburger menu */}
			<div class={`bg-dark-850/50 backdrop-blur-sm border-b ${borderColors.ui.default} p-4`}>
				<div class="max-w-6xl mx-auto w-full px-4 md:px-6 flex items-center gap-3">
					{/* Hamburger menu button - visible only on mobile */}
					<button
						onClick={handleMenuClick}
						class={`md:hidden p-2 -ml-2 bg-dark-850 border ${borderColors.ui.default} rounded-lg hover:bg-dark-800 transition-colors text-gray-400 hover:text-gray-100 flex-shrink-0`}
						title="Open menu"
					>
						<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M4 6h16M4 12h16M4 18h16"
							/>
						</svg>
					</button>

					<div class="flex-1">
						<h2 class="text-2xl font-bold text-gray-100">Welcome to Liuboer</h2>
						<p class="text-sm text-gray-400 mt-1">
							{recentSessions.length > 0
								? 'Continue where you left off or create a new session'
								: 'Create a new session to get started'}
						</p>
					</div>
				</div>
			</div>

			{/* Content */}
			<div class="flex-1 overflow-y-auto">
				<div class="max-w-6xl mx-auto w-full px-4 md:px-6 py-8">
					{/* Welcome message */}
					<div class="text-center mb-8">
						<div class="text-5xl mb-4">🤖</div>
						<p class="text-gray-400 text-base mb-6">
							A modern wrapper around Claude Agent SDK with rich UI and multi-device access
						</p>
						<div class="flex flex-wrap justify-center gap-4 text-sm text-gray-400">
							<span class="flex items-center gap-2">
								<span>✨</span>
								<span>Real-time streaming</span>
							</span>
							<span class="flex items-center gap-2">
								<span>🛠️</span>
								<span>Tool visualization</span>
							</span>
							<span class="flex items-center gap-2">
								<span>📁</span>
								<span>Workspace management</span>
							</span>
							<span class="flex items-center gap-2">
								<span>💬</span>
								<span>Multi-session support</span>
							</span>
						</div>
					</div>

					{/* Recent Sessions */}
					{recentSessions.length > 0 && (
						<div>
							<h3 class="text-lg font-semibold text-gray-100 mb-4">Recent Sessions</h3>
							<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
								{recentSessions.map((session) => (
									<button
										key={session.id}
										onClick={() => handleSessionClick(session.id)}
										class={`group relative bg-dark-850 border ${borderColors.ui.default} rounded-lg p-5 hover:bg-dark-800 hover:border-dark-600 transition-all text-left cursor-pointer hover:shadow-lg hover:shadow-blue-500/10`}
									>
										{/* Session header */}
										<div class="mb-3">
											<div class="flex items-center gap-2 mb-1">
												<h3 class="flex-1 text-lg font-semibold text-gray-100 line-clamp-2 group-hover:text-blue-400 transition-colors">
													{session.title || 'New Session'}
												</h3>
												{session.worktree && (
													<span
														class="text-purple-400 flex-shrink-0"
														title={`Worktree: ${session.worktree.branch}`}
													>
														<svg
															class="w-4 h-4"
															fill="none"
															viewBox="0 0 24 24"
															stroke="currentColor"
														>
															<path
																stroke-linecap="round"
																stroke-linejoin="round"
																stroke-width={2}
																d="M9 4v16m-4-8h4m0 0l-3-3m3 3l-3 3m8-3h4m0 0l3-3m-3 3l3 3"
															/>
														</svg>
													</span>
												)}
												{session.status === 'archived' && (
													<span class="text-amber-600 flex-shrink-0" title="Archived session">
														<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 16 16">
															<path d="M15.528 2.973a.75.75 0 0 1 .472.696v8.662a.75.75 0 0 1-.472.696l-7.25 2.9a.75.75 0 0 1-.557 0l-7.25-2.9A.75.75 0 0 1 0 12.331V3.669a.75.75 0 0 1 .471-.696L7.443.184l.01-.003.268-.108a.75.75 0 0 1 .558 0l.269.108.01.003zM10.404 2 4.25 4.461 1.846 3.5 1 3.839v.4l6.5 2.6v7.922l.5.2.5-.2V6.84l6.5-2.6v-.4l-.846-.339L8 5.961 5.596 5l6.154-2.461z" />
														</svg>
													</span>
												)}
											</div>
											<p class="text-xs text-gray-500 flex items-center gap-1">
												<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width={2}
														d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
													/>
												</svg>
												{formatRelativeTime(new Date(session.lastActiveAt))}
											</p>
										</div>

										{/* Session stats */}
										<div class="flex items-center gap-3 text-sm text-gray-400">
											<span class="flex items-center gap-1.5">
												<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 16 16">
													<path d="M5 8a1 1 0 1 1-2 0 1 1 0 0 1 2 0m4 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0m3 1a1 1 0 1 0 0-2 1 1 0 0 0 0 2" />
													<path d="m2.165 15.803.02-.004c1.83-.363 2.948-.842 3.468-1.105A9 9 0 0 0 8 15c4.418 0 8-3.134 8-7s-3.582-7-8-7-8 3.134-8 7c0 1.76.743 3.37 1.97 4.6a10.4 10.4 0 0 1-.524 2.318l-.003.011a11 11 0 0 1-.244.637c-.079.186.074.394.273.362a22 22 0 0 0 .693-.125m.8-3.108a1 1 0 0 0-.287-.801C1.618 10.83 1 9.468 1 8c0-3.192 3.004-6 7-6s7 2.808 7 6-3.004 6-7 6a8 8 0 0 1-2.088-.272 1 1 0 0 0-.711.074c-.387.196-1.24.57-2.634.893a11 11 0 0 0 .398-2" />
												</svg>
												<span class="font-semibold">{session.metadata.messageCount || 0}</span>
											</span>
											<span class="flex items-center gap-1.5">
												<svg class="w-4 h-4" fill="currentColor" viewBox="-1 -1 18 18">
													<path d="M8 2a.5.5 0 0 1 .5.5V4a.5.5 0 0 1-1 0V2.5A.5.5 0 0 1 8 2M3.732 3.732a.5.5 0 0 1 .707 0l.915.914a.5.5 0 1 1-.708.708l-.914-.915a.5.5 0 0 1 0-.707M2 8a.5.5 0 0 1 .5-.5h1.586a.5.5 0 0 1 0 1H2.5A.5.5 0 0 1 2 8m9.5 0a.5.5 0 0 1 .5-.5h1.5a.5.5 0 0 1 0 1H12a.5.5 0 0 1-.5-.5m.754-4.246a.39.39 0 0 0-.527-.02L7.547 7.31A.91.91 0 1 0 8.85 8.569l3.434-4.297a.39.39 0 0 0-.029-.518z" />
													<path
														fill-rule="evenodd"
														d="M6.664 15.889A8 8 0 1 1 9.336.11a8 8 0 0 1-2.672 15.78zm-4.665-4.283A11.95 11.95 0 0 1 8 10c2.186 0 4.236.585 6.001 1.606a7 7 0 1 0-12.002 0"
													/>
												</svg>
												<span class="font-semibold">
													{formatTokens(session.metadata.totalTokens || 0)}
												</span>
											</span>
											<span class="font-mono text-green-400 font-semibold">
												${(session.metadata.totalCost || 0).toFixed(4)}
											</span>
										</div>

										{/* Hover indicator */}
										<div class="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
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
													d="M13 7l5 5m0 0l-5 5m5-5H6"
												/>
											</svg>
										</div>
									</button>
								))}
							</div>

							{/* Show more sessions hint */}
							{sessions.length > 5 && (
								<div class="mt-6 text-center">
									<p class="text-sm text-gray-400">
										Showing {recentSessions.length} of {sessions.length} sessions
									</p>
									<p class="text-xs text-gray-500 mt-1">View all sessions in the sidebar</p>
								</div>
							)}
						</div>
					)}

					{/* No sessions state */}
					{recentSessions.length === 0 && (
						<div class="text-center mt-8">
							<p class="text-gray-500 text-sm">
								No sessions yet. Create a new session from the sidebar to start chatting.
							</p>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
