// @ts-nocheck
/**
 * Unit tests for AutonomyWorkflowSummary.
 *
 * Verifies:
 * - Renders "X of Y" text with the current level
 * - Hides itself until workflows are loaded
 * - Expands to show blocking actions when the toggle is clicked
 * - Uses the runtime fallback for workflows with no completion actions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import type { SpaceWorkflow } from '@neokai/shared';
import { AutonomyWorkflowSummary } from '../AutonomyWorkflowSummary';

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
	return {
		id: 'wf-1',
		spaceId: 'space-1',
		name: 'Test Workflow',
		nodes: [],
		startNodeId: 'n-1',
		tags: [],
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

describe('AutonomyWorkflowSummary', () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	it('renders nothing when there are no workflows', () => {
		const { queryByTestId } = render(<AutonomyWorkflowSummary level={3} workflows={[]} />);
		expect(queryByTestId('autonomy-workflow-summary')).toBeNull();
	});

	it('renders "X of Y workflows run without approval" at the current level', () => {
		const easy = makeWorkflow({
			id: 'easy',
			name: 'Easy',
			nodes: [
				{
					id: 'n-1',
					name: 'Node',
					agents: [{ agentId: 'a-1', name: 'a-1' }],
					completionActions: [
						{ type: 'script', id: 'a1', name: 'Lint', script: '', requiredLevel: 2 },
					],
				},
			],
		});
		const hard = makeWorkflow({
			id: 'hard',
			name: 'Hard',
			nodes: [
				{
					id: 'n-2',
					name: 'Deploy',
					agents: [{ agentId: 'a-1', name: 'a-1' }],
					completionActions: [
						{ type: 'script', id: 'h1', name: 'Merge PR', script: '', requiredLevel: 4 },
					],
				},
			],
		});

		const { getByTestId } = render(<AutonomyWorkflowSummary level={3} workflows={[easy, hard]} />);

		const count = getByTestId('autonomy-workflow-summary-count');
		expect(count.textContent).toContain('Level 3');
		expect(count.textContent).toContain('1 of 2');
		expect(count.textContent).toContain('without approval');
	});

	it('expands to reveal blocking workflows when the toggle is clicked', () => {
		const wf = makeWorkflow({
			id: 'wf-hard',
			name: 'Coding Workflow',
			nodes: [
				{
					id: 'n-1',
					name: 'Ship',
					agents: [{ agentId: 'a-1', name: 'a-1' }],
					completionActions: [
						{ type: 'script', id: 'h1', name: 'Merge PR', script: '', requiredLevel: 4 },
					],
				},
			],
		});

		const { getByTestId, queryByTestId } = render(
			<AutonomyWorkflowSummary level={3} workflows={[wf]} />
		);

		expect(queryByTestId('autonomy-workflow-summary-details')).toBeNull();

		fireEvent.click(getByTestId('autonomy-workflow-summary-toggle'));

		const details = getByTestId('autonomy-workflow-summary-details');
		expect(details.textContent).toContain('Coding Workflow');
		expect(details.textContent).toContain('Ship');
		expect(details.textContent).toContain('requires level 4');
	});

	it('describes no-completion-action workflows as requiring the runtime fallback level', () => {
		const wf = makeWorkflow({
			id: 'wf-review',
			name: 'Review Only',
			nodes: [
				{
					id: 'n-1',
					name: 'Only Node',
					agents: [{ agentId: 'a-1', name: 'a-1' }],
				},
			],
		});

		const { getByTestId } = render(<AutonomyWorkflowSummary level={1} workflows={[wf]} />);

		fireEvent.click(getByTestId('autonomy-workflow-summary-toggle'));

		const details = getByTestId('autonomy-workflow-summary-details');
		expect(details.textContent).toContain('Review Only');
		expect(details.textContent).toContain('requires level 2');
	});

	it('hides the toggle when all workflows are already autonomous', () => {
		const wf = makeWorkflow({
			id: 'wf-ok',
			name: 'OK',
			nodes: [
				{
					id: 'n-1',
					name: 'Node',
					agents: [{ agentId: 'a-1', name: 'a-1' }],
					completionActions: [
						{ type: 'script', id: 'a1', name: 'Lint', script: '', requiredLevel: 2 },
					],
				},
			],
		});

		const { queryByTestId, getByTestId } = render(
			<AutonomyWorkflowSummary level={5} workflows={[wf]} />
		);

		expect(queryByTestId('autonomy-workflow-summary-toggle')).toBeNull();
		expect(getByTestId('autonomy-workflow-summary-count').textContent).toContain('1 of 1');
	});
});
