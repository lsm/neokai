import { describe, expect, it } from 'bun:test';
import {
	formatWorkerToLeaderEnvelope,
	formatLeaderToWorkerFeedback,
	formatLeaderContractNudge,
	priorityOrder,
	sortTasksByPriority,
} from '../../../src/lib/room/message-routing';

describe('Message Routing', () => {
	describe('formatWorkerToLeaderEnvelope', () => {
		it('should format basic envelope', () => {
			const result = formatWorkerToLeaderEnvelope({
				iteration: 0,
				taskTitle: 'Add health endpoint',
				terminalState: 'idle',
				workerOutput: 'I added the /health endpoint.',
			});

			expect(result).toContain('[WORKER OUTPUT] Iteration: 0');
			expect(result).toContain('Task: Add health endpoint');
			expect(result).toContain('Terminal state: idle');
			expect(result).toContain('---');
			expect(result).toContain('I added the /health endpoint.');
		});

		it('should include task type when present', () => {
			const result = formatWorkerToLeaderEnvelope({
				iteration: 1,
				taskTitle: 'Fix bug',
				taskType: 'coding',
				terminalState: 'idle',
				workerOutput: 'Fixed.',
			});

			expect(result).toContain('Task type: coding');
		});

		it('should include tool call summaries when present', () => {
			const result = formatWorkerToLeaderEnvelope({
				iteration: 0,
				taskTitle: 'Task',
				terminalState: 'idle',
				toolCallSummaries: ['Edit src/auth.ts (+42 lines)', 'Bash: npm test'],
				workerOutput: 'Done.',
			});

			expect(result).toContain('Tool calls:');
			expect(result).toContain('Edit src/auth.ts (+42 lines)');
		});

		it('should pass waiting_for_input terminal state directly', () => {
			const result = formatWorkerToLeaderEnvelope({
				iteration: 0,
				taskTitle: 'Task',
				terminalState: 'waiting_for_input',
				workerOutput: 'Which framework?',
			});

			expect(result).toContain('Terminal state: waiting_for_input');
		});

		it('should map interrupted terminal state', () => {
			const result = formatWorkerToLeaderEnvelope({
				iteration: 0,
				taskTitle: 'Task',
				terminalState: 'interrupted',
				workerOutput: 'Was interrupted.',
			});

			expect(result).toContain('Terminal state: interrupted');
		});
	});

	describe('formatLeaderToWorkerFeedback', () => {
		it('should format feedback with iteration', () => {
			const result = formatLeaderToWorkerFeedback('Fix the error handling', 1);

			expect(result).toContain('[LEADER FEEDBACK] Iteration: 1');
			expect(result).toContain('---');
			expect(result).toContain('Fix the error handling');
		});
	});

	describe('formatLeaderContractNudge', () => {
		it('should return nudge message', () => {
			const result = formatLeaderContractNudge();

			expect(result).toContain('send_to_worker');
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
