/**
 * QARoundPanel Component
 *
 * Displays an active Q&A round for context refinement.
 * Shows questions from the room agent and allows the human to answer.
 * Provides progress tracking, auto-scroll to new questions, and round completion.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { Signal } from '@preact/signals';
import type { RoomQARound } from '@neokai/shared';
import { cn } from '../../lib/utils';
import { QAQuestionCard } from './QAQuestionCard';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';

export interface QARoundPanelProps {
	/** Room ID */
	roomId: string;
	/** Signal containing the active Q&A round */
	activeRound: Signal<RoomQARound | null>;
	/** Handler for answering a question */
	onAnswer: (roundId: string, questionId: string, answer: string) => Promise<void>;
	/** Handler for completing the round */
	onComplete: (roundId: string, summary?: string) => Promise<void>;
}

/**
 * Trigger type badge colors
 */
const TRIGGER_COLORS: Record<RoomQARound['trigger'], string> = {
	room_created: 'bg-purple-900/50 text-purple-300',
	context_updated: 'bg-blue-900/50 text-blue-300',
	goal_created: 'bg-green-900/50 text-green-300',
};

/**
 * Trigger type labels
 */
const TRIGGER_LABELS: Record<RoomQARound['trigger'], string> = {
	room_created: 'Room Created',
	context_updated: 'Context Updated',
	goal_created: 'Goal Created',
};

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

export function QARoundPanel({
	roomId: _roomId,
	activeRound,
	onAnswer,
	onComplete,
}: QARoundPanelProps) {
	const [answeringQuestionId, setAnsweringQuestionId] = useState<string | null>(null);
	const [isCompleting, setIsCompleting] = useState(false);
	const [showSummaryInput, setShowSummaryInput] = useState(false);
	const [summary, setSummary] = useState('');
	const questionsEndRef = useRef<HTMLDivElement>(null);
	const prevQuestionCountRef = useRef(0);

	const round = activeRound.value;

	// Auto-scroll to new questions
	useEffect(() => {
		if (round && round.questions.length > prevQuestionCountRef.current) {
			questionsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
		}
		prevQuestionCountRef.current = round?.questions.length || 0;
	}, [round?.questions.length]);

	// No active round
	if (!round) {
		return (
			<div class="bg-dark-850 border border-dark-700 rounded-lg p-6 text-center">
				<div class="w-12 h-12 rounded-full bg-dark-700 flex items-center justify-center mx-auto mb-4">
					<svg class="w-6 h-6 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
						/>
					</svg>
				</div>
				<h3 class="text-lg font-medium text-gray-200 mb-2">No Active Q&A Round</h3>
				<p class="text-sm text-gray-400">
					Q&A rounds help refine the room context. The agent may start one when needed.
				</p>
			</div>
		);
	}

	const answeredCount = round.questions.filter((q) => q.answer).length;
	const totalCount = round.questions.length;
	const allAnswered = answeredCount === totalCount && totalCount > 0;

	// Separate questions into unanswered and answered
	const unansweredQuestions = round.questions.filter((q) => !q.answer);
	const answeredQuestions = round.questions.filter((q) => q.answer);

	const handleAnswer = async (questionId: string, answer: string) => {
		setAnsweringQuestionId(questionId);
		try {
			await onAnswer(round.id, questionId, answer);
		} finally {
			setAnsweringQuestionId(null);
		}
	};

	const handleComplete = async () => {
		setIsCompleting(true);
		try {
			await onComplete(round.id, summary.trim() || undefined);
			setSummary('');
			setShowSummaryInput(false);
		} finally {
			setIsCompleting(false);
		}
	};

	return (
		<div class="bg-dark-850 border border-dark-700 rounded-lg overflow-hidden">
			{/* Header */}
			<div class="px-4 py-3 border-b border-dark-700 bg-dark-800/50">
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-3">
						<div class="w-8 h-8 rounded-full bg-blue-900/50 flex items-center justify-center">
							<svg
								class="w-4 h-4 text-blue-400"
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
						</div>
						<div>
							<h3 class="font-semibold text-gray-100">Q&A Round</h3>
							<div class="flex items-center gap-2 text-xs text-gray-400">
								<span class={cn('px-1.5 py-0.5 rounded', TRIGGER_COLORS[round.trigger])}>
									{TRIGGER_LABELS[round.trigger]}
								</span>
								<span>Started {formatRelativeTime(round.startedAt)}</span>
							</div>
						</div>
					</div>

					{/* Progress indicator */}
					<div class="flex items-center gap-3">
						<div class="text-right">
							<div class="text-sm font-medium text-gray-100">
								{answeredCount} of {totalCount}
							</div>
							<div class="text-xs text-gray-400">questions answered</div>
						</div>
						{/* Progress bar */}
						<div class="w-16 h-2 bg-dark-700 rounded-full overflow-hidden">
							<div
								class={cn(
									'h-full transition-all duration-300',
									allAnswered ? 'bg-green-500' : 'bg-blue-500'
								)}
								style={{ width: `${totalCount > 0 ? (answeredCount / totalCount) * 100 : 0}%` }}
							/>
						</div>
					</div>
				</div>
			</div>

			{/* Questions list */}
			<div class="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
				{/* Unanswered questions first */}
				{unansweredQuestions.length > 0 && (
					<div class="space-y-4">
						<div class="flex items-center gap-2 text-xs text-gray-400 uppercase tracking-wide">
							<div class="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
							<span>Pending Questions</span>
						</div>
						{unansweredQuestions.map((question) => (
							<QAQuestionCard
								key={question.id}
								question={question}
								onAnswer={(answer) => handleAnswer(question.id, answer)}
								isAnswering={answeringQuestionId === question.id}
							/>
						))}
					</div>
				)}

				{/* Answered questions */}
				{answeredQuestions.length > 0 && (
					<div class="space-y-4">
						<div class="flex items-center gap-2 text-xs text-gray-400 uppercase tracking-wide">
							<div class="w-2 h-2 rounded-full bg-green-500" />
							<span>Answered Questions</span>
						</div>
						{answeredQuestions.map((question) => (
							<QAQuestionCard
								key={question.id}
								question={question}
								onAnswer={(answer) => handleAnswer(question.id, answer)}
								isAnswering={answeringQuestionId === question.id}
							/>
						))}
					</div>
				)}

				{/* Auto-scroll anchor */}
				<div ref={questionsEndRef} />
			</div>

			{/* Footer with completion */}
			<div class="px-4 py-3 border-t border-dark-700 bg-dark-800/50">
				{showSummaryInput ? (
					<div class="space-y-3">
						<div>
							<label class="block text-sm font-medium text-gray-300 mb-1">Optional Summary</label>
							<textarea
								value={summary}
								onInput={(e) => setSummary((e.target as HTMLTextAreaElement).value)}
								placeholder="Add a summary of the Q&A round (optional)..."
								rows={2}
								class="w-full px-3 py-2 text-sm bg-dark-900 border border-dark-600 rounded-lg text-gray-100 placeholder-gray-500 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
							/>
						</div>
						<div class="flex items-center justify-end gap-2">
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setShowSummaryInput(false)}
								disabled={isCompleting}
							>
								Cancel
							</Button>
							<Button
								size="sm"
								onClick={handleComplete}
								loading={isCompleting}
								disabled={!allAnswered}
							>
								Complete Round
							</Button>
						</div>
					</div>
				) : (
					<div class="flex items-center justify-between">
						<div class="flex items-center gap-2 text-sm text-gray-400">
							{allAnswered ? (
								<>
									<svg class="w-4 h-4 text-green-400" fill="currentColor" viewBox="0 0 20 20">
										<path
											fill-rule="evenodd"
											d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
											clip-rule="evenodd"
										/>
									</svg>
									<span>All questions answered</span>
								</>
							) : (
								<>
									<Spinner size="xs" />
									<span>Waiting for answers ({totalCount - answeredCount} remaining)</span>
								</>
							)}
						</div>
						<Button
							size="sm"
							onClick={() => setShowSummaryInput(true)}
							disabled={!allAnswered || isCompleting}
						>
							Complete Round
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}
