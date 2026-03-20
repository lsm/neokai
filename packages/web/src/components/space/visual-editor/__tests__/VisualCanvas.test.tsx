/**
 * Unit tests for VisualCanvas and coordinate conversion utilities.
 *
 * Tests:
 * - Renders children inside the transform layer
 * - Transform style reflects ViewportState
 * - applyWheelEvent: zoom increases/decreases scale correctly
 * - applyWheelEvent: zoom clamps to [0.25, 2.0]
 * - applyWheelEvent: pan updates offsets
 * - applyWheelEvent: zoom adjusts offset toward cursor
 * - Pan via wheel event (no ctrlKey) updates offset via DOM event
 * - screenToCanvas and canvasToScreen are correct inverse functions
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { VisualCanvas, applyWheelEvent, MIN_SCALE, MAX_SCALE } from '../VisualCanvas';
import { screenToCanvas, canvasToScreen } from '../types';
import type { ViewportState } from '../types';

afterEach(() => cleanup());

// ---- Helper ----

function renderCanvas(initial: ViewportState = { offsetX: 0, offsetY: 0, scale: 1 }) {
	const changes: ViewportState[] = [];

	function Wrapper() {
		const [vp, setVp] = useState<ViewportState>(initial);
		return (
			<VisualCanvas
				viewportState={vp}
				onViewportChange={(next) => {
					changes.push(next);
					setVp(next);
				}}
			>
				<div data-testid="child-node">Hello</div>
			</VisualCanvas>
		);
	}

	const result = render(<Wrapper />);
	return { ...result, changes };
}

// ---- Component rendering tests ----

describe('VisualCanvas', () => {
	it('renders children inside the transform layer', () => {
		const { getByTestId } = renderCanvas();
		expect(getByTestId('child-node').textContent).toBe('Hello');
		const transformEl = getByTestId('visual-canvas-transform');
		expect(transformEl.contains(getByTestId('child-node'))).toBe(true);
	});

	it('applies the correct CSS transform from ViewportState', () => {
		const { getByTestId } = renderCanvas({ offsetX: 50, offsetY: -20, scale: 1.5 });
		const transformEl = getByTestId('visual-canvas-transform');
		expect(transformEl.style.transform).toBe('translate(50px, -20px) scale(1.5)');
	});

	it('pans via wheel event (no ctrlKey) - deltaX/deltaY update offsets', () => {
		const { getByTestId, changes } = renderCanvas({ offsetX: 0, offsetY: 0, scale: 1 });
		const container = getByTestId('visual-canvas');

		fireEvent.wheel(container, { deltaX: 30, deltaY: 10 });

		expect(changes.length).toBeGreaterThan(0);
		const last = changes[changes.length - 1];
		expect(last.offsetX).toBe(-30);
		expect(last.offsetY).toBe(-10);
		expect(last.scale).toBe(1);
	});
});

// ---- applyWheelEvent pure logic tests ----

describe('applyWheelEvent', () => {
	const base: ViewportState = { offsetX: 0, offsetY: 0, scale: 1 };

	it('pans when isZoom=false', () => {
		const result = applyWheelEvent(base, 30, 10, false);
		expect(result.offsetX).toBe(-30);
		expect(result.offsetY).toBe(-10);
		expect(result.scale).toBe(1);
	});

	it('zooms in (negative deltaY) when isZoom=true', () => {
		const result = applyWheelEvent(base, 0, -100, true, 0, 0);
		expect(result.scale).toBeGreaterThan(1);
	});

	it('zooms out (positive deltaY) when isZoom=true', () => {
		const result = applyWheelEvent(base, 0, 100, true, 0, 0);
		expect(result.scale).toBeLessThan(1);
	});

	it('clamps scale to MIN_SCALE on aggressive zoom-out', () => {
		const result = applyWheelEvent({ ...base, scale: 0.3 }, 0, 10000, true, 0, 0);
		expect(result.scale).toBeGreaterThanOrEqual(MIN_SCALE);
		expect(result.scale).toBe(MIN_SCALE);
	});

	it('clamps scale to MAX_SCALE on aggressive zoom-in', () => {
		const result = applyWheelEvent({ ...base, scale: 1.9 }, 0, -10000, true, 0, 0);
		expect(result.scale).toBeLessThanOrEqual(MAX_SCALE);
		expect(result.scale).toBe(MAX_SCALE);
	});

	it('zooms toward cursor position', () => {
		// At cursor (100, 100) with scale going from 1 to ~1.5,
		// the point under cursor should remain at (100, 100) in screen space.
		const vp: ViewportState = { offsetX: 0, offsetY: 0, scale: 1 };
		const cursorX = 100;
		const cursorY = 100;
		const result = applyWheelEvent(vp, 0, -100, true, cursorX, cursorY);

		// The canvas point under cursor before and after should be the same
		const canvasBefore = {
			x: (cursorX - vp.offsetX) / vp.scale,
			y: (cursorY - vp.offsetY) / vp.scale,
		};
		const screenAfter = {
			x: canvasBefore.x * result.scale + result.offsetX,
			y: canvasBefore.y * result.scale + result.offsetY,
		};
		expect(screenAfter.x).toBeCloseTo(cursorX);
		expect(screenAfter.y).toBeCloseTo(cursorY);
	});
});

// ---- Coordinate conversion ----

describe('screenToCanvas / canvasToScreen', () => {
	it('are inverse functions at scale=1, no offset', () => {
		const vp: ViewportState = { offsetX: 0, offsetY: 0, scale: 1 };
		const screen = { x: 100, y: 200 };
		const canvas = screenToCanvas(screen, vp);
		const back = canvasToScreen(canvas, vp);
		expect(back.x).toBeCloseTo(screen.x);
		expect(back.y).toBeCloseTo(screen.y);
	});

	it('are inverse functions with offset and scale', () => {
		const vp: ViewportState = { offsetX: 50, offsetY: -30, scale: 1.5 };
		const screen = { x: 300, y: 150 };
		const canvas = screenToCanvas(screen, vp);
		const back = canvasToScreen(canvas, vp);
		expect(back.x).toBeCloseTo(screen.x);
		expect(back.y).toBeCloseTo(screen.y);
	});

	it('screenToCanvas maps correctly', () => {
		const vp: ViewportState = { offsetX: 100, offsetY: 50, scale: 2 };
		// canvas.x = (screenX - offsetX) / scale = (200 - 100) / 2 = 50
		const canvas = screenToCanvas({ x: 200, y: 150 }, vp);
		expect(canvas.x).toBeCloseTo(50);
		expect(canvas.y).toBeCloseTo(50);
	});

	it('canvasToScreen maps correctly', () => {
		const vp: ViewportState = { offsetX: 100, offsetY: 50, scale: 2 };
		// screen.x = canvas.x * scale + offsetX = 50 * 2 + 100 = 200
		const screen = canvasToScreen({ x: 50, y: 50 }, vp);
		expect(screen.x).toBeCloseTo(200);
		expect(screen.y).toBeCloseTo(150);
	});
});
