/**
 * ReadOnlyWorkflowCanvas
 *
 * Read-only runtime view of a workflow using the visual-editor's WorkflowCanvas.
 * Shows the same visual style as the full editor but with no editing affordances.
 *
 * Used in SpaceTaskPane to replace the old custom SVG WorkflowCanvas.
 */

import { useRef, useEffect, useState } from 'preact/hooks';
import type { SpaceTask } from '@neokai/shared';
import { spaceStore } from '../../lib/space-store';
import { WorkflowCanvas } from './visual-editor/WorkflowCanvas';
import { CanvasToolbar } from './visual-editor/CanvasToolbar';
import { useRuntimeCanvasData } from './useRuntimeCanvasData';
import { cn } from '../../lib/utils';

interface ReadOnlyWorkflowCanvasProps {
	workflowId: string;
	runId?: string | null;
	spaceId?: string | null;
	onNodeClick?: (nodeId: string, nodeTasks: SpaceTask[]) => void;
	class?: string;
}

export function ReadOnlyWorkflowCanvas({
	workflowId,
	runId,
	onNodeClick,
	class: className,
}: ReadOnlyWorkflowCanvasProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });

	const {
		nodeData,
		channelEdges,
		canvasNodePositions,
		viewportState,
		setViewportState,
		gateDataLoading,
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

	const handleNodeSelect = (stepId: string | null) => {
		if (!stepId || !onNodeClick) return;
		// stepId is localId — find the persisted node ID if available
		const nodeEntry = nodeData.find((n) => n.step.localId === stepId);
		const persistedId = nodeEntry?.step.id ?? stepId;
		// SpaceTask doesn't have workflowNodeId — pass all tasks for this run
		const tasks = spaceStore.tasks.value.filter((t) => t.workflowRunId === runId);
		onNodeClick(persistedId, tasks);
	};

	return (
		<div class={cn('relative flex flex-col h-full', className)}>
			{gateDataLoading && (
				<div class="absolute top-2 right-2 z-10 text-xs text-gray-500 px-2 py-0.5 bg-dark-800 rounded">
					Loading…
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
					readOnly
				/>
				<CanvasToolbar
					viewport={viewportState}
					nodes={canvasNodePositions}
					viewportWidth={containerSize.width}
					viewportHeight={containerSize.height}
					onViewportChange={setViewportState}
				/>
			</div>
		</div>
	);
}
