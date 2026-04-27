// @ts-nocheck
/**
 * Unit tests for PendingAgentOverlay (Task #139, Symptom 2 fix).
 *
 * The overlay is opened when the user clicks a "(Not started)" entry for a
 * workflow-declared peer that has not yet spawned a session. It renders a
 * minimal composer; on first send it invokes
 * `spaceStore.activateTaskNodeAgent(taskId, agentName, message)` which
 * triggers a lazy daemon-side activation. Once the live session appears in
 * `spaceStore.taskActivity`, the overlay hands off to the standard
 * session-mode overlay via `pushOverlayHistory(sessionId, agentName)`.
 *
 * These tests verify:
 *   - The overlay renders a composer with starting copy and aria-label.
 *   - Clicking Send invokes spaceStore.activateTaskNodeAgent with the right
 *     (taskId, agentName, message) tuple.
 *   - When the daemon returns a live sessionId synchronously, the overlay
 *     hands off via pushOverlayHistory.
 *   - When the daemon returns no sessionId yet, the overlay enters a
 *     waiting state. When taskActivity later surfaces a node_agent member
 *     whose role matches the agentName, the overlay hands off as soon as
 *     that member's sessionId is set.
 *   - Escape and backdrop clicks invoke onClose.
 *   - Submit error path surfaces an error message and re-enables the input.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signal } from '@preact/signals';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/preact';

// Hoisted bridges — mock factories are evaluated before module init, so
// module-level variables referenced inside the factory body fail with TDZ
// errors. Hoist plain objects here and assign real Preact signals to
// `taskActivityBridge.signal` after import so reactivity works inside the
// component.
const { taskActivityBridge, mockActivateTaskNodeAgent, mockPushOverlayHistory } = vi.hoisted(
	() => ({
		taskActivityBridge: {
			signal: null as ReturnType<typeof signal<Map<string, unknown[]>>> | null,
		},
		mockActivateTaskNodeAgent: vi.fn(),
		mockPushOverlayHistory: vi.fn(),
	})
);

vi.mock('../../../lib/space-store', () => ({
	get spaceStore() {
		return {
			get taskActivity() {
				return taskActivityBridge.signal!;
			},
			activateTaskNodeAgent: mockActivateTaskNodeAgent,
		};
	},
}));

vi.mock('../../../lib/router', () => ({
	pushOverlayHistory: mockPushOverlayHistory,
}));

vi.mock('../../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// Assign the real signal after the hoist so the bridge resolves to a live
// Preact signal at test-runtime.
taskActivityBridge.signal = signal(new Map<string, unknown[]>());

import { PendingAgentOverlay, PENDING_AGENT_OVERLAY_TEST_ID } from '../PendingAgentOverlay';

const TASK_ID = 'task-123';
const AGENT_NAME = 'reviewer';

describe('PendingAgentOverlay', () => {
	let onClose: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		cleanup();
		onClose = vi.fn();
		taskActivityBridge.signal!.value = new Map();
		mockActivateTaskNodeAgent.mockReset();
		mockPushOverlayHistory.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders the overlay with the agent name in copy and aria-label', () => {
		const { getByTestId, getByText } = render(
			<PendingAgentOverlay taskId={TASK_ID} agentName={AGENT_NAME} onClose={onClose} />
		);
		const overlay = getByTestId(PENDING_AGENT_OVERLAY_TEST_ID);
		expect(overlay).toBeTruthy();
		expect(overlay.getAttribute('aria-label')).toBe(`${AGENT_NAME} chat (starting)`);
		// Body explains the pending state and the path forward.
		expect(getByText(`${AGENT_NAME} hasn't started yet`)).toBeTruthy();
	});

	it('disables the Send button until the user types a non-empty message', () => {
		const { getByTestId } = render(
			<PendingAgentOverlay taskId={TASK_ID} agentName={AGENT_NAME} onClose={onClose} />
		);
		const send = getByTestId('pending-agent-overlay-send') as HTMLButtonElement;
		expect(send.disabled).toBe(true);

		const textarea = getByTestId('pending-agent-overlay-textarea') as HTMLTextAreaElement;
		fireEvent.input(textarea, { target: { value: 'kick off' } });
		expect(send.disabled).toBe(false);
	});

	it('calls activateTaskNodeAgent on send and hands off when the daemon returns a sessionId synchronously', async () => {
		mockActivateTaskNodeAgent.mockResolvedValue({
			sessionId: 'sess-live-1',
			activated: true,
			queued: false,
		});

		const { getByTestId } = render(
			<PendingAgentOverlay taskId={TASK_ID} agentName={AGENT_NAME} onClose={onClose} />
		);

		const textarea = getByTestId('pending-agent-overlay-textarea') as HTMLTextAreaElement;
		fireEvent.input(textarea, { target: { value: 'wake up reviewer' } });
		fireEvent.click(getByTestId('pending-agent-overlay-send'));

		await waitFor(() => expect(mockActivateTaskNodeAgent).toHaveBeenCalledTimes(1));
		expect(mockActivateTaskNodeAgent).toHaveBeenCalledWith(TASK_ID, AGENT_NAME, 'wake up reviewer');
		await waitFor(() =>
			expect(mockPushOverlayHistory).toHaveBeenCalledWith('sess-live-1', AGENT_NAME)
		);
	});

	it('enters a waiting state when the daemon defers activation, then hands off when taskActivity surfaces the live session', async () => {
		mockActivateTaskNodeAgent.mockResolvedValue({
			sessionId: null,
			activated: true,
			queued: true,
			queuedMessageId: 'msg-1',
		});

		const { getByTestId, getByText } = render(
			<PendingAgentOverlay taskId={TASK_ID} agentName={AGENT_NAME} onClose={onClose} />
		);

		const textarea = getByTestId('pending-agent-overlay-textarea') as HTMLTextAreaElement;
		fireEvent.input(textarea, { target: { value: 'queue please' } });
		fireEvent.click(getByTestId('pending-agent-overlay-send'));

		// After send, the overlay is waiting for the activity subscription to
		// surface the new session.
		await waitFor(() => expect(getByText(`Starting ${AGENT_NAME}…`)).toBeTruthy());
		expect(mockPushOverlayHistory).not.toHaveBeenCalled();

		// Simulate the live-query subscription delivering the new session.
		taskActivityBridge.signal!.value = new Map([
			[
				TASK_ID,
				[
					{
						id: 'm1',
						sessionId: 'sess-spawned-2',
						kind: 'node_agent',
						role: AGENT_NAME,
						label: 'Reviewer',
						state: 'active',
						messageCount: 0,
					},
				],
			],
		]);

		await waitFor(() =>
			expect(mockPushOverlayHistory).toHaveBeenCalledWith('sess-spawned-2', 'Reviewer')
		);
	});

	it('surfaces an error and re-enables the input when activateTaskNodeAgent rejects', async () => {
		mockActivateTaskNodeAgent.mockRejectedValue(new Error('hub disconnected'));

		const { getByTestId, getByText } = render(
			<PendingAgentOverlay taskId={TASK_ID} agentName={AGENT_NAME} onClose={onClose} />
		);

		const textarea = getByTestId('pending-agent-overlay-textarea') as HTMLTextAreaElement;
		fireEvent.input(textarea, { target: { value: 'try' } });
		fireEvent.click(getByTestId('pending-agent-overlay-send'));

		await waitFor(() =>
			expect(getByText(/Failed to start reviewer: hub disconnected/)).toBeTruthy()
		);
		// Input is re-enabled so the user can retry.
		expect((textarea as HTMLTextAreaElement).disabled).toBe(false);
		expect(mockPushOverlayHistory).not.toHaveBeenCalled();
	});

	it('calls onClose when the Escape key is pressed', () => {
		render(<PendingAgentOverlay taskId={TASK_ID} agentName={AGENT_NAME} onClose={onClose} />);
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('calls onClose when the backdrop is clicked', () => {
		const { getByTestId } = render(
			<PendingAgentOverlay taskId={TASK_ID} agentName={AGENT_NAME} onClose={onClose} />
		);
		const overlay = getByTestId(PENDING_AGENT_OVERLAY_TEST_ID);
		const backdrop = overlay.querySelector('[aria-hidden="true"]');
		expect(backdrop).toBeTruthy();
		fireEvent.click(backdrop!);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('hands off immediately when the matching activity member is already present on mount (already spawned)', () => {
		// If the user clicks a "(Not started)" entry while a race makes the
		// session show up before the overlay mounts, hand off without waiting
		// for a send. This keeps the overlay in lock-step with the live store.
		taskActivityBridge.signal!.value = new Map([
			[
				TASK_ID,
				[
					{
						id: 'm1',
						sessionId: 'sess-pre-existing-3',
						kind: 'node_agent',
						role: AGENT_NAME,
						label: 'Reviewer',
						state: 'active',
						messageCount: 0,
					},
				],
			],
		]);
		render(<PendingAgentOverlay taskId={TASK_ID} agentName={AGENT_NAME} onClose={onClose} />);
		expect(mockPushOverlayHistory).toHaveBeenCalledWith('sess-pre-existing-3', 'Reviewer');
	});
});
