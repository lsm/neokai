/**
 * TaskMessageQueue - Stub for MVP
 *
 * The task_messages table exists for schema forward-compatibility but is
 * not used in MVP. Lead->Craft routing is synchronous (direct injection).
 *
 * This stub will be replaced with write-ahead queue semantics when
 * human message queueing and interrupts are implemented.
 */

export interface TaskMessage {
	id: string;
	taskId: string;
	pairId: string;
	fromRole: 'craft' | 'lead' | 'human';
	toRole: 'craft' | 'lead';
	toSessionId: string;
	messageType: 'normal' | 'interrupt' | 'escalation_context';
	payload: string;
	status: 'pending' | 'delivered' | 'dead_letter';
	createdAt: number;
	deliveredAt: number | null;
}

export interface EnqueueParams {
	pairId: string;
	taskId: string;
	fromRole: 'craft' | 'lead' | 'human';
	toRole: 'craft' | 'lead';
	toSessionId: string;
	payload: string;
	messageType?: 'normal' | 'interrupt' | 'escalation_context';
}

export class TaskMessageQueue {
	enqueue(_params: EnqueueParams): TaskMessage {
		throw new Error('TaskMessageQueue.enqueue is not implemented in MVP');
	}

	dequeuePending(_pairId: string, _toRole: 'craft' | 'lead'): TaskMessage[] {
		return [];
	}

	markDelivered(_messageId: string): void {
		// no-op in MVP
	}

	markDeadLetter(_messageId: string): void {
		// no-op in MVP
	}

	deadLetterAllForPair(_pairId: string): void {
		// no-op in MVP
	}
}
