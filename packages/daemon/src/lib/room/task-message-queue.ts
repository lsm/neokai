/**
 * TaskMessageQueue - Stub for MVP
 *
 * The task_messages table exists for schema forward-compatibility but is
 * not used in MVP. Leader->Worker routing is synchronous (direct injection).
 *
 * This stub will be replaced with write-ahead queue semantics when
 * human message queueing and interrupts are implemented.
 */

export interface TaskMessage {
	id: string;
	taskId: string;
	groupId: string;
	fromRole: 'worker' | 'leader' | 'human';
	toRole: 'worker' | 'leader';
	toSessionId: string;
	messageType: 'normal' | 'interrupt' | 'escalation_context';
	payload: string;
	status: 'pending' | 'delivered' | 'dead_letter';
	createdAt: number;
	deliveredAt: number | null;
}

export interface EnqueueParams {
	groupId: string;
	taskId: string;
	fromRole: 'worker' | 'leader' | 'human';
	toRole: 'worker' | 'leader';
	toSessionId: string;
	payload: string;
	messageType?: 'normal' | 'interrupt' | 'escalation_context';
}

export class TaskMessageQueue {
	enqueue(_params: EnqueueParams): TaskMessage {
		throw new Error('TaskMessageQueue.enqueue is not implemented in MVP');
	}

	dequeuePending(_groupId: string, _toRole: 'worker' | 'leader'): TaskMessage[] {
		return [];
	}

	markDelivered(_messageId: string): void {
		// no-op in MVP
	}

	markDeadLetter(_messageId: string): void {
		// no-op in MVP
	}

	deadLetterAllForGroup(_groupId: string): void {
		// no-op in MVP
	}
}
