import { piMonoQueryGenerator } from './src/lib/providers/pimono-adapter.js';
import * as fs from 'fs';

async function* createPrompt(message: string) {
	yield {
		type: 'user' as const,
		uuid: 'test-uuid' as any,
		session_id: 'test-session',
		parent_tool_use_id: null,
		message: {
			role: 'user' as const,
			content: message,
		},
	};
}

async function main() {
	const token = JSON.parse(fs.readFileSync(process.env.HOME + '/.neokai/auth.json', 'utf-8'));
	const apiKey = token['github-copilot'].access_token;

	console.log('API Key (first 20 chars):', apiKey?.substring(0, 20));

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

	console.log('Starting query generator...');

	try {
		const generator = piMonoQueryGenerator(
			createPrompt('What is 2+2? Reply with just the number.'),
			options,
			context,
			'github-copilot',
			'gpt-5-mini'
		);

		for await (const message of generator) {
			console.log('Message:', message.type);
			if (message.type === 'assistant') {
				console.log('  Content:', JSON.stringify((message as any).message?.content));
			} else if (message.type === 'result') {
				console.log('  Result:', message);
			}
		}

		console.log('Done!');
	} catch (error) {
		console.error('Error:', error);
	}
}

main().catch(console.error);
