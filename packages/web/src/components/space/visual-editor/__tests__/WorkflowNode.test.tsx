/**
 * Unit tests for WorkflowNode
 *
 * Tests:
 * - Renders step name and agent name
 * - Shows step number badge
 * - Applies selected styles (ring-2, ring-blue-500)
 * - Renders input and output ports
 * - Start node hides input port and shows START badge + green border
 * - Port mousedown emits onPortMouseDown with correct args
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import type { SpaceAgent } from '@neokai/shared';
import { WorkflowNode } from '../WorkflowNode';
import type { WorkflowNodeProps } from '../WorkflowNode';
import type { StepDraft } from '../../WorkflowStepCard';

vi.mock('../../../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

function makeAgent(id: string, name: string, role = 'coder'): SpaceAgent {
	return {
		id,
		spaceId: 'space-1',
		name,
		role,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function makeStep(overrides: Partial<StepDraft> = {}): StepDraft {
	return {
		localId: 'step-1',
		name: 'My Step',
		agentId: 'agent-1',
		instructions: '',
		...overrides,
	};
}

const defaultAgents: SpaceAgent[] = [
	makeAgent('agent-1', 'planner', 'planner'),
	makeAgent('agent-2', 'coder', 'coder'),
];

function makeProps(overrides: Partial<WorkflowNodeProps> = {}): WorkflowNodeProps {
	return {
		step: makeStep(),
		stepNumber: 1,
		position: { x: 100, y: 200 },
		agents: defaultAgents,
		isSelected: false,
		isStartNode: false,
		onPortMouseDown: vi.fn(),
		...overrides,
	};
}

describe('WorkflowNode', () => {
	afterEach(() => {
		cleanup();
	});

	it('renders step name', () => {
		const { getByText } = render(<WorkflowNode {...makeProps()} />);
		expect(getByText('My Step')).toBeTruthy();
	});

	it('renders agent name resolved from agents list', () => {
		const { getByText } = render(<WorkflowNode {...makeProps()} />);
		expect(getByText('planner')).toBeTruthy();
	});

	it('falls back to agentId when agent not found', () => {
		const step = makeStep({ agentId: 'unknown-agent' });
		const { getByText } = render(<WorkflowNode {...makeProps({ step })} />);
		expect(getByText('unknown-agent')).toBeTruthy();
	});

	it('renders step number badge', () => {
		const { getByText } = render(<WorkflowNode {...makeProps({ stepNumber: 3 })} />);
		expect(getByText('3')).toBeTruthy();
	});

	it('shows "Unnamed Step" when name is empty', () => {
		const step = makeStep({ name: '' });
		const { getByText } = render(<WorkflowNode {...makeProps({ step })} />);
		expect(getByText('Unnamed Step')).toBeTruthy();
	});

	it('positions card via inline styles', () => {
		const { container } = render(<WorkflowNode {...makeProps({ position: { x: 150, y: 300 } })} />);
		const card = container.firstChild as HTMLElement;
		expect(card.style.left).toBe('150px');
		expect(card.style.top).toBe('300px');
	});

	describe('selection state', () => {
		it('applies selection ring classes when isSelected is true', () => {
			const { container } = render(<WorkflowNode {...makeProps({ isSelected: true })} />);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('ring-2');
			expect(card.className).toContain('ring-blue-500');
			expect(card.className).toContain('border-blue-500');
		});

		it('does not apply selection ring when isSelected is false', () => {
			const { container } = render(<WorkflowNode {...makeProps({ isSelected: false })} />);
			const card = container.firstChild as HTMLElement;
			expect(card.className).not.toContain('ring-2');
		});
	});

	describe('start node', () => {
		it('shows START badge when isStartNode is true', () => {
			const { getByText } = render(<WorkflowNode {...makeProps({ isStartNode: true })} />);
			expect(getByText('START')).toBeTruthy();
		});

		it('does not show START badge for non-start nodes', () => {
			const { container } = render(<WorkflowNode {...makeProps({ isStartNode: false })} />);
			const text = container.textContent ?? '';
			expect(text).not.toContain('START');
		});

		it('applies green border when isStartNode is true', () => {
			const { container } = render(<WorkflowNode {...makeProps({ isStartNode: true })} />);
			const card = container.firstChild as HTMLElement;
			expect(card.className).toContain('border-green-500');
		});

		it('hides input port when isStartNode is true', () => {
			const { queryByTitle } = render(<WorkflowNode {...makeProps({ isStartNode: true })} />);
			expect(queryByTitle('Input port')).toBeNull();
		});

		it('shows input port when isStartNode is false', () => {
			const { getByTitle } = render(<WorkflowNode {...makeProps({ isStartNode: false })} />);
			expect(getByTitle('Input port')).toBeTruthy();
		});
	});

	describe('ports', () => {
		it('renders output port', () => {
			const { getByTitle } = render(<WorkflowNode {...makeProps()} />);
			expect(getByTitle('Output port')).toBeTruthy();
		});

		it('calls onPortMouseDown with stepId and "input" when input port is clicked', () => {
			const onPortMouseDown = vi.fn();
			const step = makeStep({ localId: 'step-abc' });
			const { getByTitle } = render(
				<WorkflowNode {...makeProps({ step, onPortMouseDown, isStartNode: false })} />
			);
			fireEvent.mouseDown(getByTitle('Input port'));
			expect(onPortMouseDown).toHaveBeenCalledWith('step-abc', 'input');
		});

		it('calls onPortMouseDown with stepId and "output" when output port is clicked', () => {
			const onPortMouseDown = vi.fn();
			const step = makeStep({ localId: 'step-xyz' });
			const { getByTitle } = render(<WorkflowNode {...makeProps({ step, onPortMouseDown })} />);
			fireEvent.mouseDown(getByTitle('Output port'));
			expect(onPortMouseDown).toHaveBeenCalledWith('step-xyz', 'output');
		});
	});

	describe('event handlers', () => {
		it('calls onClick with stepId when card is clicked', () => {
			const onClick = vi.fn();
			const step = makeStep({ localId: 'step-click' });
			const { container } = render(<WorkflowNode {...makeProps({ step, onClick })} />);
			fireEvent.click(container.firstChild as HTMLElement);
			expect(onClick).toHaveBeenCalledWith('step-click');
		});

		it('calls onMouseDown with stepId when card mousedown fires', () => {
			const onMouseDown = vi.fn();
			const step = makeStep({ localId: 'step-md' });
			const { container } = render(<WorkflowNode {...makeProps({ step, onMouseDown })} />);
			fireEvent.mouseDown(container.firstChild as HTMLElement);
			expect(onMouseDown).toHaveBeenCalledWith('step-md', expect.anything());
		});
	});
});
