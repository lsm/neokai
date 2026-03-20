# Milestone 1: Canvas Foundation

## Goal

Build the pannable, zoomable canvas container that will host workflow nodes and edges. This is the foundational rendering surface for the visual editor.

## Tasks

### Task 1.1: Create VisualCanvas component with pan and zoom

**Description**: Build a `VisualCanvas` component that provides a pannable, zoomable viewport. The component uses a `<div>` container with an inner transform layer. Pan is achieved by mouse drag (middle-click or spacebar+left-click), zoom by scroll wheel. The canvas manages a `ViewportState` (offsetX, offsetY, scale) and exposes coordinate conversion helpers (screen-to-canvas, canvas-to-screen).

**Agent type**: coder

**Subtasks**:
1. Create `packages/web/src/components/space/visual-editor/types.ts` with shared types: `Point`, `Size`, `ViewportState`, `NodePosition` (x, y, width, height per node ID)
2. Create `packages/web/src/components/space/visual-editor/VisualCanvas.tsx`:
   - Accept `children`, `viewportState`, `onViewportChange` props
   - Render outer container `<div>` with `overflow: hidden`, inner `<div>` with CSS `transform: translate(offsetX, offsetY) scale(scale)`
   - Handle `onWheel` for zoom (clamp scale between 0.25 and 2.0, zoom toward cursor position)
   - Handle `onMouseDown`/`onMouseMove`/`onMouseUp` for pan (middle mouse button or spacebar held)
   - Expose `screenToCanvas(point)` and `canvasToScreen(point)` utility functions in the types file
3. Create `packages/web/src/components/space/visual-editor/index.ts` barrel export
4. Add basic unit tests in `packages/web/src/components/space/visual-editor/__tests__/VisualCanvas.test.tsx` covering: renders children, zoom clamps to bounds, coordinate conversion math

**Acceptance criteria**:
- VisualCanvas renders children at the correct transform
- Zoom with scroll wheel works, clamped to [0.25, 2.0]
- Pan with middle-click works
- `screenToCanvas` and `canvasToScreen` are correct inverse functions
- Unit tests pass (`bunx vitest run`)

**Dependencies**: None

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

### Task 1.2: Add SVG overlay layer for edges

**Description**: Add an SVG layer inside the VisualCanvas that sits behind the DOM nodes and will be used for rendering edges. The SVG must scale and translate with the viewport transform.

**Agent type**: coder

**Subtasks**:
1. Update `VisualCanvas.tsx` to render an `<svg>` element as the first child of the transform layer, with `position: absolute`, `pointer-events: none`, covering the full canvas area
2. Accept an `svgContent` render prop or `edgeLayer` slot that receives the current viewport state and renders SVG elements (paths, circles) inside the SVG layer
3. Add a test verifying the SVG layer is present and positioned correctly

**Acceptance criteria**:
- SVG layer renders inside the canvas transform, behind DOM children
- SVG layer scales/translates with viewport changes
- Edge content can be injected via props
- Tests pass

**Dependencies**: Task 1.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

### Task 1.3: Canvas toolbar (zoom controls, fit-to-view)

**Description**: Add a small floating toolbar over the canvas with zoom-in, zoom-out, zoom-reset (100%), and fit-to-view buttons.

**Agent type**: coder

**Subtasks**:
1. Create `packages/web/src/components/space/visual-editor/CanvasToolbar.tsx` with buttons for zoom in (+0.25), zoom out (-0.25), reset (scale=1, offset=0,0), and fit-to-view
2. Fit-to-view accepts the bounding box of all nodes and computes the viewport to center and fit them with padding
3. Style using existing Tailwind classes consistent with NeoKai dark theme (`bg-dark-850`, `border-dark-700`, etc.)
4. Add to VisualCanvas as an absolutely-positioned overlay (bottom-right corner)
5. Add tests for fit-to-view bounding box calculation

**Acceptance criteria**:
- Zoom buttons adjust viewport scale correctly
- Reset returns to default viewport
- Fit-to-view centers all nodes in the viewport
- Toolbar does not interfere with canvas pan/zoom interactions
- Tests pass

**Dependencies**: Task 1.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
