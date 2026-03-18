import { describe, expect, it } from 'bun:test';
import { buildRoomChatSystemPrompt } from '../../../src/lib/room/agents/room-chat-agent';

describe('buildRoomChatSystemPrompt', () => {
	it('returns a non-empty string', () => {
		const prompt = buildRoomChatSystemPrompt();
		expect(typeof prompt).toBe('string');
		expect(prompt.length).toBeGreaterThan(0);
	});

	it('includes the Room Agent role description', () => {
		const prompt = buildRoomChatSystemPrompt();
		expect(prompt).toContain('Room Agent');
	});

	it('instructs the agent NOT to call create_task when creating a goal', () => {
		const prompt = buildRoomChatSystemPrompt();
		expect(prompt).toContain('create_goal');
		expect(prompt).toContain('create_task');
		// Must explicitly say not to call create_task after create_goal
		expect(prompt).toMatch(/do NOT call.*create_task|never call.*create_task/i);
	});

	it('describes the full goal creation workflow steps', () => {
		const prompt = buildRoomChatSystemPrompt();
		// Planning phase
		expect(prompt.toLowerCase()).toContain('plan');
		// Approval step
		expect(prompt.toLowerCase()).toContain('approv');
		// Task creation only after approval
		expect(prompt.toLowerCase()).toContain('task');
	});

	it('tells the agent to explain the workflow to the user after goal creation', () => {
		const prompt = buildRoomChatSystemPrompt();
		expect(prompt).toContain('planning phase');
	});

	it('includes room background when provided', () => {
		const prompt = buildRoomChatSystemPrompt({ background: 'This is a trading platform.' });
		expect(prompt).toContain('This is a trading platform.');
		expect(prompt).toContain('Room Background');
	});

	it('includes room instructions when provided', () => {
		const prompt = buildRoomChatSystemPrompt({ instructions: 'Always prefer TypeScript.' });
		expect(prompt).toContain('Always prefer TypeScript.');
		expect(prompt).toContain('Room Instructions');
	});

	it('omits background section when not provided', () => {
		const prompt = buildRoomChatSystemPrompt({ instructions: 'Use bun.' });
		expect(prompt).not.toContain('Room Background');
	});

	it('omits instructions section when not provided', () => {
		const prompt = buildRoomChatSystemPrompt({ background: 'A fintech room.' });
		expect(prompt).not.toContain('Room Instructions');
	});

	it('includes both sections when both are provided', () => {
		const prompt = buildRoomChatSystemPrompt({
			background: 'A fintech room.',
			instructions: 'Always add tests.',
		});
		expect(prompt).toContain('Room Background');
		expect(prompt).toContain('A fintech room.');
		expect(prompt).toContain('Room Instructions');
		expect(prompt).toContain('Always add tests.');
	});

	it('produces identical output when called with undefined context', () => {
		const promptA = buildRoomChatSystemPrompt();
		const promptB = buildRoomChatSystemPrompt(undefined);
		expect(promptA).toBe(promptB);
	});

	it('mentions that tasks are created automatically after plan approval', () => {
		const prompt = buildRoomChatSystemPrompt();
		// Should mention that tasks come from an approved plan
		expect(prompt.toLowerCase()).toMatch(
			/tasks.*automatically|automatically.*created.*plan|tasks.*approved plan/
		);
	});
});
