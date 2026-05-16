import { useEffect, useState } from 'preact/hooks';
import type {
	CreateSessionRequest,
	GitBranchesResponse,
	WorkspaceHistoryEntry,
} from '@neokai/shared';
import { connectionState, sessions } from '../lib/state.ts';
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
import { isUserSession } from '../lib/session-utils.ts';
import { listProjectPaths } from '../lib/projects.ts';
import { MobileMenuButton } from '../components/ui/MobileMenuButton.tsx';
import { WorkspaceChips } from '../components/WorkspaceChips.tsx';

type NewChatWorktreeMode = 'worktree' | 'direct';

interface NewChatSelection {
	project: string | null;
	mode: NewChatWorktreeMode;
	baseBranch: string | null;
}

const NEW_CHAT_SELECTION_KEY = 'neokai_new_chat_selection';
const DEFAULT_NEW_CHAT_SELECTION: NewChatSelection = {
	project: null,
	mode: 'worktree',
	baseBranch: null,
};

function loadNewChatSelection(): NewChatSelection {
	try {
		const stored = localStorage.getItem(NEW_CHAT_SELECTION_KEY);
		if (!stored) return DEFAULT_NEW_CHAT_SELECTION;
		const parsed: unknown = JSON.parse(stored);
		if (!parsed || typeof parsed !== 'object') return DEFAULT_NEW_CHAT_SELECTION;
		const value = parsed as Partial<NewChatSelection>;
		const mode = value.mode === 'direct' ? 'direct' : 'worktree';
		return {
			project: typeof value.project === 'string' ? value.project : null,
			mode,
			baseBranch: typeof value.baseBranch === 'string' ? value.baseBranch : null,
		};
	} catch {
		return DEFAULT_NEW_CHAT_SELECTION;
	}
}

function saveNewChatSelection(selection: NewChatSelection): void {
	try {
		localStorage.setItem(NEW_CHAT_SELECTION_KEY, JSON.stringify(selection));
	} catch {
		// Ignore storage failures; the composer still works without persistence.
	}
}

function getKnownBranches(info: GitBranchesResponse): Set<string> {
	return new Set(
		[info.defaultBranch, info.currentBranch, ...info.branches].filter(
			(branch): branch is string => typeof branch === 'string' && branch.length > 0
		)
	);
}

/**
 * Codex-style landing for `/sessions` when no session is selected: a centered
 * prompt, a starter input, and a project / worktree / branch context row.
 * Submitting creates a session (with the chosen workspace + worktree mode),
 * sends the typed text as its first message, and opens the chat.
 */
export function SessionsPage() {
	const [text, setText] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const [initialSelection] = useState<NewChatSelection>(() => loadNewChatSelection());

	const [history, setHistory] = useState<WorkspaceHistoryEntry[]>([]);
	const [project, setProject] = useState<string | null>(initialSelection.project);
	const [gitInfo, setGitInfo] = useState<GitBranchesResponse | null>(null);
	const [gitLoading, setGitLoading] = useState(false);
	const [mode, setMode] = useState<NewChatWorktreeMode>(initialSelection.mode);
	const [baseBranch, setBaseBranch] = useState<string | null>(initialSelection.baseBranch);

	// Session creation only needs a live connection — auth is exercised later by
	// the message send, which surfaces its own error.
	const canCreate = connectionState.value === 'connected';
	const waitingForProjectGit = project !== null && gitLoading;

	// Project folders shown in the picker — same set as the sidebar: folders
	// with sessions, merged with registered workspace-history folders.
	const projectPaths = listProjectPaths(sessions.value.filter(isUserSession), history);

	// Load registered workspace-history folders for the project picker.
	useEffect(() => {
		getWorkspaceHistory()
			.then(setHistory)
			.catch(() => {
				// Non-critical — the picker still offers "No folder" and "Browse…".
			});
	}, []);

	useEffect(() => {
		saveNewChatSelection({ project, mode, baseBranch });
	}, [project, mode, baseBranch]);

	// Fetch git context whenever the selected project changes.
	useEffect(() => {
		if (!project) {
			setGitInfo(null);
			setGitLoading(false);
			setBaseBranch(null);
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
					const knownBranches = getKnownBranches(info);
					setMode((currentMode) => (canWorktree ? currentMode : 'direct'));
					setBaseBranch((currentBranch) =>
						currentBranch && knownBranches.has(currentBranch)
							? currentBranch
							: (info.defaultBranch ?? info.currentBranch ?? null)
					);
				} else {
					setBaseBranch(null);
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

	const handleSelectProject = (path: string | null) => {
		setProject(path);
		if (!path) setBaseBranch(null);
	};

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
			const entry = await addWorkspaceToHistory(folder);
			setHistory((prev) => [entry, ...prev.filter((p) => p.path !== entry.path)]);
			handleSelectProject(folder);
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
		if (waitingForProjectGit) {
			toast.error('Checking the selected project. Please try again in a moment.');
			return;
		}
		setSubmitting(true);
		let createdSessionId: string | null = null;
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
			createdSessionId = response.sessionId;
			const hub = connectionManager.getHubIfConnected();
			if (!hub) throw new ConnectionNotReadyError('Not connected to server');
			await hub.request('message.send', { sessionId: response.sessionId, content });
			navigateToSession(response.sessionId);
			// Navigation unmounts this view, so there is no state to reset.
		} catch (err) {
			if (createdSessionId) {
				toast.error('Chat was created, but the first message failed. Opened it so you can retry.');
				navigateToSession(createdSessionId);
				return;
			} else if (err instanceof ConnectionNotReadyError) {
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
								disabled={!text.trim() || submitting || !canCreate || waitingForProjectGit}
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
							projects={projectPaths}
							selectedProject={project}
							gitInfo={gitInfo}
							gitLoading={gitLoading}
							mode={mode}
							baseBranch={baseBranch}
							onSelectProject={handleSelectProject}
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
