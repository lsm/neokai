import { useEffect, useState } from 'preact/hooks';
import type { GitChangedFile, GitFileStatusKind, GitSessionStatusResponse } from '@neokai/shared';
import { getGitSessionStatus } from '../lib/api-helpers.ts';
import { cn } from '../lib/utils.ts';

interface GitPanelProps {
	sessionId: string;
	onClose: () => void;
}

const STATUS_LABELS: Record<GitFileStatusKind, string> = {
	modified: 'Modified',
	added: 'Added',
	deleted: 'Deleted',
	renamed: 'Renamed',
	untracked: 'Untracked',
	conflicted: 'Conflicted',
	other: 'Other',
};

const STATUS_DOTS: Record<GitFileStatusKind, string> = {
	modified: 'bg-amber-400',
	added: 'bg-emerald-400',
	deleted: 'bg-red-400',
	renamed: 'bg-sky-400',
	untracked: 'bg-violet-400',
	conflicted: 'bg-orange-500',
	other: 'bg-gray-500',
};

const STATUS_ORDER: GitFileStatusKind[] = [
	'conflicted',
	'modified',
	'added',
	'deleted',
	'renamed',
	'untracked',
	'other',
];

function basename(path: string | null): string {
	if (!path) return 'None';
	const trimmed = path.replace(/\/+$/, '');
	return trimmed.split('/').pop() || trimmed;
}

function modeLabel(status: GitSessionStatusResponse): string {
	if (status.mode === 'worktree') return 'Worktree';
	if (status.mode === 'direct') return 'Direct';
	return 'No workspace';
}

function groupFiles(
	files: GitChangedFile[]
): Array<{ status: GitFileStatusKind; files: GitChangedFile[] }> {
	return STATUS_ORDER.map((status) => ({
		status,
		files: files.filter((file) => file.status === status),
	})).filter((group) => group.files.length > 0);
}

function InfoRow({ label, value, title }: { label: string; value: string; title?: string }) {
	return (
		<div class="min-w-0">
			<div class="text-[11px] font-medium uppercase text-gray-600">{label}</div>
			<div class="mt-1 truncate text-sm text-gray-300" title={title ?? value}>
				{value}
			</div>
		</div>
	);
}

function EmptyState({ title, body }: { title: string; body: string }) {
	return (
		<div class="flex flex-1 items-center justify-center px-6 text-center">
			<div>
				<svg
					class="mx-auto mb-3 h-10 w-10 text-gray-700"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={1.5}
						d="M6 3v7m0 0a3 3 0 100-6 3 3 0 000 6zm0 0v11m12-7V3m0 11a3 3 0 100-6 3 3 0 000 6zm0 0v7"
					/>
				</svg>
				<p class="text-sm font-medium text-gray-300">{title}</p>
				<p class="mt-1 text-xs leading-relaxed text-gray-500">{body}</p>
			</div>
		</div>
	);
}

function GitPanelBody({ status }: { status: GitSessionStatusResponse }) {
	if (status.mode === 'none') {
		return (
			<EmptyState
				title="No Git workspace"
				body="This chat was started without a project folder, so there is no repository state to show."
			/>
		);
	}

	if (!status.isGitRepo) {
		return (
			<EmptyState
				title="Not a Git repository"
				body="This chat has a workspace folder, but it is not inside a Git repository."
			/>
		);
	}

	const groups = groupFiles(status.files);

	return (
		<div class="flex-1 overflow-y-auto px-4 py-4">
			<div class="space-y-5">
				<section>
					<div class="mb-3 flex items-center justify-between gap-3">
						<h3 class="text-xs font-medium uppercase text-gray-500">Repository</h3>
						<span
							class={cn(
								'rounded-full px-2 py-0.5 text-xs font-medium',
								status.mode === 'worktree'
									? 'bg-emerald-400/10 text-emerald-300'
									: 'bg-amber-400/10 text-amber-300'
							)}
						>
							{modeLabel(status)}
						</span>
					</div>
					<div class="space-y-3 rounded-lg bg-white/[0.03] p-3">
						<InfoRow label="Branch" value={status.branch ?? 'Detached'} />
						{status.baseBranch && <InfoRow label="Base" value={status.baseBranch} />}
						<InfoRow
							label={status.mode === 'worktree' ? 'Worktree' : 'Workspace'}
							value={basename(status.worktreePath ?? status.workspacePath)}
							title={status.worktreePath ?? status.workspacePath ?? undefined}
						/>
						{status.mode === 'worktree' && status.workspacePath && (
							<InfoRow
								label="Project"
								value={basename(status.workspacePath)}
								title={status.workspacePath}
							/>
						)}
					</div>
					{status.mode === 'direct' && (
						<p class="mt-2 rounded-lg bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-200">
							Direct mode edits the real checkout. Changes here are not isolated in a session
							worktree.
						</p>
					)}
				</section>

				<section>
					<div class="mb-3 flex items-center justify-between">
						<h3 class="text-xs font-medium uppercase text-gray-500">Changes</h3>
						<span class="text-xs text-gray-500">
							{status.files.length === 0
								? 'Clean'
								: `${status.files.length} file${status.files.length === 1 ? '' : 's'}`}
						</span>
					</div>
					{groups.length === 0 ? (
						<div class="rounded-lg bg-white/[0.03] px-3 py-4 text-sm text-gray-500">
							Working tree is clean.
						</div>
					) : (
						<div class="space-y-3">
							{groups.map((group) => (
								<div key={group.status}>
									<div class="mb-1.5 flex items-center gap-2 px-1">
										<span class={cn('h-2 w-2 rounded-full', STATUS_DOTS[group.status])} />
										<span class="text-xs font-medium text-gray-400">
											{STATUS_LABELS[group.status]}
										</span>
										<span class="text-xs text-gray-600">{group.files.length}</span>
									</div>
									<div class="space-y-0.5">
										{group.files.map((file) => (
											<div
												key={`${group.status}:${file.path}:${file.oldPath ?? ''}`}
												class="rounded-md px-2 py-1.5 text-xs text-gray-400 hover:bg-white/5"
												title={file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}
											>
												<div class="truncate font-mono">{file.path}</div>
												{file.oldPath && (
													<div class="mt-0.5 truncate font-mono text-gray-600">
														from {file.oldPath}
													</div>
												)}
											</div>
										))}
									</div>
								</div>
							))}
						</div>
					)}
				</section>

				<section>
					<div class="mb-3 flex items-center justify-between">
						<h3 class="text-xs font-medium uppercase text-gray-500">Commits</h3>
						{status.aheadCount !== null && (
							<span class="text-xs text-gray-500">
								{status.aheadCount} ahead
								{status.behindCount ? `, ${status.behindCount} behind` : ''}
							</span>
						)}
					</div>
					{status.commitsAhead.length === 0 ? (
						<div class="rounded-lg bg-white/[0.03] px-3 py-4 text-sm text-gray-500">
							No commits ahead of {status.baseBranch ?? 'base'}.
						</div>
					) : (
						<div class="space-y-1">
							{status.commitsAhead.map((commit) => (
								<div key={commit.hash} class="rounded-lg bg-white/[0.03] px-3 py-2">
									<div class="flex items-center gap-2">
										<span class="font-mono text-xs text-emerald-300">{commit.hash}</span>
										<span class="min-w-0 flex-1 truncate text-sm text-gray-300">
											{commit.message}
										</span>
									</div>
									<div class="mt-1 truncate text-xs text-gray-600">
										{commit.author} - {new Date(commit.date).toLocaleDateString()}
									</div>
								</div>
							))}
						</div>
					)}
				</section>

				{status.error && (
					<p class="rounded-lg bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-300">
						{status.error}
					</p>
				)}
			</div>
		</div>
	);
}

export function GitPanel({ sessionId, onClose }: GitPanelProps) {
	const [status, setStatus] = useState<GitSessionStatusResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const refresh = () => {
		setLoading(true);
		setError(null);
		getGitSessionStatus(sessionId)
			.then((nextStatus) => {
				setStatus(nextStatus);
			})
			.catch((err) => {
				setError(err instanceof Error ? err.message : 'Failed to load Git status');
			})
			.finally(() => {
				setLoading(false);
			});
	};

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		getGitSessionStatus(sessionId)
			.then((nextStatus) => {
				if (!cancelled) setStatus(nextStatus);
			})
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load Git status');
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	return (
		<aside class="hidden w-80 flex-shrink-0 flex-col border-l border-dark-700 bg-dark-800 lg:flex">
			<div class="flex h-[65px] flex-shrink-0 items-center gap-2 px-4">
				<div class="min-w-0 flex-1">
					<h2 class="text-sm font-semibold text-gray-100">Git</h2>
					<p class="truncate text-xs text-gray-500">
						{status?.branch ?? (loading ? 'Loading status...' : 'Session workspace')}
					</p>
				</div>
				<button
					type="button"
					onClick={refresh}
					disabled={loading}
					class="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-white/5 hover:text-gray-100 disabled:opacity-50"
					title="Refresh Git status"
					aria-label="Refresh Git status"
				>
					<svg
						class={cn('h-4 w-4', loading && 'animate-spin')}
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
						/>
					</svg>
				</button>
				<button
					type="button"
					onClick={onClose}
					class="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-white/5 hover:text-gray-100"
					title="Close Git panel"
					aria-label="Close Git panel"
				>
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M6 18L18 6M6 6l12 12"
						/>
					</svg>
				</button>
			</div>

			{loading && !status ? (
				<div class="flex-1 px-4 py-4">
					<div class="space-y-3">
						<div class="h-20 rounded-lg bg-white/[0.03] animate-pulse" />
						<div class="h-32 rounded-lg bg-white/[0.03] animate-pulse" />
						<div class="h-24 rounded-lg bg-white/[0.03] animate-pulse" />
					</div>
				</div>
			) : error ? (
				<EmptyState title="Git status unavailable" body={error} />
			) : status ? (
				<GitPanelBody status={status} />
			) : null}
		</aside>
	);
}
