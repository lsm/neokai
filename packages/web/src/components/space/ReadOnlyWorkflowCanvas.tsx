/**
 * ReadOnlyWorkflowCanvas
 *
 * Read-only runtime view of a workflow using the visual-editor's WorkflowCanvas.
 * Shows the same visual style as the full editor but with no editing affordances.
 *
 * Used in SpaceTaskPane to replace the old custom SVG WorkflowCanvas.
 *
 * When a gate icon in `waiting_human` state is clicked, a popup appears with
 * "View Artifacts", "Approve", and "Reject" buttons. "View Artifacts" opens a
 * full overlay containing GateArtifactsView.
 */

import { useRef, useEffect, useState, useCallback } from 'preact/hooks';
import { WorkflowCanvas } from './visual-editor/WorkflowCanvas';
import { CanvasToolbar } from './visual-editor/CanvasToolbar';
import { useRuntimeCanvasData } from './useRuntimeCanvasData';
import { ChannelInfoPanel } from './ChannelInfoPanel';
import { GateArtifactsView } from './GateArtifactsView';
import { connectionManager } from '../../lib/connection-manager';
import { cn } from '../../lib/utils';

interface ReadOnlyWorkflowCanvasProps {
	workflowId: string;
	runId?: string | null;
	spaceId?: string;
	onNodeClick?: (nodeId: string, nodeName: string, agentNames: string[]) => void;
	class?: string;
}

interface GatePopupState {
	gateId: string;
	x: number;
	y: number;
}

export function ReadOnlyWorkflowCanvas({
	workflowId,
	runId,
	spaceId,
	onNodeClick,
	class: className,
}: ReadOnlyWorkflowCanvasProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });
	const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);

	// Gate popup / overlay state
	const [gatePopup, setGatePopup] = useState<GatePopupState | null>(null);
	const [artifactsOverlay, setArtifactsOverlay] = useState<{ gateId: string } | null>(null);
	const [approving, setApproving] = useState(false);
	const [channelDecisionError, setChannelDecisionError] = useState<string | null>(null);
	const [popupDecisionError, setPopupDecisionError] = useState<string | null>(null);

	const {
		nodeData,
		channelEdges,
		canvasNodePositions,
		viewportState,
		setViewportState,
		gateDataLoading,
		gateDataMap,
		gateDataError,
		retryGateData,
	} = useRuntimeCanvasData(workflowId, runId ?? null);

	// Track container dimensions for the toolbar's fit-to-view
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;

		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (entry) {
				setContainerSize({
					width: entry.contentRect.width,
					height: entry.contentRect.height,
				});
			}
		});

		observer.observe(el);
		setContainerSize({ width: el.clientWidth, height: el.clientHeight });

		return () => observer.disconnect();
	}, []);

	const handleNodeSelect = useCallback(
		(stepId: string | null) => {
			// Clicking a node clears channel selection and gate popup
			setSelectedChannelId(null);
			setGatePopup(null);
			if (!stepId || !onNodeClick) return;
			// stepId is localId — find the persisted node ID, name, and agent names
			const nodeEntry = nodeData.find((n) => n.step.localId === stepId);
			const persistedId = nodeEntry?.step.id ?? stepId;
			const nodeName = nodeEntry?.step.name ?? '';
			const agentNames = nodeEntry?.step.agents?.map((a) => a.name) ?? [];
			onNodeClick(persistedId, nodeName, agentNames);
		},
		[onNodeClick, nodeData]
	);

	const handleChannelSelect = useCallback((channelId: string | null) => {
		setSelectedChannelId(channelId);
		setGatePopup(null);
		setChannelDecisionError(null);
	}, []);

	// Gate icon click — open action popup
	const handleGateClick = useCallback((gateId: string, event: MouseEvent) => {
		const container = containerRef.current;
		if (!container) return;
		const rect = container.getBoundingClientRect();
		setGatePopup({
			gateId,
			x: event.clientX - rect.left,
			y: event.clientY - rect.top,
		});
		setSelectedChannelId(null);
		setPopupDecisionError(null);
	}, []);

	const approveGateRequest = useCallback(
		async (gateId: string, approved: boolean): Promise<{ ok: boolean; error?: string }> => {
			if (!runId) return { ok: false, error: 'Missing run ID' };
			setApproving(true);
			try {
				const hub = await connectionManager.getHub();
				await hub.request('spaceWorkflowRun.approveGate', {
					runId,
					gateId,
					approved,
				});
				return { ok: true };
			} catch (err) {
				return {
					ok: false,
					error: err instanceof Error ? err.message : 'Failed to submit decision',
				};
			} finally {
				setApproving(false);
			}
		},
		[runId]
	);

	// Direct approve/reject from popup
	const handlePopupDecision = useCallback(
		async (approved: boolean) => {
			if (!gatePopup) return;
			setPopupDecisionError(null);
			const result = await approveGateRequest(gatePopup.gateId, approved);
			if (result.ok) {
				setGatePopup(null);
				setPopupDecisionError(null);
			} else {
				setPopupDecisionError(result.error ?? 'Failed to submit decision');
			}
		},
		[gatePopup, approveGateRequest]
	);

	// Approve/reject from inline channel info panel
	const handleChannelGateDecision = useCallback(
		async (gateId: string, approved: boolean) => {
			setChannelDecisionError(null);
			const result = await approveGateRequest(gateId, approved);
			if (result.ok) {
				setSelectedChannelId(null);
			} else {
				setChannelDecisionError(result.error ?? 'Failed to submit decision');
			}
		},
		[approveGateRequest]
	);

	// Open artifacts overlay directly from channel info panel
	const handleChannelViewArtifacts = useCallback((gateId: string) => {
		setArtifactsOverlay({ gateId });
	}, []);

	// Open artifacts overlay from popup
	const handleOpenArtifacts = useCallback(() => {
		if (!gatePopup) return;
		setArtifactsOverlay({ gateId: gatePopup.gateId });
		setGatePopup(null);
	}, [gatePopup]);

	// Close artifacts overlay after decision
	const handleArtifactsDecision = useCallback(() => {
		setArtifactsOverlay(null);
	}, []);

	const selectedChannel = selectedChannelId
		? (channelEdges.find((c) => c.id === selectedChannelId) ?? null)
		: null;

	// Show a banner when a human-approval gate has been rejected (approved === false).
	const isWorkflowRejected = [...gateDataMap.values()].some((data) => data['approved'] === false);

	// Resolve node names for the info panel
	const getNodeName = (stepLocalId: string): string => {
		const node = nodeData.find((n) => n.step.localId === stepLocalId);
		return node?.step.name ?? stepLocalId;
	};

	return (
		<div
			class={cn('relative flex flex-col h-full', className)}
			data-testid="workflow-canvas"
			data-mode="runtime"
		>
			{gateDataLoading && (
				<div class="absolute top-2 right-2 z-10 text-xs text-gray-500 px-2 py-0.5 bg-dark-800 rounded">
					Loading…
				</div>
			)}
			{gateDataError && !gateDataLoading && (
				<div
					class="absolute top-2 right-2 z-10 flex items-center gap-2 text-xs px-2 py-0.5 bg-red-900/50 border border-red-700/50 text-red-200 rounded"
					data-testid="canvas-gate-data-error"
					title={gateDataError}
				>
					<span>Gate status unavailable</span>
					<button
						type="button"
						onClick={retryGateData}
						data-testid="canvas-gate-data-retry"
						class="underline hover:text-red-100"
					>
						Retry
					</button>
				</div>
			)}
			{isWorkflowRejected && (
				<div class="flex-shrink-0 flex items-center justify-center px-4 py-2 bg-red-900/80 border-b border-red-700/60 text-sm text-red-200">
					Workflow paused — awaiting approval
				</div>
			)}
			<div ref={containerRef} class="flex-1 min-h-0 relative">
				<WorkflowCanvas
					nodes={nodeData}
					viewportState={viewportState}
					onViewportChange={setViewportState}
					channels={channelEdges}
					nodePositions={canvasNodePositions}
					onNodeSelect={handleNodeSelect}
					onChannelSelect={handleChannelSelect}
					onGateClick={handleGateClick}
					selectedChannelId={selectedChannelId}
					readOnly
				/>
				<CanvasToolbar
					viewport={viewportState}
					nodes={canvasNodePositions}
					viewportWidth={containerSize.width}
					viewportHeight={containerSize.height}
					onViewportChange={setViewportState}
				/>
				{selectedChannel && (
					<ChannelInfoPanel
						channel={selectedChannel}
						fromNodeName={getNodeName(selectedChannel.fromStepId)}
						toNodeName={getNodeName(selectedChannel.toStepId)}
						onClose={() => {
							setSelectedChannelId(null);
							setChannelDecisionError(null);
						}}
						onGateDecision={handleChannelGateDecision}
						onViewArtifacts={handleChannelViewArtifacts}
						decisionPending={approving}
						decisionError={channelDecisionError}
					/>
				)}

				{/* Gate action popup */}
				{gatePopup && (
					<div
						class="absolute z-30"
						style={{
							left: `${gatePopup.x}px`,
							top: `${gatePopup.y + 12}px`,
						}}
					>
						<div class="bg-dark-800 border border-dark-600 rounded-lg shadow-xl p-2 space-y-2 min-w-[160px]">
							<button
								data-testid="view-artifacts-btn"
								onClick={handleOpenArtifacts}
								class="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-dark-700 rounded transition-colors"
							>
								View Artifacts
							</button>
							<div class="flex gap-2">
								<button
									onClick={() => void handlePopupDecision(true)}
									disabled={approving}
									class="flex-1 px-2 py-1.5 text-xs font-medium rounded bg-green-900/40 text-green-300 border border-green-700/50 hover:bg-green-800/50 disabled:opacity-50 transition-colors"
								>
									Approve
								</button>
								<button
									data-testid="popup-reject-btn"
									onClick={() => void handlePopupDecision(false)}
									disabled={approving}
									class="flex-1 px-2 py-1.5 text-xs font-medium rounded bg-red-900/40 text-red-300 border border-red-700/50 hover:bg-red-800/50 disabled:opacity-50 transition-colors"
								>
									Reject
								</button>
							</div>
							{popupDecisionError && (
								<p class="text-xs text-red-400 break-words" data-testid="popup-decision-error">
									{popupDecisionError}
								</p>
							)}
						</div>
					</div>
				)}
			</div>

			{/* Artifacts panel overlay */}
			{artifactsOverlay && runId && (
				<div
					data-testid="artifacts-panel-overlay"
					class="absolute inset-0 z-40 bg-black/50 flex items-center justify-center"
					onClick={(e) => {
						if (e.target === e.currentTarget) setArtifactsOverlay(null);
					}}
				>
					<div class="w-full max-w-2xl max-h-[80vh] bg-dark-900 border border-dark-600 rounded-xl shadow-2xl overflow-hidden flex flex-col">
						<GateArtifactsView
							runId={runId}
							gateId={artifactsOverlay.gateId}
							spaceId={spaceId ?? ''}
							gateData={gateDataMap.get(artifactsOverlay.gateId)}
							onClose={() => setArtifactsOverlay(null)}
							onDecision={handleArtifactsDecision}
							class="flex-1 min-h-0"
						/>
					</div>
				</div>
			)}
		</div>
	);
}
