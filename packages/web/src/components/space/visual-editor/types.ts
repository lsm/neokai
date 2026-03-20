/**
 * Shared types for the visual editor canvas and nodes.
 */

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
	return {
		x: (point.x - viewport.offsetX) / viewport.scale,
		y: (point.y - viewport.offsetY) / viewport.scale,
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
