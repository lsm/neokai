/**
 * WorkflowNode
 *
 * Renders a single workflow step as a positioned node on the canvas.
 * The node is positioned absolutely within the canvas transform layer
 * using canvas-space coordinates.
 *
 * Visual indicator: a ring/border highlight shows when `isSelected` is true.
 */

import type { JSX } from 'preact';

export interface WorkflowNodeProps {
	/** Stable identifier for this workflow step. */
	stepId: string;
	/** Human-readable label rendered inside the node. */
	name: string;
	/** Canvas-space X position (pixels, left edge). */
	x: number;
	/** Canvas-space Y position (pixels, top edge). */
	y: number;
	/** Node width in canvas-space pixels. Defaults to 160. */
	width?: number;
	/** Node height in canvas-space pixels. Defaults to 60. */
	height?: number;
	/** Whether this node is currently selected. */
	isSelected: boolean;
	/** Called when the node is clicked. */
	onSelect: (stepId: string) => void;
}

export function WorkflowNode({
	stepId,
	name,
	x,
	y,
	width = 160,
	height = 60,
	isSelected,
	onSelect,
}: WorkflowNodeProps): JSX.Element {
	function handleClick(e: MouseEvent) {
		e.stopPropagation();
		onSelect(stepId);
	}

	return (
		<div
			data-testid={`workflow-node-${stepId}`}
			data-node-id={stepId}
			style={{
				position: 'absolute',
				left: `${x}px`,
				top: `${y}px`,
				width: `${width}px`,
				height: `${height}px`,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				background: 'var(--color-surface, #fff)',
				borderRadius: '8px',
				border: isSelected
					? '2px solid var(--color-primary, #6366f1)'
					: '2px solid var(--color-border, #e2e8f0)',
				boxShadow: isSelected
					? '0 0 0 3px var(--color-primary-faint, rgba(99,102,241,0.2))'
					: '0 1px 3px rgba(0,0,0,0.1)',
				cursor: 'pointer',
				userSelect: 'none',
				boxSizing: 'border-box',
			}}
			class={`workflow-node${isSelected ? ' workflow-node--selected' : ''}`}
			onClick={handleClick}
		>
			<span
				style={{
					fontSize: '13px',
					fontWeight: 500,
					overflow: 'hidden',
					textOverflow: 'ellipsis',
					whiteSpace: 'nowrap',
					padding: '0 12px',
				}}
			>
				{name}
			</span>
		</div>
	);
}
