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
// Types
// ---------------------------------------------------------------------------

export interface EdgeRendererProps {
	transitions: WorkflowTransition[];
	nodePositions: NodePosition;
	selectedEdgeId?: string | null;
	onEdgeSelect?: (transitionId: string) => void;
	onEdgeDelete?: (transitionId: string) => void;
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
// Component
// ---------------------------------------------------------------------------

export function EdgeRenderer({
	transitions,
	nodePositions,
	selectedEdgeId,
	onEdgeSelect,
	onEdgeDelete,
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
		</>
	);
}
