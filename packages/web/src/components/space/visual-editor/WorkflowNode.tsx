/**
 * WorkflowNode Component
 *
 * Renders a single workflow step as an absolutely-positioned card on the canvas.
 * Shows step name, agent name, and step number badge.
 * Has input (top-center) and output (bottom-center) connection ports.
 * Start node gets a green border and hides its input port.
 */

import type { SpaceAgent } from '@neokai/shared';
import { cn } from '../../../lib/utils';
import type { StepDraft } from '../WorkflowStepCard';
import type { Point } from './types';

export type PortType = 'input' | 'output';

export interface WorkflowNodeProps {
	step: StepDraft;
	stepNumber: number;
	position: Point;
	agents: SpaceAgent[];
	isSelected: boolean;
	isStartNode: boolean;
	onPortMouseDown: (stepId: string, port: PortType) => void;
	onClick?: (stepId: string) => void;
	onMouseDown?: (stepId: string, e: MouseEvent) => void;
}

const NODE_WIDTH = 160;

export function WorkflowNode({
	step,
	stepNumber,
	position,
	agents,
	isSelected,
	isStartNode,
	onPortMouseDown,
	onClick,
	onMouseDown,
}: WorkflowNodeProps) {
	const agentName = agents.find((a) => a.id === step.agentId)?.name ?? step.agentId;

	return (
		<div
			class={cn(
				'absolute rounded-lg border bg-dark-850 shadow-lg select-none',
				isSelected
					? 'border-blue-500 ring-2 ring-blue-500'
					: isStartNode
						? 'border-green-500'
						: 'border-dark-600',
				'cursor-grab'
			)}
			style={{
				left: `${position.x}px`,
				top: `${position.y}px`,
				width: `${NODE_WIDTH}px`,
			}}
			onClick={() => onClick?.(step.localId)}
			onMouseDown={(e) => onMouseDown?.(step.localId, e as unknown as MouseEvent)}
		>
			{/* Input port — top-center, hidden for start node */}
			{!isStartNode && (
				<div
					class="absolute -top-2 left-1/2 -translate-x-1/2 w-3.5 h-3.5 rounded-full bg-dark-700 border-2 border-dark-400 hover:border-blue-400 hover:bg-blue-900 cursor-crosshair z-10"
					title="Input port"
					onMouseDown={(e) => {
						e.stopPropagation();
						onPortMouseDown(step.localId, 'input');
					}}
				/>
			)}

			{/* Card body */}
			<div class="px-3 py-2.5">
				{/* Header row: step badge + START badge */}
				<div class="flex items-center justify-between mb-1.5">
					<span class="w-5 h-5 flex items-center justify-center rounded-full bg-dark-700 text-xs font-semibold text-gray-400 flex-shrink-0">
						{stepNumber}
					</span>
					{isStartNode && <span class="text-xs font-bold text-green-400 tracking-wide">START</span>}
				</div>

				{/* Step name */}
				<p class="text-xs font-medium text-gray-200 truncate leading-tight">
					{step.name || 'Unnamed Step'}
				</p>

				{/* Agent name */}
				<p class="text-xs text-gray-500 truncate mt-0.5">{agentName || '—'}</p>
			</div>

			{/* Output port — bottom-center */}
			<div
				class="absolute -bottom-2 left-1/2 -translate-x-1/2 w-3.5 h-3.5 rounded-full bg-dark-700 border-2 border-dark-400 hover:border-blue-400 hover:bg-blue-900 cursor-crosshair z-10"
				title="Output port"
				onMouseDown={(e) => {
					e.stopPropagation();
					onPortMouseDown(step.localId, 'output');
				}}
			/>
		</div>
	);
}
