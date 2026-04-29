import { describe, expect, it } from 'bun:test';
import { buildNeoSystemPrompt } from '../../../../src/lib/neo/neo-system-prompt';

describe('buildNeoSystemPrompt', () => {
	it('includes runtime-dependent room task tools when the room runtime is available', () => {
		const prompt = buildNeoSystemPrompt('balanced', { roomRuntimeToolsAvailable: true });

		expect(prompt).toContain('`stop_session`');
		expect(prompt).toContain('`approve_task`');
		expect(prompt).toContain('`reject_task`');
	});

	it('omits runtime-dependent room task tools when the room runtime is unavailable', () => {
		const prompt = buildNeoSystemPrompt('balanced', { roomRuntimeToolsAvailable: false });

		expect(prompt).not.toContain('`stop_session`');
		expect(prompt).not.toContain('`approve_task`');
		expect(prompt).not.toContain('`reject_task`');
		expect(prompt).toContain('`send_message_to_room`');
	});
});
