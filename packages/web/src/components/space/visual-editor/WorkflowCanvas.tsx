/**
 * WorkflowCanvas
 *
 * Wraps VisualCanvas with workflow-specific behaviour:
 *  - Manages selectedNodeId state (single-select)
 *  - Renders WorkflowNode components with correct isSelected prop
 *  - Handles Delete/Backspace keyboard shortcut to delete selected node
 *  - Emits onNodeSelect(stepId | null) so parent components can react
 */

import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { VisualCanvas } from './VisualCanvas';
import { WorkflowNode } from './WorkflowNode';
import type { WorkflowNodeProps } from './WorkflowNode';
import type { ViewportState, Point } from './types';

/**
 * Per-node data passed to WorkflowCanvas.
 * WorkflowCanvas injects: isSelected, onClick, scale, onPositionChange.
 */
export type WorkflowNodeData = Omit<
	WorkflowNodeProps,
	'isSelected' | 'onClick' | 'scale' | 'onPositionChange'
>;

export interface WorkflowCanvasProps {
	nodes: WorkflowNodeData[];
	viewportState: ViewportState;
	onViewportChange: (state: ViewportState) => void;
	/** Called when the selected node changes. Null means nothing is selected. */
	onNodeSelect?: (stepId: string | null) => void;
	/** Called when Delete/Backspace is pressed with a node selected. */
	onDeleteNode?: (stepId: string) => void;
	/** Called when a node is dragged to a new position. */
	onNodePositionChange?: (stepId: string, position: Point) => void;
}

export function WorkflowCanvas({
	nodes,
	viewportState,
	onViewportChange,
	onNodeSelect,
	onDeleteNode,
	onNodePositionChange,
}: WorkflowCanvasProps) {
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

	// Keep refs so keyboard handler always sees the latest value without re-registering
	const selectedNodeIdRef = useRef<string | null>(null);
	selectedNodeIdRef.current = selectedNodeId;

	const onNodeSelectRef = useRef(onNodeSelect);
	onNodeSelectRef.current = onNodeSelect;

	const onDeleteNodeRef = useRef(onDeleteNode);
	onDeleteNodeRef.current = onDeleteNode;

	// Clear selection if the selected node is removed externally (e.g. parent deletes it
	// from the nodes array). Without this, a node re-added with the same stepId would
	// appear pre-selected, which is unexpected.
	useEffect(() => {
		if (selectedNodeId !== null && !nodes.some((n) => n.step.localId === selectedNodeId)) {
			setSelectedNodeId(null);
			onNodeSelectRef.current?.(null);
		}
	}, [nodes, selectedNodeId]);

	const handleNodeSelect = useCallback(
		(stepId: string) => {
			setSelectedNodeId(stepId);
			onNodeSelect?.(stepId);
		},
		[onNodeSelect]
	);

	const handleBackgroundClick = useCallback(() => {
		setSelectedNodeId(null);
		onNodeSelect?.(null);
	}, [onNodeSelect]);

	// ---- Keyboard: Delete / Backspace removes the selected node ----
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key !== 'Delete' && e.key !== 'Backspace') return;
			const tag = (e.target as HTMLElement)?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA') return;

			const current = selectedNodeIdRef.current;
			if (!current || !onDeleteNodeRef.current) return;

			e.preventDefault();
			onDeleteNodeRef.current(current);
			setSelectedNodeId(null);
			onNodeSelectRef.current?.(null);
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, []);

	return (
		<VisualCanvas
			viewportState={viewportState}
			onViewportChange={onViewportChange}
			onBackgroundClick={handleBackgroundClick}
		>
			{nodes.map((node) => (
				<WorkflowNode
					key={node.step.localId}
					{...node}
					scale={viewportState.scale}
					onPositionChange={onNodePositionChange ?? (() => {})}
					isSelected={selectedNodeId === node.step.localId}
					onClick={handleNodeSelect}
				/>
			))}
		</VisualCanvas>
	);
}
