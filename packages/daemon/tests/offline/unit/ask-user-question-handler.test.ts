/**
 * AskUserQuestionHandler Tests
 *
 * Tests the handling of the AskUserQuestion tool via canUseTool callback.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { AskUserQuestionHandler } from '../../../src/lib/agent/ask-user-question-handler';
import type { ProcessingStateManager } from '../../../src/lib/agent/processing-state-manager';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { PendingUserQuestion, AgentProcessingState } from '@liuboer/shared';
import { generateUUID } from '@liuboer/shared';

describe('AskUserQuestionHandler', () => {
	let handler: AskUserQuestionHandler;
	let mockStateManager: ProcessingStateManager;
	let mockDaemonHub: DaemonHub;
	let emitSpy: ReturnType<typeof mock>;
	let setWaitingForInputSpy: ReturnType<typeof mock>;
	let setProcessingSpy: ReturnType<typeof mock>;
	let getStateSpy: ReturnType<typeof mock>;
	let updateQuestionDraftSpy: ReturnType<typeof mock>;
	const testSessionId = generateUUID();

	let currentState: AgentProcessingState;

	beforeEach(() => {
		currentState = { status: 'idle' };

		// Create mock DaemonHub
		emitSpy = mock(async () => {});
		mockDaemonHub = {
			emit: emitSpy,
		} as unknown as DaemonHub;

		// Create mock ProcessingStateManager
		setWaitingForInputSpy = mock(async (pendingQuestion: PendingUserQuestion) => {
			currentState = { status: 'waiting_for_input', pendingQuestion };
		});
		setProcessingSpy = mock(async () => {
			currentState = { status: 'processing', messageId: 'test', phase: 'streaming' };
		});
		getStateSpy = mock(() => currentState);
		updateQuestionDraftSpy = mock(async () => {});

		mockStateManager = {
			setWaitingForInput: setWaitingForInputSpy,
			setProcessing: setProcessingSpy,
			getState: getStateSpy,
			updateQuestionDraft: updateQuestionDraftSpy,
		} as unknown as ProcessingStateManager;

		handler = new AskUserQuestionHandler(testSessionId, mockStateManager, mockDaemonHub);
	});

	describe('createCanUseToolCallback', () => {
		it('should return a function', () => {
			const callback = handler.createCanUseToolCallback();
			expect(typeof callback).toBe('function');
		});

		it('should allow non-AskUserQuestion tools', async () => {
			const callback = handler.createCanUseToolCallback();

			const result = await callback(
				'Bash',
				{ command: 'ls' },
				{ signal: new AbortController().signal, toolUseID: 'test-id' }
			);

			expect(result.behavior).toBe('allow');
			expect(result.updatedInput).toEqual({ command: 'ls' });
		});

		it('should intercept AskUserQuestion tool', async () => {
			const callback = handler.createCanUseToolCallback();

			const input = {
				questions: [
					{
						question: 'What do you prefer?',
						header: 'Preference',
						options: [
							{ label: 'Option A', description: 'First option' },
							{ label: 'Option B', description: 'Second option' },
						],
						multiSelect: false,
					},
				],
			};

			// Start the callback but don't await - it will block waiting for user input
			const resultPromise = callback('AskUserQuestion', input, {
				signal: new AbortController().signal,
				toolUseID: 'tool-123',
			});

			// Give the callback time to set up
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Should have transitioned to waiting_for_input
			expect(setWaitingForInputSpy).toHaveBeenCalled();
			expect(emitSpy).toHaveBeenCalledWith('question.asked', expect.any(Object));

			// Simulate user response to unblock
			await handler.handleQuestionResponse('tool-123', [
				{ questionIndex: 0, selectedLabels: ['Option A'] },
			]);

			const result = await resultPromise;
			expect(result.behavior).toBe('allow');
		});

		it('should pass through SDK toolUseID', async () => {
			const callback = handler.createCanUseToolCallback();

			const input = {
				questions: [
					{
						question: 'Test question',
						header: 'Test',
						options: [
							{ label: 'Yes', description: 'Yes' },
							{ label: 'No', description: 'No' },
						],
						multiSelect: false,
					},
				],
			};

			const toolUseID = 'sdk-tool-use-id-12345';
			const resultPromise = callback('AskUserQuestion', input, {
				signal: new AbortController().signal,
				toolUseID,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify the pending question uses SDK's toolUseID
			expect(setWaitingForInputSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					toolUseId: toolUseID,
				})
			);

			// Respond with matching toolUseId
			await handler.handleQuestionResponse(toolUseID, [
				{ questionIndex: 0, selectedLabels: ['Yes'] },
			]);

			await resultPromise;
		});
	});

	describe('handleQuestionResponse', () => {
		it('should throw when not waiting for input', async () => {
			currentState = { status: 'idle' };

			await expect(
				handler.handleQuestionResponse('tool-123', [{ questionIndex: 0, selectedLabels: ['A'] }])
			).rejects.toThrow('agent is not waiting for input');
		});

		it('should throw when no pending resolver', async () => {
			const pendingQuestion: PendingUserQuestion = {
				toolUseId: 'tool-123',
				questions: [
					{
						question: 'Test?',
						header: 'Test',
						options: [{ label: 'A', description: 'A' }],
						multiSelect: false,
					},
				],
				askedAt: Date.now(),
			};
			currentState = { status: 'waiting_for_input', pendingQuestion };

			await expect(
				handler.handleQuestionResponse('tool-123', [{ questionIndex: 0, selectedLabels: ['A'] }])
			).rejects.toThrow('No pending question');
		});

		it('should throw on toolUseId mismatch', async () => {
			const callback = handler.createCanUseToolCallback();

			const input = {
				questions: [
					{
						question: 'Test?',
						header: 'Test',
						options: [
							{ label: 'A', description: 'A' },
							{ label: 'B', description: 'B' },
						],
						multiSelect: false,
					},
				],
			};

			const resultPromise = callback('AskUserQuestion', input, {
				signal: new AbortController().signal,
				toolUseID: 'correct-id',
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Try to respond with wrong toolUseId
			await expect(
				handler.handleQuestionResponse('wrong-id', [{ questionIndex: 0, selectedLabels: ['A'] }])
			).rejects.toThrow('Tool use ID mismatch');

			// Cleanup - respond with correct ID
			await handler.handleQuestionResponse('correct-id', [
				{ questionIndex: 0, selectedLabels: ['A'] },
			]);
			await resultPromise;
		});

		it('should format answers correctly for single select', async () => {
			const callback = handler.createCanUseToolCallback();

			const input = {
				questions: [
					{
						question: 'What is your choice?',
						header: 'Choice',
						options: [
							{ label: 'Option A', description: 'First' },
							{ label: 'Option B', description: 'Second' },
						],
						multiSelect: false,
					},
				],
			};

			const resultPromise = callback('AskUserQuestion', input, {
				signal: new AbortController().signal,
				toolUseID: 'format-test',
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			await handler.handleQuestionResponse('format-test', [
				{ questionIndex: 0, selectedLabels: ['Option A'] },
			]);

			const result = await resultPromise;
			expect(result.behavior).toBe('allow');
			expect(result.updatedInput).toEqual(
				expect.objectContaining({
					answers: {
						'What is your choice?': 'Option A',
					},
				})
			);
		});

		it('should format answers correctly for multi select', async () => {
			const callback = handler.createCanUseToolCallback();

			const input = {
				questions: [
					{
						question: 'Select all that apply',
						header: 'Multi',
						options: [
							{ label: 'A', description: 'A' },
							{ label: 'B', description: 'B' },
							{ label: 'C', description: 'C' },
						],
						multiSelect: true,
					},
				],
			};

			const resultPromise = callback('AskUserQuestion', input, {
				signal: new AbortController().signal,
				toolUseID: 'multi-test',
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			await handler.handleQuestionResponse('multi-test', [
				{ questionIndex: 0, selectedLabels: ['A', 'C'] },
			]);

			const result = await resultPromise;
			expect(result.updatedInput).toEqual(
				expect.objectContaining({
					answers: {
						'Select all that apply': 'A, C',
					},
				})
			);
		});

		it('should handle custom text response', async () => {
			const callback = handler.createCanUseToolCallback();

			const input = {
				questions: [
					{
						question: 'What is your name?',
						header: 'Name',
						options: [
							{ label: 'John', description: 'John' },
							{ label: 'Jane', description: 'Jane' },
						],
						multiSelect: false,
					},
				],
			};

			const resultPromise = callback('AskUserQuestion', input, {
				signal: new AbortController().signal,
				toolUseID: 'custom-test',
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			await handler.handleQuestionResponse('custom-test', [
				{ questionIndex: 0, selectedLabels: [], customText: 'Bob' },
			]);

			const result = await resultPromise;
			expect(result.updatedInput).toEqual(
				expect.objectContaining({
					answers: {
						'What is your name?': 'Bob',
					},
				})
			);
		});

		it('should transition back to processing state', async () => {
			const callback = handler.createCanUseToolCallback();

			const input = {
				questions: [
					{
						question: 'Continue?',
						header: 'Confirm',
						options: [
							{ label: 'Yes', description: 'Yes' },
							{ label: 'No', description: 'No' },
						],
						multiSelect: false,
					},
				],
			};

			const resultPromise = callback('AskUserQuestion', input, {
				signal: new AbortController().signal,
				toolUseID: 'state-test',
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			await handler.handleQuestionResponse('state-test', [
				{ questionIndex: 0, selectedLabels: ['Yes'] },
			]);

			await resultPromise;

			expect(setProcessingSpy).toHaveBeenCalledWith('state-test', 'streaming');
		});
	});

	describe('handleQuestionCancel', () => {
		it('should throw when not waiting for input', async () => {
			currentState = { status: 'idle' };

			await expect(handler.handleQuestionCancel('tool-123')).rejects.toThrow(
				'agent is not waiting for input'
			);
		});

		it('should deny tool and provide cancellation message', async () => {
			const callback = handler.createCanUseToolCallback();

			const input = {
				questions: [
					{
						question: 'Proceed?',
						header: 'Confirm',
						options: [
							{ label: 'Yes', description: 'Yes' },
							{ label: 'No', description: 'No' },
						],
						multiSelect: false,
					},
				],
			};

			const resultPromise = callback('AskUserQuestion', input, {
				signal: new AbortController().signal,
				toolUseID: 'cancel-test',
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			await handler.handleQuestionCancel('cancel-test');

			const result = await resultPromise;
			expect(result.behavior).toBe('deny');
			expect(result.message).toContain('cancelled');
		});
	});

	describe('updateQuestionDraft', () => {
		it('should delegate to state manager', async () => {
			const draftResponses = [{ questionIndex: 0, selectedLabels: ['A'] }];

			await handler.updateQuestionDraft(draftResponses);

			expect(updateQuestionDraftSpy).toHaveBeenCalledWith(draftResponses);
		});
	});

	describe('cleanup', () => {
		it('should reject pending resolver on cleanup', async () => {
			const callback = handler.createCanUseToolCallback();

			const input = {
				questions: [
					{
						question: 'Test?',
						header: 'Test',
						options: [
							{ label: 'A', description: 'A' },
							{ label: 'B', description: 'B' },
						],
						multiSelect: false,
					},
				],
			};

			const resultPromise = callback('AskUserQuestion', input, {
				signal: new AbortController().signal,
				toolUseID: 'cleanup-test',
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			handler.cleanup();

			await expect(resultPromise).rejects.toThrow('Session cleanup');
		});

		it('should be safe to call cleanup when no pending resolver', () => {
			// Should not throw
			expect(() => handler.cleanup()).not.toThrow();
		});
	});
});
