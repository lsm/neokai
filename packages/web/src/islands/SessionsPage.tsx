import { useEffect, useState } from 'preact/hooks';
import type {
	CreateSessionRequest,
	GitBranchesResponse,
	WorkspaceHistoryEntry,
} from '@neokai/shared';
import { connectionState, authStatus } from '../lib/state.ts';
import { navigateToSession } from '../lib/router.ts';
import {
	createSession,
	getWorkspaceHistory,
	getGitBranches,
	addWorkspaceToHistory,
} from '../lib/api-helpers.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { toast } from '../lib/toast.ts';
import { ConnectionNotReadyError } from '../lib/errors.ts';
import { MobileMenuButton } from '../components/ui/MobileMenuButton.tsx';
import { WorkspaceChips } from '../components/WorkspaceChips.tsx';

/**
 * Codex-style landing for `/sessions` when no session is selected: a centered
 * prompt, a starter input, and a project / worktree / branch context row.
 * Submitting creates a session (with the chosen workspace + worktree mode),
 * sends the typed text as its first message, and opens the chat.
 */
export function SessionsPage() {
	const [text, setText] = useState('');
	const [submitting, setSubmitting] = useState(false);

	const [projects, setProjects] = useState<WorkspaceHistoryEntry[]>([]);
	const [project, setProject] = useState<string | null>(null);
	const [gitInfo, setGitInfo] = useState<GitBranchesResponse | null>(null);
	const [gitLoading, setGitLoading] = useState(false);
	const [mode, setMode] = useState<'worktree' | 'direct'>('worktree');
	const [baseBranch, setBaseBranch] = useState<string | null>(null);

	const canCreate =
		connectionState.value === 'connected' && (authStatus.value?.isAuthenticated ?? false);

	// Load known project folders for the project picker.
	useEffect(() => {
		getWorkspaceHistory()
			.then(setProjects)
			.catch(() => {
				// Non-critical — the picker still offers "No folder" and "Browse…".
			});
	}, []);

	// Fetch git context whenever the selected project changes.
	useEffect(() => {
		if (!project) {
			setGitInfo(null);
			setGitLoading(false);
			return;
		}
		let cancelled = false;
		setGitLoading(true);
		setGitInfo(null);
		getGitBranches(project)
			.then((info) => {
				if (cancelled) return;
				setGitInfo(info);
				if (info.isGitRepo) {
					// Worktree needs at least one commit to fork from.
					const canWorktree = info.branches.length > 0;
					setMode(canWorktree ? 'worktree' : 'direct');
					setBaseBranch(info.defaultBranch ?? info.currentBranch ?? null);
				}
				setGitLoading(false);
			})
			.catch(() => {
				if (cancelled) return;
				// Treat a failed lookup as "no git info" — submit still sends the path.
				setGitInfo(null);
				setGitLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [project]);

	const handleBrowse = async () => {
		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			toast.error('Not connected to server. Please wait...');
			return;
		}
		try {
			const picked = await hub.request<{ path: string | null }>('dialog.pickFolder');
			if (!picked?.path) return;
			const folder = picked.path;
			await addWorkspaceToHistory(folder);
			setProjects((prev) =>
				prev.some((p) => p.path === folder)
					? prev
					: [{ path: folder, lastUsedAt: Date.now(), useCount: 1 }, ...prev]
			);
			setProject(folder);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to add project');
		}
	};

	const handleSubmit = async () => {
		const content = text.trim();
		if (!content || submitting) return;
		if (!canCreate) {
			toast.error('Not connected to server. Please wait...');
			return;
		}
		setSubmitting(true);
		try {
			const req: CreateSessionRequest = {};
			if (project) {
				req.workspacePath = project;
				// Worktree mode is only meaningful for a git repo.
				if (gitInfo?.isGitRepo) {
					req.worktreeMode = mode;
					if (mode === 'worktree' && baseBranch) {
						req.worktreeBaseBranch = baseBranch;
					}
				}
			}
			const response = await createSession(req);
			if (!response?.sessionId) {
				toast.error('No sessionId in response');
				setSubmitting(false);
				return;
			}
			const hub = connectionManager.getHubIfConnected();
			if (!hub) throw new ConnectionNotReadyError('Not connected to server');
			await hub.request('message.send', { sessionId: response.sessionId, content });
			navigateToSession(response.sessionId);
			// Navigation unmounts this view, so there is no state to reset.
		} catch (err) {
			if (err instanceof ConnectionNotReadyError) {
				toast.error('Connection lost. Please try again.');
			} else {
				toast.error(err instanceof Error ? err.message : 'Failed to start chat');
			}
			setSubmitting(false);
		}
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSubmit();
		}
	};

	return (
		<div class="flex-1 flex flex-col bg-dark-900 overflow-hidden">
			{/* Mobile: open the sidebar drawer */}
			<div class="md:hidden flex items-center px-3 py-2">
				<MobileMenuButton />
			</div>

			{/* Centered landing */}
			<div class="flex-1 flex flex-col items-center justify-center px-6 pb-16">
				<h1 class="text-2xl md:text-3xl font-semibold text-gray-100 mb-8 text-center">
					What should we build?
				</h1>

				<div class="w-full max-w-2xl">
					<div class="bg-dark-800 border border-dark-700 rounded-2xl px-3 py-2.5 transition-colors focus-within:border-dark-600">
						<textarea
							value={text}
							onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
							onKeyDown={handleKeyDown}
							placeholder="Ask anything to start a new chat..."
							rows={3}
							disabled={submitting}
							autoFocus
							class="w-full bg-transparent resize-none px-1.5 py-1 text-sm text-gray-100 placeholder-gray-500 focus:outline-none disabled:opacity-60"
						/>
						<div class="flex items-center justify-end pt-1">
							<button
								type="button"
								data-testid="landing-send"
								onClick={handleSubmit}
								disabled={!text.trim() || submitting || !canCreate}
								title="Start chat"
								aria-label="Start chat"
								class="flex items-center justify-center w-8 h-8 rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
							>
								{submitting ? (
									<svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
										<circle
											class="opacity-25"
											cx="12"
											cy="12"
											r="10"
											stroke="currentColor"
											stroke-width="4"
										/>
										<path
											class="opacity-75"
											fill="currentColor"
											d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
										/>
									</svg>
								) : (
									<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width={2}
											d="M12 19V5M5 12l7-7 7 7"
										/>
									</svg>
								)}
							</button>
						</div>
					</div>

					{/* Project / worktree / branch context row */}
					<div class="mt-2 px-1">
						<WorkspaceChips
							projects={projects}
							selectedProject={project}
							gitInfo={gitInfo}
							gitLoading={gitLoading}
							mode={mode}
							baseBranch={baseBranch}
							onSelectProject={setProject}
							onBrowse={handleBrowse}
							onSelectMode={setMode}
							onSelectBranch={setBaseBranch}
						/>
					</div>
				</div>
			</div>
		</div>
	);
}
