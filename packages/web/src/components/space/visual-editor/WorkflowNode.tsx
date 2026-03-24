/**
 * WorkflowNode
 *
 * Renders a single workflow step as a draggable card on the visual canvas.
 *
 * Features:
 * - Card shows step number badge, step name, and assigned agent name
 * - Start node gets a green border and "START" badge
 * - Input port (top-center, hidden on start node) and output port (bottom-center)
 *   for future connection creation
 * - Draggable: mousedown on card body starts drag; delta is converted from
 *   screen-space to canvas-space using the current viewport scale
 * - Emits onPositionChange(stepId, newPosition) to parent on every move
 * - stopPropagation on port mousedown prevents drag from starting on port clicks
 */

import { useEffect, useCallback, useRef } from 'preact/hooks';
import type { SpaceAgent } from '@neokai/shared';
import type { NodeDraft } from '../WorkflowNodeCard';
import { isMultiAgentNode } from '../WorkflowNodeCard';
import type { Point } from './types';

// ============================================================================
// Channel topology visualization helpers
// ============================================================================

/** Renders a compact text representation of channel topology. */
function ChannelTopologyBadge({ step }: { step: NodeDraft }) {
	const channels = step.channels;
	if (!channels || channels.length === 0) return null;

	/** Truncate a role string for compact display. Channels already use role strings as identifiers. */
	const roleLabel = (role: string) => (role.length > 8 ? role.slice(0, 8) + '…' : role);

	const formatTo = (to: string | string[]) => {
		if (Array.isArray(to)) return `[${to.map(roleLabel).join(',')}]`;
		return roleLabel(to);
	};

	return (
		<div class="mt-1.5 space-y-0.5" data-testid="channel-topology-badge">
			{channels.map((ch, i) => (
				<div key={i} class="flex items-center gap-0.5 text-xs text-gray-500">
					<span class="font-mono">{roleLabel(ch.from)}</span>
					<span class="text-gray-600">{ch.direction === 'bidirectional' ? '↔' : '→'}</span>
					<span class="font-mono">{formatTo(ch.to)}</span>
					{ch.label && <span class="text-gray-700 ml-0.5">"{ch.label}"</span>}
				</div>
			))}
		</div>
	);
}

// ============================================================================
// Props
// ============================================================================

export type PortType = 'input' | 'output';

export interface WorkflowNodeProps {
	/** Zero-based index within the steps array; used for step number badge */
	stepIndex: number;
	step: NodeDraft;
	/** Absolute position in canvas coordinates */
	position: Point;
	/** Full agents list — used to resolve the agent name from step.agentId */
	agents: SpaceAgent[];
	isSelected?: boolean;
	/** First step in the workflow — hides input port, adds green border + START badge */
	isStartNode?: boolean;
	/** Current viewport scale — used to convert screen-space drag deltas to canvas-space */
	scale: number;
	/** Called continuously while the node is being dragged */
	onPositionChange: (stepId: string, newPosition: Point) => void;
	/** Called when a connection port is pressed */
	onPortMouseDown?: (stepId: string, portType: PortType, e: MouseEvent, portEl: Element) => void;
	/** Called when the mouse enters a port during a connection drag */
	onPortMouseEnter?: (stepId: string, portType: PortType) => void;
	/** Called when the mouse leaves a port during a connection drag */
	onPortMouseLeave?: (stepId: string, portType: PortType) => void;
	/** Highlight the input port as a valid drop target (during connection drag) */
	isDropTarget?: boolean;
	/** Called when the card body is clicked (for selection) */
	onClick?: (stepId: string) => void;
}

// ============================================================================
// Component
// ============================================================================

export function WorkflowNode({
	stepIndex,
	step,
	position,
	agents,
	isSelected = false,
	isStartNode = false,
	isDropTarget = false,
	scale,
	onPositionChange,
	onPortMouseDown,
	onPortMouseEnter,
	onPortMouseLeave,
	onClick,
}: WorkflowNodeProps) {
	const stepId = step.localId;

	const multi = isMultiAgentNode(step);
	const agentName = agents.find((a) => a.id === step.agentId)?.name ?? step.agentId;

	// ---- Drag state ----
	const dragState = useRef<{
		startX: number;
		startY: number;
		origX: number;
		origY: number;
	} | null>(null);

	// Track whether a meaningful drag has occurred (to suppress post-drag click)
	const hasDraggedRef = useRef(false);
	const DRAG_THRESHOLD = 3; // px

	// Keep refs to the latest values so window handlers don't close over stale data
	const scaleRef = useRef(scale);
	scaleRef.current = scale;

	const onPositionChangeRef = useRef(onPositionChange);
	onPositionChangeRef.current = onPositionChange;

	const nodeRef = useRef<HTMLDivElement>(null);

	// ---- Window-level listeners (always registered, guard on dragState) ----
	// Mirrors the pattern used by VisualCanvas for its spacebar+drag pan.
	useEffect(() => {
		const onMouseMove = (e: MouseEvent) => {
			if (!dragState.current) return;
			const dx = e.clientX - dragState.current.startX;
			const dy = e.clientY - dragState.current.startY;

			// Only start tracking drag after threshold
			if (Math.abs(dx) <= DRAG_THRESHOLD && Math.abs(dy) <= DRAG_THRESHOLD) return;

			hasDraggedRef.current = true;

			// Convert screen-space delta to canvas-space (guard against scale=0)
			const safeScale = Math.max(scaleRef.current, 0.01);
			const canvasDx = dx / safeScale;
			const canvasDy = dy / safeScale;
			onPositionChangeRef.current(stepId, {
				x: dragState.current.origX + canvasDx,
				y: dragState.current.origY + canvasDy,
			});
		};

		const onMouseUp = () => {
			if (!dragState.current) return;
			dragState.current = null;
			if (nodeRef.current) {
				nodeRef.current.style.cursor = 'grab';
				nodeRef.current.style.boxShadow = '';
			}
		};

		window.addEventListener('mousemove', onMouseMove);
		window.addEventListener('mouseup', onMouseUp);
		return () => {
			window.removeEventListener('mousemove', onMouseMove);
			window.removeEventListener('mouseup', onMouseUp);
		};
	}, [stepId]);

	// ---- Card body mousedown — starts drag ----
	const handleMouseDown = useCallback(
		(e: MouseEvent) => {
			// Only primary button
			if (e.button !== 0) return;
			e.stopPropagation(); // prevent canvas pan from triggering
			e.preventDefault();

			hasDraggedRef.current = false; // reset for this interaction

			dragState.current = {
				startX: e.clientX,
				startY: e.clientY,
				origX: position.x,
				origY: position.y,
			};

			if (nodeRef.current) {
				nodeRef.current.style.cursor = 'grabbing';
				nodeRef.current.style.boxShadow = '0 8px 24px rgba(0,0,0,0.4)';
			}
		},
		[position.x, position.y]
	);

	// ---- Card click — for selection (suppressed after drag) ----
	const handleClick = useCallback(
		(e: MouseEvent) => {
			e.stopPropagation();
			if (hasDraggedRef.current) return; // don't fire selection after drag
			onClick?.(stepId);
		},
		[onClick, stepId]
	);

	// ---- Port handlers ----
	const handleInputPortMouseDown = useCallback(
		(e: MouseEvent) => {
			e.stopPropagation(); // prevent card drag from starting
			onPortMouseDown?.(stepId, 'input', e, e.currentTarget as Element);
		},
		[onPortMouseDown, stepId]
	);

	const handleOutputPortMouseDown = useCallback(
		(e: MouseEvent) => {
			e.stopPropagation(); // prevent card drag from starting
			onPortMouseDown?.(stepId, 'output', e, e.currentTarget as Element);
		},
		[onPortMouseDown, stepId]
	);

	// Prevent clicks on ports from bubbling to the card and triggering node selection
	const stopClickPropagation = useCallback((e: MouseEvent) => {
		e.stopPropagation();
	}, []);

	const handleInputPortMouseEnter = useCallback(() => {
		onPortMouseEnter?.(stepId, 'input');
	}, [onPortMouseEnter, stepId]);

	const handleInputPortMouseLeave = useCallback(() => {
		onPortMouseLeave?.(stepId, 'input');
	}, [onPortMouseLeave, stepId]);

	// ---- Styles ----
	const borderClass = isStartNode
		? 'border-green-500'
		: isSelected
			? 'border-blue-500'
			: 'border-gray-700';

	const inputPortBg = isDropTarget ? '#22c55e' : '#6b7280';
	const inputPortBorder = isDropTarget ? '#16a34a' : '#374151';
	const inputPortScale = isDropTarget ? 'scale(1.4)' : '';

	const ringClass = isSelected ? 'ring-2 ring-blue-500' : '';

	return (
		<div
			ref={nodeRef}
			data-testid={`workflow-node-${stepId}`}
			data-step-id={stepId}
			style={{
				position: 'absolute',
				left: position.x,
				top: position.y,
				minWidth: multi ? 200 : 160,
				cursor: 'grab',
				userSelect: 'none',
			}}
			class={`rounded-lg border-2 bg-gray-800 ${borderClass} ${ringClass}`}
			onMouseDown={handleMouseDown}
			onClick={handleClick}
		>
			{/* Top port */}
			{!isStartNode && (
				<div
					data-testid="port-input"
					style={{
						position: 'absolute',
						top: -7,
						left: '50%',
						transform: `translateX(-50%) ${inputPortScale}`,
						width: 14,
						height: 14,
						borderRadius: '50%',
						background: inputPortBg,
						border: `2px solid ${inputPortBorder}`,
						cursor: 'crosshair',
						transition: 'transform 0.1s, background 0.1s',
						zIndex: isDropTarget ? 10 : undefined,
					}}
					onMouseDown={handleInputPortMouseDown}
					onMouseEnter={handleInputPortMouseEnter}
					onMouseLeave={handleInputPortMouseLeave}
					onClick={stopClickPropagation}
				/>
			)}

			{/* Card content */}
			<div class="px-3 py-2">
				{/* Header row: step badge + optional START badge */}
				<div class="flex items-center justify-between mb-1">
					<span
						data-testid="step-badge"
						class="text-xs font-mono bg-gray-700 text-gray-300 rounded px-1.5 py-0.5"
					>
						{stepIndex + 1}
					</span>
					{isStartNode && (
						<span
							data-testid="start-badge"
							class="text-xs font-bold text-green-400 uppercase tracking-wider"
						>
							START
						</span>
					)}
				</div>

				{/* Step name */}
				<p
					data-testid="step-name"
					class="text-sm font-medium text-white truncate"
					style={{ maxWidth: 180 }}
				>
					{step.name || '(unnamed)'}
				</p>

				{/* Agent(s) */}
				{multi ? (
					<div data-testid="agent-badges" class="flex flex-wrap gap-1 mt-1">
						{step.agents!.map((sa) => {
							const hasOverrides = !!(sa.model || sa.systemPrompt);
							return (
								<span
									key={sa.role}
									class={`text-xs rounded px-1.5 py-0.5 flex items-center gap-0.5 ${hasOverrides ? 'bg-amber-900/40 text-amber-300' : 'bg-gray-700 text-gray-300'}`}
									title={hasOverrides ? `${sa.role} (has overrides)` : sa.role}
								>
									{sa.role}
									{hasOverrides && (
										<span
											data-testid="override-indicator"
											class="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0"
										/>
									)}
								</span>
							);
						})}
					</div>
				) : (
					<p data-testid="agent-name" class="text-xs text-gray-400 truncate mt-0.5">
						{agentName}
					</p>
				)}

				{/* Channel topology */}
				<ChannelTopologyBadge step={step} />
			</div>

			{/* Bottom port */}
			<div
				data-testid="port-output"
				style={{
					position: 'absolute',
					bottom: -7,
					left: '50%',
					transform: 'translateX(-50%)',
					width: 14,
					height: 14,
					borderRadius: '50%',
					background: '#6b7280',
					border: '2px solid #374151',
					cursor: 'crosshair',
				}}
				onMouseDown={handleOutputPortMouseDown}
				onClick={stopClickPropagation}
			/>
		</div>
	);
}
