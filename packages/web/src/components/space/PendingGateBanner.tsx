/**
 * PendingGateBanner — thread-view CTA for workflow gates awaiting human approval.
 *
 * Shows whenever the task's workflow run has at least one external-approval
 * gate that evaluates to `waiting_human` (see `gate-status.ts` for the exact
 * rule — mirrors the canvas evaluator). Task status is independent — a gate
 * can be waiting while the task itself is still `in_progress`. Provides
 * Approve / Reject / Review buttons wired to `spaceWorkflowRun.approveGate`,
 * and opens `GateArtifactsView` as a full-pane overlay for deeper review.
 *
 * Distinct from `TaskBlockedBanner` (which only shows when the task itself is
 * in `blocked` status). Multi-gate workflows render a short stack — one row
 * per pending gate.
 */

import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import type { Gate } from '@neokai/shared';
import { connectionManager } from '../../lib/connection-manager';
import { spaceStore } from '../../lib/space-store';
import { GateArtifactsView } from './GateArtifactsView';
import { evaluateGateStatus, parseScriptResult } from './gate-status';

interface PendingGate {
	gateId: string;
	data: Record<string, unknown>;
	label?: string;
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
	/** Workflow ID for the run; used to resolve gate definitions. */
	workflowId: string | null;
}

export function PendingGateBanner({ runId, spaceId, workflowId }: PendingGateBannerProps) {
	const workflow = workflowId
		? (spaceStore.workflows.value.find((w) => w.id === workflowId) ?? null)
		: null;
	const gates: Gate[] = workflow?.gates ?? [];

	const [gateDataMap, setGateDataMap] = useState<Map<string, Record<string, unknown>>>(new Map());
	const [reviewGateId, setReviewGateId] = useState<string | null>(null);
	// Multiple gates can be pending at once, so busy/error state is keyed by
	// gateId — otherwise a second click would clobber the first gate's spinner
	// or error, and an error from gate A could render under gate B's row.
	const [busyGateIds, setBusyGateIds] = useState<Set<string>>(() => new Set());
	const [decisionErrors, setDecisionErrors] = useState<Map<string, string>>(() => new Map());
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [fetchAttempt, setFetchAttempt] = useState(0);
	const decisionCancelledRef = useRef(false);
	// Tracks the live runId so in-flight decision responses from a previous
	// run don't stamp busy/error state onto the new run after a runId swap.
	const currentRunIdRef = useRef(runId);

	useEffect(() => {
		let cancelled = false;
		let unsubscribe: (() => void) | undefined;
		setGateDataMap(new Map());
		setReviewGateId(null);
		setDecisionErrors(new Map());
		setFetchError(null);
		// If a decision RPC is in-flight when runId swaps (e.g. user navigates to
		// another task's run), the pending promise is abandoned by the cleanup
		// flag below — but busyGateIds from the prior run would otherwise leak
		// here and permanently disable a gate's buttons in the new run.
		setBusyGateIds(new Set());
		currentRunIdRef.current = runId;

		(async () => {
			try {
				const hub = await connectionManager.getHub();
				if (cancelled) return;

				// Subscribe BEFORE firing the initial fetch so updates that arrive
				// while the request is in flight aren't dropped. When the fetch
				// resolves we merge the snapshot into the map, giving event-
				// delivered data precedence (strictly newer than a fetch that
				// was serialized before the update was published).
				unsubscribe = hub.onEvent<{
					runId: string;
					gateId: string;
					data: Record<string, unknown>;
				}>('space.gateData.updated', (event) => {
					if (event.runId !== runId) return;
					setGateDataMap((prev) => {
						const next = new Map(prev);
						next.set(event.gateId, event.data);
						return next;
					});
				});

				const result = await hub.request<{ gateData: GateDataRecord[] }>(
					'spaceWorkflowRun.listGateData',
					{ runId }
				);
				if (cancelled) return;
				setGateDataMap((prev) => {
					// Seed from the fetch snapshot, then overlay any event-delivered
					// entries already in `prev` — those races the fetch and are newer.
					const merged = new Map<string, Record<string, unknown>>();
					for (const record of result.gateData) {
						merged.set(record.gateId, record.data);
					}
					for (const [gateId, data] of prev) {
						merged.set(gateId, data);
					}
					return merged;
				});
			} catch (err: unknown) {
				if (cancelled) return;
				setFetchError(err instanceof Error ? err.message : 'Failed to load gate status');
			}
		})();

		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, [runId, fetchAttempt]);

	useEffect(() => {
		decisionCancelledRef.current = false;
		return () => {
			decisionCancelledRef.current = true;
		};
	}, []);

	// Tracks the element that opened the review overlay so we can restore focus
	// to it when the overlay closes (WCAG 2.4.3). Captured at open time; cleared
	// after restore to avoid cross-open leakage. If the opener was removed from
	// the DOM while the overlay was open (e.g. approving a gate removes it from
	// `pendingGates`), we fall back to a wrapper element that is still mounted.
	const overlayOpenerRef = useRef<HTMLElement | null>(null);
	const bannerRef = useRef<HTMLDivElement | null>(null);

	// Close the review overlay on Escape (basic modal a11y). We don't implement a
	// full focus trap — GateArtifactsView's own close button is reachable via Tab.
	useEffect(() => {
		if (!reviewGateId) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setReviewGateId(null);
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [reviewGateId]);

	// On overlay close, return focus to the element that opened it. If the
	// opener was unmounted while the overlay was open (common when Approve/
	// Reject from GateArtifactsView transitions the gate out of `pendingGates`),
	// .focus() on the detached node is a no-op — fall back to the banner wrapper
	// so keyboard focus lands somewhere meaningful rather than collapsing to
	// <body>.
	useEffect(() => {
		if (reviewGateId) return;
		const opener = overlayOpenerRef.current;
		if (!opener) return; // no overlay was open — nothing to restore
		if (opener.isConnected && typeof opener.focus === 'function') {
			opener.focus();
		} else if (bannerRef.current && typeof bannerRef.current.focus === 'function') {
			bannerRef.current.focus();
		}
		overlayOpenerRef.current = null;
	}, [reviewGateId]);

	const openReview = useCallback((gateId: string, event: Event) => {
		const target = event.currentTarget;
		if (target instanceof HTMLElement) overlayOpenerRef.current = target;
		setReviewGateId(gateId);
	}, []);

	const pendingGates: PendingGate[] = [];
	for (const gate of gates) {
		// Only evaluate gates that have been activated (data written to gate_data table).
		// An external-approval gate with no data has never been triggered — it's merely
		// configured, so the banner must not show.
		if (!gateDataMap.has(gate.id)) continue;
		const data = gateDataMap.get(gate.id)!;
		const scriptResult = parseScriptResult(data);
		if (evaluateGateStatus(gate, data, scriptResult.failed) === 'waiting_human') {
			pendingGates.push({ gateId: gate.id, data, label: gate.label ?? gate.description });
		}
	}

	const handleDecision = useCallback(
		async (gateId: string, approved: boolean) => {
			setBusyGateIds((prev) => {
				const next = new Set(prev);
				next.add(gateId);
				return next;
			});
			setDecisionErrors((prev) => {
				if (!prev.has(gateId)) return prev;
				const next = new Map(prev);
				next.delete(gateId);
				return next;
			});
			const runIdAtCall = runId;
			try {
				const hub = await connectionManager.getHub();
				await hub.request('spaceWorkflowRun.approveGate', { runId, gateId, approved });
			} catch (err: unknown) {
				if (decisionCancelledRef.current) return;
				if (currentRunIdRef.current !== runIdAtCall) return; // stale runId
				const msg = err instanceof Error ? err.message : 'Failed to submit decision';
				setDecisionErrors((prev) => {
					const next = new Map(prev);
					next.set(gateId, msg);
					return next;
				});
			} finally {
				if (!decisionCancelledRef.current && currentRunIdRef.current === runIdAtCall) {
					setBusyGateIds((prev) => {
						if (!prev.has(gateId)) return prev;
						const next = new Set(prev);
						next.delete(gateId);
						return next;
					});
				}
			}
		},
		[runId]
	);

	// Render the artifacts review as a full-pane modal overlay so `h-full`
	// inside GateArtifactsView resolves against a definite height. Rendering
	// it inline in the banner slot collapses it (banner is auto-height).
	const reviewOverlay = reviewGateId ? (
		<div
			class="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-4"
			data-testid="pending-gate-review-overlay"
			role="dialog"
			aria-modal="true"
			aria-label="Review gate artifacts"
			onClick={(e) => {
				if (e.target === e.currentTarget) setReviewGateId(null);
			}}
		>
			<div class="w-full max-w-2xl max-h-[80vh] bg-dark-900 border border-dark-600 rounded-xl shadow-2xl overflow-hidden flex flex-col">
				<GateArtifactsView
					runId={runId}
					gateId={reviewGateId}
					spaceId={spaceId}
					gateData={gateDataMap.get(reviewGateId) ?? {}}
					onClose={() => setReviewGateId(null)}
					onDecision={() => setReviewGateId(null)}
					class="flex-1 min-h-0"
				/>
			</div>
		</div>
	) : null;

	if (pendingGates.length === 0 && !fetchError) return reviewOverlay;

	const fetchErrorBanner = fetchError ? (
		<div
			class="mx-4 mt-2 mb-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 flex items-center justify-between gap-2"
			data-testid="pending-gate-fetch-error"
		>
			<p class="text-xs text-red-300 flex-1 min-w-0">Failed to load gate status — {fetchError}</p>
			<button
				type="button"
				onClick={() => setFetchAttempt((n) => n + 1)}
				data-testid="pending-gate-fetch-retry"
				class="px-2 py-1 text-xs font-medium rounded bg-red-900/40 text-red-200 border border-red-700/50 hover:bg-red-800/50 transition-colors flex-shrink-0"
			>
				Retry
			</button>
		</div>
	) : null;

	return (
		<>
			{fetchErrorBanner}
			{pendingGates.length > 0 && (
				<div
					ref={bannerRef}
					tabIndex={-1}
					class="mx-4 mt-2 mb-2 rounded-lg border border-purple-500/30 bg-purple-500/10 px-3 py-2 space-y-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/70"
					data-testid="pending-gate-banner"
				>
					{pendingGates.map((gate) => {
						const busy = busyGateIds.has(gate.gateId);
						const error = decisionErrors.get(gate.gateId);
						return (
							<div key={gate.gateId} class="space-y-1">
								<div class="flex items-start justify-between gap-2">
									<div class="flex-1 min-w-0">
										<p class="text-xs font-medium text-purple-300">
											🔒 Gate Awaiting Approval{gate.label ? ` — ${gate.label}` : ''}
										</p>
										<p class="mt-0.5 text-xs text-purple-400/70">
											The workflow is paused until a human approves the proposed changes.
										</p>
									</div>

									<div class="flex items-center gap-1.5 flex-shrink-0">
										<button
											type="button"
											onClick={() => void handleDecision(gate.gateId, true)}
											disabled={busy}
											data-testid="pending-gate-approve-btn"
											class="px-2 py-1 text-xs font-medium rounded bg-green-900/40 text-green-300 border border-green-700/50 hover:bg-green-800/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
										>
											Approve
										</button>
										<button
											type="button"
											onClick={() => void handleDecision(gate.gateId, false)}
											disabled={busy}
											data-testid="pending-gate-reject-btn"
											class="px-2 py-1 text-xs font-medium rounded bg-red-900/40 text-red-300 border border-red-700/50 hover:bg-red-800/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
										>
											Reject
										</button>
										<button
											type="button"
											onClick={(e) => openReview(gate.gateId, e)}
											data-testid="pending-gate-review-btn"
											class="px-2 py-1 text-xs font-medium rounded bg-purple-900/30 text-purple-300 border border-purple-700/30 hover:bg-purple-900/50 transition-colors"
										>
											Review
										</button>
									</div>
								</div>
								{error && (
									<p class="text-xs text-red-400" data-testid="pending-gate-error">
										{error}
									</p>
								)}
							</div>
						);
					})}
				</div>
			)}
			{reviewOverlay}
		</>
	);
}
