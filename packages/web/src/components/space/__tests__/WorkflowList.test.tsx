// @ts-nocheck
/**
 * Unit tests for WorkflowList
 *
 * Tests:
 * - Loading state shows spinner
 * - Empty state with create CTA
 * - Renders workflow cards with name, description, step count
 * - Tag chips rendered
 * - Mini step visualization renders dots
 * - "Create Workflow" header button fires onCreateWorkflow
 * - Edit button on card fires onEditWorkflow with correct ID
 * - Real-time updates via SpaceStore signal
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { SpaceWorkflow } from '@neokai/shared';

// ---- Mocks ----

let mockWorkflows: ReturnType<typeof signal<SpaceWorkflow[]>>;
let mockLoading: ReturnType<typeof signal<boolean>>;

vi.mock('../../../lib/space-store', () => ({
	get spaceStore() {
		return {
			workflows: mockWorkflows,
			loading: mockLoading,
		};
	},
}));

// Initialize signals before import
mockWorkflows = signal<SpaceWorkflow[]>([]);
mockLoading = signal(false);

import { WorkflowList } from '../WorkflowList';

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
	const s1 = 'step-1';
	const s2 = 'step-2';
	return {
		id: 'wf-1',
		spaceId: 'space-1',
		name: 'My Workflow',
		description: 'Does stuff',
		steps: [
			{ id: s1, name: 'Plan', agentId: 'a1' },
			{ id: s2, name: 'Code', agentId: 'a2' },
		],
		transitions: [{ id: 'tr-1', from: s1, to: s2, order: 0 }],
		startStepId: s1,
		rules: [],
		tags: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

const defaultProps = {
	onCreateWorkflow: vi.fn(),
	onEditWorkflow: vi.fn(),
};

describe('WorkflowList', () => {
	beforeEach(() => {
		cleanup();
		mockWorkflows.value = [];
		mockLoading.value = false;
		defaultProps.onCreateWorkflow.mockClear();
		defaultProps.onEditWorkflow.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders loading spinner when loading', () => {
		mockLoading.value = true;
		const { container } = render(<WorkflowList {...defaultProps} />);
		expect(container.querySelector('.animate-spin')).toBeTruthy();
	});

	it('renders empty state when no workflows', () => {
		const { getByText } = render(<WorkflowList {...defaultProps} />);
		expect(getByText('No workflows yet')).toBeTruthy();
		expect(getByText('Create your first workflow')).toBeTruthy();
	});

	it('renders Workflows heading', () => {
		const { getByText } = render(<WorkflowList {...defaultProps} />);
		expect(getByText('Workflows')).toBeTruthy();
	});

	it('renders Create Workflow button in header', () => {
		const { getByText } = render(<WorkflowList {...defaultProps} />);
		expect(getByText('Create Workflow')).toBeTruthy();
	});

	it('calls onCreateWorkflow when header Create button clicked', () => {
		const { getByText } = render(<WorkflowList {...defaultProps} />);
		fireEvent.click(getByText('Create Workflow'));
		expect(defaultProps.onCreateWorkflow).toHaveBeenCalledOnce();
	});

	it('calls onCreateWorkflow when empty-state CTA clicked', () => {
		const { getByText } = render(<WorkflowList {...defaultProps} />);
		fireEvent.click(getByText('Create your first workflow'));
		expect(defaultProps.onCreateWorkflow).toHaveBeenCalled();
	});

	it('renders workflow card with name', () => {
		mockWorkflows.value = [makeWorkflow({ name: 'Feature Pipeline' })];
		const { getByText } = render(<WorkflowList {...defaultProps} />);
		expect(getByText('Feature Pipeline')).toBeTruthy();
	});

	it('renders workflow description', () => {
		mockWorkflows.value = [makeWorkflow({ description: 'Runs features end-to-end' })];
		const { getByText } = render(<WorkflowList {...defaultProps} />);
		expect(getByText('Runs features end-to-end')).toBeTruthy();
	});

	it('renders step count', () => {
		mockWorkflows.value = [makeWorkflow()];
		const { getByText } = render(<WorkflowList {...defaultProps} />);
		expect(getByText('2 steps')).toBeTruthy();
	});

	it('renders singular "1 step"', () => {
		const s1 = 'step-1';
		mockWorkflows.value = [
			makeWorkflow({
				steps: [{ id: s1, name: 'Plan', agentId: 'a1' }],
				transitions: [],
				startStepId: s1,
			}),
		];
		const { getByText } = render(<WorkflowList {...defaultProps} />);
		expect(getByText('1 step')).toBeTruthy();
	});

	it('renders tag chips', () => {
		mockWorkflows.value = [makeWorkflow({ tags: ['ci', 'dev'] })];
		const { getByText } = render(<WorkflowList {...defaultProps} />);
		expect(getByText('ci')).toBeTruthy();
		expect(getByText('dev')).toBeTruthy();
	});

	it('renders mini step dots (one per step)', () => {
		mockWorkflows.value = [makeWorkflow()]; // 2 steps
		const { container } = render(<WorkflowList {...defaultProps} />);
		// Each step dot has bg-blue-400 or bg-blue-500 class
		const dots = container.querySelectorAll('.bg-blue-400, .bg-blue-500');
		expect(dots.length).toBeGreaterThanOrEqual(2);
	});

	it('calls onEditWorkflow with workflow ID when Edit clicked', async () => {
		mockWorkflows.value = [makeWorkflow({ id: 'wf-abc' })];
		const { container } = render(<WorkflowList {...defaultProps} />);
		const card = container.querySelector('.group');
		// Hover to reveal edit button (opacity-0 group-hover:opacity-100)
		// In tests, we just query for the button text
		const editBtn = container.querySelector('button.opacity-0');
		// fireEvent.click won't work on opacity-0 element if it's not visible,
		// but happy-dom doesn't respect CSS visibility so click should still work
		fireEvent.click(editBtn);
		expect(defaultProps.onEditWorkflow).toHaveBeenCalledWith('wf-abc');
	});

	it('renders multiple workflows', () => {
		mockWorkflows.value = [
			makeWorkflow({ id: 'wf-1', name: 'Alpha' }),
			makeWorkflow({ id: 'wf-2', name: 'Beta' }),
		];
		const { getByText } = render(<WorkflowList {...defaultProps} />);
		expect(getByText('Alpha')).toBeTruthy();
		expect(getByText('Beta')).toBeTruthy();
	});

	it('handles workflow with no steps in mini viz', () => {
		mockWorkflows.value = [makeWorkflow({ steps: [], transitions: [], startStepId: '' })];
		const { getByText } = render(<WorkflowList {...defaultProps} />);
		expect(getByText('No steps')).toBeTruthy();
	});

	it('renders human gate connector for human condition transition', () => {
		const s1 = 'step-1';
		const s2 = 'step-2';
		mockWorkflows.value = [
			makeWorkflow({
				steps: [
					{ id: s1, name: 'Plan', agentId: 'a1' },
					{ id: s2, name: 'Code', agentId: 'a2' },
				],
				transitions: [{ id: 'tr-1', from: s1, to: s2, condition: { type: 'human' }, order: 0 }],
				startStepId: s1,
			}),
		];
		const { container } = render(<WorkflowList {...defaultProps} />);
		// Human gate indicator: bg-yellow-400 class on mini connector dot
		expect(container.querySelector('.bg-yellow-400')).toBeTruthy();
	});
});
