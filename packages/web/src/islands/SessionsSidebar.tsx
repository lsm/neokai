import { useEffect, useState } from 'preact/hooks';
import type { Session, WorkspaceHistoryEntry } from '@neokai/shared';
import { navigateToSession, navigateToSessions } from '../lib/router.ts';
import { sessions, hasArchivedSessions, globalSettings } from '../lib/state.ts';
import {
	updateGlobalSettings,
	getWorkspaceHistory,
	addWorkspaceToHistory,
	removeWorkspaceFromHistory,
} from '../lib/api-helpers.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { toast } from '../lib/toast.ts';
import { isUserSession } from '../lib/session-utils.ts';
import { getCollapsedProjects, setCollapsedProjects } from '../lib/sidebar-prefs.ts';
import SessionListItem from '../components/SessionListItem.tsx';
import { SessionProjectGroup } from '../components/SessionProjectGroup.tsx';

interface SessionsSidebarProps {
	/** Called when a session is selected (for mobile drawer close). */
	onSessionSelect?: () => void;
	/** Called from the mobile-only close affordance. */
	onClose?: () => void;
}

/** The project root a session belongs to: the main repo for worktree sessions. */
function projectRootOf(session: Session): string | null {
	return session.worktree?.mainRepoPath ?? session.workspacePath ?? null;
}

/** Folder basename of an absolute path, used as the project display name. */
function basename(path: string): string {
	const trimmed = path.replace(/\/+$/, '');
	const idx = trimmed.lastIndexOf('/');
	return (idx >= 0 ? trimmed.slice(idx + 1) : trimmed) || trimmed;
}

function lastActive(session: Session): number {
	const time = new Date(session.lastActiveAt).getTime();
	return Number.isNaN(time) ? 0 : time;
}

interface ProjectGroup {
	path: string;
	name: string;
	sessions: Session[];
	sortTime: number;
}

/**
 * Build the grouped sidebar view: sessions grouped by project root, merged with
 * workspace history so explicitly-added folders appear even with no sessions.
 * Sessions without a workspace stay ungrouped.
 */
function buildView(
	sessionsList: Session[],
	history: WorkspaceHistoryEntry[]
): { projects: ProjectGroup[]; ungrouped: Session[] } {
	const byRoot = new Map<string, Session[]>();
	const ungrouped: Session[] = [];

	for (const session of sessionsList) {
		const root = projectRootOf(session);
		if (root) {
			const existing = byRoot.get(root);
			if (existing) existing.push(session);
			else byRoot.set(root, [session]);
		} else {
			ungrouped.push(session);
		}
	}

	// Seed empty projects from workspace history.
	const historyTime = new Map<string, number>();
	for (const entry of history) {
		historyTime.set(entry.path, entry.lastUsedAt);
		if (!byRoot.has(entry.path)) byRoot.set(entry.path, []);
	}

	const projects: ProjectGroup[] = [...byRoot.entries()]
		.map(([path, grouped]) => {
			const sorted = grouped.slice().sort((a, b) => lastActive(b) - lastActive(a));
			const sortTime = sorted.length > 0 ? lastActive(sorted[0]) : (historyTime.get(path) ?? 0);
			return { path, name: basename(path), sessions: sorted, sortTime };
		})
		.sort((a, b) => b.sortTime - a.sortTime);

	ungrouped.sort((a, b) => lastActive(b) - lastActive(a));

	return { projects, ungrouped };
}

/**
 * Codex-style chats sidebar: a borderless "New chat" row on top, then sessions
 * grouped into collapsible Projects (folders, backed by workspace history) plus
 * a flat Chats section for sessions that have no workspace yet.
 */
export function SessionsSidebar({ onSessionSelect, onClose }: SessionsSidebarProps) {
	const [history, setHistory] = useState<WorkspaceHistoryEntry[]>([]);
	// Project paths that are collapsed; empty means every project is expanded.
	const [collapsed, setCollapsed] = useState<Set<string>>(() => getCollapsedProjects());

	// Load workspace history once so explicitly-added (empty) projects show.
	useEffect(() => {
		getWorkspaceHistory()
			.then(setHistory)
			.catch(() => {
				// Non-critical — projects with sessions still render without history.
			});
	}, []);

	// Only show user-created sessions (not internal orchestration agents).
	const sessionsList = sessions.value.filter(isUserSession);
	const showArchived = globalSettings.value?.showArchived ?? false;
	const { projects, ungrouped } = buildView(sessionsList, history);
	const hasContent = sessionsList.length > 0 || projects.length > 0;

	const handleSessionClick = (sessionId: string) => {
		navigateToSession(sessionId);
		onSessionSelect?.();
	};

	const toggleProject = (path: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			setCollapsedProjects(next);
			return next;
		});
	};

	const handleToggleShowArchived = async () => {
		try {
			await updateGlobalSettings({ showArchived: !showArchived });
		} catch {
			toast.error('Failed to toggle archived sessions visibility');
		}
	};

	const handleAddProject = async () => {
		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			toast.error('Not connected to server. Please wait...');
			return;
		}
		try {
			const picked = await hub.request<{ path: string | null }>('dialog.pickFolder');
			if (!picked?.path) return;
			const entry = await addWorkspaceToHistory(picked.path);
			setHistory((prev) => (prev.some((e) => e.path === entry.path) ? prev : [entry, ...prev]));
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to add project');
		}
	};

	const handleRemoveProject = async (path: string) => {
		try {
			await removeWorkspaceFromHistory(path);
			setHistory((prev) => prev.filter((e) => e.path !== path));
		} catch {
			toast.error('Failed to remove project');
		}
	};

	// "New chat" opens the empty-state landing; the session is created when the
	// user submits text there.
	const handleNewChat = () => {
		navigateToSessions();
		onSessionSelect?.();
	};

	return (
		<div class="flex flex-col h-full">
			{/* Top: mobile close + New chat */}
			<div class="p-2">
				{onClose && (
					<button
						type="button"
						onClick={onClose}
						class="md:hidden mb-1 ml-auto flex p-1.5 rounded-lg text-gray-400 hover:text-gray-100 hover:bg-white/5 transition-colors"
						title="Close panel"
						aria-label="Close panel"
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
				)}
				<button
					type="button"
					data-testid="new-chat-button"
					onClick={handleNewChat}
					class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium text-gray-200 hover:bg-white/5 hover:text-gray-100 transition-colors"
				>
					<svg class="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"
						/>
					</svg>
					<span>New chat</span>
				</button>
			</div>

			{/* Grouped session list */}
			<div class="flex-1 overflow-y-auto px-2 pb-2">
				{!hasContent ? (
					<div class="px-2 py-10 text-center">
						<p class="text-sm text-gray-500">No chats yet</p>
						<p class="text-xs text-gray-600 mt-1">Start a new chat to begin.</p>
					</div>
				) : (
					<>
						{/* Projects */}
						<div class="flex items-center justify-between px-2.5 pt-2 pb-1">
							<span class="text-xs font-medium text-gray-500">Projects</span>
							<button
								type="button"
								data-testid="add-project-button"
								onClick={handleAddProject}
								title="Add project"
								aria-label="Add project"
								class="p-0.5 rounded text-gray-500 hover:text-gray-200 hover:bg-white/5 transition-colors"
							>
								<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M12 4v16m8-8H4"
									/>
								</svg>
							</button>
						</div>
						{projects.length > 0 && (
							<div class="flex flex-col gap-0.5">
								{projects.map((project) => (
									<SessionProjectGroup
										key={project.path}
										name={project.name}
										path={project.path}
										sessions={project.sessions}
										collapsed={collapsed.has(project.path)}
										onToggle={() => toggleProject(project.path)}
										onSessionClick={handleSessionClick}
										onRemove={
											project.sessions.length === 0
												? () => handleRemoveProject(project.path)
												: undefined
										}
									/>
								))}
							</div>
						)}

						{/* Chats — sessions with no workspace */}
						{ungrouped.length > 0 && (
							<>
								<div class="px-2.5 pt-3 pb-1 text-xs font-medium text-gray-500">Chats</div>
								<div class="flex flex-col gap-0.5">
									{ungrouped.map((session) => (
										<SessionListItem
											key={session.id}
											session={session}
											onSessionClick={handleSessionClick}
										/>
									))}
								</div>
							</>
						)}
					</>
				)}
			</div>

			{/* Archived sessions toggle — only when archived sessions exist */}
			{hasArchivedSessions.value && (
				<div class="p-2">
					<button
						type="button"
						onClick={handleToggleShowArchived}
						class="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-gray-500 hover:text-gray-300 hover:bg-white/5 rounded-lg transition-colors"
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
		</div>
	);
}
