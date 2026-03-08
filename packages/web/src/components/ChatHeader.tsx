/**
 * ChatHeader Component
 *
 * Compact single-line header for chat sessions.
 * Layout: [MobileMenu] Breadcrumb/Title ... stats · branch [⋮]
 */

import type { Session, SessionFeatures } from '@neokai/shared';
import { DEFAULT_WORKER_FEATURES } from '@neokai/shared';
import { borderColors } from '../lib/design-tokens';
import { formatTokens } from '../lib/utils';
import { connectionState } from '../lib/state';
import { navigateToRoom } from '../lib/router';
import { Breadcrumb } from './ui/Breadcrumb';
import { IconButton } from './ui/IconButton';
import { Dropdown } from './ui/Dropdown';
import { Tooltip } from './ui/Tooltip';
import { GitBranchIcon } from './icons/GitBranchIcon';
import { MobileMenuButton } from './ui/MobileMenuButton';
import { t } from '../lib/i18n.ts';

export interface RoomContext {
	roomName: string;
	roomId: string;
}

export interface ChatHeaderProps {
	session: Session | null;
	displayStats: {
		totalTokens: number;
		totalCost: number;
	};
	features?: SessionFeatures;
	roomContext?: RoomContext;
	onToolsClick: () => void;
	onInfoClick: () => void;
	onExportClick: () => void;
	onResetClick: () => void;
	onArchiveClick: () => void;
	onDeleteClick: () => void;
	archiving?: boolean;
	resettingAgent?: boolean;
	readonly?: boolean;
}

export function ChatHeader({
	session,
	displayStats,
	features = DEFAULT_WORKER_FEATURES,
	roomContext,
	onToolsClick,
	onInfoClick,
	onExportClick,
	onResetClick,
	onArchiveClick,
	onDeleteClick,
	archiving = false,
	resettingAgent = false,
	readonly = false,
}: ChatHeaderProps) {
	const isConnected = connectionState.value === 'connected';

	const getHeaderActions = () => {
		const actions: Array<
			| {
					label: string;
					onClick: () => void;
					icon: preact.JSX.Element;
					disabled?: boolean;
					danger?: boolean;
			  }
			| { type: 'divider' }
		> = [];

		if (!readonly) {
			actions.push({
				label: t('chat.tools'),
				onClick: onToolsClick,
				icon: (
					<svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
						/>
					</svg>
				),
			});
		}

		if (features.sessionInfo) {
			actions.push({
				label: t('chat.sessionInfo'),
				onClick: onInfoClick,
				icon: (
					<svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
						/>
					</svg>
				),
			});
		}

		actions.push({
			label: t('chat.exportChat'),
			onClick: onExportClick,
			disabled: !isConnected,
			icon: (
				<svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
					/>
				</svg>
			),
		});

		actions.push({
			label: resettingAgent ? t('chat.resetting') : t('chat.resetAgent'),
			onClick: onResetClick,
			disabled: resettingAgent || !isConnected,
			icon: (
				<svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
					/>
				</svg>
			),
		});

		if (features.archive) {
			actions.push({ type: 'divider' as const });
			actions.push({
				label: t('chat.archiveSession'),
				onClick: onArchiveClick,
				disabled: archiving || session?.status === 'archived' || !isConnected,
				icon: (
					<svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
						/>
					</svg>
				),
			});
			actions.push({
				label: t('chat.deleteChat'),
				onClick: onDeleteClick,
				danger: true,
				disabled: !isConnected,
				icon: (
					<svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
						/>
					</svg>
				),
			});
		}

		return actions;
	};

	// Build breadcrumb: Room context → session title (deduplicated)
	const sessionTitle = session?.title || t('chat.newSessionTitle');
	const branch = session?.worktree?.branch || session?.gitBranch;

	const breadcrumbItems = roomContext
		? [
				{
					label: roomContext.roomName,
					onClick: () => navigateToRoom(roomContext.roomId),
				},
				// Only show session title if different from room name
				...(sessionTitle !== roomContext.roomName
					? [{ label: sessionTitle }]
					: []),
			]
		: [{ label: sessionTitle }];

	return (
		<div
			class={`flex-shrink-0 bg-dark-850/50 backdrop-blur-sm border-b ${borderColors.ui.default} px-4 py-2.5 relative z-10`}
		>
			<div class="flex items-center gap-3 w-full">
				<MobileMenuButton />

				{/* Left: Breadcrumb navigation */}
				<div class="min-w-0 flex-shrink">
					<Breadcrumb items={breadcrumbItems} />
				</div>

				{/* Right: Stats + branch + menu */}
				<div class="flex items-center gap-3 ml-auto flex-shrink-0">
					{/* Stats */}
					<div class="hidden sm:flex items-center gap-2 text-xs text-gray-500">
						<span class="flex items-center gap-1" title={t('chat.totalTokens')}>
							{formatTokens(displayStats.totalTokens)}
						</span>
						<span>·</span>
						<span class="font-mono text-green-400/70">
							${displayStats.totalCost.toFixed(4)}
						</span>
						{branch && (
							<>
								<span>·</span>
								<span class="flex items-center gap-1 font-mono">
									{branch}
									{session?.worktree && (
										<Tooltip content={t('chat.worktreeTooltip')} position="bottom">
											<GitBranchIcon className="w-3 h-3 text-purple-400" />
										</Tooltip>
									)}
								</span>
							</>
						)}
					</div>

					{/* Options dropdown */}
					<Dropdown
						trigger={
							<IconButton
								title={!isConnected ? t('input.notConnected') : t('chat.sessionOptions')}
								disabled={!isConnected}
							>
								<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
									<path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
								</svg>
							</IconButton>
						}
						items={getHeaderActions()}
					/>
				</div>
			</div>
		</div>
	);
}
