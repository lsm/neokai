/**
 * PendingGateBanner — thread-view CTA for workflow gates awaiting human approval.
 *
 * Shows whenever the task's workflow run has at least one external-approval
 * gate that evaluates to `waiting_human` (see `gate-status.ts` for the exact
 * rule — mirrors the canvas evaluator). Task status is independent — a gate
 * can be waiting while the task itself is still `in_progress`. Provides
 * Approve / Reject / Review buttons wired to `spaceWorkflowRun.approveGate`,
 * and opens `GateArtifactsView` for full review.
 *
 * Distinct from `TaskBlockedBanner` (which only shows when the task itself is
 * in `blocked` status). Multi-gate workflows render a short stack — one row
 * per pending gate.
 */

import { useState, useEffect, useRef } from 'preact/hooks';
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
	const [busyGateId, setBusyGateId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const decisionCancelledRef = useRef(false);

	useEffect(() => {
		let cancelled = false;
		let unsubscribe: (() => void) | undefined;
		setGateDataMap(new Map());
		setReviewGateId(null);
		setError(null);

		(async () => {
			try {
				const hub = await connectionManager.getHub();
				if (cancelled) return;

				const result = await hub.request<{ gateData: GateDataRecord[] }>(
					'spaceWorkflowRun.listGateData',
					{ runId }
				);
				if (cancelled) return;
				setGateDataMap(new Map(result.gateData.map((r) => [r.gateId, r.data])));

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
			} catch {
				// Best-effort — leave banner hidden on error
			}
		})();

		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, [runId]);

	useEffect(() => {
		decisionCancelledRef.current = false;
		return () => {
			decisionCancelledRef.current = true;
		};
	}, []);

	const pendingGates: PendingGate[] = [];
	for (const gate of gates) {
		const data = gateDataMap.get(gate.id) ?? {};
		const scriptResult = parseScriptResult(data);
		if (evaluateGateStatus(gate, data, scriptResult.failed) === 'waiting_human') {
			pendingGates.push({ gateId: gate.id, data, label: gate.label ?? gate.description });
		}
	}

	if (reviewGateId) {
		const gateData = gateDataMap.get(reviewGateId) ?? {};
		return (
			<GateArtifactsView
				runId={runId}
				gateId={reviewGateId}
				spaceId={spaceId}
				gateData={gateData}
				onClose={() => setReviewGateId(null)}
				onDecision={() => setReviewGateId(null)}
			/>
		);
	}

	if (pendingGates.length === 0) return null;

	const handleDecision = async (gateId: string, approved: boolean) => {
		setBusyGateId(gateId);
		setError(null);
		try {
			const hub = await connectionManager.getHub();
			await hub.request('spaceWorkflowRun.approveGate', { runId, gateId, approved });
		} catch (err: unknown) {
			if (decisionCancelledRef.current) return;
			setError(err instanceof Error ? err.message : 'Failed to submit decision');
		} finally {
			if (!decisionCancelledRef.current) setBusyGateId(null);
		}
	};

	return (
		<div
			class="mx-4 mt-2 mb-2 rounded-lg border border-purple-500/30 bg-purple-500/10 px-3 py-2 space-y-2"
			data-testid="pending-gate-banner"
		>
			{pendingGates.map((gate) => {
				const busy = busyGateId === gate.gateId;
				return (
					<div key={gate.gateId} class="flex items-start justify-between gap-2">
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
								onClick={() => setReviewGateId(gate.gateId)}
								disabled={busy}
								data-testid="pending-gate-review-btn"
								class="px-2 py-1 text-xs font-medium rounded bg-purple-900/30 text-purple-300 border border-purple-700/30 hover:bg-purple-900/50 disabled:opacity-50 transition-colors"
							>
								Review
							</button>
						</div>
					</div>
				);
			})}

			{error && (
				<p class="text-xs text-red-400" data-testid="pending-gate-error">
					{error}
				</p>
			)}
		</div>
	);
}
