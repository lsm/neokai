import type { Session } from '@neokai/shared';
import SessionListItem from './SessionListItem.tsx';

interface SessionProjectGroupProps {
	/** Display name (folder basename). */
	name: string;
	/** Absolute project root path — shown as the row tooltip. */
	path: string;
	/** Sessions belonging to this project, pre-sorted. */
	sessions: Session[];
	/** Whether the group is collapsed. */
	collapsed: boolean;
	/** Toggle the collapsed state. */
	onToggle: () => void;
	onSessionClick: (sessionId: string) => void;
	/** Archive a session in this project. */
	onArchive: (sessionId: string) => void | Promise<void>;
	/** When provided, shows a remove affordance (only passed for empty projects). */
	onRemove?: () => void;
}

/**
 * A collapsible project folder in the chats sidebar. Renders a disclosure
 * header (chevron + folder + name) and, when expanded, the nested chats — or
 * a "No chats" placeholder for empty projects.
 */
export function SessionProjectGroup({
	name,
	path,
	sessions,
	collapsed,
	onToggle,
	onSessionClick,
	onArchive,
	onRemove,
}: SessionProjectGroupProps) {
	const isEmpty = sessions.length === 0;

	return (
		<div>
			<div class="group/project flex items-center rounded-lg transition-colors hover:bg-white/5">
				<button
					type="button"
					data-testid="project-group-header"
					onClick={onToggle}
					title={path}
					aria-expanded={!collapsed}
					class="flex-1 min-w-0 flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-gray-300 transition-colors group-hover/project:text-gray-100"
				>
					<svg
						class={`w-3 h-3 flex-shrink-0 text-gray-500 transition-transform ${
							collapsed ? '' : 'rotate-90'
						}`}
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2.5}
							d="M8.25 4.5l7.5 7.5-7.5 7.5"
						/>
					</svg>
					<svg
						class="w-4 h-4 flex-shrink-0 text-gray-500"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={1.75}
							d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
						/>
					</svg>
					<span class="flex-1 min-w-0 truncate text-left font-medium">{name}</span>
				</button>
				{onRemove && (
					<button
						type="button"
						data-testid="project-remove"
						onClick={onRemove}
						title="Remove project"
						aria-label={`Remove project ${name}`}
						class="opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100 mr-1 p-1 rounded text-gray-500 hover:text-red-400 hover:bg-white/10 transition-colors"
					>
						<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M6 18L18 6M6 6l12 12"
							/>
						</svg>
					</button>
				)}
			</div>
			{!collapsed && (
				<div class="ml-3 mt-0.5 flex flex-col gap-0.5">
					{isEmpty ? (
						<div class="px-2.5 py-1.5 text-xs text-gray-600">No chats</div>
					) : (
						sessions.map((session) => (
							<SessionListItem
								key={session.id}
								session={session}
								onSessionClick={onSessionClick}
								onArchive={onArchive}
							/>
						))
					)}
				</div>
			)}
		</div>
	);
}
