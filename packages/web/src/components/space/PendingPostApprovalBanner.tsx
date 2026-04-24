/**
 * PendingPostApprovalBanner — surfaces tasks stuck mid-post-approval.
 *
 * Renders when a task is in the `approved` status (i.e. the runtime routed
 * post-approval work) AND the router recorded a reason it could not complete
 * (`postApprovalBlockedReason` is set). This is a signal to the human that a
 * spawned post-approval sub-session failed — e.g. the sub-session died before
 * calling `mark_complete`, or the configured target agent could not be found.
 *
 * The banner offers three actions:
 *   - **Retry** — re-run the approval dispatch (not implemented yet; surfaces
 *     a disabled placeholder with a future hook).
 *   - **Mark done** — manually transition `approved → done` via
 *     `spaceTask.update`. Equivalent to the end-node calling `mark_complete`
 *     itself; use when the work is provably finished but the sub-session
 *     failed to self-close.
 *   - **View session** — navigates to the spawned sub-session if we have a
 *     session id on `task.postApprovalSessionId`.
 *
 * Not shown when `task.status !== 'approved'` — `approved` with no
 * `postApprovalBlockedReason` is the healthy mid-flight state and does not
 * warrant a banner.
 */

import { useCallback, useState } from 'preact/hooks';
import type { SpaceTask } from '@neokai/shared';
import { spaceStore } from '../../lib/space-store';
import { InlineStatusBanner, type InlineStatusBannerAction } from './InlineStatusBanner';

export interface PendingPostApprovalBannerProps {
	task: SpaceTask;
	spaceId: string;
	/** Optional navigation hook for the "View session" action. */
	onViewSession?: (sessionId: string) => void;
}

export function PendingPostApprovalBanner({
	task,
	spaceId: _spaceId,
	onViewSession,
}: PendingPostApprovalBannerProps) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const reason = task.postApprovalBlockedReason?.trim();
	const sessionId = task.postApprovalSessionId?.trim() || null;

	const onMarkDone = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			await spaceStore.updateTask(task.id, {
				status: 'done',
				postApprovalSessionId: null,
				postApprovalStartedAt: null,
				postApprovalBlockedReason: null,
			});
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : 'Failed to mark done');
		} finally {
			setBusy(false);
		}
	}, [task.id]);

	const onRetry = useCallback(async () => {
		// Retry is surfaced as a placeholder for now — wiring a dedicated
		// `spaceTask.retryPostApproval` RPC is tracked separately. For the
		// moment, nudging the task back to `in_progress` lets the runtime tick
		// re-dispatch on the next reconciliation pass.
		setBusy(true);
		setError(null);
		try {
			await spaceStore.updateTask(task.id, {
				status: 'in_progress',
				postApprovalBlockedReason: null,
			});
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : 'Failed to retry');
		} finally {
			setBusy(false);
		}
	}, [task.id]);

	if (task.status !== 'approved') return null;
	if (!reason) return null;

	const actions: InlineStatusBannerAction[] = [
		{
			label: 'Retry',
			onClick: () => void onRetry(),
			variant: 'secondary',
			disabled: busy,
			testId: 'pending-post-approval-retry-btn',
		},
		{
			label: 'Mark done',
			onClick: () => void onMarkDone(),
			variant: 'primary',
			disabled: busy,
			testId: 'pending-post-approval-mark-done-btn',
		},
	];
	if (sessionId && onViewSession) {
		actions.push({
			label: 'View session',
			onClick: () => onViewSession(sessionId),
			variant: 'secondary',
			disabled: busy,
			testId: 'pending-post-approval-view-session-btn',
		});
	}

	return (
		<>
			<InlineStatusBanner
				tone="amber"
				icon={<span aria-hidden="true">⏳</span>}
				label={`Post-approval blocked: ${reason}`}
				actions={actions}
				testId="pending-post-approval-banner"
				dataAttrs={{ 'data-task-id': task.id }}
			/>
			{error ? (
				<p class="mx-4 -mt-1 mb-2 text-xs text-red-400" data-testid="pending-post-approval-error">
					{error}
				</p>
			) : null}
		</>
	);
}
