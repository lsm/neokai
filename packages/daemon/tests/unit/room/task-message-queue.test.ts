import { describe, expect, it } from 'bun:test';
import { TaskMessageQueue } from '../../../src/lib/room/task-message-queue';

describe('TaskMessageQueue (MVP stub)', () => {
	it('should return empty array from dequeuePending', () => {
		const queue = new TaskMessageQueue();
		expect(queue.dequeuePending('pair-1', 'craft')).toEqual([]);
	});

	it('should throw on enqueue (not implemented in MVP)', () => {
		const queue = new TaskMessageQueue();
		expect(() =>
			queue.enqueue({
				pairId: 'pair-1',
				taskId: 'task-1',
				fromRole: 'lead',
				toRole: 'craft',
				toSessionId: 'sess-1',
				payload: 'hello',
			})
		).toThrow('not implemented in MVP');
	});

	it('should not throw on no-op methods', () => {
		const queue = new TaskMessageQueue();
		expect(() => queue.markDelivered('msg-1')).not.toThrow();
		expect(() => queue.markDeadLetter('msg-1')).not.toThrow();
		expect(() => queue.deadLetterAllForPair('pair-1')).not.toThrow();
	});
});
