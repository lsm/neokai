/**
 * PendingGateBanner — thread-view CTA for workflow gates awaiting human approval.
 *
 * Shows whenever the task's workflow run has at least one gate in a pending
 * state (data.waiting === true OR data.approved === false), regardless of
 * task.status. Provides Approve / Reject / Review buttons wired to
 * spaceWorkflowRun.approveGate, and opens GateArtifactsView for full review.
 *
 * Distinct from TaskBlockedBanner (which only shows when the task itself is
 * in `blocked` status) — this banner surfaces gate approval even while the
 * task is still `in_progress`.
 */

import { useState, useEffect } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager';
import { GateArtifactsView } from './GateArtifactsView';

interface PendingGate {
	gateId: string;
	data: Record<string, unknown>;
}

interface GateDataRecord {
	runId: string;
	gateId: string;
	data: Record<string, unknown>;
	updatedAt: number;
}

interface PendingGateBannerProps {
	runId: string;
	spaceId: string;
}

function isPending(data: Record<string, unknown>): boolean {
	return data['waiting'] === true || data['approved'] === false;
}

export function PendingGateBanner({ runId, spaceId }: PendingGateBannerProps) {
	const [pending, setPending] = useState<PendingGate | null>(null);
	const [showReview, setShowReview] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setPending(null);
		setShowReview(false);
		setError(null);

		const hub = connectionManager.getHubIfConnected();
		if (!hub) return;

		hub
			.request<{ gateData: GateDataRecord[] }>('spaceWorkflowRun.listGateData', { runId })
			.then((result) => {
				if (cancelled) return;
				const pendingRecord = result.gateData.find((r) => isPending(r.data));
				if (pendingRecord) {
					setPending({ gateId: pendingRecord.gateId, data: pendingRecord.data });
				}
			})
			.catch(() => {
				// Best-effort — leave banner hidden on error
			});

		const unsubscribe =
			typeof hub.onEvent === 'function'
				? hub.onEvent<{
						runId: string;
						gateId: string;
						data: Record<string, unknown>;
					}>('space.gateData.updated', (event) => {
						if (cancelled || event.runId !== runId) return;
						if (isPending(event.data)) {
							setPending({ gateId: event.gateId, data: event.data });
						} else {
							setPending((prev) => (prev?.gateId === event.gateId ? null : prev));
						}
					})
				: undefined;

		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, [runId]);

	const handleDecision = async (approved: boolean) => {
		if (!pending) return;
		setBusy(true);
		setError(null);
		try {
			const hub = await connectionManager.getHub();
			await hub.request('spaceWorkflowRun.approveGate', {
				runId,
				gateId: pending.gateId,
				approved,
			});
			// Local clear — event will also clear, but be responsive.
			setPending(null);
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : 'Failed to submit decision');
		} finally {
			setBusy(false);
		}
	};

	if (!pending) return null;

	if (showReview) {
		return (
			<GateArtifactsView
				runId={runId}
				gateId={pending.gateId}
				spaceId={spaceId}
				gateData={pending.data}
				onClose={() => setShowReview(false)}
				onDecision={() => setShowReview(false)}
			/>
		);
	}

	const gateLabel = typeof pending.data['label'] === 'string' ? pending.data['label'] : null;

	return (
		<div
			class="mx-4 mt-2 mb-2 rounded-lg border border-purple-500/30 bg-purple-500/10 px-3 py-2"
			data-testid="pending-gate-banner"
		>
			<div class="flex items-start justify-between gap-2">
				<div class="flex-1 min-w-0">
					<p class="text-xs font-medium text-purple-300">
						🔒 Gate Awaiting Approval{gateLabel ? ` — ${gateLabel}` : ''}
					</p>
					<p class="mt-0.5 text-xs text-purple-400/70">
						The workflow is paused until a human approves the proposed changes.
					</p>
					{error && (
						<p class="mt-1 text-xs text-red-400" data-testid="pending-gate-error">
							{error}
						</p>
					)}
				</div>

				<div class="flex items-center gap-1.5 flex-shrink-0">
					<button
						type="button"
						onClick={() => void handleDecision(true)}
						disabled={busy}
						data-testid="pending-gate-approve-btn"
						class="px-2 py-1 text-xs font-medium rounded bg-green-900/40 text-green-300 border border-green-700/50 hover:bg-green-800/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
					>
						Approve
					</button>
					<button
						type="button"
						onClick={() => void handleDecision(false)}
						disabled={busy}
						data-testid="pending-gate-reject-btn"
						class="px-2 py-1 text-xs font-medium rounded bg-red-900/40 text-red-300 border border-red-700/50 hover:bg-red-800/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
					>
						Reject
					</button>
					<button
						type="button"
						onClick={() => setShowReview(true)}
						disabled={busy}
						data-testid="pending-gate-review-btn"
						class="px-2 py-1 text-xs font-medium rounded bg-purple-900/30 text-purple-300 border border-purple-700/30 hover:bg-purple-900/50 disabled:opacity-50 transition-colors"
					>
						Review
					</button>
				</div>
			</div>
		</div>
	);
}
