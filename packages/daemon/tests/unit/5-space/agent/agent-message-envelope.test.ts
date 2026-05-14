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

	test('appends reply-routing XML footer when replyToSessionId is set (space-agent → node-agent)', () => {
		const result = formatAgentMessage({
			fromLevel: 'space-agent',
			fromAgentName: 'Space Agent',
			toLevel: 'node-agent',
			body: 'Proceed with option A',
			replyToSessionId: 'session-adhoc-42',
		});
		expect(result).toContain('<reply-routing replyToSessionId="session-adhoc-42" />');
		expect(result).toContain('Proceed with option A');
	});

	test('appends reply-routing XML footer when replyToSessionId is set (space-agent → task-agent)', () => {
		const result = formatAgentMessage({
			fromLevel: 'space-agent',
			fromAgentName: 'Space Agent',
			toLevel: 'task-agent',
			body: 'Do the thing',
			taskId: 'task-999',
			replyToSessionId: 'session-adhoc-99',
		});
		expect(result).toContain('<reply-routing replyToSessionId="session-adhoc-99" />');
	});

	test('appends reply-routing XML footer when replyToSessionId is set (node-agent → task-agent)', () => {
		const result = formatAgentMessage({
			fromLevel: 'node-agent',
			fromAgentName: 'reviewer',
			toLevel: 'task-agent',
			body: 'Here is my review',
			taskId: 'task-888',
			taskNumber: 42,
			replyToSessionId: 'session-adhoc-88',
		});
		expect(result).toContain('<reply-routing replyToSessionId="session-adhoc-88" />');
	});

	test('does not append reply-routing footer when replyToSessionId is null or undefined', () => {
		const result1 = formatAgentMessage({
			fromLevel: 'space-agent',
			fromAgentName: 'Space Agent',
			toLevel: 'node-agent',
			body: 'No reply routing',
			replyToSessionId: null,
		});
		expect(result1).not.toContain('<reply-routing');

		const result2 = formatAgentMessage({
			fromLevel: 'space-agent',
			fromAgentName: 'Space Agent',
			toLevel: 'node-agent',
			body: 'No reply routing',
		});
		expect(result2).not.toContain('<reply-routing');
	});
});
