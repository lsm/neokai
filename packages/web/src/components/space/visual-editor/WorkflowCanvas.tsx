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
import type { ViewportState } from './types';

export interface WorkflowNodeData {
	stepId: string;
	name: string;
	/** Canvas-space X position. */
	x: number;
	/** Canvas-space Y position. */
	y: number;
	width?: number;
	height?: number;
}

export interface WorkflowCanvasProps {
	nodes: WorkflowNodeData[];
	viewportState: ViewportState;
	onViewportChange: (state: ViewportState) => void;
	/** Called when the selected node changes. Null means nothing is selected. */
	onNodeSelect?: (stepId: string | null) => void;
	/** Called when Delete/Backspace is pressed with a node selected. */
	onDeleteNode?: (stepId: string) => void;
}

export function WorkflowCanvas({
	nodes,
	viewportState,
	onViewportChange,
	onNodeSelect,
	onDeleteNode,
}: WorkflowCanvasProps) {
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

	// Keep ref so keyboard handler always sees the latest value without re-registering
	const selectedNodeIdRef = useRef<string | null>(null);
	selectedNodeIdRef.current = selectedNodeId;

	const onNodeSelectRef = useRef(onNodeSelect);
	onNodeSelectRef.current = onNodeSelect;

	const onDeleteNodeRef = useRef(onDeleteNode);
	onDeleteNodeRef.current = onDeleteNode;

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
					key={node.stepId}
					stepId={node.stepId}
					name={node.name}
					x={node.x}
					y={node.y}
					width={node.width}
					height={node.height}
					isSelected={selectedNodeId === node.stepId}
					onSelect={handleNodeSelect}
				/>
			))}
		</VisualCanvas>
	);
}
