/**
 * EdgeRenderer
 *
 * Renders WorkflowTransition entries as SVG cubic bezier paths.
 *
 * Each edge connects the output port (bottom-center) of the source node to the
 * input port (top-center) of the target node. Control points are offset vertically
 * by CONTROL_OFFSET px for a smooth curve.
 *
 * Edge color reflects the condition type:
 *   always   → blue  (#3b82f6)
 *   human    → yellow (#facc15)
 *   condition → purple (#c084fc)
 *
 * A wider invisible hitbox path (stroke-width 12px) is rendered behind each
 * visible edge to make clicking easier. An arrowhead marker indicates direction.
 *
 * Delete/Backspace while an edge is selected calls onEdgeDelete.
 *
 * Marker IDs are prefixed with a stable per-instance ID (via useId) to prevent
 * collisions when multiple EdgeRenderer instances are mounted simultaneously.
 *
 * Channel edges are also rendered (via the channels prop). Channel edges connect
 * between side ports (left/right) of nodes with a distinct dashed teal style.
 * Bidirectional channels show double arrowheads; one-way channels show a single arrowhead.
 */

import { useEffect, useRef } from 'preact/hooks';
import type { WorkflowTransition, WorkflowConditionType } from '@neokai/shared';
import type { NodePosition } from './types';

// Module-level counter — increments on each EdgeRenderer mount, giving every
// instance a unique marker ID prefix even when multiple instances are on the
// same page (e.g. split-view or comparison mode).
let _instanceCounter = 0;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Control point vertical offset for bezier curves (px, canvas space). */
export const CONTROL_OFFSET = 60;

/** Stroke colors matching GATE_COLORS from WorkflowList.tsx */
export const EDGE_COLORS: Record<WorkflowConditionType, string> = {
	always: '#3b82f6', // blue-500
	human: '#facc15', // yellow-400
	condition: '#c084fc', // purple-400
	task_result: '#f97316', // orange-500
};

export const NORMAL_STROKE_WIDTH = 1.5;
export const SELECTED_STROKE_WIDTH = 3;
const HITBOX_STROKE_WIDTH = 12;

// ---------------------------------------------------------------------------
// Channel edge types and constants
// ---------------------------------------------------------------------------

/**
 * A messaging channel between two nodes with resolved node IDs.
 * This is the rendered form of a WorkflowChannel where role strings
 * have been resolved to actual node/step IDs.
 */
export interface ResolvedWorkflowChannel {
	fromStepId: string;
	toStepId: string;
	direction: 'one-way' | 'bidirectional';
}

/** Channel edge color — teal, distinct from transition edge colors */
export const CHANNEL_EDGE_COLOR = '#14b8a6'; // teal-500

/** Channel edge stroke dash pattern for visual distinction */
export const CHANNEL_EDGE_DASH_ARRAY = '6 4';

/** Control point horizontal offset for channel edge bezier curves */
const CHANNEL_CP_OFFSET = 80;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EdgeRendererProps {
	transitions: WorkflowTransition[];
	nodePositions: NodePosition;
	selectedEdgeId?: string | null;
	onEdgeSelect?: (transitionId: string) => void;
	onEdgeDelete?: (transitionId: string) => void;
	/** Channel edges to render between nodes (with resolved source/target node IDs). */
	channels?: ResolvedWorkflowChannel[];
}

// ---------------------------------------------------------------------------
// Helper: compute bezier path string
// ---------------------------------------------------------------------------

export interface EdgePoints {
	sx: number;
	sy: number;
	tx: number;
	ty: number;
	cp1x: number;
	cp1y: number;
	cp2x: number;
	cp2y: number;
}

/**
 * Compute the bezier path data and control points for a transition.
 * Returns null when either node position is missing.
 */
export function computeEdgePoints(
	transition: WorkflowTransition,
	nodePositions: NodePosition
): EdgePoints | null {
	const fromPos = nodePositions[transition.from];
	const toPos = nodePositions[transition.to];
	if (!fromPos || !toPos) return null;

	// Source: bottom-center of from-node (output port center)
	const sx = fromPos.x + fromPos.width / 2;
	const sy = fromPos.y + fromPos.height;

	// Target: top-center of to-node (input port center)
	const tx = toPos.x + toPos.width / 2;
	const ty = toPos.y;

	// Bezier control points offset vertically
	const cp1x = sx;
	const cp1y = sy + CONTROL_OFFSET;
	const cp2x = tx;
	const cp2y = ty - CONTROL_OFFSET;

	return { sx, sy, tx, ty, cp1x, cp1y, cp2x, cp2y };
}

/** Build the SVG path `d` attribute string from computed edge points. */
export function buildPathD(pts: EdgePoints): string {
	return `M ${pts.sx} ${pts.sy} C ${pts.cp1x} ${pts.cp1y}, ${pts.cp2x} ${pts.cp2y}, ${pts.tx} ${pts.ty}`;
}

// ---------------------------------------------------------------------------
// Channel edge helpers
// ---------------------------------------------------------------------------

/** Fixed X position for the Task Agent hub rail on the left side of the canvas. */
export const TASK_AGENT_X = 60;

/** Compute the bezier path for a channel edge connecting side ports of two nodes.
 *  For the special 'task-agent' source, routes from the Task Agent rail (left side)
 *  to the target node's top-center port. */
export function computeChannelEdgePoints(
	channel: ResolvedWorkflowChannel,
	nodePositions: NodePosition
): EdgePoints | null {
	const toPos = nodePositions[channel.toStepId];
	if (!toPos) return null;

	// Handle Task Agent source (special virtual hub on the left side)
	if (channel.fromStepId === 'task-agent') {
		const sx = TASK_AGENT_X;
		const sy = toPos.y + toPos.height / 2;
		const tx = toPos.x + toPos.width / 2;
		const ty = toPos.y;

		const cpOffset = Math.max(40, Math.abs(tx - sx) * 0.5);
		const cp1x = sx + cpOffset;
		const cp1y = sy;
		const cp2x = tx - cpOffset;
		const cp2y = ty;

		return { sx, sy, tx, ty, cp1x, cp1y, cp2x, cp2y };
	}

	// Regular node-to-node channel: connect from right side of source to left side of target
	const fromPos = nodePositions[channel.fromStepId];
	if (!fromPos) return null;

	const sx = fromPos.x + fromPos.width; // right edge of source
	const sy = fromPos.y + fromPos.height / 2; // vertical center of source

	const tx = toPos.x; // left edge of target
	const ty = toPos.y + toPos.height / 2; // vertical center of target

	// Horizontal bezier: bow outward from both sides
	const cp1x = sx + CHANNEL_CP_OFFSET;
	const cp1y = sy;
	const cp2x = tx - CHANNEL_CP_OFFSET;
	const cp2y = ty;

	return { sx, sy, tx, ty, cp1x, cp1y, cp2x, cp2y };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EdgeRenderer({
	transitions,
	nodePositions,
	selectedEdgeId,
	onEdgeSelect,
	onEdgeDelete,
	channels = [],
}: EdgeRendererProps) {
	// Stable per-instance prefix to prevent marker ID collisions across instances
	const markerPrefixRef = useRef<string | null>(null);
	if (markerPrefixRef.current === null) {
		markerPrefixRef.current = `edge-arrow-${_instanceCounter++}`;
	}
	const markerPrefix = markerPrefixRef.current;

	// Keep refs so the keyboard handler always sees the latest values
	const selectedEdgeIdRef = useRef(selectedEdgeId);
	selectedEdgeIdRef.current = selectedEdgeId;

	const onEdgeDeleteRef = useRef(onEdgeDelete);
	onEdgeDeleteRef.current = onEdgeDelete;

	// ---- Keyboard: Delete / Backspace deletes the selected edge ----
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key !== 'Delete' && e.key !== 'Backspace') return;
			const target = e.target as HTMLElement;
			const tag = target?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;

			const current = selectedEdgeIdRef.current;
			if (!current || !onEdgeDeleteRef.current) return;

			e.preventDefault();
			onEdgeDeleteRef.current(current);
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, []);

	return (
		<>
			{/* Arrowhead marker definitions — one per condition type + one for selected state.
			    IDs are prefixed with instanceId to prevent collisions between multiple instances. */}
			<defs>
				{(Object.entries(EDGE_COLORS) as [WorkflowConditionType, string][]).map(([type, color]) => (
					<marker
						key={`${markerPrefix}-${type}`}
						id={`${markerPrefix}-${type}`}
						viewBox="0 0 10 10"
						refX="10"
						refY="5"
						markerWidth="6"
						markerHeight="6"
						orient="auto-start-reverse"
					>
						<path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
					</marker>
				))}
				<marker
					id={`${markerPrefix}-selected`}
					viewBox="0 0 10 10"
					refX="10"
					refY="5"
					markerWidth="6"
					markerHeight="6"
					orient="auto-start-reverse"
				>
					<path d="M 0 0 L 10 5 L 0 10 z" fill="white" />
				</marker>
				{/* Channel edge arrowhead markers — teal colored, distinct from transition markers */}
				<marker
					id={`${markerPrefix}-channel-end`}
					viewBox="0 0 10 10"
					refX="10"
					refY="5"
					markerWidth="6"
					markerHeight="6"
					orient="auto-start-reverse"
				>
					<path d="M 0 0 L 10 5 L 0 10 z" fill={CHANNEL_EDGE_COLOR} />
				</marker>
				<marker
					id={`${markerPrefix}-channel-start`}
					viewBox="0 0 10 10"
					refX="0"
					refY="5"
					markerWidth="6"
					markerHeight="6"
					orient="auto-start-reverse"
				>
					<path d="M 10 0 L 0 5 L 10 10 z" fill={CHANNEL_EDGE_COLOR} />
				</marker>
			</defs>

			{transitions.map((transition) => {
				const pts = computeEdgePoints(transition, nodePositions);
				if (!pts) return null;

				const d = buildPathD(pts);
				const conditionType: WorkflowConditionType = transition.condition?.type ?? 'always';
				const color = EDGE_COLORS[conditionType];
				const isSelected = transition.id === selectedEdgeId;
				const strokeColor = isSelected ? 'white' : color;
				const strokeWidth = isSelected ? SELECTED_STROKE_WIDTH : NORMAL_STROKE_WIDTH;
				const markerId = isSelected
					? `${markerPrefix}-selected`
					: `${markerPrefix}-${conditionType}`;

				return (
					<g
						key={transition.id}
						data-testid={`edge-${transition.id}`}
						data-edge-id={transition.id}
						data-selected={isSelected ? 'true' : 'false'}
						data-condition-type={conditionType}
						style={{ pointerEvents: 'auto' }}
					>
						{/* Invisible wider hitbox for easier click selection */}
						<path
							d={d}
							stroke="transparent"
							strokeWidth={HITBOX_STROKE_WIDTH}
							fill="none"
							style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
							onClick={(e: MouseEvent) => {
								e.stopPropagation();
								onEdgeSelect?.(transition.id);
							}}
						/>
						{/* Visible edge path */}
						<path
							d={d}
							stroke={strokeColor}
							strokeWidth={strokeWidth}
							strokeOpacity={isSelected ? 1 : 0.85}
							fill="none"
							markerEnd={`url(#${markerId})`}
							data-stroke-color={strokeColor}
							data-stroke-width={String(strokeWidth)}
							style={{ pointerEvents: 'none' }}
						/>
					</g>
				);
			})}

			{/* Channel edges — dashed teal edges connecting side ports of nodes */}
			{channels.map((channel) => {
				const pts = computeChannelEdgePoints(channel, nodePositions);
				if (!pts) return null;

				const d = buildPathD(pts);
				const isBidirectional = channel.direction === 'bidirectional';
				const markerEndId = `${markerPrefix}-channel-end`;
				const markerStartId = `${markerPrefix}-channel-start`;

				return (
					<g
						key={`channel-${channel.fromStepId}-${channel.toStepId}`}
						data-testid={`channel-edge-${channel.fromStepId}-${channel.toStepId}`}
						data-channel-edge="true"
						data-channel-direction={channel.direction}
					>
						{/* Invisible hitbox for easier interaction */}
						<path
							d={d}
							stroke="transparent"
							strokeWidth={HITBOX_STROKE_WIDTH}
							fill="none"
							style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
						/>
						{/* Visible dashed channel edge */}
						<path
							d={d}
							stroke={CHANNEL_EDGE_COLOR}
							strokeWidth={NORMAL_STROKE_WIDTH}
							strokeDasharray={CHANNEL_EDGE_DASH_ARRAY}
							strokeOpacity={0.8}
							fill="none"
							markerEnd={`url(#${markerEndId})`}
							markerStart={isBidirectional ? `url(#${markerStartId})` : undefined}
							data-stroke-color={CHANNEL_EDGE_COLOR}
							data-stroke-width={String(NORMAL_STROKE_WIDTH)}
							style={{ pointerEvents: 'none' }}
						/>
					</g>
				);
			})}
		</>
	);
}
