/**
 * RoomEscalations Component
 *
 * Displays escalated issues and requests for human intervention from the room agent.
 * Shows:
 * - Escalations that need attention
 * - Review requests
 * - Questions from the agent
 * - Input form to respond to the agent
 */

import { useState } from 'preact/hooks';
import type { RoomAgentWaitingContext, RoomAgentState } from '@neokai/shared';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { roomStore } from '../../lib/room-store';

export interface RoomEscalationsProps {
	roomId: string;
	agentState: RoomAgentState | null;
	waitingContext: RoomAgentWaitingContext | null;
}

function formatRelativeTime(timestamp: number): string {
	const now = Date.now();
	const diff = now - timestamp;
	const seconds = Math.floor(diff / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);

	if (seconds < 60) return 'Just now';
	if (minutes < 60) return `${minutes}m ago`;
	if (hours < 24) return `${hours}h ago`;
	return new Date(timestamp).toLocaleDateString();
}

export function RoomEscalations({
	roomId: _roomId,
	agentState,
	waitingContext,
}: RoomEscalationsProps) {
	const [inputValue, setInputValue] = useState('');
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [responseMessage, setResponseMessage] = useState('');

	const handleSubmitInput = async () => {
		if (!inputValue.trim() || isSubmitting) return;

		setIsSubmitting(true);
		try {
			await roomStore.sendHumanInput(inputValue.trim());
			setInputValue('');
			setResponseMessage('Response sent. Agent is processing...');
			// Clear success message after a delay
			setTimeout(() => setResponseMessage(''), 3000);
		} catch (err) {
			setResponseMessage(err instanceof Error ? err.message : 'Failed to send response');
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleReviewResponse = async (approved: boolean) => {
		if (!waitingContext || waitingContext.type !== 'review' || !waitingContext.taskId) return;

		setIsSubmitting(true);
		try {
			await roomStore.respondToReview(
				waitingContext.taskId,
				approved,
				inputValue.trim() || undefined
			);
			setInputValue('');
			setResponseMessage(approved ? 'Task approved' : 'Task rejected');
			setTimeout(() => setResponseMessage(''), 3000);
		} catch (err) {
			setResponseMessage(err instanceof Error ? err.message : 'Failed to respond');
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleEscalationResponse = async () => {
		if (!waitingContext || waitingContext.type !== 'escalation') return;

		setIsSubmitting(true);
		try {
			await roomStore.respondToEscalation(
				waitingContext.escalationId || waitingContext.taskId || 'unknown',
				inputValue.trim()
			);
			setInputValue('');
			setResponseMessage('Response sent. Agent is processing...');
			setTimeout(() => setResponseMessage(''), 3000);
		} catch (err) {
			setResponseMessage(err instanceof Error ? err.message : 'Failed to respond');
		} finally {
			setIsSubmitting(false);
		}
	};

	// Don't show anything if agent is not in waiting state
	if (!agentState || agentState.lifecycleState !== 'waiting') {
		// Also check if there's a waiting context despite the state
		if (!waitingContext) {
			return null;
		}
	}

	const getEscalationTitle = () => {
		if (!waitingContext) return 'Agent Request';
		switch (waitingContext.type) {
			case 'escalation':
				return 'Issue Escalated ⚠️';
			case 'review':
				return 'Review Requested 📋';
			case 'question':
				return 'Question from Agent ❓';
		}
	};

	const getEscalationIcon = () => {
		switch (waitingContext?.type) {
			case 'escalation':
				return (
					<svg
						class="w-5 h-5 text-yellow-400"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
						/>
					</svg>
				);
			case 'review':
				return (
					<svg class="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
						/>
					</svg>
				);
			case 'question':
				return (
					<svg
						class="w-5 h-5 text-purple-400"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
						/>
					</svg>
				);
		}
	};

	return (
		<div class="bg-yellow-900/20 border border-yellow-700/50 rounded-lg p-4">
			{/* Header */}
			<div class="flex items-center gap-3 mb-3">
				{getEscalationIcon()}
				<div>
					<h3 class="text-sm font-semibold text-gray-100">{getEscalationTitle()}</h3>
					{waitingContext?.since && (
						<span class="text-xs text-gray-400">{formatRelativeTime(waitingContext.since)}</span>
					)}
				</div>
			</div>

			{/* Reason/Problem description */}
			{waitingContext?.reason && (
				<div class="mb-3 p-3 bg-dark-800 rounded border-l-2 border-yellow-600">
					<p class="text-sm text-gray-200 whitespace-pre-wrap">{waitingContext.reason}</p>
				</div>
			)}

			{/* Response message */}
			{responseMessage && (
				<div
					class={cn(
						'mb-3 p-2 rounded text-sm',
						responseMessage.includes('Failed')
							? 'bg-red-900/30 text-red-300'
							: 'bg-green-900/30 text-green-300'
					)}
				>
					{responseMessage}
				</div>
			)}

			{/* Input area */}
			<div class="space-y-2">
				<textarea
					value={inputValue}
					onInput={(e) => setInputValue((e.target as HTMLTextAreaElement).value)}
					placeholder="Type your response or guidance here..."
					disabled={isSubmitting}
					class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:border-transparent resize-none"
					rows={3}
				/>

				{/* Action buttons */}
				<div class="flex items-center gap-2">
					<Button
						onClick={handleSubmitInput}
						disabled={!inputValue.trim() || isSubmitting}
						loading={isSubmitting}
						size="sm"
					>
						Send Response
					</Button>

					{/* Review-specific actions */}
					{waitingContext?.type === 'review' && (
						<>
							<Button
								variant="primary"
								onClick={() => handleReviewResponse(true)}
								disabled={isSubmitting}
								size="sm"
							>
								Approve Task
							</Button>
							<Button
								variant="secondary"
								onClick={() => handleReviewResponse(false)}
								disabled={isSubmitting}
								size="sm"
							>
								Reject Task
							</Button>
						</>
					)}

					{/* Escalation-specific action */}
					{waitingContext?.type === 'escalation' && (
						<Button
							variant="primary"
							onClick={handleEscalationResponse}
							disabled={!inputValue.trim() || isSubmitting}
							loading={isSubmitting}
							size="sm"
						>
							Resolve Escalation
						</Button>
					)}
				</div>

				{/* Helper text */}
				<p class="text-xs text-gray-500 mt-2">
					Your response will be sent to the room agent to help resolve this issue.
				</p>
			</div>
		</div>
	);
}
