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
import type { SpaceAgent, WorkflowChannel } from '@neokai/shared';
import { TASK_AGENT_NODE_ID } from '@neokai/shared';
import type { NodeDraft, AgentTaskState } from '../WorkflowNodeCard';
import { isMultiAgentNode, isNodeFullyCompleted, AgentStatusIcon } from '../WorkflowNodeCard';
import type { Point } from './types';
import type { AnchorSide } from './semanticWorkflowGraph';

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
	/** Workflow-level channels (kept for canvas compatibility; not rendered inside node cards). */
	workflowChannels?: WorkflowChannel[];
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
	/**
	 * Runtime agent completion states for this node.
	 * When provided, per-agent status indicators are shown inside the node card.
	 */
	nodeTaskStates?: AgentTaskState[];
	/** Semantic edge anchor sides currently in use for this node. */
	activeAnchorSides?: AnchorSide[];
}

function renderDock(side: AnchorSide, visible: boolean, highlighted = false) {
	const commonStyle = {
		position: 'absolute' as const,
		width: 14,
		height: 14,
		borderRadius: '50%',
		border: `2px solid ${highlighted ? '#16a34a' : '#374151'}`,
		background: highlighted ? '#22c55e' : '#6b7280',
		zIndex: highlighted ? 10 : 5,
	};

	if (side === 'top') {
		return (
			<div
				data-testid="dock-top"
				style={{
					...commonStyle,
					top: -7,
					left: '50%',
					transform: highlighted ? 'translateX(-50%) scale(1.4)' : 'translateX(-50%)',
					transition: 'transform 0.1s, background 0.1s, opacity 0.15s',
				}}
				class={visible ? 'opacity-100' : 'opacity-0 transition-opacity group-hover:opacity-100'}
			/>
		);
	}

	if (side === 'bottom') {
		return (
			<div
				data-testid="dock-bottom"
				style={{
					...commonStyle,
					bottom: -7,
					left: '50%',
					transform: 'translateX(-50%)',
					transition: 'opacity 0.15s',
				}}
				class={visible ? 'opacity-100' : 'opacity-0 transition-opacity group-hover:opacity-100'}
			/>
		);
	}

	if (side === 'left') {
		return (
			<div
				data-testid="dock-left"
				style={{
					...commonStyle,
					left: -7,
					top: '50%',
					transform: 'translateY(-50%)',
				}}
				class={visible ? 'opacity-100' : 'opacity-0'}
			/>
		);
	}

	return (
		<div
			data-testid="dock-right"
			style={{
				...commonStyle,
				right: -7,
				top: '50%',
				transform: 'translateY(-50%)',
			}}
			class={visible ? 'opacity-100' : 'opacity-0'}
		/>
	);
}

// ============================================================================
// Component
// ============================================================================

export function WorkflowNode({
	stepIndex,
	step,
	position,
	agents,
	workflowChannels: _workflowChannels = [],
	isSelected = false,
	isStartNode = false,
	isDropTarget = false,
	scale,
	onPositionChange,
	onPortMouseDown,
	onPortMouseEnter,
	onPortMouseLeave,
	onClick,
	nodeTaskStates,
	activeAnchorSides = [],
}: WorkflowNodeProps) {
	const stepId = step.localId;
	const isTaskAgent = stepId === TASK_AGENT_NODE_ID;

	const multi = isMultiAgentNode(step);
	const agentName = agents.find((a) => a.id === step.agentId)?.name ?? step.agentId;

	// Build a lookup: agentName → AgentTaskState
	const taskStateByAgent = new Map<string | null, AgentTaskState>(
		(nodeTaskStates ?? []).map((s) => [s.agentName, s])
	);
	const allDone = isNodeFullyCompleted(nodeTaskStates ?? []);

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
	// For the Task Agent node, dragState.current is never set (handleMouseDown
	// returns early), so both handlers short-circuit immediately — they are no-ops.
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
				// Only reset to 'grab' for draggable nodes — Task Agent uses 'default'
				// and dragState.current can never be set for it, so this branch is
				// unreachable for Task Agent. Guard here for defence-in-depth.
				if (!isTaskAgent) {
					nodeRef.current.style.cursor = 'grab';
				}
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

	// ---- Card body mousedown — starts drag (disabled for Task Agent) ----
	const handleMouseDown = useCallback(
		(e: MouseEvent) => {
			// Task Agent is pinned — it cannot be dragged
			if (isTaskAgent) {
				e.stopPropagation();
				return;
			}
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
		[isTaskAgent, position.x, position.y]
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
	const borderClass = isTaskAgent
		? 'border-amber-400'
		: isStartNode
			? 'border-green-500'
			: isSelected
				? 'border-blue-500'
				: allDone
					? 'border-green-600'
					: 'border-gray-700';

	const bgClass = isTaskAgent ? 'bg-amber-950' : 'bg-gray-800';

	const inputPortBg = isDropTarget ? '#22c55e' : '#6b7280';
	const inputPortBorder = isDropTarget ? '#16a34a' : '#374151';
	const inputPortScale = isDropTarget ? 'scale(1.4)' : '';

	const ringClass = isSelected ? 'ring-2 ring-blue-500' : '';
	const activeAnchorSideSet = new Set(activeAnchorSides);

	// Task Agent: render a visually distinct pinned node with no ports
	if (isTaskAgent) {
		return (
			<div
				ref={nodeRef}
				data-testid={`workflow-node-${stepId}`}
				data-step-id={stepId}
				data-task-agent="true"
				data-pan-canvas="true"
				style={{
					position: 'absolute',
					left: position.x,
					top: position.y,
					minWidth: 160,
					cursor: 'grab',
					userSelect: 'none',
					zIndex: 10,
				}}
				class={`rounded-lg border-2 ${bgClass} ${borderClass}`}
				onMouseDown={handleMouseDown}
			>
				<div class="px-3 py-2">
					{/* Header row: Task Agent badge */}
					<div class="flex items-center justify-between mb-1">
						<span
							data-testid="task-agent-badge"
							class="text-xs font-bold text-amber-400 uppercase tracking-wider"
						>
							Task Agent
						</span>
					</div>
					{/* Name */}
					<p
						data-testid="step-name"
						class="text-sm font-medium text-amber-100 truncate"
						style={{ maxWidth: 180 }}
					>
						{step.name || 'Task Agent'}
					</p>
				</div>
			</div>
		);
	}

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
			class={`group rounded-lg border-2 ${bgClass} ${borderClass} ${ringClass}`}
			onMouseDown={handleMouseDown}
			onClick={handleClick}
		>
			{activeAnchorSideSet.has('left') && renderDock('left', true)}
			{activeAnchorSideSet.has('right') && renderDock('right', true)}

			{/* Top port */}
			{(!isStartNode || activeAnchorSideSet.has('top')) && (
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
						transition: 'transform 0.1s, background 0.1s, opacity 0.15s',
						zIndex: isDropTarget ? 10 : 6,
					}}
					class={
						isDropTarget || activeAnchorSideSet.has('top')
							? 'opacity-100'
							: 'opacity-0 transition-opacity group-hover:opacity-100'
					}
					onMouseDown={!isStartNode ? handleInputPortMouseDown : undefined}
					onMouseEnter={!isStartNode ? handleInputPortMouseEnter : undefined}
					onMouseLeave={!isStartNode ? handleInputPortMouseLeave : undefined}
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
							const taskState = taskStateByAgent.get(sa.name);
							return (
								<span
									key={sa.name}
									class={`text-xs rounded px-1.5 py-0.5 flex items-center gap-0.5 ${hasOverrides ? 'bg-amber-900/40 text-amber-300' : 'bg-gray-700 text-gray-300'}`}
									title={hasOverrides ? `${sa.name} (has overrides)` : sa.name}
								>
									{sa.name}
									{hasOverrides && !taskState && (
										<span
											data-testid="override-indicator"
											class="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0"
										/>
									)}
									{taskState && <AgentStatusIcon state={taskState} />}
								</span>
							);
						})}
					</div>
				) : (
					<div
						data-testid="agent-name"
						class="flex items-center gap-1 text-xs text-gray-400 truncate mt-0.5"
					>
						<span class="truncate">{agentName}</span>
						{taskStateByAgent.get(null) && <AgentStatusIcon state={taskStateByAgent.get(null)!} />}
					</div>
				)}
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
					zIndex: 6,
				}}
				class={
					activeAnchorSideSet.has('bottom')
						? 'opacity-100'
						: 'opacity-0 transition-opacity group-hover:opacity-100'
				}
				onMouseDown={handleOutputPortMouseDown}
				onClick={stopClickPropagation}
			/>
		</div>
	);
}
