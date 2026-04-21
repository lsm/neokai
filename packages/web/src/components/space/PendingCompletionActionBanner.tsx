/**
 * PendingCompletionActionBanner — thread-view CTA for completion-action pauses.
 *
 * Renders when the task is paused at a workflow end-node `completionAction` —
 * i.e. `task.pendingCheckpointType === 'completion_action'` and
 * `pendingActionIndex` points at a real action on the run's end node. Provides
 * Approve and Reject controls. Approve forwards to `spaceTask.update` with
 * `status: 'done'` which the daemon intercepts and routes through the runtime's
 * completion-action resume path (see
 * `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts`). Reject maps to
 * `status: 'cancelled'` — we treat rejection as cancelling the task, which is
 * the transition the daemon already permits out of `review`.
 *
 * Compact design: shows a single status line inline; full action details and
 * confirmation are shown in modals opened by the Approve / Reject buttons.
 *
 * Distinct from `PendingGateBanner` (workflow-level gates) and
 * `TaskBlockedBanner` (blocked-status tasks). The three can, in principle, be
 * shown at the same time if a task is both blocked at a gate and paused at a
 * completion action — `SpaceTaskPane` decides the priority.
 */

import { useCallback, useMemo, useState } from 'preact/hooks';
import type { CompletionAction, SpaceAutonomyLevel, SpaceTask } from '@neokai/shared';
import { spaceStore } from '../../lib/space-store';
import { AUTONOMY_LABELS } from '../../lib/space-constants';
import { Modal } from '../ui/Modal.tsx';

interface PendingCompletionActionBannerProps {
	task: SpaceTask;
	spaceId: string;
	/** Space autonomy level for "requires level X" context. Defaults to 1 when unknown. */
	spaceAutonomyLevel?: SpaceAutonomyLevel;
}

/**
 * Resolves the paused-on `CompletionAction` from the task's workflow run.
 *
 * Returns `null` when the task is not paused at a completion-action checkpoint,
 * when the run/workflow/end-node can't be found in the store, or when the
 * `pendingActionIndex` is out of range (workflow edited between pause and
 * render). The banner treats all of these as "nothing to show" rather than
 * crashing — the daemon still owns the truth and will surface a mismatch when
 * the user clicks Approve.
 */
export function resolvePendingCompletionAction(task: SpaceTask): CompletionAction | null {
	if (task.pendingCheckpointType !== 'completion_action') return null;
	if (task.pendingActionIndex == null) return null;
	if (!task.workflowRunId) return null;

	const run = spaceStore.workflowRuns.value.find((r) => r.id === task.workflowRunId);
	if (!run) return null;

	const workflow = spaceStore.workflows.value.find((w) => w.id === run.workflowId);
	if (!workflow) return null;

	const endNodeId = workflow.endNodeId;
	if (!endNodeId) return null;

	const endNode = workflow.nodes.find((n) => n.id === endNodeId);
	const actions = endNode?.completionActions;
	if (!actions || actions.length === 0) return null;

	const action = actions[task.pendingActionIndex];
	return action ?? null;
}

export function PendingCompletionActionBanner({
	task,
	spaceId: _spaceId,
	spaceAutonomyLevel,
}: PendingCompletionActionBannerProps) {
	const action = useMemo(() => resolvePendingCompletionAction(task), [task]);

	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showApproveModal, setShowApproveModal] = useState(false);
	const [showRejectModal, setShowRejectModal] = useState(false);
	const [rejectReason, setRejectReason] = useState('');

	const onApprove = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			// Daemon intercepts `status: 'done'` when pendingCheckpointType is
			// 'completion_action' and routes through resumeCompletionActions. It
			// recomputes the resulting status (done / review / blocked) based on
			// the action outcome + remaining actions, so we don't need to guess.
			await spaceStore.updateTask(task.id, { status: 'done' });
			setShowApproveModal(false);
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : 'Failed to approve');
		} finally {
			setBusy(false);
		}
	}, [task.id]);

	const onRejectConfirm = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			// Rejection-as-cancel: the task transitions review → cancelled, which is
			// a valid transition the daemon already allows. The completion action is
			// not executed. We explicitly clear `pendingActionIndex` and
			// `pendingCheckpointType` in the same call — `setTaskStatus` on the
			// daemon doesn't clear them, and stale values would confuse the
			// awaiting-approval summary (which filters on pendingCheckpointType).
			const reason = rejectReason.trim();
			await spaceStore.updateTask(task.id, {
				status: 'cancelled',
				pendingActionIndex: null,
				pendingCheckpointType: null,
				...(reason ? { result: reason } : {}),
			});
			setShowRejectModal(false);
			setRejectReason('');
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : 'Failed to reject');
		} finally {
			setBusy(false);
		}
	}, [task.id, rejectReason]);

	if (!action) return null;

	const currentLevel: SpaceAutonomyLevel = spaceAutonomyLevel ?? 1;
	const requiredLabel = AUTONOMY_LABELS[action.requiredLevel] ?? `Level ${action.requiredLevel}`;
	const currentLabel = AUTONOMY_LABELS[currentLevel] ?? `Level ${currentLevel}`;

	const typeLabel =
		action.type === 'script'
			? 'Bash script'
			: action.type === 'instruction'
				? 'Agent instruction'
				: 'MCP tool call';

	return (
		<>
			{/* Compact one-line banner */}
			<div
				class="mx-4 mt-2 mb-2 flex items-center gap-2 px-2 py-1 rounded text-xs text-amber-400/90"
				data-testid="pending-completion-action-banner"
				data-action-type={action.type}
			>
				<span class="shrink-0">⏸</span>
				<span class="flex-1 min-w-0 truncate">
					Completion action: <span class="font-medium">{action.name}</span>
					<span class="text-amber-400/60 ml-1">· {typeLabel}</span>
					<span class="text-amber-400/60 ml-1">· requires Level {action.requiredLevel}</span>
				</span>

				<div class="flex items-center gap-1 flex-shrink-0">
					<button
						type="button"
						onClick={() => {
							setError(null);
							setShowApproveModal(true);
						}}
						disabled={busy}
						data-testid="pending-completion-action-approve-btn"
						class="px-2 py-0.5 text-xs font-medium rounded bg-green-900/40 text-green-300 border border-green-700/50 hover:bg-green-800/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
					>
						Approve
					</button>
					<button
						type="button"
						onClick={() => {
							setError(null);
							setShowRejectModal(true);
						}}
						disabled={busy}
						data-testid="pending-completion-action-reject-btn"
						class="px-2 py-0.5 text-xs font-medium rounded bg-red-900/40 text-red-300 border border-red-700/50 hover:bg-red-800/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
					>
						Reject
					</button>
				</div>
			</div>

			{/* Approve modal */}
			<Modal
				isOpen={showApproveModal}
				onClose={() => {
					if (!busy) {
						setShowApproveModal(false);
						setError(null);
					}
				}}
				title={`Approve "${action.name}"?`}
				size="md"
				data-testid="pending-completion-action-approve-modal"
			>
				<div class="space-y-4" data-testid="pending-completion-action-approve-modal-content">
					<div class="text-xs text-amber-400/80" data-testid="pending-completion-action-type">
						{typeLabel} · requires {requiredLabel} (Level {action.requiredLevel}); space is{' '}
						<span data-testid="pending-completion-action-current-level">
							{currentLabel} (Level {currentLevel})
						</span>
					</div>

					<CompletionActionDetails action={action} />

					{error && (
						<p class="text-xs text-red-400" data-testid="pending-completion-action-error">
							{error}
						</p>
					)}

					<div class="flex items-center justify-end gap-3 pt-1">
						<button
							type="button"
							onClick={() => {
								if (!busy) {
									setShowApproveModal(false);
									setError(null);
								}
							}}
							disabled={busy}
							class="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white bg-dark-800 hover:bg-dark-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={() => void onApprove()}
							disabled={busy}
							data-testid="pending-completion-action-approve-confirm"
							class="px-4 py-2 text-sm font-medium rounded-lg transition-colors bg-green-600 hover:bg-green-700 text-white disabled:bg-green-600/50 disabled:cursor-not-allowed"
						>
							{busy ? 'Processing...' : 'Approve'}
						</button>
					</div>
				</div>
			</Modal>

			{/* Reject modal */}
			<Modal
				isOpen={showRejectModal}
				onClose={() => {
					if (!busy) {
						setShowRejectModal(false);
						setRejectReason('');
						setError(null);
					}
				}}
				title={`Reject "${action.name}"?`}
				size="md"
				data-testid="pending-completion-action-reject-modal"
			>
				<div class="space-y-4" data-testid="pending-completion-action-reject-modal-content">
					<p class="text-gray-300 text-sm leading-relaxed">
						The task will be cancelled and the {typeLabel.toLowerCase()} will not run. This can't be
						undone by the banner — to retry, reopen the task.
					</p>

					<CompletionActionDetails action={action} />

					<div>
						<label class="block text-xs text-gray-400 mb-1" for="reject-reason-input">
							Reason (optional — recorded on the task)
						</label>
						<textarea
							id="reject-reason-input"
							data-testid="pending-completion-action-reject-reason"
							value={rejectReason}
							onInput={(e) => setRejectReason((e.target as HTMLTextAreaElement).value)}
							class="w-full rounded border border-dark-600 bg-dark-800 px-2 py-1 text-sm text-gray-200 focus:border-red-500 focus:outline-none"
							rows={2}
							disabled={busy}
						/>
					</div>

					{error && (
						<p class="text-xs text-red-400" data-testid="pending-completion-action-error">
							{error}
						</p>
					)}

					<div class="flex items-center justify-end gap-3 pt-1">
						<button
							type="button"
							onClick={() => {
								if (!busy) {
									setShowRejectModal(false);
									setRejectReason('');
									setError(null);
								}
							}}
							disabled={busy}
							class="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white bg-dark-800 hover:bg-dark-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						>
							Keep Pending
						</button>
						<button
							type="button"
							onClick={() => void onRejectConfirm()}
							disabled={busy}
							data-testid="pending-completion-action-reject-confirm"
							class="px-4 py-2 text-sm font-medium rounded-lg transition-colors bg-red-600 hover:bg-red-700 text-white disabled:bg-red-600/50 disabled:cursor-not-allowed"
						>
							{busy ? 'Processing...' : 'Reject and Cancel Task'}
						</button>
					</div>
				</div>
			</Modal>
		</>
	);
}

/**
 * Collapsible details for a completion action.
 *
 * Kept inside this file (rather than a dedicated component) because it's
 * display-only and has no state of its own beyond the native `<details>`
 * disclosure.
 */
function CompletionActionDetails({ action }: { action: CompletionAction }) {
	if (action.type === 'script') {
		return (
			<details
				class="text-xs"
				data-testid="pending-completion-action-details"
				data-action-type="script"
			>
				<summary class="cursor-pointer text-amber-400/80 hover:text-amber-300 select-none">
					Show script source
				</summary>
				<pre
					class="mt-2 p-2 bg-dark-900/60 border border-dark-700 rounded overflow-x-auto whitespace-pre-wrap text-[11px] text-gray-300"
					data-testid="pending-completion-action-script"
				>
					{action.script}
				</pre>
			</details>
		);
	}

	if (action.type === 'instruction') {
		return (
			<details
				class="text-xs"
				data-testid="pending-completion-action-details"
				data-action-type="instruction"
			>
				<summary class="cursor-pointer text-amber-400/80 hover:text-amber-300 select-none">
					Show instruction
				</summary>
				<p class="mt-2 p-2 bg-dark-900/60 border border-dark-700 rounded text-[11px] text-gray-300">
					<span class="text-gray-500">→ agent </span>
					<span class="font-mono">{action.agentName}</span>
				</p>
				<pre
					class="mt-1 p-2 bg-dark-900/60 border border-dark-700 rounded overflow-x-auto whitespace-pre-wrap text-[11px] text-gray-300"
					data-testid="pending-completion-action-instruction"
				>
					{action.instruction}
				</pre>
			</details>
		);
	}

	// mcp_call
	return (
		<details
			class="text-xs"
			data-testid="pending-completion-action-details"
			data-action-type="mcp_call"
		>
			<summary class="cursor-pointer text-amber-400/80 hover:text-amber-300 select-none">
				Show MCP call
			</summary>
			<p class="mt-2 p-2 bg-dark-900/60 border border-dark-700 rounded text-[11px] text-gray-300">
				<span class="text-gray-500">server </span>
				<span class="font-mono">{action.server}</span>
				<span class="text-gray-500"> · tool </span>
				<span class="font-mono">{action.tool}</span>
			</p>
			<pre
				class="mt-1 p-2 bg-dark-900/60 border border-dark-700 rounded overflow-x-auto whitespace-pre-wrap text-[11px] text-gray-300"
				data-testid="pending-completion-action-mcp-args"
			>
				{JSON.stringify(action.args, null, 2)}
			</pre>
		</details>
	);
}
