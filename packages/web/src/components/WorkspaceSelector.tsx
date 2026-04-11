/**
 * WorkspaceSelector Component
 *
 * Inline workspace selector shown in the chat container for sessions
 * that were created without a workspace. Allows users to:
 * - Select from recent workspace history (pre-selected: most recent)
 * - Pick a new workspace via system folder picker
 * - Choose worktree vs direct mode
 * - Skip workspace selection entirely
 */

import { useState, useEffect } from 'preact/hooks';
import type { WorkspaceHistoryEntry } from '@neokai/shared';
import { connectionManager } from '../lib/connection-manager';
import {
	getWorkspaceHistory,
	addWorkspaceToHistory,
	setSessionWorkspace,
} from '../lib/api-helpers';
import { addRecentPath } from '../lib/recent-paths';

interface WorkspaceSelectorProps {
	sessionId: string;
	onConfirm: (workspacePath: string, worktreeMode: 'worktree' | 'direct') => void;
	onSkip: () => void;
}

export function WorkspaceSelector({ sessionId, onConfirm, onSkip }: WorkspaceSelectorProps) {
	const [history, setHistory] = useState<WorkspaceHistoryEntry[]>([]);
	const [selectedPath, setSelectedPath] = useState<string>('');
	const [customPath, setCustomPath] = useState<string>('');
	const [showCustomInput, setShowCustomInput] = useState(false);
	const [worktreeMode, setWorktreeMode] = useState<'worktree' | 'direct'>('worktree');
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		getWorkspaceHistory()
			.then((entries) => {
				setHistory(entries);
				// Pre-select most recent workspace
				if (entries.length > 0) {
					setSelectedPath(entries[0].path);
				}
			})
			.catch(() => {
				// Non-critical - proceed without history
			});
	}, []);

	const activePath = showCustomInput ? customPath.trim() : selectedPath;

	const handleBrowse = async () => {
		try {
			const hub = connectionManager.getHubIfConnected();
			if (!hub) return;
			const response = await hub.request<{ path: string | null }>('dialog.pickFolder');
			if (response.path) {
				setCustomPath(response.path);
				setShowCustomInput(true);
				setSelectedPath('');
			}
		} catch {
			// Silently ignore - user cancelled dialog
		}
	};

	const handleSelectChange = (value: string) => {
		if (value === '__new__') {
			setShowCustomInput(true);
			setSelectedPath('');
		} else {
			setSelectedPath(value);
			setShowCustomInput(false);
		}
	};

	const handleConfirm = async () => {
		const path = activePath;
		if (!path) {
			setError('Please select or enter a workspace path');
			return;
		}

		try {
			setLoading(true);
			setError(null);

			await setSessionWorkspace(sessionId, path, worktreeMode);

			// Persist to history
			addRecentPath(path);
			addWorkspaceToHistory(path).catch(() => {});

			onConfirm(path, worktreeMode);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to set workspace');
		} finally {
			setLoading(false);
		}
	};

	return (
		<div class="border-t border-dark-700 bg-dark-850/60 px-4 py-3">
			<div class="max-w-4xl mx-auto">
				<div class="flex items-start gap-3">
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2 mb-2">
							<svg
								class="w-4 h-4 text-blue-400 shrink-0"
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
							<span class="text-sm font-medium text-gray-200">Select a workspace</span>
							<span class="text-xs text-gray-500">(optional)</span>
						</div>

						{/* Workspace Dropdown */}
						{!showCustomInput ? (
							<div class="flex gap-2">
								<select
									value={selectedPath}
									onChange={(e) => handleSelectChange((e.target as HTMLSelectElement).value)}
									class="flex-1 bg-dark-800 border border-dark-600 rounded-lg px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500 cursor-pointer"
								>
									{history.length === 0 && <option value="">No recent workspaces</option>}
									{history.map((item) => (
										<option key={item.path} value={item.path}>
											{item.path}
										</option>
									))}
									<option value="__new__">Select new workspace...</option>
								</select>
								<button
									type="button"
									onClick={handleBrowse}
									title="Browse for folder"
									class="p-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-400 hover:text-gray-100 border border-dark-600 transition-colors"
								>
									<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width={2}
											d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
										/>
									</svg>
								</button>
							</div>
						) : (
							<div class="flex gap-2">
								<input
									type="text"
									value={customPath}
									onInput={(e) => setCustomPath((e.target as HTMLInputElement).value)}
									placeholder="Enter workspace path..."
									autoFocus
									class="flex-1 bg-dark-800 border border-dark-600 rounded-lg px-3 py-1.5 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
								/>
								<button
									type="button"
									onClick={handleBrowse}
									title="Browse for folder"
									class="p-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-400 hover:text-gray-100 border border-dark-600 transition-colors"
								>
									<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width={2}
											d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
										/>
									</svg>
								</button>
								{history.length > 0 && (
									<button
										type="button"
										onClick={() => {
											setShowCustomInput(false);
											setSelectedPath(history[0].path);
										}}
										class="p-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-400 hover:text-gray-100 border border-dark-600 transition-colors"
										title="Back to history"
									>
										<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width={2}
												d="M15 19l-7-7 7-7"
											/>
										</svg>
									</button>
								)}
							</div>
						)}

						{/* Worktree/Direct Toggle - shown when a path is selected */}
						{activePath && (
							<div class="mt-2 flex items-center gap-2">
								<span class="text-xs text-gray-500">Mode:</span>
								<div class="flex rounded-lg overflow-hidden border border-dark-600">
									<button
										type="button"
										onClick={() => setWorktreeMode('worktree')}
										class={`px-3 py-1 text-xs font-medium transition-colors ${
											worktreeMode === 'worktree'
												? 'bg-green-700/50 text-green-300 border-r border-dark-600'
												: 'bg-dark-800 text-gray-400 hover:text-gray-200 border-r border-dark-600'
										}`}
									>
										Worktree
									</button>
									<button
										type="button"
										onClick={() => setWorktreeMode('direct')}
										class={`px-3 py-1 text-xs font-medium transition-colors ${
											worktreeMode === 'direct'
												? 'bg-amber-700/40 text-amber-300'
												: 'bg-dark-800 text-gray-400 hover:text-gray-200'
										}`}
									>
										Direct
									</button>
								</div>
								<span class="text-xs text-gray-600">
									{worktreeMode === 'worktree' ? 'Isolated branch (safe)' : 'Edit directly (fast)'}
								</span>
							</div>
						)}

						{error && <p class="mt-1.5 text-xs text-red-400">{error}</p>}
					</div>

					{/* Action buttons */}
					<div class="flex items-center gap-2 shrink-0 mt-6">
						<button
							type="button"
							onClick={onSkip}
							class="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
						>
							Skip
						</button>
						<button
							type="button"
							onClick={handleConfirm}
							disabled={!activePath || loading}
							class="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg transition-colors"
						>
							{loading ? 'Setting...' : 'Set Workspace'}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
