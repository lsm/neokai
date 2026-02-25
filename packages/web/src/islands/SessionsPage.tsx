import { useState } from 'preact/hooks';
import type { Session } from '@neokai/shared';
import { sessions } from '../lib/state.ts';
import { connectionState, authStatus } from '../lib/state.ts';
import { navigateToSession } from '../lib/router.ts';
import { createSession } from '../lib/api-helpers.ts';
import { toast } from '../lib/toast.ts';
import { formatRelativeTime, formatTokens } from '../lib/utils.ts';
import { allSessionStatuses, getProcessingPhaseColor } from '../lib/session-status.ts';
import { GitBranchIcon } from '../components/icons/GitBranchIcon.tsx';
import { Button } from '../components/ui/Button.tsx';
import { ConnectionNotReadyError } from '../lib/errors.ts';

function StatusDot({ sessionId }: { sessionId: string }) {
	const status = allSessionStatuses.value.get(sessionId);
	if (!status) return null;

	const { processingState, hasUnread } = status;
	const phaseColors = getProcessingPhaseColor(processingState);

	if (phaseColors) {
		return (
			<div class="relative flex-shrink-0 w-2.5 h-2.5 mt-0.5">
				<span class={`absolute inset-0 rounded-full ${phaseColors.dot} animate-pulse`} />
				<span class={`absolute inset-0 rounded-full ${phaseColors.dot} animate-ping opacity-50`} />
			</div>
		);
	}

	if (hasUnread) {
		return (
			<div class="flex-shrink-0 w-2.5 h-2.5 mt-0.5">
				<span class="block w-full h-full rounded-full bg-blue-500" />
			</div>
		);
	}

	return null;
}

function SessionCard({ session }: { session: Session }) {
	return (
		<button
			type="button"
			onClick={() => navigateToSession(session.id)}
			class="bg-dark-800 hover:bg-dark-750 border border-dark-700 hover:border-dark-600 rounded-lg p-4 text-left transition-colors w-full"
		>
			{/* Title row */}
			<div class="flex items-start justify-between gap-2 mb-2">
				<div class="flex items-start gap-2 flex-1 min-w-0">
					<StatusDot sessionId={session.id} />
					<span class="text-sm font-medium text-gray-100 truncate">
						{session.title || 'New Session'}
					</span>
				</div>
				<div class="flex items-center gap-1 flex-shrink-0">
					{session.worktree && (
						<span class="text-purple-400" title={`Worktree: ${session.worktree.branch}`}>
							<GitBranchIcon className="w-3.5 h-3.5" />
						</span>
					)}
					{session.status === 'archived' && (
						<span class="text-xs text-amber-600 bg-amber-900/30 px-1.5 py-0.5 rounded">
							archived
						</span>
					)}
				</div>
			</div>

			{/* Workspace path */}
			<p class="text-xs text-gray-500 truncate mb-3">{session.workspacePath || '—'}</p>

			{/* Stats row */}
			<div class="flex items-center gap-3 text-xs text-gray-500">
				<span class="flex items-center gap-1">
					<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
						<path d="M5 8a1 1 0 1 1-2 0 1 1 0 0 1 2 0m4 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0m3 1a1 1 0 1 0 0-2 1 1 0 0 0 0 2" />
						<path d="m2.165 15.803.02-.004c1.83-.363 2.948-.842 3.468-1.105A9 9 0 0 0 8 15c4.418 0 8-3.134 8-7s-3.582-7-8-7-8 3.134-8 7c0 1.76.743 3.37 1.97 4.6a10.4 10.4 0 0 1-.524 2.318l-.003.011a11 11 0 0 1-.244.637c-.079.186.074.394.273.362a22 22 0 0 0 .693-.125m.8-3.108a1 1 0 0 0-.287-.801C1.618 10.83 1 9.468 1 8c0-3.192 3.004-6 7-6s7 2.808 7 6-3.004 6-7 6a8 8 0 0 1-2.088-.272 1 1 0 0 0-.711.074c-.387.196-1.24.57-2.634.893a11 11 0 0 0 .398-2" />
					</svg>
					{session.metadata.messageCount || 0}
				</span>
				<span class="flex items-center gap-1">
					<svg class="w-3 h-3" fill="currentColor" viewBox="-1 -1 18 18">
						<path d="M8 2a.5.5 0 0 1 .5.5V4a.5.5 0 0 1-1 0V2.5A.5.5 0 0 1 8 2M3.732 3.732a.5.5 0 0 1 .707 0l.915.914a.5.5 0 1 1-.708.708l-.914-.915a.5.5 0 0 1 0-.707M2 8a.5.5 0 0 1 .5-.5h1.586a.5.5 0 0 1 0 1H2.5A.5.5 0 0 1 2 8m9.5 0a.5.5 0 0 1 .5-.5h1.5a.5.5 0 0 1 0 1H12a.5.5 0 0 1-.5-.5m.754-4.246a.39.39 0 0 0-.527-.02L7.547 7.31A.91.91 0 1 0 8.85 8.569l3.434-4.297a.39.39 0 0 0-.029-.518z" />
						<path
							fill-rule="evenodd"
							d="M6.664 15.889A8 8 0 1 1 9.336.11a8 8 0 0 1-2.672 15.78zm-4.665-4.283A11.95 11.95 0 0 1 8 10c2.186 0 4.236.585 6.001 1.606a7 7 0 1 0-12.002 0"
						/>
					</svg>
					{formatTokens(session.metadata.totalTokens || 0)}
				</span>
				<span class="font-mono text-green-400">
					${(session.metadata.totalCost || 0).toFixed(4)}
				</span>
				<span class="ml-auto flex items-center gap-1">
					<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
						/>
					</svg>
					{formatRelativeTime(new Date(session.lastActiveAt))}
				</span>
			</div>
		</button>
	);
}

export function SessionsPage() {
	const [creating, setCreating] = useState(false);

	const sessionsList = sessions.value.filter((s) => !s.context?.roomId);
	const canCreate =
		connectionState.value === 'connected' && (authStatus.value?.isAuthenticated ?? false);

	const handleNewSession = async () => {
		if (!canCreate) {
			toast.error('Not connected to server. Please wait...');
			return;
		}
		setCreating(true);
		try {
			const response = await createSession({ workspacePath: undefined });
			if (!response?.sessionId) {
				toast.error('No sessionId in response');
				return;
			}
			navigateToSession(response.sessionId);
			toast.success('Session created successfully');
		} catch (err) {
			if (err instanceof ConnectionNotReadyError) {
				toast.error('Connection lost. Please try again.');
			} else {
				toast.error(err instanceof Error ? err.message : 'Failed to create session');
			}
		} finally {
			setCreating(false);
		}
	};

	return (
		<div class="flex-1 flex flex-col bg-dark-900 overflow-hidden">
			{/* Header */}
			<div class="px-6 py-4 border-b border-dark-700 pl-12 md:pl-6 flex items-center justify-between">
				<div>
					<h2 class="text-lg font-semibold text-gray-100">Sessions</h2>
					<p class="text-sm text-gray-400">
						{sessionsList.length} session{sessionsList.length !== 1 ? 's' : ''}
					</p>
				</div>
				<Button
					onClick={handleNewSession}
					loading={creating}
					disabled={!canCreate}
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
					New Session
				</Button>
			</div>

			{/* Grid */}
			<div class="flex-1 overflow-y-auto p-6">
				{sessionsList.length === 0 ? (
					<div class="flex flex-col items-center justify-center h-full text-center">
						<div class="text-5xl mb-4">💬</div>
						<h3 class="text-lg font-semibold text-gray-100 mb-2">No sessions yet</h3>
						<p class="text-sm text-gray-400 mb-6">Create a session to start working with AI</p>
						<Button onClick={handleNewSession} loading={creating} disabled={!canCreate}>
							New Session
						</Button>
					</div>
				) : (
					<div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
						{sessionsList.map((session) => (
							<SessionCard key={session.id} session={session} />
						))}
					</div>
				)}
			</div>
		</div>
	);
}
