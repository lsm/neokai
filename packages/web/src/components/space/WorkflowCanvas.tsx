/**
 * WorkflowCanvas
 *
 * SVG-based canvas that renders a workflow as nodes + channels + gates.
 *
 * Two modes (auto-detected by context):
 *   - Runtime mode (`runId` provided): read-only, shows live node/gate status
 *     with real-time updates from space.task.updated and space.gateData.updated events.
 *   - Template mode (no `runId`): editable, allows adding/removing gates on channels.
 *
 * Gate visual states (ON the channel line, like a valve on a pipe):
 *   - open:         green checkmark — condition satisfied
 *   - blocked:      red/gray lock — condition not met or rejected
 *   - waiting_human: amber pulsing — human approval gate waiting for input
 *
 * Node status (from tasks in the space store):
 *   - pending:    gray box, no tasks yet
 *   - active:     blue box, pulsing — has in_progress tasks
 *   - completed:  green box, checkmark + elapsed time
 *   - failed:     red box — task errored or run failed
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import type { JSX } from 'preact';
import type {
	SpaceWorkflow,
	SpaceWorkflowRun,
	SpaceTask,
	Gate,
	GateField,
	WorkflowNode,
} from '@neokai/shared';
import { spaceStore } from '../../lib/space-store';
import { connectionManager } from '../../lib/connection-manager';
import { cn } from '../../lib/utils';
import { GateArtifactsView } from './GateArtifactsView';

// ============================================================================
// Constants
// ============================================================================

const NODE_WIDTH = 160;
const NODE_HEIGHT = 72;
const H_GAP = 220;
const V_GAP = 130;
const START_Y = 40;
const CANVAS_PADDING = 40;

// ============================================================================
// Types
// ============================================================================

type NodeStatus = 'pending' | 'active' | 'completed' | 'failed';

type GateStatus = 'open' | 'blocked' | 'waiting_human';

interface GateDataRecord {
	runId: string;
	gateId: string;
	data: Record<string, unknown>;
	updatedAt: number;
}

interface NodeLayout {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

interface RenderedChannel {
	id: string;
	fromId: string;
	toId: string;
	gateId?: string;
}

// ============================================================================
// Gate status evaluation
// ============================================================================

/**
 * Determine whether a human approval gate is involved — checks for a
 * field named 'approved' with 'human' in writers.
 */
function isHumanApprovalGate(fields: GateField[]): boolean {
	return fields.some((f) => f.name === 'approved' && f.writers.includes('human'));
}

/**
 * Compute the current matching vote count for a map-type field with count check.
 * Returns `{ current, min }` so the UI can render "N/M" progress.
 * Returns `undefined` when no map count field exists.
 */
function computeVoteCount(
	fields: GateField[],
	data: Record<string, unknown>
): { current: number; min: number } | undefined {
	const mapField = fields.find((f) => f.type === 'map' && f.check.op === 'count');
	if (!mapField || mapField.check.op !== 'count') return undefined;
	const check = mapField.check;
	const map = data[mapField.name];
	if (!map || typeof map !== 'object' || Array.isArray(map)) {
		return { current: 0, min: check.min };
	}
	const current = Object.values(map as Record<string, unknown>).filter(
		(v) => v === check.match
	).length;
	return { current, min: check.min };
}

/**
 * Extract the script error reason from gate data, if any.
 * Returns the reason string when `_scriptResult.success === false`, otherwise undefined.
 */
function getScriptErrorReason(data: Record<string, unknown>): string | undefined {
	const sr = data._scriptResult as { success: boolean; reason?: string } | undefined;
	if (sr && !sr.success && sr.reason) return sr.reason;
	return undefined;
}

/**
 * Evaluate gate status from current gate data (field-based + script result).
 *
 * Simplified frontend evaluation:
 *   - Script result: if `_scriptResult.success === false` → blocked
 *   - Human approval gate (field 'approved' with human writers):
 *       data.approved === true  -> open
 *       data.approved === false -> blocked
 *       otherwise               -> waiting_human
 *   - All fields must pass their checks for the gate to be open.
 */
function evaluateGateStatus(gate: Gate, data: Record<string, unknown>): GateStatus {
	// Script-based gates: check _scriptResult before the empty-fields shortcut
	if (getScriptErrorReason(data) !== undefined) return 'blocked';
	if ((gate.fields ?? []).length === 0) return 'open';

	// Check for human approval field first
	if (isHumanApprovalGate(gate.fields ?? [])) {
		const val = data['approved'];
		if (val === true) {
			// Check remaining fields too
			const othersPassed = (gate.fields ?? []).every((f) => {
				if (f.name === 'approved') return true;
				return evalFieldStatus(f, data) === 'open';
			});
			return othersPassed ? 'open' : 'blocked';
		}
		if (val === false) return 'blocked';
		return 'waiting_human';
	}

	// All fields must pass
	for (const field of gate.fields ?? []) {
		const status = evalFieldStatus(field, data);
		if (status !== 'open') return status;
	}
	return 'open';
}

function evalFieldStatus(field: GateField, data: Record<string, unknown>): GateStatus {
	const check = field.check;
	if (check.op === 'count') {
		// Map count check
		const map = data[field.name];
		if (!map || typeof map !== 'object' || Array.isArray(map)) return 'blocked';
		const count = Object.values(map as Record<string, unknown>).filter(
			(v) => v === check.match
		).length;
		return count >= check.min ? 'open' : 'blocked';
	}
	// Scalar check
	const val = data[field.name];
	if (check.op === 'exists') return val !== undefined ? 'open' : 'blocked';
	if (check.op === '==') return val === check.value ? 'open' : 'blocked';
	if (check.op === '!=') return val !== check.value ? 'open' : 'blocked';
	return 'blocked';
}

// ============================================================================
// Layout
// ============================================================================

/**
 * Build a map from node name → node UUID.
 * Channels use node names for from/to, but layout uses UUIDs.
 */
function buildNameToIdMap(nodes: WorkflowNode[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const node of nodes) {
		if (node.name) map.set(node.name, node.id);
	}
	return map;
}

/**
 * Resolve a channel endpoint (name or UUID) to a node UUID.
 * Falls back to the original value if it's already a UUID.
 */
function resolveNodeId(ref: string, nameToId: Map<string, string>): string {
	return nameToId.get(ref) ?? ref;
}

/**
 * Compute node positions using a layered DAG layout.
 * Returns a map from node ID → {x, y, width, height}.
 */
function computeLayout(workflow: SpaceWorkflow): Map<string, NodeLayout> {
	const nodes = workflow.nodes;
	const startId = workflow.startNodeId;
	const channels = workflow.channels ?? [];

	if (nodes.length === 0) return new Map();

	const nameToId = buildNameToIdMap(nodes);

	// Build successor map from channels (resolving names to UUIDs)
	const successors = new Map<string, Set<string>>();
	for (const node of nodes) {
		successors.set(node.id, new Set());
	}
	for (const ch of channels) {
		const fromId = resolveNodeId(ch.from, nameToId);
		const targets = Array.isArray(ch.to) ? ch.to : [ch.to];
		for (const t of targets) {
			const toId = resolveNodeId(t, nameToId);
			if (successors.has(fromId) && successors.has(toId)) {
				successors.get(fromId)!.add(toId);
			}
		}
	}

	// BFS layer assignment from start node.
	// Workflows may contain cycles (for retry/review loops), so we only assign
	// the first discovered layer for each node instead of continually promoting
	// nodes deeper through the cycle.
	const layers = new Map<string, number>();
	const queue: string[] = [startId];
	layers.set(startId, 0);

	while (queue.length > 0) {
		const current = queue.shift()!;
		const currentLayer = layers.get(current) ?? 0;
		for (const next of successors.get(current) ?? []) {
			if (!layers.has(next)) {
				layers.set(next, currentLayer + 1);
				queue.push(next);
			}
		}
	}

	// Assign orphaned nodes to a final layer
	const maxLayer = Math.max(0, ...layers.values());
	for (const node of nodes) {
		if (!layers.has(node.id)) {
			layers.set(node.id, maxLayer + 1);
		}
	}

	// Group nodes by layer
	const byLayer = new Map<number, string[]>();
	for (const [nodeId, layer] of layers) {
		if (!byLayer.has(layer)) byLayer.set(layer, []);
		byLayer.get(layer)!.push(nodeId);
	}

	// Calculate canvas dimensions for centering
	const maxPerLayer = Math.max(...Array.from(byLayer.values()).map((n) => n.length));
	const totalWidth = maxPerLayer * (NODE_WIDTH + H_GAP) - H_GAP + CANVAS_PADDING * 2;

	const result = new Map<string, NodeLayout>();

	for (const [layer, nodeIds] of byLayer) {
		const y = START_Y + layer * (NODE_HEIGHT + V_GAP);
		const rowWidth = nodeIds.length * (NODE_WIDTH + H_GAP) - H_GAP;
		const rowStartX = (totalWidth - rowWidth) / 2;

		nodeIds.forEach((nodeId, i) => {
			result.set(nodeId, {
				id: nodeId,
				x: rowStartX + i * (NODE_WIDTH + H_GAP),
				y,
				width: NODE_WIDTH,
				height: NODE_HEIGHT,
			});
		});
	}

	return result;
}

// ============================================================================
// Bezier path helpers
// ============================================================================

interface BezierPoints {
	sx: number;
	sy: number;
	cp1x: number;
	cp1y: number;
	cp2x: number;
	cp2y: number;
	tx: number;
	ty: number;
	mx: number; // midpoint x for gate icon
	my: number; // midpoint y for gate icon
}

function computeChannelPath(fromLayout: NodeLayout, toLayout: NodeLayout): BezierPoints {
	// Source: bottom-center of from-node
	const sx = fromLayout.x + fromLayout.width / 2;
	const sy = fromLayout.y + fromLayout.height;

	// Target: top-center of to-node
	const tx = toLayout.x + toLayout.width / 2;
	const ty = toLayout.y;

	const dy = ty - sy;
	const cpOffset = Math.max(50, Math.abs(dy) * 0.5);
	const cp1x = sx;
	const cp1y = sy + cpOffset;
	const cp2x = tx;
	const cp2y = ty - cpOffset;

	// Approximate bezier midpoint (t=0.5)
	const t = 0.5;
	const mx =
		(1 - t) ** 3 * sx + 3 * (1 - t) ** 2 * t * cp1x + 3 * (1 - t) * t ** 2 * cp2x + t ** 3 * tx;
	const my =
		(1 - t) ** 3 * sy + 3 * (1 - t) ** 2 * t * cp1y + 3 * (1 - t) * t ** 2 * cp2y + t ** 3 * ty;

	return { sx, sy, cp1x, cp1y, cp2x, cp2y, tx, ty, mx, my };
}

function buildBezierD(pts: BezierPoints): string {
	return `M ${pts.sx} ${pts.sy} C ${pts.cp1x} ${pts.cp1y}, ${pts.cp2x} ${pts.cp2y}, ${pts.tx} ${pts.ty}`;
}

// ============================================================================
// Gate icon rendered at midpoint of a channel line
// ============================================================================

interface GateIconProps {
	x: number;
	y: number;
	status: GateStatus;
	isRuntimeMode: boolean;
	gateId?: string;
	onApprove?: () => void;
	onReject?: () => void;
	onViewArtifacts?: () => void;
	voteCount?: { current: number; min: number };
	/** Script error reason from `_scriptResult` in gate data. */
	scriptErrorReason?: string;
}

const GATE_ICON_R = 11; // radius

function GateIcon({
	x,
	y,
	status,
	isRuntimeMode,
	gateId,
	onApprove,
	onReject,
	onViewArtifacts,
	voteCount,
	scriptErrorReason,
}: GateIconProps): JSX.Element {
	const [showActions, setShowActions] = useState(false);

	// Dismiss the popup when the user clicks anywhere outside the gate icon
	useEffect(() => {
		if (!showActions) return;
		const dismiss = () => setShowActions(false);
		document.addEventListener('click', dismiss, { once: true });
		return () => document.removeEventListener('click', dismiss);
	}, [showActions]);

	let fill: string;
	let strokeColor: string;
	let icon: JSX.Element;
	let pulseClass = '';

	switch (status) {
		case 'open':
			fill = '#052e16';
			strokeColor = '#16a34a';
			icon = (
				// checkmark
				<path
					d="M -5 0 L -1.5 4 L 6 -4"
					stroke="#16a34a"
					strokeWidth={2}
					strokeLinecap="round"
					strokeLinejoin="round"
					fill="none"
				/>
			);
			break;
		case 'waiting_human':
			fill = '#431407';
			strokeColor = '#f59e0b';
			pulseClass = 'animate-pulse';
			icon = (
				// clock / hourglass
				<>
					<line
						x1={0}
						y1={-5}
						x2={0}
						y2={-1}
						stroke="#f59e0b"
						strokeWidth={1.5}
						strokeLinecap="round"
					/>
					<circle cx={0} cy={2} r={1.5} fill="#f59e0b" />
				</>
			);
			break;
		case 'blocked':
		default:
			fill = '#1c1917';
			strokeColor = '#6b7280';
			icon = (
				// lock body + shackle
				<>
					<rect
						x={-4}
						y={-1}
						width={8}
						height={6}
						rx={1}
						stroke="#6b7280"
						strokeWidth={1.5}
						fill="none"
					/>
					<path
						d="M -3 -1 L -3 -3.5 Q 0 -6.5 3 -3.5 L 3 -1"
						stroke="#6b7280"
						strokeWidth={1.5}
						fill="none"
						strokeLinecap="round"
					/>
				</>
			);
			break;
	}

	const handleClick = (e: MouseEvent) => {
		e.stopPropagation();
		if (isRuntimeMode && status === 'waiting_human') {
			setShowActions((v) => !v);
		}
	};

	return (
		<g
			data-testid={`gate-icon-${status}`}
			data-gate-id={gateId}
			style={{ cursor: isRuntimeMode && status === 'waiting_human' ? 'pointer' : 'default' }}
			onClick={handleClick}
		>
			<circle
				cx={x}
				cy={y}
				r={GATE_ICON_R}
				fill={fill}
				stroke={strokeColor}
				strokeWidth={1.5}
				class={pulseClass}
			/>
			<g transform={`translate(${x}, ${y})`}>{icon}</g>

			{voteCount !== undefined && isRuntimeMode && (
				<text
					x={x}
					y={y + GATE_ICON_R + 11}
					textAnchor="middle"
					dominantBaseline="middle"
					style={{ fontSize: '9px', fill: '#a8a29e', fontFamily: 'monospace' }}
					data-testid="gate-vote-count"
				>
					{voteCount.current}/{voteCount.min}
				</text>
			)}

			{/* Script failed indicator */}
			{scriptErrorReason && isRuntimeMode && (
				<foreignObject
					x={x - 55}
					y={y + GATE_ICON_R + (voteCount !== undefined ? 20 : 8)}
					width={110}
					height={16}
					data-testid="gate-script-error-badge"
				>
					<div
						style={{
							fontSize: '9px',
							color: '#ef4444',
							fontFamily: 'monospace',
							textAlign: 'center',
							whiteSpace: 'nowrap',
							overflow: 'hidden',
							textOverflow: 'ellipsis',
						}}
						title={scriptErrorReason}
					>
						{'⚠️ Script failed'}
					</div>
				</foreignObject>
			)}

			{showActions && isRuntimeMode && (
				<foreignObject x={x - 65} y={y + 14} width={130} height={onViewArtifacts ? 84 : 56}>
					<div
						style={{
							background: '#1c1917',
							border: '1px solid #44403c',
							borderRadius: 6,
							padding: '6px',
							display: 'flex',
							flexDirection: 'column',
							gap: '4px',
						}}
					>
						<div style={{ display: 'flex', gap: '4px' }}>
							<button
								class={cn(
									'flex-1 text-xs py-1 rounded font-medium',
									'bg-green-900/60 text-green-300 border border-green-700/50',
									'hover:bg-green-800/60'
								)}
								onClick={(e) => {
									e.stopPropagation();
									setShowActions(false);
									onApprove?.();
								}}
							>
								Approve
							</button>
							<button
								class={cn(
									'flex-1 text-xs py-1 rounded font-medium',
									'bg-red-900/60 text-red-300 border border-red-700/50',
									'hover:bg-red-800/60'
								)}
								onClick={(e) => {
									e.stopPropagation();
									setShowActions(false);
									onReject?.();
								}}
							>
								Reject
							</button>
						</div>
						{onViewArtifacts && (
							<button
								class={cn(
									'w-full text-xs py-1 rounded font-medium',
									'bg-stone-800/80 text-stone-300 border border-stone-700/50',
									'hover:bg-stone-700/80'
								)}
								onClick={(e) => {
									e.stopPropagation();
									setShowActions(false);
									onViewArtifacts();
								}}
								data-testid="view-artifacts-btn"
							>
								View Artifacts
							</button>
						)}
					</div>
				</foreignObject>
			)}
		</g>
	);
}

// ============================================================================
// Single workflow node box
// ============================================================================

interface NodeBoxProps {
	node: WorkflowNode;
	layout: NodeLayout;
	status: NodeStatus;
	tasks: SpaceTask[];
	isRuntimeMode: boolean;
}

function NodeBox({
	node,
	layout,
	status,
	tasks,
	isRuntimeMode: _isRuntimeMode,
}: NodeBoxProps): JSX.Element {
	const { x, y, width, height } = layout;

	let borderColor: string;
	let bgColor: string;
	let labelColor: string;
	let pulseClass = '';
	let statusIndicator: JSX.Element | null = null;

	switch (status) {
		case 'active':
			borderColor = '#3b82f6';
			bgColor = '#1e3a5f';
			labelColor = '#93c5fd';
			pulseClass = 'animate-pulse';
			statusIndicator = (
				<circle
					cx={x + width - 10}
					cy={y + 10}
					r={4}
					fill="#3b82f6"
					class="animate-ping"
					opacity={0.75}
				/>
			);
			break;
		case 'completed': {
			borderColor = '#16a34a';
			bgColor = '#052e16';
			labelColor = '#86efac';
			// Find most recent completed task for elapsed time
			const completedTasks = tasks.filter((t) => t.status === 'done' && t.updatedAt);
			const elapsed =
				completedTasks.length > 0
					? formatElapsed(
							completedTasks[completedTasks.length - 1].updatedAt,
							completedTasks[completedTasks.length - 1].createdAt
						)
					: null;
			statusIndicator = (
				<>
					<path
						d={`M ${x + width - 18} ${y + 8} L ${x + width - 13} ${y + 13} L ${x + width - 7} ${y + 6}`}
						stroke="#16a34a"
						strokeWidth={2}
						strokeLinecap="round"
						strokeLinejoin="round"
						fill="none"
					/>
					{elapsed && (
						<text
							x={x + width / 2}
							y={y + height - 6}
							textAnchor="middle"
							style={{ fontSize: '9px', fill: '#4ade80', fontFamily: 'monospace' }}
						>
							{elapsed}
						</text>
					)}
				</>
			);
			break;
		}
		case 'failed':
			borderColor = '#dc2626';
			bgColor = '#450a0a';
			labelColor = '#fca5a5';
			statusIndicator = (
				<>
					<line
						x1={x + width - 16}
						y1={y + 7}
						x2={x + width - 8}
						y2={y + 15}
						stroke="#dc2626"
						strokeWidth={2}
						strokeLinecap="round"
					/>
					<line
						x1={x + width - 8}
						y1={y + 7}
						x2={x + width - 16}
						y2={y + 15}
						stroke="#dc2626"
						strokeWidth={2}
						strokeLinecap="round"
					/>
				</>
			);
			break;
		case 'pending':
		default:
			borderColor = '#44403c';
			bgColor = '#1c1917';
			labelColor = '#a8a29e';
			break;
	}

	// Agent count badge
	const agentCount = node.agents.length;
	const agentLabel = agentCount > 1 ? `×${agentCount}` : null;

	return (
		<g data-testid={`node-${node.id}`} class={status === 'active' ? pulseClass : undefined}>
			{/* Shadow */}
			<rect x={x + 2} y={y + 2} width={width} height={height} rx={6} fill="rgba(0,0,0,0.4)" />
			{/* Main box */}
			<rect
				x={x}
				y={y}
				width={width}
				height={height}
				rx={6}
				fill={bgColor}
				stroke={borderColor}
				strokeWidth={status === 'active' ? 2 : 1.5}
			/>

			{/* Node name */}
			<text
				x={x + width / 2}
				y={y + height / 2 - (agentLabel ? 6 : 0)}
				textAnchor="middle"
				dominantBaseline="middle"
				style={{
					fontSize: '12px',
					fontWeight: '600',
					fill: labelColor,
					fontFamily: 'system-ui, sans-serif',
				}}
			>
				{truncate(node.name, 18)}
			</text>

			{agentLabel && (
				<text
					x={x + width / 2}
					y={y + height / 2 + 10}
					textAnchor="middle"
					style={{ fontSize: '10px', fill: '#78716c', fontFamily: 'system-ui' }}
				>
					{agentLabel} agents
				</text>
			)}

			{/* Status indicator (top-right corner) */}
			{statusIndicator}

			{/* Input port (top-center) */}
			<circle cx={x + width / 2} cy={y} r={3} fill={borderColor} stroke={bgColor} strokeWidth={1} />

			{/* Output port (bottom-center) */}
			<circle
				cx={x + width / 2}
				cy={y + height}
				r={3}
				fill={borderColor}
				stroke={bgColor}
				strokeWidth={1}
			/>
		</g>
	);
}

// ============================================================================
// Helper utilities
// ============================================================================

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen - 1) + '…';
}

function formatElapsed(endMs: number, startMs: number): string {
	const ms = endMs - startMs;
	if (ms < 1000) return `${ms}ms`;
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return rem > 0 ? `${m}m${rem}s` : `${m}m`;
}

// ============================================================================
// Determine node status from tasks
// ============================================================================

function getNodeStatus(
	nodeId: string,
	tasks: SpaceTask[],
	run: SpaceWorkflowRun | null
): NodeStatus {
	const nodeTasks = tasks.filter((t) => t.workflowRunId === nodeId);

	if (nodeTasks.length === 0) {
		return 'pending';
	}

	if (nodeTasks.some((t) => t.status === 'in_progress')) return 'active';

	if (
		nodeTasks.every(
			(t) => t.status === 'done' || t.status === 'cancelled' || t.status === 'archived'
		)
	) {
		// All terminal — check if they succeeded
		if (nodeTasks.some((t) => t.status === 'done')) return 'completed';
	}

	if (run?.status === 'blocked' || run?.status === 'cancelled') {
		if (nodeTasks.some((t) => t.status === 'blocked' || t.status === 'cancelled')) {
			return 'failed';
		}
	}

	return 'pending';
}

// ============================================================================
// Template-mode gate editor controls (add/remove gate on channel)
// ============================================================================

interface GateAddButtonProps {
	x: number;
	y: number;
	channelId: string;
	availableGates: Gate[];
	onAddGate: (channelId: string, gateId: string) => void;
}

function GateAddButton({
	x,
	y,
	channelId,
	availableGates,
	onAddGate,
}: GateAddButtonProps): JSX.Element {
	const [open, setOpen] = useState(false);

	if (availableGates.length === 0) return <g />;

	return (
		<g>
			<circle
				cx={x}
				cy={y}
				r={9}
				fill="#292524"
				stroke="#57534e"
				strokeWidth={1.5}
				style={{ cursor: 'pointer' }}
				onClick={(e) => {
					e.stopPropagation();
					setOpen((v) => !v);
				}}
				data-testid={`gate-add-btn-${channelId}`}
			/>
			<text
				x={x}
				y={y + 1}
				textAnchor="middle"
				dominantBaseline="middle"
				style={{ fontSize: '14px', fill: '#a8a29e', pointerEvents: 'none' }}
			>
				+
			</text>

			{open && (
				<foreignObject x={x - 70} y={y + 14} width={140} height={availableGates.length * 28 + 8}>
					<div
						style={{
							background: '#1c1917',
							border: '1px solid #44403c',
							borderRadius: 6,
							overflow: 'hidden',
						}}
					>
						{availableGates.map((gate) => (
							<div
								key={gate.id}
								style={{
									padding: '5px 10px',
									fontSize: '11px',
									color: '#d6d3d1',
									cursor: 'pointer',
									borderBottom: '1px solid #292524',
								}}
								onClick={(e) => {
									e.stopPropagation();
									setOpen(false);
									onAddGate(channelId, gate.id);
								}}
							>
								{gate.description ?? gate.id}
							</div>
						))}
					</div>
				</foreignObject>
			)}
		</g>
	);
}

// ============================================================================
// Main WorkflowCanvas
// ============================================================================

export interface WorkflowCanvasProps {
	/** ID of the workflow to render */
	workflowId: string;
	/**
	 * ID of the active workflow run.
	 * When provided → runtime mode (read-only, live status).
	 * When absent   → template mode (editable gates).
	 */
	runId?: string | null;
	/** Space ID for emitting gate approval events */
	spaceId: string;
	/** Optional additional class name */
	class?: string;
}

export function WorkflowCanvas({
	workflowId,
	runId,
	spaceId,
	class: className,
}: WorkflowCanvasProps): JSX.Element {
	const isRuntimeMode = !!runId;

	// ---- Data from store ----
	const workflow = useMemo(
		() => spaceStore.workflows.value.find((w) => w.id === workflowId) ?? null,
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[workflowId, spaceStore.workflows.value]
	);

	const run = useMemo(
		() => (runId ? (spaceStore.workflowRuns.value.find((r) => r.id === runId) ?? null) : null),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[runId, spaceStore.workflowRuns.value]
	);

	// All tasks for this run (via workflowRunId)
	const runTasks = useMemo(
		() => (runId ? (spaceStore.tasksByRun.value.get(runId) ?? []) : []),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[runId, spaceStore.tasksByRun.value]
	);

	// ---- Gate data state ----
	const [gateDataMap, setGateDataMap] = useState<Map<string, Record<string, unknown>>>(new Map());
	const [gateDataLoading, setGateDataLoading] = useState(false);

	// ---- Artifacts panel state (gateId of the panel open, null = closed) ----
	const [artifactsPanelGateId, setArtifactsPanelGateId] = useState<string | null>(null);

	// ---- Template-mode: local gate assignments (channelId → gateId) ----
	const [localGateAssignments, setLocalGateAssignments] = useState<Map<string, string>>(new Map());

	// Initialize local gate assignments from workflow definition
	useEffect(() => {
		if (!workflow) return;
		const map = new Map<string, string>();
		for (const ch of workflow.channels ?? []) {
			if (ch.id && ch.gateId) {
				map.set(ch.id, ch.gateId);
			}
		}
		setLocalGateAssignments(map);
	}, [workflow]);

	// ---- Fetch gate data for runtime mode ----
	const fetchGateData = useCallback(async () => {
		if (!runId) return;
		// Clear stale data immediately so old run's gate states don't flash on the new run's channels.
		setGateDataMap(new Map());
		setGateDataLoading(true);
		try {
			const hub = connectionManager.getHubIfConnected();
			if (!hub) return;
			const result = await hub.request<{ gateData: GateDataRecord[] }>(
				'spaceWorkflowRun.listGateData',
				{ runId }
			);
			const map = new Map<string, Record<string, unknown>>();
			for (const record of result.gateData) {
				map.set(record.gateId, record.data);
			}
			setGateDataMap(map);
		} catch {
			// non-fatal — gate data is optional display info
		} finally {
			setGateDataLoading(false);
		}
	}, [runId]);

	useEffect(() => {
		if (isRuntimeMode) {
			void fetchGateData();
		}
	}, [isRuntimeMode, fetchGateData]);

	// ---- Subscribe to gate data events ----
	useEffect(() => {
		if (!runId) return;

		const hub = connectionManager.getHubIfConnected();
		if (!hub) return;

		const unsub = hub.onEvent<{
			spaceId: string;
			runId: string;
			gateId: string;
			data: Record<string, unknown>;
		}>('space.gateData.updated', (event) => {
			if (event.spaceId === spaceId && event.runId === runId) {
				setGateDataMap((prev) => {
					const next = new Map(prev);
					next.set(event.gateId, event.data);
					return next;
				});
			}
		});

		return unsub;
	}, [runId, spaceId]);

	// Re-fetch gate data when run status changes (catches approveGate responses)
	const prevRunStatus = useRef<string | null>(null);
	useEffect(() => {
		const newStatus = run?.status ?? null;
		if (newStatus !== prevRunStatus.current) {
			prevRunStatus.current = newStatus;
			if (isRuntimeMode) {
				void fetchGateData();
			}
		}
	}, [run?.status, isRuntimeMode, fetchGateData]);

	// ---- Gate approval handler ----
	const handleApproveGate = useCallback(
		async (gateId: string, approved: boolean) => {
			if (!runId) return;
			try {
				const hub = connectionManager.getHubIfConnected();
				if (!hub) return;
				await hub.request('spaceWorkflowRun.approveGate', { runId, gateId, approved });
				void fetchGateData();
			} catch {
				// error handled by caller
			}
		},
		[runId, fetchGateData]
	);

	// ---- Template mode: add/remove gate on channel ----
	// TODO(M6.3): Persist template-mode gate assignments to the backend by calling
	// spaceWorkflow.update (or a dedicated channel-gate RPC) when add/remove fires.
	// Currently these changes are local-only and lost on unmount. Gate editing in
	// WorkflowEditor.tsx remains the canonical way to persist gate assignments.
	const handleAddGate = useCallback((channelId: string, gateId: string) => {
		setLocalGateAssignments((prev) => {
			const next = new Map(prev);
			next.set(channelId, gateId);
			return next;
		});
	}, []);

	// ---- Layout computation ----
	const layout = useMemo(
		() => (workflow ? computeLayout(workflow) : new Map<string, NodeLayout>()),
		[workflow]
	);

	// Canvas dimensions
	const { canvasWidth, canvasHeight } = useMemo(() => {
		if (layout.size === 0) return { canvasWidth: 400, canvasHeight: 300 };
		let maxX = 0;
		let maxY = 0;
		for (const l of layout.values()) {
			maxX = Math.max(maxX, l.x + l.width);
			maxY = Math.max(maxY, l.y + l.height);
		}
		return {
			canvasWidth: maxX + CANVAS_PADDING,
			canvasHeight: maxY + CANVAS_PADDING,
		};
	}, [layout]);

	// ---- Name-to-ID map for channel endpoint resolution ----
	const nameToId = useMemo(() => {
		if (!workflow) return new Map<string, string>();
		return buildNameToIdMap(workflow.nodes);
	}, [workflow]);

	// ---- Rendered channels ----
	const renderedChannels = useMemo((): RenderedChannel[] => {
		if (!workflow) return [];
		return (workflow.channels ?? [])
			.filter((ch) => ch.id)
			.flatMap((ch) => {
				const targets = Array.isArray(ch.to) ? ch.to : [ch.to];
				return targets.map((to) => ({
					id: ch.id!,
					fromId: resolveNodeId(ch.from, nameToId),
					toId: resolveNodeId(to, nameToId),
					gateId: isRuntimeMode ? ch.gateId : (localGateAssignments.get(ch.id!) ?? ch.gateId),
				}));
			});
	}, [workflow, isRuntimeMode, localGateAssignments, nameToId]);

	// ---- Gates by ID ----
	const gatesById = useMemo(() => {
		const map = new Map<string, Gate>();
		for (const gate of workflow?.gates ?? []) {
			map.set(gate.id, gate);
		}
		return map;
	}, [workflow]);

	// ---- Unassigned gates (for template mode add button) ----
	const unassignedGates = useMemo(() => {
		if (!workflow) return [];
		const usedGateIds = new Set(localGateAssignments.values());
		return (workflow.gates ?? []).filter((g) => !usedGateIds.has(g.id));
	}, [workflow, localGateAssignments]);

	// ---- Loading/empty states ----
	if (!workflow) {
		return (
			<div class={cn('flex items-center justify-center h-full text-stone-500 text-sm', className)}>
				Workflow not found
			</div>
		);
	}

	if (workflow.nodes.length === 0) {
		return (
			<div class={cn('flex items-center justify-center h-full text-stone-500 text-sm', className)}>
				No nodes in workflow
			</div>
		);
	}

	// ============================================================================
	// Render
	// ============================================================================

	const arrowMarkerId = `wc-arrow-${workflowId.slice(0, 8)}`;
	const arrowMarkerGatedId = `${arrowMarkerId}-gated`;

	return (
		<div
			class={cn('relative overflow-auto bg-stone-950', className)}
			data-testid="workflow-canvas"
			data-mode={isRuntimeMode ? 'runtime' : 'template'}
			data-workflow-id={workflowId}
		>
			{gateDataLoading && (
				<div class="absolute top-2 right-2 text-stone-500 text-xs">Loading gate data…</div>
			)}
			{run && run.status === 'blocked' && (
				<div class="absolute top-0 left-0 right-0 bg-amber-900/40 border-b border-amber-700/50 px-3 py-1.5 text-xs text-amber-300 text-center z-10">
					{run.failureReason === 'humanRejected'
						? 'Workflow paused — awaiting approval'
						: 'Workflow needs attention'}
				</div>
			)}

			<svg
				viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
				width={canvasWidth}
				height={canvasHeight}
				style={{ display: 'block', minWidth: canvasWidth, minHeight: canvasHeight }}
				data-testid="workflow-canvas-svg"
			>
				<defs>
					<marker
						id={arrowMarkerId}
						viewBox="0 0 10 10"
						refX="10"
						refY="5"
						markerWidth="6"
						markerHeight="6"
						orient="auto-start-reverse"
					>
						<path d="M 0 0 L 10 5 L 0 10 z" fill="#44403c" />
					</marker>
					<marker
						id={arrowMarkerGatedId}
						viewBox="0 0 10 10"
						refX="10"
						refY="5"
						markerWidth="6"
						markerHeight="6"
						orient="auto-start-reverse"
					>
						<path d="M 0 0 L 10 5 L 0 10 z" fill="#78716c" />
					</marker>
				</defs>

				{/* Channel lines */}
				{renderedChannels.map((ch) => {
					const fromLayout = layout.get(ch.fromId);
					const toLayout = layout.get(ch.toId);
					if (!fromLayout || !toLayout) return null;

					const pts = computeChannelPath(fromLayout, toLayout);
					const d = buildBezierD(pts);
					const hasGate = !!ch.gateId;

					const gate = ch.gateId ? gatesById.get(ch.gateId) : undefined;
					const gateData = ch.gateId ? (gateDataMap.get(ch.gateId) ?? {}) : {};
					const gateStatus: GateStatus = gate ? evaluateGateStatus(gate, gateData) : 'open';

					// Channel color based on gate status in runtime mode
					let strokeColor = '#44403c';
					let strokeDash: string | undefined;
					if (hasGate) {
						strokeColor = '#78716c';
					} else {
						strokeDash = '6 4';
					}
					if (isRuntimeMode && hasGate) {
						if (gateStatus === 'open') strokeColor = '#166534';
						else if (gateStatus === 'waiting_human') strokeColor = '#92400e';
						else strokeColor = '#44403c';
					}

					// Channels without gates are always available (plain arrows)
					const isHumanGate = gate ? isHumanApprovalGate(gate.fields ?? []) : false;
					const voteCount =
						gate && isRuntimeMode ? computeVoteCount(gate.fields ?? [], gateData) : undefined;

					// Script error reason from gate data (for display below the gate icon)
					const scriptErrorReason =
						gate && isRuntimeMode ? getScriptErrorReason(gateData) : undefined;

					return (
						<g key={`ch-${ch.id}-${ch.toId}`} data-testid={`channel-${ch.id}`}>
							{/* Invisible wider hitbox */}
							<path
								d={d}
								stroke="transparent"
								strokeWidth={12}
								fill="none"
								style={{ pointerEvents: 'stroke' }}
							/>
							{/* Visible path */}
							<path
								d={d}
								stroke={strokeColor}
								strokeWidth={1.5}
								strokeDasharray={strokeDash}
								strokeOpacity={0.85}
								fill="none"
								markerEnd={`url(#${hasGate ? arrowMarkerGatedId : arrowMarkerId})`}
							/>

							{/* Gate icon ON the channel line (at midpoint) */}
							{hasGate && gate && (
								<GateIcon
									x={pts.mx}
									y={pts.my}
									status={gateStatus}
									isRuntimeMode={isRuntimeMode}
									gateId={ch.gateId}
									voteCount={voteCount}
									scriptErrorReason={scriptErrorReason}
									onApprove={
										isHumanGate ? () => void handleApproveGate(ch.gateId!, true) : undefined
									}
									onReject={
										isHumanGate ? () => void handleApproveGate(ch.gateId!, false) : undefined
									}
									onViewArtifacts={
										isHumanGate && gateStatus === 'waiting_human'
											? () => setArtifactsPanelGateId(ch.gateId!)
											: undefined
									}
								/>
							)}

							{/* Template mode: "+" add gate button */}
							{!isRuntimeMode && !hasGate && (
								<GateAddButton
									x={pts.mx}
									y={pts.my}
									channelId={ch.id}
									availableGates={unassignedGates}
									onAddGate={handleAddGate}
								/>
							)}

							{/* Template mode: remove gate button */}
							{!isRuntimeMode && hasGate && (
								<g
									data-testid={`gate-remove-${ch.id}`}
									style={{ cursor: 'pointer' }}
									onClick={() => {
										setLocalGateAssignments((prev) => {
											const next = new Map(prev);
											next.delete(ch.id);
											return next;
										});
									}}
								>
									<circle
										cx={pts.mx + 14}
										cy={pts.my - 14}
										r={7}
										fill="#292524"
										stroke="#57534e"
										strokeWidth={1}
									/>
									<line
										x1={pts.mx + 10}
										y1={pts.my - 18}
										x2={pts.mx + 18}
										y2={pts.my - 10}
										stroke="#a8a29e"
										strokeWidth={1.5}
										strokeLinecap="round"
									/>
									<line
										x1={pts.mx + 18}
										y1={pts.my - 18}
										x2={pts.mx + 10}
										y2={pts.my - 10}
										stroke="#a8a29e"
										strokeWidth={1.5}
										strokeLinecap="round"
									/>
								</g>
							)}
						</g>
					);
				})}

				{/* Nodes */}
				{workflow.nodes.map((node) => {
					const nodeLayout = layout.get(node.id);
					if (!nodeLayout) return null;

					const nodeTasks = runTasks.filter((t) => t.workflowRunId === node.id);
					const status = isRuntimeMode ? getNodeStatus(node.id, runTasks, run) : 'pending';

					return (
						<NodeBox
							key={node.id}
							node={node}
							layout={nodeLayout}
							status={status}
							tasks={nodeTasks}
							isRuntimeMode={isRuntimeMode}
						/>
					);
				})}
			</svg>

			{/* Artifacts panel overlay (shown when a human gate requests it) */}
			{artifactsPanelGateId && runId && (
				<div
					class="absolute inset-0 bg-stone-950/95 z-20 flex flex-col"
					data-testid="artifacts-panel-overlay"
				>
					<GateArtifactsView
						runId={runId}
						gateId={artifactsPanelGateId}
						spaceId={spaceId}
						gateData={gateDataMap.get(artifactsPanelGateId)}
						onClose={() => setArtifactsPanelGateId(null)}
						onDecision={() => {
							setArtifactsPanelGateId(null);
							void fetchGateData();
						}}
						class="h-full"
					/>
				</div>
			)}
		</div>
	);
}
