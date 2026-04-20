/**
 * PendingTaskCompletionBanner — thread-view CTA for `submit_for_approval` pauses.
 *
 * Renders when the task is paused at a `submit_for_approval` checkpoint — i.e.
 * `task.pendingCheckpointType === 'task_completion'`. Provides Approve and
 * Reject controls.
 *
 * - Approve → `spaceTask.approvePendingCompletion({ approved: true, reason? })`
 *   which transitions review → done, stamps human approval metadata, clears
 *   the pending-completion fields, and fires `space.task.updated`.
 * - Reject  → `spaceTask.approvePendingCompletion({ approved: false, reason? })`
 *   which transitions review → in_progress so the end-node agent can revise
 *   its output; clears the pending-completion fields.
 *
 * Distinct from `PendingCompletionActionBanner` (completion-action checkpoints,
 * `pendingCheckpointType === 'completion_action'`) which runs a configured
 * script/instruction/mcp_call on approval.
 */

import { useCallback, useState } from 'preact/hooks';
import type { SpaceTask } from '@neokai/shared';
import { spaceStore } from '../../lib/space-store';
import { ConfirmModal } from '../ui/ConfirmModal';

interface PendingTaskCompletionBannerProps {
	task: SpaceTask;
	spaceId: string;
}

function formatPendingSince(submittedAt: number | null | undefined): string | null {
	if (!submittedAt) return null;
	const delta = Date.now() - submittedAt;
	if (delta < 0) return null;
	const seconds = Math.floor(delta / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

export function PendingTaskCompletionBanner({
	task,
	spaceId: _spaceId,
}: PendingTaskCompletionBannerProps) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showRejectConfirm, setShowRejectConfirm] = useState(false);
	const [rejectReason, setRejectReason] = useState('');
	const [approveReason, setApproveReason] = useState('');

	const onApprove = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			const reason = approveReason.trim();
			await spaceStore.approvePendingCompletion(task.id, true, reason ? reason : null);
			setApproveReason('');
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : 'Failed to approve');
		} finally {
			setBusy(false);
		}
	}, [task.id, approveReason]);

	const onRejectConfirm = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			const reason = rejectReason.trim();
			await spaceStore.approvePendingCompletion(task.id, false, reason ? reason : null);
			setShowRejectConfirm(false);
			setRejectReason('');
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : 'Failed to reject');
		} finally {
			setBusy(false);
		}
	}, [task.id, rejectReason]);

	if (task.pendingCheckpointType !== 'task_completion') return null;

	const agentReason = task.pendingCompletionReason?.trim();
	const submittedBy = task.pendingCompletionSubmittedByNodeId;
	const submittedAgo = formatPendingSince(task.pendingCompletionSubmittedAt ?? null);

	return (
		<>
			<div
				class="mx-4 mt-2 mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 space-y-2"
				data-testid="pending-task-completion-banner"
			>
				<div class="flex items-start justify-between gap-2">
					<div class="flex-1 min-w-0">
						<p class="text-xs font-medium text-amber-300">
							Awaiting Human Approval — Submit for Review
						</p>
						<p class="mt-0.5 text-xs text-amber-400/70">
							An end-node agent requested human sign-off
							{submittedBy ? ` (node: ${submittedBy})` : ''}
							{submittedAgo ? ` · ${submittedAgo}` : ''}.
						</p>
					</div>

					<div class="flex items-center gap-1.5 flex-shrink-0">
						<button
							type="button"
							onClick={() => void onApprove()}
							disabled={busy}
							data-testid="pending-task-completion-approve-btn"
							class="px-2 py-1 text-xs font-medium rounded bg-green-900/40 text-green-300 border border-green-700/50 hover:bg-green-800/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
						>
							Approve
						</button>
						<button
							type="button"
							onClick={() => setShowRejectConfirm(true)}
							disabled={busy}
							data-testid="pending-task-completion-reject-btn"
							class="px-2 py-1 text-xs font-medium rounded bg-red-900/40 text-red-300 border border-red-700/50 hover:bg-red-800/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
						>
							Send back
						</button>
					</div>
				</div>

				{agentReason && (
					<div class="text-xs" data-testid="pending-task-completion-agent-reason">
						<p class="text-amber-400/80">Agent rationale:</p>
						<p class="mt-0.5 p-2 bg-dark-900/60 border border-dark-700 rounded text-[11px] text-gray-300 whitespace-pre-wrap">
							{agentReason}
						</p>
					</div>
				)}

				<div>
					<label class="block text-[11px] text-gray-400 mb-1" for="approve-reason-input">
						Approval note (optional — recorded on the task)
					</label>
					<textarea
						id="approve-reason-input"
						data-testid="pending-task-completion-approve-reason"
						value={approveReason}
						onInput={(e) => setApproveReason((e.target as HTMLTextAreaElement).value)}
						class="w-full rounded border border-dark-600 bg-dark-800 px-2 py-1 text-[11px] text-gray-200 focus:border-amber-500 focus:outline-none"
						rows={2}
						disabled={busy}
					/>
				</div>

				{error && (
					<p class="text-xs text-red-400" data-testid="pending-task-completion-error">
						{error}
					</p>
				)}
			</div>

			<ConfirmModal
				isOpen={showRejectConfirm}
				onClose={() => {
					if (!busy) {
						setShowRejectConfirm(false);
						setRejectReason('');
					}
				}}
				onConfirm={() => void onRejectConfirm()}
				title="Send task back for revision?"
				message="The task will be reopened (status: in_progress) so the end-node agent can revise and re-submit. The pending-completion request will be cleared."
				confirmText="Send back to agent"
				cancelText="Keep Pending"
				confirmButtonVariant="danger"
				isLoading={busy}
				error={error}
				confirmTestId="pending-task-completion-reject-confirm"
			>
				<label class="block text-xs text-gray-400 mb-1" for="task-completion-reject-reason-input">
					Reason (optional — shared with the agent as feedback)
				</label>
				<textarea
					id="task-completion-reject-reason-input"
					data-testid="pending-task-completion-reject-reason"
					value={rejectReason}
					onInput={(e) => setRejectReason((e.target as HTMLTextAreaElement).value)}
					class="w-full rounded border border-dark-600 bg-dark-800 px-2 py-1 text-sm text-gray-200 focus:border-red-500 focus:outline-none"
					rows={3}
					disabled={busy}
				/>
			</ConfirmModal>
		</>
	);
}
