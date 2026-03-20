/**
 * WorkflowCanvas
 *
 * Wraps VisualCanvas with workflow-specific behaviour:
 *  - Manages selectedNodeId state (single-select)
 *  - Renders WorkflowNode components with correct isSelected prop
 *  - Handles Delete/Backspace keyboard shortcut to delete selected node
 *  - Emits onNodeSelect(stepId | null) so parent components can react
 *  - Manages connection drag via useConnectionDrag hook
 *    - Shows ghost edge (dashed SVG path) during drag
 *    - Highlights valid input ports as drop targets
 *    - Creates transitions on valid drop
 */

import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import type { ComponentChildren, JSX, RefObject } from 'preact';
import { VisualCanvas } from './VisualCanvas';
import { WorkflowNode } from './WorkflowNode';
import type { WorkflowNodeProps, PortType } from './WorkflowNode';
import type { ViewportState, Point } from './types';
import { useConnectionDrag } from './useConnectionDrag';
import type { TransitionLike } from './useConnectionDrag';

/**
 * Per-node data passed to WorkflowCanvas.
 * WorkflowCanvas injects: isSelected, isDropTarget, onClick, scale, onPositionChange,
 * onPortMouseDown, onPortMouseEnter, onPortMouseLeave.
 */
export type WorkflowNodeData = Omit<
	WorkflowNodeProps,
	| 'isSelected'
	| 'isDropTarget'
	| 'onClick'
	| 'scale'
	| 'onPositionChange'
	| 'onPortMouseDown'
	| 'onPortMouseEnter'
	| 'onPortMouseLeave'
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
	/** Existing transitions — used for duplicate detection during connection drag. */
	transitions?: TransitionLike[];
	/** Called when a new connection is created by dragging from an output to an input port. */
	onCreateTransition?: (fromStepId: string, toStepId: string) => void;
}

// ---- Ghost edge rendering ----

/** Render a dashed bezier ghost edge from `from` to `to` in canvas-space SVG coordinates. */
function GhostEdge({ from, to }: { from: Point; to: Point }): JSX.Element | null {
	// Directional bezier: for forward (downward) drags use a vertical S-curve.
	// For backward (upward) drags, route horizontally to avoid the path looping.
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	let d: string;
	if (dy >= -40) {
		// Forward or slightly backward: standard vertical bezier
		const cpOffset = Math.max(50, dy * 0.5);
		d = `M ${from.x} ${from.y} C ${from.x} ${from.y + cpOffset}, ${to.x} ${to.y - cpOffset}, ${to.x} ${to.y}`;
	} else {
		// Backward drag: route around horizontally to avoid S-curve loops
		const sideOffset = Math.max(60, Math.abs(dx) * 0.4 + 40);
		const midY = (from.y + to.y) / 2;
		d = `M ${from.x} ${from.y} C ${from.x} ${from.y + 40}, ${from.x + sideOffset} ${from.y + 40}, ${from.x + sideOffset} ${midY} S ${from.x + sideOffset} ${to.y - 40}, ${to.x} ${to.y}`;
	}

	return (
		<>
			{/* Shadow for contrast */}
			<path
				d={d}
				fill="none"
				stroke="rgba(0,0,0,0.3)"
				strokeWidth={5}
				strokeDasharray="8 4"
				strokeLinecap="round"
			/>
			{/* Visible ghost stroke */}
			<path
				data-testid="ghost-edge"
				d={d}
				fill="none"
				stroke="#60a5fa"
				strokeWidth={2.5}
				strokeDasharray="8 4"
				strokeLinecap="round"
				opacity={0.9}
			/>
		</>
	);
}

// ============================================================================
// WorkflowCanvas
// ============================================================================

export function WorkflowCanvas({
	nodes,
	viewportState,
	onViewportChange,
	onNodeSelect,
	onDeleteNode,
	onNodePositionChange,
	transitions = [],
	onCreateTransition,
}: WorkflowCanvasProps) {
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

	// Keep refs so keyboard handler always sees the latest value without re-registering
	const selectedNodeIdRef = useRef<string | null>(null);
	selectedNodeIdRef.current = selectedNodeId;

	const onNodeSelectRef = useRef(onNodeSelect);
	onNodeSelectRef.current = onNodeSelect;

	const onDeleteNodeRef = useRef(onDeleteNode);
	onDeleteNodeRef.current = onDeleteNode;

	// Ref to the VisualCanvas container (for coordinate conversion in connection drag)
	const containerRef = useRef<HTMLDivElement>(null);

	// ---- Connection drag ----
	const { dragState, startDrag, setHoverTarget } = useConnectionDrag({
		viewportState,
		containerRef: containerRef as RefObject<HTMLElement>,
		transitions,
		onCreateTransition: onCreateTransition ?? (() => {}),
	});

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

	// ---- Port event handlers ----
	const handlePortMouseDown = useCallback(
		(stepId: string, portType: PortType, e: MouseEvent, portEl: Element) => {
			if (portType === 'output') {
				startDrag(stepId, portEl, e);
			}
		},
		[startDrag]
	);

	const handlePortMouseEnter = useCallback(
		(stepId: string, portType: PortType) => {
			// setHoverTarget guards on dragRef.current.active internally —
			// no need to read dragState here, which would cause re-renders on every toggle
			if (portType === 'input') {
				setHoverTarget(stepId);
			}
		},
		[setHoverTarget]
	);

	const handlePortMouseLeave = useCallback(
		(_stepId: string, portType: PortType) => {
			if (portType === 'input') {
				setHoverTarget(null);
			}
		},
		[setHoverTarget]
	);

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

	// ---- Ghost edge (rendered in SVG edge layer) ----
	const edgeLayer = useCallback(
		(_vp: ViewportState): ComponentChildren => {
			if (!dragState.active || !dragState.fromPos || !dragState.currentPos) return null;
			return <GhostEdge from={dragState.fromPos} to={dragState.currentPos} />;
		},
		[dragState]
	);

	return (
		<div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
			<VisualCanvas
				viewportState={viewportState}
				onViewportChange={onViewportChange}
				onBackgroundClick={handleBackgroundClick}
				edgeLayer={edgeLayer}
			>
				{nodes.map((node) => {
					const stepId = node.step.localId;
					// A node is a valid drop target if: drag is active, not the source, not start node
					const isDropTarget =
						dragState.active && dragState.fromStepId !== stepId && !node.isStartNode;

					return (
						<WorkflowNode
							key={stepId}
							{...node}
							scale={viewportState.scale}
							onPositionChange={onNodePositionChange ?? (() => {})}
							isSelected={selectedNodeId === stepId}
							isDropTarget={isDropTarget}
							onClick={handleNodeSelect}
							onPortMouseDown={handlePortMouseDown}
							onPortMouseEnter={handlePortMouseEnter}
							onPortMouseLeave={handlePortMouseLeave}
						/>
					);
				})}
			</VisualCanvas>
		</div>
	);
}
