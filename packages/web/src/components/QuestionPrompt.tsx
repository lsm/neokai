/**
 * QuestionPrompt Component
 *
 * Renders a user question prompt from the AskUserQuestion tool.
 * Allows users to select predefined options or enter custom text.
 *
 * Features:
 * - Single and multi-select support
 * - "Other" option for custom text input
 * - Draft saving for persistence across refreshes
 * - Cancel/dismiss option
 */

import { useState, useCallback, useEffect } from 'preact/hooks';
import type { PendingUserQuestion, QuestionDraftResponse } from '@liuboer/shared';
import { useMessageHub } from '../hooks/useMessageHub.ts';
import { Button } from './ui/Button.tsx';
import { cn } from '../lib/utils.ts';
import { borderColors } from '../lib/design-tokens.ts';

interface QuestionPromptProps {
	sessionId: string;
	pendingQuestion: PendingUserQuestion;
}

export function QuestionPrompt({ sessionId, pendingQuestion }: QuestionPromptProps) {
	const { questions, toolUseId, draftResponses } = pendingQuestion;
	const { callIfConnected } = useMessageHub();

	// Track selections for each question (map of questionIndex -> Set of selected labels)
	const [selections, setSelections] = useState<Map<number, Set<string>>>(() => {
		// Initialize from draft responses if available
		const map = new Map<number, Set<string>>();
		if (draftResponses) {
			for (const draft of draftResponses) {
				map.set(draft.questionIndex, new Set(draft.selectedLabels));
			}
		}
		return map;
	});

	// Track custom text inputs (map of questionIndex -> text)
	const [customInputs, setCustomInputs] = useState<Map<number, string>>(() => {
		// Initialize from draft responses if available
		const map = new Map<number, string>();
		if (draftResponses) {
			for (const draft of draftResponses) {
				if (draft.customText) {
					map.set(draft.questionIndex, draft.customText);
				}
			}
		}
		return map;
	});

	// Track which questions show the "Other" input
	const [showOther, setShowOther] = useState<Set<number>>(() => {
		// Initialize from draft responses if available
		const set = new Set<number>();
		if (draftResponses) {
			for (const draft of draftResponses) {
				if (draft.customText) {
					set.add(draft.questionIndex);
				}
			}
		}
		return set;
	});

	const [isSubmitting, setIsSubmitting] = useState(false);
	const [isCancelling, setIsCancelling] = useState(false);

	// Save draft whenever selections change
	const saveDraft = useCallback(async () => {
		const responses: QuestionDraftResponse[] = [];
		for (let i = 0; i < questions.length; i++) {
			const selectedLabels = [...(selections.get(i) || [])];
			const customText = customInputs.get(i);
			if (selectedLabels.length > 0 || customText) {
				responses.push({
					questionIndex: i,
					selectedLabels,
					customText,
				});
			}
		}

		try {
			await callIfConnected('question.saveDraft', {
				sessionId,
				draftResponses: responses,
			});
		} catch (error) {
			console.error('Failed to save draft:', error);
		}
	}, [sessionId, questions.length, selections, customInputs, callIfConnected]);

	// Debounced draft saving
	useEffect(() => {
		const timeout = setTimeout(() => {
			saveDraft();
		}, 500);
		return () => clearTimeout(timeout);
	}, [saveDraft]);

	const handleOptionClick = (questionIndex: number, label: string) => {
		const question = questions[questionIndex];
		const current = new Set(selections.get(questionIndex) || []);

		if (question.multiSelect) {
			// Toggle selection
			if (current.has(label)) {
				current.delete(label);
			} else {
				current.add(label);
			}
		} else {
			// Single select - replace
			current.clear();
			current.add(label);
		}

		setSelections(new Map(selections.set(questionIndex, current)));

		// Clear "Other" if regular option selected (only for single select)
		if (!question.multiSelect) {
			setShowOther((prev) => {
				const next = new Set(prev);
				next.delete(questionIndex);
				return next;
			});
			setCustomInputs((prev) => {
				const next = new Map(prev);
				next.delete(questionIndex);
				return next;
			});
		}
	};

	const handleOtherClick = (questionIndex: number) => {
		const question = questions[questionIndex];

		setShowOther((prev) => new Set([...prev, questionIndex]));

		// Clear regular selections only for single select
		if (!question.multiSelect) {
			setSelections((prev) => {
				const next = new Map(prev);
				next.get(questionIndex)?.clear();
				return next;
			});
		}
	};

	const handleCustomInput = (questionIndex: number, text: string) => {
		setCustomInputs((prev) => new Map(prev.set(questionIndex, text)));
	};

	const handleSubmit = async () => {
		setIsSubmitting(true);

		try {
			const responses: QuestionDraftResponse[] = questions
				.map((_, index) => ({
					questionIndex: index,
					selectedLabels: [...(selections.get(index) || [])],
					customText: customInputs.get(index),
				}))
				.filter((r) => r.selectedLabels.length > 0 || r.customText);

			await callIfConnected('question.respond', {
				sessionId,
				toolUseId,
				responses,
			});
		} catch (error) {
			console.error('Failed to submit response:', error);
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleCancel = async () => {
		setIsCancelling(true);

		try {
			await callIfConnected('question.cancel', {
				sessionId,
				toolUseId,
			});
		} catch (error) {
			console.error('Failed to cancel:', error);
		} finally {
			setIsCancelling(false);
		}
	};

	// Check if form is valid (at least one answer per question)
	const isValid = questions.every((_, index) => {
		const hasSelection = (selections.get(index)?.size || 0) > 0;
		const hasCustom = !!customInputs.get(index);
		return hasSelection || hasCustom;
	});

	return (
		<div
			class={cn(
				'rounded-xl border p-4 my-4 mx-auto max-w-2xl',
				'bg-amber-950/30',
				borderColors.semantic.warning
			)}
		>
			{/* Header */}
			<div class="flex items-center gap-2 mb-4">
				<span class="text-amber-400 text-lg">?</span>
				<span class="font-medium text-amber-200">Claude needs your input</span>
			</div>

			{/* Questions */}
			{questions.map((question, qIndex) => (
				<div key={qIndex} class="mb-6 last:mb-4">
					{/* Question header and text */}
					<div class="mb-3">
						<span
							class={cn(
								'inline-block px-2 py-0.5 text-xs rounded mr-2',
								'bg-amber-900/50 text-amber-300 border',
								borderColors.semantic.warning
							)}
						>
							{question.header}
						</span>
						<span class="text-gray-200">{question.question}</span>
					</div>

					{/* Options */}
					<div class="flex flex-wrap gap-2">
						{question.options.map((option) => {
							const isSelected = selections.get(qIndex)?.has(option.label);
							return (
								<button
									key={option.label}
									onClick={() => handleOptionClick(qIndex, option.label)}
									class={cn(
										'px-3 py-2 rounded-lg border transition-all text-left',
										'hover:scale-[1.02] active:scale-[0.98]',
										isSelected
											? 'bg-amber-900/60 border-amber-500 text-amber-100'
											: cn(
													'bg-dark-800/60 text-gray-300',
													borderColors.ui.secondary,
													'hover:border-amber-600/50'
												)
									)}
									title={option.description}
								>
									<div class="font-medium text-sm">{option.label}</div>
									<div class="text-xs text-gray-500 mt-0.5">{option.description}</div>
								</button>
							);
						})}

						{/* Other option button */}
						<button
							onClick={() => handleOtherClick(qIndex)}
							class={cn(
								'px-3 py-2 rounded-lg border transition-all',
								'hover:scale-[1.02] active:scale-[0.98]',
								showOther.has(qIndex)
									? 'bg-amber-900/60 border-amber-500 text-amber-100'
									: cn(
											'bg-dark-800/60 text-gray-400',
											borderColors.ui.secondary,
											'hover:border-amber-600/50'
										)
							)}
						>
							<div class="font-medium text-sm">Other...</div>
							<div class="text-xs text-gray-500 mt-0.5">Enter custom answer</div>
						</button>
					</div>

					{/* Custom text input when "Other" is selected */}
					{showOther.has(qIndex) && (
						<input
							type="text"
							placeholder="Enter your response..."
							value={customInputs.get(qIndex) || ''}
							onInput={(e) => handleCustomInput(qIndex, (e.target as HTMLInputElement).value)}
							class={cn(
								'mt-3 w-full px-3 py-2 rounded-lg border',
								'bg-dark-800/80 text-gray-100 placeholder-gray-500',
								'focus:outline-none focus:border-amber-500',
								borderColors.ui.secondary
							)}
						/>
					)}
				</div>
			))}

			{/* Action buttons */}
			<div class="flex items-center gap-3 pt-2 border-t border-dark-700">
				<Button
					variant="primary"
					onClick={handleSubmit}
					disabled={!isValid || isSubmitting || isCancelling}
					loading={isSubmitting}
					class="bg-amber-600 hover:bg-amber-700"
				>
					Submit Response
				</Button>
				<Button
					variant="ghost"
					onClick={handleCancel}
					disabled={isSubmitting || isCancelling}
					loading={isCancelling}
				>
					Skip Question
				</Button>
			</div>
		</div>
	);
}
