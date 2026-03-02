import { piMonoQueryGenerator } from './src/lib/providers/pimono-adapter.js';
import type { SDKUserMessage } from '@neokai/shared/sdk';
import * as fs from 'fs';

// Simulate what QueryRunner does
async function* createPromptGenerator(message: SDKUserMessage): AsyncGenerator<SDKUserMessage> {
	yield message;
}

async function main() {
	const token = JSON.parse(fs.readFileSync(process.env.HOME + '/.neokai/auth.json', 'utf-8'));
	const apiKey = token['github-copilot'].access_token;

	console.log('Starting full integration test...');
	console.log('API Key (first 20 chars):', apiKey?.substring(0, 20));

	const userMessage: SDKUserMessage = {
		type: 'user',
		uuid: 'test-uuid' as any,
		session_id: 'test-session',
		parent_tool_use_id: null,
		message: {
			role: 'user',
			content: 'What is 2+2? Reply with just the number.',
		},
	};

	const options = {
		model: 'gpt-5-mini',
		systemPrompt: 'You are a helpful assistant.',
		tools: [],
		cwd: process.cwd(),
		maxTurns: 1,
		permissionMode: 'acceptEdits' as const,
		apiKey,
	};

	const context = {
		signal: new AbortController().signal,
		sessionId: 'test-session',
	};

	console.log('Creating prompt generator...');
	const promptGen = createPromptGenerator(userMessage);

	console.log('Creating pi-mono query generator...');
	const queryGen = piMonoQueryGenerator(
		promptGen,
		options,
		context,
		'github-copilot',
		'gpt-5-mini'
	);

	console.log('Iterating through messages (like QueryRunner does)...');
	let msgCount = 0;
	for await (const message of queryGen) {
		msgCount++;
		console.log(`Message ${msgCount}: type=${message.type}`);

		// Simulate what SDKMessageHandler.handleMessage does
		// This is where the state transitions happen
		if (message.type === 'system') {
			console.log('  -> Would set processing state');
		} else if (message.type === 'assistant') {
			console.log('  -> Would update phase to streaming');
		} else if (message.type === 'result') {
			console.log('  -> Result message received');
		}
	}

	console.log(`Done! Processed ${msgCount} messages.`);
	console.log('In real QueryRunner, finally block would set state to idle now.');
}

main().catch(console.error);
