import { describe, expect, it } from 'bun:test';
import {
	formatCraftToLeadEnvelope,
	formatLeadToCraftFeedback,
	formatLeadContractNudge,
	priorityOrder,
	sortTasksByPriority,
} from '../../../src/lib/room/message-routing';

describe('Message Routing', () => {
	describe('formatCraftToLeadEnvelope', () => {
		it('should format basic envelope', () => {
			const result = formatCraftToLeadEnvelope({
				iteration: 0,
				taskTitle: 'Add health endpoint',
				terminalState: 'completed',
				craftOutput: 'I added the /health endpoint.',
			});

			expect(result).toContain('[CRAFT OUTPUT] Iteration: 0');
			expect(result).toContain('Task: Add health endpoint');
			expect(result).toContain('Terminal state: success');
			expect(result).toContain('---');
			expect(result).toContain('I added the /health endpoint.');
		});

		it('should include task type when present', () => {
			const result = formatCraftToLeadEnvelope({
				iteration: 1,
				taskTitle: 'Fix bug',
				taskType: 'coding',
				terminalState: 'completed',
				craftOutput: 'Fixed.',
			});

			expect(result).toContain('Task type: coding');
		});

		it('should include tool call summaries when present', () => {
			const result = formatCraftToLeadEnvelope({
				iteration: 0,
				taskTitle: 'Task',
				terminalState: 'completed',
				toolCallSummaries: ['Edit src/auth.ts (+42 lines)', 'Bash: npm test'],
				craftOutput: 'Done.',
			});

			expect(result).toContain('Tool calls:');
			expect(result).toContain('Edit src/auth.ts (+42 lines)');
		});

		it('should map waiting_for_input to question', () => {
			const result = formatCraftToLeadEnvelope({
				iteration: 0,
				taskTitle: 'Task',
				terminalState: 'waiting_for_input',
				craftOutput: 'Which framework?',
			});

			expect(result).toContain('Terminal state: question');
		});

		it('should map interrupted terminal state', () => {
			const result = formatCraftToLeadEnvelope({
				iteration: 0,
				taskTitle: 'Task',
				terminalState: 'interrupted',
				craftOutput: 'Was interrupted.',
			});

			expect(result).toContain('Terminal state: interrupted');
		});
	});

	describe('formatLeadToCraftFeedback', () => {
		it('should format feedback with iteration', () => {
			const result = formatLeadToCraftFeedback('Fix the error handling', 1);

			expect(result).toContain('[LEAD FEEDBACK] Iteration: 1');
			expect(result).toContain('---');
			expect(result).toContain('Fix the error handling');
		});
	});

	describe('formatLeadContractNudge', () => {
		it('should return nudge message', () => {
			const result = formatLeadContractNudge();

			expect(result).toContain('send_to_craft');
			expect(result).toContain('complete_task');
			expect(result).toContain('fail_task');
		});
	});

	describe('priorityOrder', () => {
		it('should order urgent highest', () => {
			expect(priorityOrder('urgent')).toBe(0);
		});

		it('should order high second', () => {
			expect(priorityOrder('high')).toBe(1);
		});

		it('should order normal third', () => {
			expect(priorityOrder('normal')).toBe(2);
		});

		it('should order low last', () => {
			expect(priorityOrder('low')).toBe(3);
		});

		it('should default unknown to normal', () => {
			expect(priorityOrder('unknown')).toBe(2);
		});
	});

	describe('sortTasksByPriority', () => {
		it('should sort by priority first', () => {
			const tasks = [
				{ priority: 'low', createdAt: 1, id: 'a' },
				{ priority: 'urgent', createdAt: 2, id: 'b' },
				{ priority: 'normal', createdAt: 3, id: 'c' },
			];

			const sorted = sortTasksByPriority(tasks);
			expect(sorted.map((t) => t.priority)).toEqual(['urgent', 'normal', 'low']);
		});

		it('should sort by creation time within same priority', () => {
			const tasks = [
				{ priority: 'normal', createdAt: 300, id: 'a' },
				{ priority: 'normal', createdAt: 100, id: 'b' },
				{ priority: 'normal', createdAt: 200, id: 'c' },
			];

			const sorted = sortTasksByPriority(tasks);
			expect(sorted.map((t) => t.id)).toEqual(['b', 'c', 'a']);
		});

		it('should use id as tiebreaker', () => {
			const tasks = [
				{ priority: 'normal', createdAt: 100, id: 'c' },
				{ priority: 'normal', createdAt: 100, id: 'a' },
				{ priority: 'normal', createdAt: 100, id: 'b' },
			];

			const sorted = sortTasksByPriority(tasks);
			expect(sorted.map((t) => t.id)).toEqual(['a', 'b', 'c']);
		});

		it('should not mutate the original array', () => {
			const tasks = [
				{ priority: 'low', createdAt: 1, id: 'a' },
				{ priority: 'urgent', createdAt: 2, id: 'b' },
			];

			const sorted = sortTasksByPriority(tasks);
			expect(tasks[0].priority).toBe('low');
			expect(sorted[0].priority).toBe('urgent');
		});
	});
});
