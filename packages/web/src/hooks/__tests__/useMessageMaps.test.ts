// @ts-nocheck
/**
 * Tests for useMessageMaps hook
 */

import './setup';
import { describe, expect, it } from 'bun:test';
import { renderHook } from '@testing-library/preact';
import { useMessageMaps } from '../useMessageMaps.ts';
import type { SDKMessage } from '@liuboer/shared/sdk/sdk.d.ts';

// UUID format for test data
const uuid1 = '00000000-0000-0000-0000-000000000001';
const uuid2 = '00000000-0000-0000-0000-000000000002';
const uuid3 = '00000000-0000-0000-0000-000000000003';
const uuid4 = '00000000-0000-0000-0000-000000000004';

describe('useMessageMaps', () => {
	describe('subagentMessagesMap', () => {
		it('should create empty map when no messages have parent_tool_use_id', () => {
			const messages = [
				{
					type: 'user',
					uuid: uuid1,
					session_id: 'session-1',
					message: {
						role: 'user',
						content: 'Hello',
					},
				},
				{
					type: 'assistant',
					uuid: uuid2,
					session_id: 'session-1',
					parent_tool_use_id: null,
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'Hi there!' }],
					},
				},
			] as unknown as SDKMessage[];

			const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));
			expect(result.current.subagentMessagesMap.size).toBe(0);
		});

		it('should group messages by parent_tool_use_id', () => {
			const messages = [
				{
					type: 'assistant',
					uuid: uuid1,
					session_id: 'session-1',
					parent_tool_use_id: null,
					message: {
						role: 'assistant',
						content: [
							{
								type: 'tool_use',
								id: 'tool-1',
								name: 'Task',
								input: { subagent_type: 'explore', description: 'Test', prompt: 'Do something' },
							},
						],
					},
				},
				{
					type: 'assistant',
					uuid: uuid2,
					session_id: 'session-1',
					parent_tool_use_id: 'tool-1',
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'Exploring...' }],
					},
				},
				{
					type: 'user',
					uuid: uuid3,
					session_id: 'session-1',
					parent_tool_use_id: 'tool-1',
					message: {
						role: 'user',
						content: [{ type: 'tool_result', tool_use_id: 'sub-tool-1', content: 'Result' }],
					},
				},
				{
					type: 'assistant',
					uuid: uuid4,
					session_id: 'session-1',
					parent_tool_use_id: 'tool-1',
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'Done!' }],
					},
				},
			] as unknown as SDKMessage[];

			const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));
			const subagentMessages = result.current.subagentMessagesMap.get('tool-1');

			expect(subagentMessages).toBeDefined();
			expect(subagentMessages?.length).toBe(3);
			expect(subagentMessages?.[0].uuid).toBe(uuid2);
			expect(subagentMessages?.[1].uuid).toBe(uuid3);
			expect(subagentMessages?.[2].uuid).toBe(uuid4);
		});

		it('should handle multiple parent tool use IDs', () => {
			const messages = [
				{
					type: 'assistant',
					uuid: uuid1,
					session_id: 'session-1',
					parent_tool_use_id: 'tool-1',
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'Agent 1 message' }],
					},
				},
				{
					type: 'assistant',
					uuid: uuid2,
					session_id: 'session-1',
					parent_tool_use_id: 'tool-2',
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'Agent 2 message' }],
					},
				},
				{
					type: 'assistant',
					uuid: uuid3,
					session_id: 'session-1',
					parent_tool_use_id: 'tool-1',
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'Agent 1 second message' }],
					},
				},
			] as unknown as SDKMessage[];

			const { result } = renderHook(() => useMessageMaps(messages, 'session-1'));

			const agent1Messages = result.current.subagentMessagesMap.get('tool-1');
			const agent2Messages = result.current.subagentMessagesMap.get('tool-2');

			expect(agent1Messages?.length).toBe(2);
			expect(agent2Messages?.length).toBe(1);
			expect(agent1Messages?.[0].uuid).toBe(uuid1);
			expect(agent1Messages?.[1].uuid).toBe(uuid3);
			expect(agent2Messages?.[0].uuid).toBe(uuid2);
		});
	});
});
