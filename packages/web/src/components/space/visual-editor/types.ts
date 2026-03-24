/**
 * Shared types for the visual editor canvas and nodes.
 */

import { TASK_AGENT_NODE_ID } from '@neokai/shared';

/**
 * Represents the Task Agent virtual node in the visual editor.
 *
 * The Task Agent node is always present in the visual editor — it is pinned
 * to the top-center of the canvas and cannot be deleted by the user.
 * It is never persisted in the backend (stripped during serialization).
 */
export interface TaskAgentVisualNode {
	/** Always `TASK_AGENT_NODE_ID` — used to identify this node uniquely. */
	id: typeof TASK_AGENT_NODE_ID;
	/** Display name shown in the canvas. */
	name: 'Task Agent';
	/** Virtual nodes are never stored in the DB. */
	virtual: true;
}

export interface Point {
	x: number;
	y: number;
}

export interface Size {
	width: number;
	height: number;
}

export interface ViewportState {
	offsetX: number;
	offsetY: number;
	scale: number;
}

/** Per-node position and size keyed by node ID. */
export type NodePosition = Record<string, { x: number; y: number; width: number; height: number }>;

/**
 * Convert a screen-space point to canvas-space using the current viewport.
 * Inverse of canvasToScreen.
 */
export function screenToCanvas(point: Point, viewport: ViewportState): Point {
	const scale = viewport.scale || 1;
	return {
		x: (point.x - viewport.offsetX) / scale,
		y: (point.y - viewport.offsetY) / scale,
	};
}

/**
 * Convert a canvas-space point to screen-space using the current viewport.
 * Inverse of screenToCanvas.
 */
export function canvasToScreen(point: Point, viewport: ViewportState): Point {
	return {
		x: point.x * viewport.scale + viewport.offsetX,
		y: point.y * viewport.scale + viewport.offsetY,
	};
}
