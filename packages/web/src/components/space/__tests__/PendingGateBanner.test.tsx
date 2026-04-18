/**
 * Unit tests for PendingGateBanner.
 *
 * Covers:
 * - hidden when no pending gates
 * - rendered when a gate is waiting_human
 * - multi-gate stack
 * - approve click fires spaceWorkflowRun.approveGate
 * - reject click fires spaceWorkflowRun.approveGate with approved=false
 * - fetch error surfaces with a Retry button
 * - Review opens the artifacts overlay
 */

// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { Gate, SpaceWorkflow } from '@neokai/shared';

// ---- Mock hub ----
const mockRequest: Mock = vi.fn();
const mockOnEvent: Mock = vi.fn(() => () => {});
const mockHub = { request: mockRequest, onEvent: mockOnEvent };

vi.mock('../../../lib/connection-manager', () => ({
	connectionManager: {
		getHub: vi.fn(() => Promise.resolve(mockHub)),
		getHubIfConnected: vi.fn(() => mockHub),
	},
}));

// ---- Mock space-store.workflows signal ----
const workflowsSignal = signal<SpaceWorkflow[]>([]);
vi.mock('../../../lib/space-store', () => ({
	spaceStore: {
		get workflows() {
			return workflowsSignal;
		},
	},
}));

// ---- Mock GateArtifactsView ----
vi.mock('../GateArtifactsView', () => ({
	GateArtifactsView: (props: Record<string, unknown>) => (
		<div data-testid="gate-artifacts-view" data-gate-id={props.gateId as string}>
			GateArtifactsView
			<button data-testid="gate-close" onClick={props.onClose as () => void}>
				Close
			</button>
		</div>
	),
}));

import { PendingGateBanner } from '../PendingGateBanner';

function approvalGate(id: string, label?: string): Gate {
	return {
		id,
		label,
		resetOnCycle: false,
		fields: [
			{
				name: 'approved',
				type: 'boolean',
				writers: [],
				check: { op: '==', value: true },
			},
		],
	};
}

function makeWorkflow(gates: Gate[]): SpaceWorkflow {
	return {
		id: 'wf-1',
		name: 'Test Workflow',
		description: '',
		nodes: [],
		channels: [],
		gates,
		startNodeId: null,
		endNodeId: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		spaceId: 'space-1',
	} as unknown as SpaceWorkflow;
}

describe('PendingGateBanner', () => {
	beforeEach(() => {
		cleanup();
		mockRequest.mockReset();
		mockOnEvent.mockReset();
		mockOnEvent.mockImplementation(() => () => {});
		workflowsSignal.value = [];
	});

	afterEach(() => {
		cleanup();
	});

	it('renders nothing when there are no pending gates', async () => {
		workflowsSignal.value = [makeWorkflow([approvalGate('g1')])];
		mockRequest.mockResolvedValue({
			gateData: [{ runId: 'r1', gateId: 'g1', data: { approved: true }, updatedAt: 0 }],
		});
		const { queryByTestId } = render(
			<PendingGateBanner runId="r1" spaceId="s1" workflowId="wf-1" />
		);
		await waitFor(() =>
			expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.listGateData', { runId: 'r1' })
		);
		expect(queryByTestId('pending-gate-banner')).toBeNull();
		expect(queryByTestId('pending-gate-fetch-error')).toBeNull();
	});

	it('renders the banner for a gate that is waiting_human', async () => {
		workflowsSignal.value = [makeWorkflow([approvalGate('g1', 'Merge PR')])];
		mockRequest.mockResolvedValue({ gateData: [] });
		const { findByTestId, getByTestId } = render(
			<PendingGateBanner runId="r1" spaceId="s1" workflowId="wf-1" />
		);
		await findByTestId('pending-gate-banner');
		expect(getByTestId('pending-gate-approve-btn')).toBeTruthy();
		expect(getByTestId('pending-gate-reject-btn')).toBeTruthy();
		expect(getByTestId('pending-gate-review-btn')).toBeTruthy();
	});

	it('renders one row per pending gate in multi-gate workflows', async () => {
		workflowsSignal.value = [
			makeWorkflow([approvalGate('g1', 'First'), approvalGate('g2', 'Second')]),
		];
		mockRequest.mockResolvedValue({ gateData: [] });
		const { findByTestId, getAllByTestId } = render(
			<PendingGateBanner runId="r1" spaceId="s1" workflowId="wf-1" />
		);
		await findByTestId('pending-gate-banner');
		expect(getAllByTestId('pending-gate-approve-btn')).toHaveLength(2);
	});

	it('approve click fires approveGate with approved=true', async () => {
		workflowsSignal.value = [makeWorkflow([approvalGate('g1')])];
		mockRequest.mockImplementation((method: string) => {
			if (method === 'spaceWorkflowRun.listGateData') return Promise.resolve({ gateData: [] });
			return Promise.resolve({});
		});
		const { findByTestId } = render(
			<PendingGateBanner runId="r1" spaceId="s1" workflowId="wf-1" />
		);
		const btn = await findByTestId('pending-gate-approve-btn');
		fireEvent.click(btn);
		await waitFor(() =>
			expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.approveGate', {
				runId: 'r1',
				gateId: 'g1',
				approved: true,
			})
		);
	});

	it('reject click fires approveGate with approved=false', async () => {
		workflowsSignal.value = [makeWorkflow([approvalGate('g1')])];
		mockRequest.mockImplementation((method: string) => {
			if (method === 'spaceWorkflowRun.listGateData') return Promise.resolve({ gateData: [] });
			return Promise.resolve({});
		});
		const { findByTestId } = render(
			<PendingGateBanner runId="r1" spaceId="s1" workflowId="wf-1" />
		);
		const btn = await findByTestId('pending-gate-reject-btn');
		fireEvent.click(btn);
		await waitFor(() =>
			expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.approveGate', {
				runId: 'r1',
				gateId: 'g1',
				approved: false,
			})
		);
	});

	it('surfaces fetch errors with a Retry button', async () => {
		workflowsSignal.value = [makeWorkflow([approvalGate('g1')])];
		mockRequest.mockRejectedValueOnce(new Error('network down'));
		const { findByTestId, getByTestId } = render(
			<PendingGateBanner runId="r1" spaceId="s1" workflowId="wf-1" />
		);
		await findByTestId('pending-gate-fetch-error');
		expect(getByTestId('pending-gate-fetch-error').textContent).toContain('network down');
		// Retry re-issues the listGateData request
		mockRequest.mockResolvedValueOnce({ gateData: [] });
		fireEvent.click(getByTestId('pending-gate-fetch-retry'));
		await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2));
	});

	it('Review button opens the artifacts overlay', async () => {
		workflowsSignal.value = [makeWorkflow([approvalGate('g1')])];
		mockRequest.mockResolvedValue({ gateData: [] });
		const { findByTestId, queryByTestId, getByTestId } = render(
			<PendingGateBanner runId="r1" spaceId="s1" workflowId="wf-1" />
		);
		await findByTestId('pending-gate-banner');
		expect(queryByTestId('pending-gate-review-overlay')).toBeNull();
		fireEvent.click(getByTestId('pending-gate-review-btn'));
		expect(getByTestId('pending-gate-review-overlay')).toBeTruthy();
		expect(getByTestId('gate-artifacts-view').getAttribute('data-gate-id')).toBe('g1');
	});
});
