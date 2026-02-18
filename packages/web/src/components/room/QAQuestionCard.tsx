/**
 * QAQuestionCard Component
 *
 * Displays a single question in a Q&A round with answer state.
 * Shows the question text, timestamps, and an answer input area if unanswered.
 * Supports editing answered questions.
 */

import { useState } from 'preact/hooks';
import type { QAQuestion } from '@neokai/shared';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';

export interface QAQuestionCardProps {
	/** The question to display */
	question: QAQuestion;
	/** Handler for submitting an answer */
	onAnswer: (answer: string) => Promise<void>;
	/** Whether an answer is currently being submitted */
	isAnswering?: boolean;
}

/**
 * Format timestamp to readable time string
 */
function formatTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString(undefined, {
		hour: '2-digit',
		minute: '2-digit',
	});
}

/**
 * Format relative time from timestamp
 */
function formatRelativeTime(timestamp: number): string {
	const now = Date.now();
	const diff = now - timestamp;
	const seconds = Math.floor(diff / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);

	if (seconds < 60) {
		return 'Just now';
	} else if (minutes < 60) {
		return `${minutes}m ago`;
	} else if (hours < 24) {
		return `${hours}h ago`;
	} else {
		return new Date(timestamp).toLocaleDateString();
	}
}

export function QAQuestionCard({ question, onAnswer, isAnswering = false }: QAQuestionCardProps) {
	const [answerText, setAnswerText] = useState(question.answer || '');
	const [isEditing, setIsEditing] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const isAnswered = !!question.answer && !isEditing;

	const handleSubmit = async () => {
		if (!answerText.trim()) return;

		setIsSubmitting(true);
		try {
			await onAnswer(answerText.trim());
			setIsEditing(false);
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			handleSubmit();
		}
	};

	return (
		<div
			class={cn(
				'rounded-lg border p-4 transition-colors',
				isAnswered ? 'bg-dark-850 border-green-800/50' : 'bg-dark-800 border-blue-800/50'
			)}
		>
			{/* Question header */}
			<div class="flex items-start justify-between gap-3 mb-3">
				<div class="flex items-start gap-2">
					{/* Status indicator */}
					<div
						class={cn(
							'w-2 h-2 rounded-full mt-1.5 flex-shrink-0',
							isAnswered ? 'bg-green-500' : 'bg-blue-500 animate-pulse'
						)}
					/>
					<div>
						<span class="text-xs text-gray-400 uppercase tracking-wide">
							{isAnswered ? 'Answered' : 'Awaiting Answer'}
						</span>
					</div>
				</div>
				<span class="text-xs text-gray-500">{formatRelativeTime(question.askedAt)}</span>
			</div>

			{/* Question text */}
			<p class="text-sm text-gray-100 mb-3 leading-relaxed">{question.question}</p>

			{/* Answer section */}
			{isAnswered ? (
				<div class="space-y-2">
					<div class="flex items-center gap-2 text-xs text-gray-400">
						<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
							<path
								fill-rule="evenodd"
								d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
								clip-rule="evenodd"
							/>
						</svg>
						<span>Answered at {formatTime(question.answeredAt!)}</span>
					</div>
					<div class="bg-dark-900/50 rounded p-3 text-sm text-gray-300 border border-dark-700">
						{question.answer}
					</div>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							setAnswerText(question.answer || '');
							setIsEditing(true);
						}}
					>
						Edit Answer
					</Button>
				</div>
			) : (
				<div class="space-y-3">
					<textarea
						value={answerText}
						onInput={(e) => setAnswerText((e.target as HTMLTextAreaElement).value)}
						onKeyDown={handleKeyDown}
						placeholder="Type your answer..."
						disabled={isSubmitting || isAnswering}
						rows={3}
						class={cn(
							'w-full px-3 py-2 text-sm bg-dark-900 border rounded-lg text-gray-100',
							'placeholder-gray-500 resize-none',
							'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent',
							'disabled:opacity-50 disabled:cursor-not-allowed',
							answerText.trim() ? 'border-dark-600' : 'border-dark-700'
						)}
					/>
					<div class="flex items-center justify-between">
						<span class="text-xs text-gray-500">
							{isSubmitting || isAnswering ? (
								<span class="flex items-center gap-2">
									<Spinner size="xs" />
									Submitting...
								</span>
							) : (
								'Ctrl+Enter to submit'
							)}
						</span>
						<Button
							size="sm"
							onClick={handleSubmit}
							disabled={!answerText.trim() || isSubmitting || isAnswering}
							loading={isSubmitting || isAnswering}
						>
							Submit Answer
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}
