/**
 * WorkflowCanvas
 *
 * Wraps VisualCanvas with workflow-specific behaviour:
 *  - Manages selectedNodeId state (single-select)
 *  - Manages selectedEdgeId state (mutually exclusive with selectedNodeId)
 *  - Renders WorkflowNode components with correct isSelected prop
 *  - Renders EdgeRenderer via the edgeLayer render prop of VisualCanvas
 *  - Handles Delete/Backspace keyboard shortcut to delete selected node or edge
 *  - Emits onNodeSelect(stepId | null) and onEdgeSelect(transitionId | null)
 *  - Manages connection drag via useConnectionDrag hook
 *    - Shows ghost edge (dashed SVG path) during drag
 *    - Highlights valid input ports as drop targets
 *    - Creates transitions on valid drop
 *
 * Node and edge selection are mutually exclusive: selecting a node clears the
 * selected edge and vice versa. This prevents the two independent Delete/Backspace
 * listeners (WorkflowCanvas for nodes, EdgeRenderer for edges) from both firing on
 * the same keystroke.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import type { ComponentChildren, JSX, RefObject } from 'preact';
import type { WorkflowTransition } from '@neokai/shared';
import { VisualCanvas } from './VisualCanvas';
import { WorkflowNode } from './WorkflowNode';
import type { WorkflowNodeProps, PortType } from './WorkflowNode';
import { EdgeRenderer } from './EdgeRenderer';
import type { ViewportState, Point, NodePosition } from './types';
import { useConnectionDrag } from './useConnectionDrag';

/** Default node dimensions used when deriving NodePosition from WorkflowNodeData. */
export const DEFAULT_NODE_WIDTH = 160;
export const DEFAULT_NODE_HEIGHT = 80;

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
	/** Edges to render between nodes. Also used for duplicate detection during connection drag. */
	transitions?: WorkflowTransition[];
	/**
	 * Task Agent channel edges to render (from task-agent to step).
	 * Rendered with a distinct dashed gray style.
	 */
	channelEdges?: ChannelEdge[];
	/**
	 * Explicit node positions including width/height for edge port computation.
	 * When omitted, positions are derived from nodes with DEFAULT_NODE_WIDTH/HEIGHT.
	 */
	nodePositions?: NodePosition;
	/** Called when the selected node changes. Null means nothing is selected. */
	onNodeSelect?: (stepId: string | null) => void;
	/** Called when Delete/Backspace is pressed with a node selected. */
	onDeleteNode?: (stepId: string) => void;
	/** Called when a node is dragged to a new position. */
	onNodePositionChange?: (stepId: string, position: Point) => void;
	/** Called when a new connection is created by dragging from an output to an input port. */
	onCreateTransition?: (fromStepId: string, toStepId: string) => void;
	/** Called when the selected edge changes. Null means nothing is selected. */
	onEdgeSelect?: (transitionId: string | null) => void;
	/** Called when Delete/Backspace is pressed with an edge selected. */
	onDeleteEdge?: (transitionId: string) => void;
}

/**
 * A channel edge represents a messaging channel between Task Agent and a step.
 * The 'task-agent' is a virtual hub, so we store the target step ID.
 */
export interface ChannelEdge {
	/** Fixed identifier for the Task Agent source */
	fromStepId: 'task-agent';
	/** The target step localId */
	toStepId: string;
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

// ---- ChannelEdgeRenderer ----

/** Color for Task Agent channel edges */
const CHANNEL_EDGE_COLOR = '#9ca3af'; // gray-400

/**
 * Render Task Agent channel edges as dashed bezier paths from a fixed Task Agent
 * hub position (left side of canvas) to each target node.
 *
 * Task Agent is rendered as a vertical "rail" on the left side of the canvas,
 * and channel edges emanate from this rail to each connected node.
 */
function ChannelEdgeRenderer({
	channelEdges,
	nodePositions,
}: {
	channelEdges: ChannelEdge[];
	nodePositions: NodePosition;
}) {
	if (channelEdges.length === 0) return null;

	// Task Agent hub position: fixed on the left side
	const TASK_AGENT_X = 60;

	return (
		<>
			{channelEdges.map((edge) => {
				const toPos = nodePositions[edge.toStepId];
				if (!toPos) return null;

				// Source: Task Agent hub (left side, vertical position based on target)
				const sx = TASK_AGENT_X;
				const sy = toPos.y + toPos.height / 2;

				// Target: top-center of the target node
				const tx = toPos.x + toPos.width / 2;
				const ty = toPos.y;

				// Bezier control points
				const dx = Math.abs(tx - sx);
				const cpOffset = Math.max(40, dx * 0.5);
				const cp1x = sx + cpOffset;
				const cp1y = sy;
				const cp2x = tx - cpOffset;
				const cp2y = ty;

				const d = `M ${sx} ${sy} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${tx} ${ty}`;

				return (
					<g key={`channel-${edge.toStepId}`} data-channel-edge="true">
						{/* Channel edges are informational — no click interaction yet */}
						<path d={d} stroke="transparent" strokeWidth={12} fill="none" />
						{/* Visible dashed edge */}
						<path
							d={d}
							stroke={CHANNEL_EDGE_COLOR}
							strokeWidth={1.5}
							strokeDasharray="6 4"
							strokeOpacity={0.7}
							fill="none"
							style={{ pointerEvents: 'none' }}
						/>
						{/* Small circle at source (Task Agent end) */}
						<circle cx={sx} cy={sy} r={4} fill={CHANNEL_EDGE_COLOR} opacity={0.7} />
					</g>
				);
			})}
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
	transitions = [],
	channelEdges = [],
	nodePositions,
	onNodeSelect,
	onDeleteNode,
	onNodePositionChange,
	onCreateTransition,
	onEdgeSelect,
	onDeleteEdge,
}: WorkflowCanvasProps) {
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
	const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

	// Keep refs so keyboard handler always sees the latest value without re-registering
	const selectedNodeIdRef = useRef<string | null>(null);
	selectedNodeIdRef.current = selectedNodeId;

	const selectedEdgeIdRef = useRef<string | null>(null);
	selectedEdgeIdRef.current = selectedEdgeId;

	const onNodeSelectRef = useRef(onNodeSelect);
	onNodeSelectRef.current = onNodeSelect;

	const onEdgeSelectRef = useRef(onEdgeSelect);
	onEdgeSelectRef.current = onEdgeSelect;

	const onDeleteNodeRef = useRef(onDeleteNode);
	onDeleteNodeRef.current = onDeleteNode;

	const onDeleteEdgeRef = useRef(onDeleteEdge);
	onDeleteEdgeRef.current = onDeleteEdge;

	// Ref to the VisualCanvas container (for coordinate conversion in connection drag)
	const containerRef = useRef<HTMLDivElement>(null);

	// ---- Connection drag ----
	const { dragState, startDrag, setHoverTarget } = useConnectionDrag({
		viewportState,
		containerRef: containerRef as RefObject<HTMLElement>,
		transitions,
		onCreateTransition: onCreateTransition ?? (() => {}),
	});

	// Derive NodePosition map from nodes when not explicitly provided.
	// Edges update positions automatically because nodes update when dragged.
	const effectiveNodePositions = useMemo((): NodePosition => {
		if (nodePositions) return nodePositions;
		const result: NodePosition = {};
		for (const node of nodes) {
			result[node.step.localId] = {
				x: node.position.x,
				y: node.position.y,
				width: DEFAULT_NODE_WIDTH,
				height: DEFAULT_NODE_HEIGHT,
			};
		}
		return result;
	}, [nodes, nodePositions]);

	// Clear selection if the selected node is removed externally (e.g. parent deletes it
	// from the nodes array). Without this, a node re-added with the same stepId would
	// appear pre-selected, which is unexpected.
	useEffect(() => {
		if (selectedNodeId !== null && !nodes.some((n) => n.step.localId === selectedNodeId)) {
			setSelectedNodeId(null);
			onNodeSelectRef.current?.(null);
		}
	}, [nodes, selectedNodeId]);

	// Selecting a node clears the edge selection (mutually exclusive).
	const handleNodeSelect = useCallback(
		(stepId: string) => {
			setSelectedNodeId(stepId);
			onNodeSelect?.(stepId);
			// Clear edge selection to prevent dual Delete handlers from both firing
			if (selectedEdgeIdRef.current !== null) {
				setSelectedEdgeId(null);
				onEdgeSelectRef.current?.(null);
			}
		},
		[onNodeSelect]
	);

	// Selecting an edge clears the node selection (mutually exclusive).
	const handleEdgeSelect = useCallback(
		(transitionId: string) => {
			setSelectedEdgeId(transitionId);
			onEdgeSelect?.(transitionId);
			// Clear node selection to prevent dual Delete handlers from both firing
			if (selectedNodeIdRef.current !== null) {
				setSelectedNodeId(null);
				onNodeSelectRef.current?.(null);
			}
		},
		[onEdgeSelect]
	);

	const handleEdgeDelete = useCallback((transitionId: string) => {
		setSelectedEdgeId(null);
		onEdgeSelectRef.current?.(null);
		onDeleteEdgeRef.current?.(transitionId);
	}, []);

	const handleBackgroundClick = useCallback(() => {
		setSelectedNodeId(null);
		onNodeSelect?.(null);
		setSelectedEdgeId(null);
		onEdgeSelect?.(null);
	}, [onNodeSelect, onEdgeSelect]);

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
	// (Edge deletion is handled by EdgeRenderer's own listener. Selections are mutually
	// exclusive so at most one handler fires per keystroke.)
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key !== 'Delete' && e.key !== 'Backspace') return;
			const target = e.target as HTMLElement;
			const tag = target?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;

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

	// ---- Edge layer: committed edges (EdgeRenderer) + ghost edge during drag + channel edges ----
	const edgeLayer = useCallback(
		(_vp: ViewportState): ComponentChildren => (
			<>
				<EdgeRenderer
					transitions={transitions}
					nodePositions={effectiveNodePositions}
					selectedEdgeId={selectedEdgeId}
					onEdgeSelect={handleEdgeSelect}
					onEdgeDelete={handleEdgeDelete}
				/>
				<ChannelEdgeRenderer channelEdges={channelEdges} nodePositions={effectiveNodePositions} />
				{dragState.active && dragState.fromPos && dragState.currentPos && (
					<GhostEdge from={dragState.fromPos} to={dragState.currentPos} />
				)}
			</>
		),
		[
			transitions,
			channelEdges,
			effectiveNodePositions,
			selectedEdgeId,
			handleEdgeSelect,
			handleEdgeDelete,
			dragState,
		]
	);

	return (
		<VisualCanvas
			containerRef={containerRef}
			viewportState={viewportState}
			onViewportChange={onViewportChange}
			onBackgroundClick={handleBackgroundClick}
			nodes={effectiveNodePositions}
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
	);
}
