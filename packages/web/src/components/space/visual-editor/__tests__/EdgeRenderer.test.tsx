/**
 * Unit tests for EdgeRenderer
 *
 * Tests:
 * - Correct number of paths rendered per transition
 * - Missing node position skips that edge
 * - computeEdgePoints bezier control point math
 * - buildPathD produces correct SVG path string
 * - Edge color matches condition type (always/human/condition) via data-stroke-color
 * - Selected edge gets thicker stroke (data-stroke-width) and white color
 * - Clicking an edge calls onEdgeSelect with transitionId
 * - Delete key on selected edge calls onEdgeDelete
 * - Backspace key on selected edge calls onEdgeDelete
 * - Delete key without selection does not call onEdgeDelete
 * - Delete inside input/textarea/contenteditable does not trigger onEdgeDelete
 * - Arrowhead markers are rendered in defs
 * - Multiple instances have non-colliding marker IDs
 * - Channel edge constants (CHANNEL_EDGE_COLOR, CHANNEL_EDGE_DASH_ARRAY, TASK_AGENT_X)
 * - computeChannelEdgePoints for regular node-to-node channels
 * - computeChannelEdgePoints for task-agent to node channels
 * - Bidirectional channel renders two arrowheads (markerStart + markerEnd)
 * - One-way channel renders one arrowhead (markerEnd only)
 * - Channel edges use dashed style (strokeDasharray)
 * - Channel edges are teal colored (distinct from transition edge colors)
 * - Channel edges have correct data-testid attribute
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import type { WorkflowTransition } from '@neokai/shared';
import {
	EdgeRenderer,
	computeEdgePoints,
	buildPathD,
	CONTROL_OFFSET,
	EDGE_COLORS,
	NORMAL_STROKE_WIDTH,
	SELECTED_STROKE_WIDTH,
	CHANNEL_EDGE_COLOR,
	CHANNEL_EDGE_DASH_ARRAY,
	TASK_AGENT_X,
	computeChannelEdgePoints,
} from '../EdgeRenderer';
import type { EdgeRendererProps } from '../EdgeRenderer';
import type { NodePosition } from '../types';
import type { ResolvedWorkflowChannel } from '../EdgeRenderer';

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NODE_POSITIONS: NodePosition = {
	'step-1': { x: 50, y: 50, width: 160, height: 80 },
	'step-2': { x: 300, y: 250, width: 160, height: 80 },
	'step-3': { x: 50, y: 450, width: 160, height: 80 },
};

function makeTransition(
	id: string,
	from: string,
	to: string,
	conditionType?: 'always' | 'human' | 'condition'
): WorkflowTransition {
	return {
		id,
		from,
		to,
		condition: conditionType ? { type: conditionType } : undefined,
	};
}

const T1 = makeTransition('t1', 'step-1', 'step-2'); // always (no condition)
const T2 = makeTransition('t2', 'step-2', 'step-3', 'human');
const T3 = makeTransition('t3', 'step-1', 'step-3', 'condition');

function renderEdges(props: Partial<EdgeRendererProps> = {}) {
	const onEdgeSelect = vi.fn();
	const onEdgeDelete = vi.fn();
	const result = render(
		<svg>
			<EdgeRenderer
				transitions={[T1, T2, T3]}
				nodePositions={NODE_POSITIONS}
				onEdgeSelect={onEdgeSelect}
				onEdgeDelete={onEdgeDelete}
				{...props}
			/>
		</svg>
	);
	return { ...result, onEdgeSelect, onEdgeDelete };
}

// Helper to get the visible path (second <path> in the group)
function getVisiblePath(group: Element): Element {
	return group.querySelectorAll('path')[1];
}

// ---------------------------------------------------------------------------
// computeEdgePoints
// ---------------------------------------------------------------------------

describe('computeEdgePoints', () => {
	it('returns null when from-node is missing', () => {
		const t = makeTransition('t', 'missing', 'step-2');
		expect(computeEdgePoints(t, NODE_POSITIONS)).toBeNull();
	});

	it('returns null when to-node is missing', () => {
		const t = makeTransition('t', 'step-1', 'missing');
		expect(computeEdgePoints(t, NODE_POSITIONS)).toBeNull();
	});

	it('source x is horizontal center of from-node', () => {
		const pts = computeEdgePoints(T1, NODE_POSITIONS);
		expect(pts).not.toBeNull();
		// step-1: x=50, width=160 → center x = 50 + 80 = 130
		expect(pts!.sx).toBe(50 + 160 / 2);
	});

	it('source y is bottom edge of from-node', () => {
		const pts = computeEdgePoints(T1, NODE_POSITIONS);
		// step-1: y=50, height=80 → bottom = 130
		expect(pts!.sy).toBe(50 + 80);
	});

	it('target x is horizontal center of to-node', () => {
		const pts = computeEdgePoints(T1, NODE_POSITIONS);
		// step-2: x=300, width=160 → center x = 380
		expect(pts!.tx).toBe(300 + 160 / 2);
	});

	it('target y is top edge of to-node', () => {
		const pts = computeEdgePoints(T1, NODE_POSITIONS);
		// step-2: y=250
		expect(pts!.ty).toBe(250);
	});

	it('control point 1 is directly below source by CONTROL_OFFSET', () => {
		const pts = computeEdgePoints(T1, NODE_POSITIONS);
		expect(pts!.cp1x).toBe(pts!.sx);
		expect(pts!.cp1y).toBe(pts!.sy + CONTROL_OFFSET);
	});

	it('control point 2 is directly above target by CONTROL_OFFSET', () => {
		const pts = computeEdgePoints(T1, NODE_POSITIONS);
		expect(pts!.cp2x).toBe(pts!.tx);
		expect(pts!.cp2y).toBe(pts!.ty - CONTROL_OFFSET);
	});
});

// ---------------------------------------------------------------------------
// buildPathD
// ---------------------------------------------------------------------------

describe('buildPathD', () => {
	it('produces a valid SVG cubic bezier path string', () => {
		const pts = computeEdgePoints(T1, NODE_POSITIONS)!;
		const d = buildPathD(pts);
		// Format: M sx sy C cp1x cp1y, cp2x cp2y, tx ty
		expect(d).toBe(
			`M ${pts.sx} ${pts.sy} C ${pts.cp1x} ${pts.cp1y}, ${pts.cp2x} ${pts.cp2y}, ${pts.tx} ${pts.ty}`
		);
	});
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('EdgeRenderer — rendering', () => {
	it('renders a <g> element for each transition', () => {
		const { container } = renderEdges();
		const groups = container.querySelectorAll('g[data-edge-id]');
		expect(groups).toHaveLength(3);
	});

	it('renders two paths per edge (hitbox + visible)', () => {
		const { container } = renderEdges();
		// Each <g> should have 2 paths
		const groups = container.querySelectorAll('g[data-edge-id]');
		for (const g of groups) {
			expect(g.querySelectorAll('path')).toHaveLength(2);
		}
	});

	it('skips edges where node positions are missing', () => {
		const missingEdge = makeTransition('tmissing', 'step-1', 'missing-node');
		const { container } = renderEdges({ transitions: [T1, missingEdge] });
		// Only t1 should render (missingEdge skipped)
		const groups = container.querySelectorAll('g[data-edge-id]');
		expect(groups).toHaveLength(1);
		expect(groups[0].getAttribute('data-edge-id')).toBe('t1');
	});

	it('renders arrowhead marker <defs>', () => {
		const { container } = renderEdges();
		const defs = container.querySelector('defs');
		expect(defs).not.toBeNull();
		// Should have 5 markers: always, human, condition, task_result, selected
		// (channel-end and channel-start are only rendered when channels prop is provided)
		expect(defs!.querySelectorAll('marker')).toHaveLength(5);
	});

	it('uses testid data-testid="edge-{id}" on each group', () => {
		const { getByTestId } = renderEdges();
		expect(getByTestId('edge-t1')).toBeTruthy();
		expect(getByTestId('edge-t2')).toBeTruthy();
		expect(getByTestId('edge-t3')).toBeTruthy();
	});

	it('multiple instances have non-colliding marker IDs', () => {
		// Render two EdgeRenderer instances and check their marker IDs differ
		const { container: c1 } = render(
			<svg>
				<EdgeRenderer transitions={[T1]} nodePositions={NODE_POSITIONS} />
			</svg>
		);
		const { container: c2 } = render(
			<svg>
				<EdgeRenderer transitions={[T1]} nodePositions={NODE_POSITIONS} />
			</svg>
		);
		const markers1 = Array.from(c1.querySelectorAll('marker')).map((m) => m.id);
		const markers2 = Array.from(c2.querySelectorAll('marker')).map((m) => m.id);
		// No overlap between the two instances' marker IDs
		const overlap = markers1.filter((id) => markers2.includes(id));
		expect(overlap).toHaveLength(0);
		cleanup();
	});
});

// ---------------------------------------------------------------------------
// Edge colors
// ---------------------------------------------------------------------------

describe('EdgeRenderer — edge colors', () => {
	it('EDGE_COLORS has correct hex values for all condition types', () => {
		expect(EDGE_COLORS.always).toBe('#3b82f6');
		expect(EDGE_COLORS.human).toBe('#facc15');
		expect(EDGE_COLORS.condition).toBe('#c084fc');
	});

	it('always transition (no condition) has data-condition-type="always"', () => {
		const { getByTestId } = renderEdges();
		expect(getByTestId('edge-t1').getAttribute('data-condition-type')).toBe('always');
	});

	it('human transition has data-condition-type="human"', () => {
		const { getByTestId } = renderEdges();
		expect(getByTestId('edge-t2').getAttribute('data-condition-type')).toBe('human');
	});

	it('condition transition has data-condition-type="condition"', () => {
		const { getByTestId } = renderEdges();
		expect(getByTestId('edge-t3').getAttribute('data-condition-type')).toBe('condition');
	});

	it('always transition visible path has correct stroke color', () => {
		const { getByTestId } = renderEdges();
		const visible = getVisiblePath(getByTestId('edge-t1'));
		expect(visible.getAttribute('data-stroke-color')).toBe(EDGE_COLORS.always);
	});

	it('human transition visible path has correct stroke color', () => {
		const { getByTestId } = renderEdges();
		const visible = getVisiblePath(getByTestId('edge-t2'));
		expect(visible.getAttribute('data-stroke-color')).toBe(EDGE_COLORS.human);
	});

	it('condition transition visible path has correct stroke color', () => {
		const { getByTestId } = renderEdges();
		const visible = getVisiblePath(getByTestId('edge-t3'));
		expect(visible.getAttribute('data-stroke-color')).toBe(EDGE_COLORS.condition);
	});
});

// ---------------------------------------------------------------------------
// Selected edge
// ---------------------------------------------------------------------------

describe('EdgeRenderer — selected state', () => {
	it('selected edge has data-selected="true"', () => {
		const { getByTestId } = renderEdges({ selectedEdgeId: 't1' });
		expect(getByTestId('edge-t1').getAttribute('data-selected')).toBe('true');
	});

	it('non-selected edges have data-selected="false"', () => {
		const { getByTestId } = renderEdges({ selectedEdgeId: 't1' });
		expect(getByTestId('edge-t2').getAttribute('data-selected')).toBe('false');
		expect(getByTestId('edge-t3').getAttribute('data-selected')).toBe('false');
	});

	it('selected edge visible path has white stroke color', () => {
		const { getByTestId } = renderEdges({ selectedEdgeId: 't1' });
		const visible = getVisiblePath(getByTestId('edge-t1'));
		expect(visible.getAttribute('data-stroke-color')).toBe('white');
	});

	it('selected edge visible path has thicker stroke-width than normal', () => {
		const { getByTestId } = renderEdges({ selectedEdgeId: 't1' });
		const selectedVisible = getVisiblePath(getByTestId('edge-t1'));
		const normalVisible = getVisiblePath(getByTestId('edge-t2'));
		const selectedWidth = parseFloat(selectedVisible.getAttribute('data-stroke-width') ?? '0');
		const normalWidth = parseFloat(normalVisible.getAttribute('data-stroke-width') ?? '0');
		expect(selectedWidth).toBe(SELECTED_STROKE_WIDTH);
		expect(normalWidth).toBe(NORMAL_STROKE_WIDTH);
		expect(selectedWidth).toBeGreaterThan(normalWidth);
	});

	it('non-selected edges retain their condition color when one is selected', () => {
		const { getByTestId } = renderEdges({ selectedEdgeId: 't1' });
		expect(getVisiblePath(getByTestId('edge-t2')).getAttribute('data-stroke-color')).toBe(
			EDGE_COLORS.human
		);
	});
});

// ---------------------------------------------------------------------------
// Click selection
// ---------------------------------------------------------------------------

describe('EdgeRenderer — click selection', () => {
	it('clicking an edge calls onEdgeSelect with the transitionId', () => {
		const { getByTestId, onEdgeSelect } = renderEdges();
		const group = getByTestId('edge-t1');
		const hitboxPath = group.querySelectorAll('path')[0];
		fireEvent.click(hitboxPath);
		expect(onEdgeSelect).toHaveBeenCalledWith('t1');
	});

	it('clicking a different edge calls onEdgeSelect with its id', () => {
		const { getByTestId, onEdgeSelect } = renderEdges();
		const group = getByTestId('edge-t2');
		const hitboxPath = group.querySelectorAll('path')[0];
		fireEvent.click(hitboxPath);
		expect(onEdgeSelect).toHaveBeenCalledWith('t2');
	});

	it('hitbox path uses transparent stroke', () => {
		const { getByTestId } = renderEdges();
		const group = getByTestId('edge-t1');
		const hitboxPath = group.querySelectorAll('path')[0];
		expect(hitboxPath.getAttribute('stroke')).toBe('transparent');
	});
});

// ---------------------------------------------------------------------------
// Keyboard delete
// ---------------------------------------------------------------------------

describe('EdgeRenderer — keyboard delete', () => {
	it('Delete key calls onEdgeDelete with selected edgeId', () => {
		const { onEdgeDelete } = renderEdges({ selectedEdgeId: 't1' });
		fireEvent.keyDown(document.body, { key: 'Delete' });
		expect(onEdgeDelete).toHaveBeenCalledWith('t1');
	});

	it('Backspace key calls onEdgeDelete with selected edgeId', () => {
		const { onEdgeDelete } = renderEdges({ selectedEdgeId: 't2' });
		fireEvent.keyDown(document.body, { key: 'Backspace' });
		expect(onEdgeDelete).toHaveBeenCalledWith('t2');
	});

	it('Delete without selection does not call onEdgeDelete', () => {
		const { onEdgeDelete } = renderEdges({ selectedEdgeId: null });
		fireEvent.keyDown(document.body, { key: 'Delete' });
		expect(onEdgeDelete).not.toHaveBeenCalled();
	});

	it('Delete inside an input does not trigger onEdgeDelete', () => {
		const { onEdgeDelete, container } = renderEdges({ selectedEdgeId: 't1' });
		const input = document.createElement('input');
		container.appendChild(input);
		input.focus();
		fireEvent.keyDown(input, { key: 'Delete', target: input });
		expect(onEdgeDelete).not.toHaveBeenCalled();
	});

	it('Delete inside a textarea does not trigger onEdgeDelete', () => {
		const { onEdgeDelete, container } = renderEdges({ selectedEdgeId: 't1' });
		const textarea = document.createElement('textarea');
		container.appendChild(textarea);
		textarea.focus();
		fireEvent.keyDown(textarea, { key: 'Delete', target: textarea });
		expect(onEdgeDelete).not.toHaveBeenCalled();
	});

	it('Delete inside a contenteditable element does not trigger onEdgeDelete', () => {
		const { onEdgeDelete, container } = renderEdges({ selectedEdgeId: 't1' });
		const div = document.createElement('div');
		div.contentEditable = 'true';
		container.appendChild(div);
		div.focus();
		fireEvent.keyDown(div, { key: 'Delete', target: div });
		expect(onEdgeDelete).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Channel edge constants
// ---------------------------------------------------------------------------

describe('Channel edge constants', () => {
	it('CHANNEL_EDGE_COLOR is teal', () => {
		expect(CHANNEL_EDGE_COLOR).toBe('#14b8a6');
	});

	it('CHANNEL_EDGE_DASH_ARRAY is a dashed pattern', () => {
		expect(CHANNEL_EDGE_DASH_ARRAY).toBe('6 4');
	});

	it('TASK_AGENT_X is 60', () => {
		expect(TASK_AGENT_X).toBe(60);
	});
});

// ---------------------------------------------------------------------------
// computeChannelEdgePoints
// ---------------------------------------------------------------------------

describe('computeChannelEdgePoints', () => {
	it('returns null when from-node is missing', () => {
		const channel: ResolvedWorkflowChannel = {
			fromStepId: 'missing',
			toStepId: 'step-2',
			direction: 'bidirectional',
		};
		expect(computeChannelEdgePoints(channel, NODE_POSITIONS)).toBeNull();
	});

	it('returns null when to-node is missing', () => {
		const channel: ResolvedWorkflowChannel = {
			fromStepId: 'step-1',
			toStepId: 'missing',
			direction: 'bidirectional',
		};
		expect(computeChannelEdgePoints(channel, NODE_POSITIONS)).toBeNull();
	});

	it('source x is right edge of from-node for regular channel', () => {
		const channel: ResolvedWorkflowChannel = {
			fromStepId: 'step-1',
			toStepId: 'step-2',
			direction: 'bidirectional',
		};
		const pts = computeChannelEdgePoints(channel, NODE_POSITIONS);
		expect(pts).not.toBeNull();
		// step-1: x=50, width=160 → right edge = 210
		expect(pts!.sx).toBe(50 + 160);
	});

	it('source y is vertical center of from-node', () => {
		const channel: ResolvedWorkflowChannel = {
			fromStepId: 'step-1',
			toStepId: 'step-2',
			direction: 'bidirectional',
		};
		const pts = computeChannelEdgePoints(channel, NODE_POSITIONS);
		expect(pts).not.toBeNull();
		// step-1: y=50, height=80 → center = 90
		expect(pts!.sy).toBe(50 + 80 / 2);
	});

	it('target x is left edge of to-node', () => {
		const channel: ResolvedWorkflowChannel = {
			fromStepId: 'step-1',
			toStepId: 'step-2',
			direction: 'bidirectional',
		};
		const pts = computeChannelEdgePoints(channel, NODE_POSITIONS);
		expect(pts).not.toBeNull();
		// step-2: x=300
		expect(pts!.tx).toBe(300);
	});

	it('target y is vertical center of to-node', () => {
		const channel: ResolvedWorkflowChannel = {
			fromStepId: 'step-1',
			toStepId: 'step-2',
			direction: 'bidirectional',
		};
		const pts = computeChannelEdgePoints(channel, NODE_POSITIONS);
		expect(pts).not.toBeNull();
		// step-2: y=250, height=80 → center = 290
		expect(pts!.ty).toBe(250 + 80 / 2);
	});

	it('task-agent channel uses TASK_AGENT_X as source x', () => {
		const channel: ResolvedWorkflowChannel = {
			fromStepId: 'task-agent',
			toStepId: 'step-2',
			direction: 'bidirectional',
		};
		const pts = computeChannelEdgePoints(channel, NODE_POSITIONS);
		expect(pts).not.toBeNull();
		expect(pts!.sx).toBe(TASK_AGENT_X);
	});

	it('task-agent channel uses top-center of target node', () => {
		const channel: ResolvedWorkflowChannel = {
			fromStepId: 'task-agent',
			toStepId: 'step-2',
			direction: 'bidirectional',
		};
		const pts = computeChannelEdgePoints(channel, NODE_POSITIONS);
		expect(pts).not.toBeNull();
		// step-2: x=300, width=160 → center x = 380, y = 250
		expect(pts!.tx).toBe(300 + 160 / 2);
		expect(pts!.ty).toBe(250);
	});
});

// ---------------------------------------------------------------------------
// Channel edge rendering
// ---------------------------------------------------------------------------

function renderEdgesWithChannels(props: Partial<EdgeRendererProps> = {}) {
	const onEdgeSelect = vi.fn();
	const onEdgeDelete = vi.fn();
	const result = render(
		<svg>
			<EdgeRenderer
				transitions={[T1, T2, T3]}
				nodePositions={NODE_POSITIONS}
				onEdgeSelect={onEdgeSelect}
				onEdgeDelete={onEdgeDelete}
				{...props}
			/>
		</svg>
	);
	return { ...result, onEdgeSelect, onEdgeDelete };
}

describe('EdgeRenderer — channel edge rendering', () => {
	it('renders channel edges when channels prop is provided', () => {
		const channels: ResolvedWorkflowChannel[] = [
			{ fromStepId: 'task-agent', toStepId: 'step-1', direction: 'bidirectional' },
			{ fromStepId: 'task-agent', toStepId: 'step-2', direction: 'bidirectional' },
		];
		const { container } = renderEdgesWithChannels({ channels });
		const channelEdgeGroups = container.querySelectorAll('g[data-channel-edge="true"]');
		expect(channelEdgeGroups).toHaveLength(2);
	});

	it('channel edges have correct data-testid attribute', () => {
		const channels: ResolvedWorkflowChannel[] = [
			{ fromStepId: 'task-agent', toStepId: 'step-1', direction: 'bidirectional' },
		];
		const { getByTestId } = renderEdgesWithChannels({ channels });
		expect(getByTestId('channel-edge-task-agent-step-1')).toBeTruthy();
	});

	it('channel edges have correct data-channel-direction attribute', () => {
		const channels: ResolvedWorkflowChannel[] = [
			{ fromStepId: 'task-agent', toStepId: 'step-1', direction: 'bidirectional' },
			{ fromStepId: 'step-1', toStepId: 'step-2', direction: 'one-way' },
		];
		const { container } = renderEdgesWithChannels({ channels });
		const bidirectional = container.querySelector('g[data-channel-direction="bidirectional"]');
		const oneWay = container.querySelector('g[data-channel-direction="one-way"]');
		expect(bidirectional).toBeTruthy();
		expect(oneWay).toBeTruthy();
	});

	it('bidirectional channel has both markerStart and markerEnd on visible path', () => {
		const channels: ResolvedWorkflowChannel[] = [
			{ fromStepId: 'task-agent', toStepId: 'step-1', direction: 'bidirectional' },
		];
		const { container } = renderEdgesWithChannels({ channels });
		const visiblePath = container.querySelector(
			'g[data-channel-edge="true"] path:not([stroke="transparent"])'
		);
		expect(visiblePath).not.toBeNull();
		const markerStart = visiblePath!.getAttribute('markerStart');
		const markerEnd = visiblePath!.getAttribute('markerEnd');
		expect(markerStart).toContain('channel-start');
		expect(markerEnd).toContain('channel-end');
	});

	it('one-way channel has only markerEnd on visible path', () => {
		const channels: ResolvedWorkflowChannel[] = [
			{ fromStepId: 'step-1', toStepId: 'step-2', direction: 'one-way' },
		];
		const { container } = renderEdgesWithChannels({ channels });
		const visiblePath = container.querySelector(
			'g[data-channel-edge="true"] path:not([stroke="transparent"])'
		);
		expect(visiblePath).not.toBeNull();
		const markerStart = visiblePath!.getAttribute('markerStart');
		const markerEnd = visiblePath!.getAttribute('markerEnd');
		expect(markerStart).toBeNull();
		expect(markerEnd).toContain('channel-end');
	});

	it('channel edges use dashed stroke style', () => {
		const channels: ResolvedWorkflowChannel[] = [
			{ fromStepId: 'task-agent', toStepId: 'step-1', direction: 'bidirectional' },
		];
		const { container } = renderEdgesWithChannels({ channels });
		const visiblePath = container.querySelector(
			'g[data-channel-edge="true"] path:not([stroke="transparent"])'
		);
		expect(visiblePath).not.toBeNull();
		expect(visiblePath!.getAttribute('strokeDasharray')).toBe(CHANNEL_EDGE_DASH_ARRAY);
	});

	it('channel edges use teal color (distinct from transition edge colors)', () => {
		const channels: ResolvedWorkflowChannel[] = [
			{ fromStepId: 'task-agent', toStepId: 'step-1', direction: 'bidirectional' },
		];
		const { container } = renderEdgesWithChannels({ channels });
		const visiblePath = container.querySelector(
			'g[data-channel-edge="true"] path:not([stroke="transparent"])'
		);
		expect(visiblePath).not.toBeNull();
		expect(visiblePath!.getAttribute('stroke')).toBe(CHANNEL_EDGE_COLOR);
		// Verify it's different from transition edge colors
		expect(CHANNEL_EDGE_COLOR).not.toBe(EDGE_COLORS.always);
		expect(CHANNEL_EDGE_COLOR).not.toBe(EDGE_COLORS.human);
		expect(CHANNEL_EDGE_COLOR).not.toBe(EDGE_COLORS.condition);
	});

	it('skips channel edges where target node position is missing', () => {
		const channels: ResolvedWorkflowChannel[] = [
			{ fromStepId: 'task-agent', toStepId: 'step-1', direction: 'bidirectional' },
			{ fromStepId: 'task-agent', toStepId: 'missing-node', direction: 'bidirectional' },
		];
		const { container } = renderEdgesWithChannels({ channels });
		const channelEdgeGroups = container.querySelectorAll('g[data-channel-edge="true"]');
		expect(channelEdgeGroups).toHaveLength(1);
	});

	it('channel edge defs include channel arrowhead markers', () => {
		const channels: ResolvedWorkflowChannel[] = [
			{ fromStepId: 'task-agent', toStepId: 'step-1', direction: 'bidirectional' },
		];
		const { container } = renderEdgesWithChannels({ channels });
		const defs = container.querySelector('defs');
		expect(defs).not.toBeNull();
		const channelEndMarker = defs!.querySelector('marker[id*="channel-end"]');
		const channelStartMarker = defs!.querySelector('marker[id*="channel-start"]');
		expect(channelEndMarker).not.toBeNull();
		expect(channelStartMarker).not.toBeNull();
	});
});
