import { describe, expect, test } from 'bun:test';
import { formatAgentMessage } from '../../../../src/lib/space/agent-message-envelope.ts';

describe('formatAgentMessage', () => {
	test('formats node to space-agent messages with task context and reply instructions', () => {
		expect(
			formatAgentMessage({
				fromLevel: 'node-agent',
				fromAgentName: 'coder',
				toLevel: 'space-agent',
				body: 'Need a decision',
				taskId: 'task-123',
				taskNumber: 236,
				nodeId: 'coder',
			})
		).toBe(
			'─── Message from coder (task #236) ───\n\n' +
				'Need a decision\n\n' +
				'─── Reply ───\n' +
				'To reply, use: send_message_to_task with task_id="task-123" and target node "coder"'
		);
	});

	test('formats space-agent messages with node reply instructions', () => {
		expect(
			formatAgentMessage({
				fromLevel: 'space-agent',
				fromAgentName: 'Space Agent',
				toLevel: 'node-agent',
				body: 'Proceed with option A',
			})
		).toBe(
			'─── Message from Space Agent ───\n\n' +
				'Proceed with option A\n\n' +
				'─── Reply ───\n' +
				'To reply, use: send_message with target "space-agent"'
		);
	});

	test('formats horizontal node messages without reply boilerplate', () => {
		expect(
			formatAgentMessage({
				fromLevel: 'node-agent',
				fromAgentName: 'coder',
				toLevel: 'node-agent',
				body: 'Review is ready',
			})
		).toBe('─── Message from coder ───\n\nReview is ready');
	});
});
