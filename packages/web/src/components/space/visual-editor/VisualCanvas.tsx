/**
 * VisualCanvas
 *
 * A pannable, zoomable viewport container for the visual workflow editor.
 *
 * Pan methods:
 *  - Two-finger trackpad scroll (wheel event without ctrlKey)
 *  - Spacebar + left-click drag
 *
 * Zoom methods:
 *  - Trackpad pinch (wheel event with ctrlKey=true)
 *  - Ctrl/Cmd + scroll wheel
 *  - Scale is clamped to [0.25, 2.0] and zooms toward cursor position.
 */

import { useEffect, useRef, useCallback } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { ViewportState } from './types';

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 2.0;

function clampScale(s: number): number {
	return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/**
 * Pure function: compute the next ViewportState for a wheel event.
 *
 * @param vp        Current viewport state
 * @param deltaX    Horizontal scroll delta
 * @param deltaY    Vertical scroll delta (negative = zoom in)
 * @param isZoom    True when the wheel event should zoom (ctrlKey pressed / pinch)
 * @param cursorX   Cursor X relative to the canvas container (for zoom-toward-cursor)
 * @param cursorY   Cursor Y relative to the canvas container
 */
export function applyWheelEvent(
	vp: ViewportState,
	deltaX: number,
	deltaY: number,
	isZoom: boolean,
	cursorX = 0,
	cursorY = 0
): ViewportState {
	if (isZoom) {
		const zoomFactor = 1 - deltaY * 0.005;
		const newScale = clampScale(vp.scale * zoomFactor);
		// Adjust offset so the point under the cursor stays fixed
		const newOffsetX = cursorX - (cursorX - vp.offsetX) * (newScale / vp.scale);
		const newOffsetY = cursorY - (cursorY - vp.offsetY) * (newScale / vp.scale);
		return { offsetX: newOffsetX, offsetY: newOffsetY, scale: newScale };
	}
	// Two-finger scroll — pan
	return { ...vp, offsetX: vp.offsetX - deltaX, offsetY: vp.offsetY - deltaY };
}

interface VisualCanvasProps {
	children?: ComponentChildren;
	viewportState: ViewportState;
	onViewportChange: (state: ViewportState) => void;
	/** Called when the canvas background is clicked (not on a child node). */
	onBackgroundClick?: () => void;
	/** Render prop for injecting SVG edge content. Receives current viewport state. */
	edgeLayer?: (viewport: ViewportState) => ComponentChildren;
}

export function VisualCanvas({
	children,
	viewportState,
	onViewportChange,
	onBackgroundClick,
	edgeLayer,
}: VisualCanvasProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const transformRef = useRef<HTMLDivElement>(null);

	// Track spacebar state for pan-drag mode
	const spacebarDown = useRef(false);
	// Track drag state
	const dragState = useRef<{
		startX: number;
		startY: number;
		originOffsetX: number;
		originOffsetY: number;
	} | null>(null);
	// Track whether a spacebar-drag actually moved the canvas (suppress background click)
	const didDrag = useRef(false);

	// Keep a ref to the latest viewport so event handlers don't stale-close over it
	const viewportRef = useRef(viewportState);
	viewportRef.current = viewportState;

	// ---- Wheel handler (pan + zoom) ----
	// Registered via onWheel JSX prop so Preact attaches it as a non-passive
	// listener, which lets us call e.preventDefault() to suppress browser
	// scroll/pinch-zoom behaviour.
	const handleWheel = useCallback(
		(e: WheelEvent) => {
			e.preventDefault();
			const vp = viewportRef.current;
			const rect = containerRef.current?.getBoundingClientRect();
			const cursorX = e.clientX - (rect?.left ?? 0);
			const cursorY = e.clientY - (rect?.top ?? 0);
			onViewportChange(applyWheelEvent(vp, e.deltaX, e.deltaY, e.ctrlKey, cursorX, cursorY));
		},
		[onViewportChange]
	);

	// ---- Spacebar listeners ----
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.code === 'Space' && !e.repeat) {
				// Don't capture space when focused on an input/textarea
				const tag = (e.target as HTMLElement)?.tagName;
				if (tag === 'INPUT' || tag === 'TEXTAREA') return;
				e.preventDefault(); // prevent browser "scroll down" default
				spacebarDown.current = true;
				if (containerRef.current) {
					containerRef.current.style.cursor = 'grab';
				}
			}
		};
		const onKeyUp = (e: KeyboardEvent) => {
			if (e.code === 'Space') {
				spacebarDown.current = false;
				dragState.current = null;
				if (containerRef.current) {
					containerRef.current.style.cursor = '';
				}
			}
		};
		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('keyup', onKeyUp);
		return () => {
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('keyup', onKeyUp);
		};
	}, []);

	// ---- Mouse drag for spacebar+click pan ----
	const handleMouseDown = useCallback((e: MouseEvent) => {
		if (!spacebarDown.current || e.button !== 0) return;
		e.preventDefault();
		didDrag.current = false;
		dragState.current = {
			startX: e.clientX,
			startY: e.clientY,
			originOffsetX: viewportRef.current.offsetX,
			originOffsetY: viewportRef.current.offsetY,
		};
		if (containerRef.current) {
			containerRef.current.style.cursor = 'grabbing';
		}
	}, []);

	const handleMouseMove = useCallback(
		(e: MouseEvent) => {
			if (!dragState.current) return;
			didDrag.current = true;
			const dx = e.clientX - dragState.current.startX;
			const dy = e.clientY - dragState.current.startY;
			onViewportChange({
				...viewportRef.current,
				offsetX: dragState.current.originOffsetX + dx,
				offsetY: dragState.current.originOffsetY + dy,
			});
		},
		[onViewportChange]
	);

	const handleMouseUp = useCallback(() => {
		if (!dragState.current) return;
		dragState.current = null;
		if (containerRef.current) {
			containerRef.current.style.cursor = spacebarDown.current ? 'grab' : '';
		}
	}, []);

	useEffect(() => {
		window.addEventListener('mousemove', handleMouseMove);
		window.addEventListener('mouseup', handleMouseUp);
		return () => {
			window.removeEventListener('mousemove', handleMouseMove);
			window.removeEventListener('mouseup', handleMouseUp);
		};
	}, [handleMouseMove, handleMouseUp]);

	// ---- Background click: fires when clicking the canvas outside of child nodes ----
	// Child nodes should call e.stopPropagation() to prevent this from firing.
	const handleContainerClick = useCallback(
		(e: MouseEvent) => {
			// Suppress if a spacebar-drag just finished
			if (didDrag.current) {
				didDrag.current = false;
				return;
			}
			// Use refs instead of data-testid so this works correctly in production
			// (where data-testid attributes may be stripped by build tooling).
			const target = e.target as HTMLElement;
			const isBackground = target === containerRef.current || target === transformRef.current;
			if (isBackground) {
				onBackgroundClick?.();
			}
		},
		[onBackgroundClick]
	);

	const transform = `translate(${viewportState.offsetX}px, ${viewportState.offsetY}px) scale(${viewportState.scale})`;

	return (
		<div
			ref={containerRef}
			class="visual-canvas-container"
			style={{ overflow: 'hidden', width: '100%', height: '100%', position: 'relative' }}
			onMouseDown={handleMouseDown}
			onWheel={handleWheel}
			onClick={handleContainerClick}
			data-testid="visual-canvas"
		>
			<div
				ref={transformRef}
				class="visual-canvas-transform"
				style={{
					transform,
					transformOrigin: '0 0',
					position: 'absolute',
					top: 0,
					left: 0,
				}}
				data-testid="visual-canvas-transform"
			>
				<svg
					class="visual-canvas-edge-layer"
					style={{
						position: 'absolute',
						top: 0,
						left: 0,
						width: '100%',
						height: '100%',
						pointerEvents: 'none',
						overflow: 'visible',
					}}
					data-testid="visual-canvas-svg"
				>
					{edgeLayer?.(viewportState)}
				</svg>
				{children}
			</div>
		</div>
	);
}
