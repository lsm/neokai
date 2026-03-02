import { Agent } from '@mariozechner/pi-agent-core';
import { getModel } from '@mariozechner/pi-ai';
import * as fs from 'fs';

async function main() {
	const token = JSON.parse(fs.readFileSync(process.env.HOME + '/.neokai/auth.json', 'utf-8'));
	const apiKey = token['github-copilot'].access_token;

	console.log('API Key (first 20 chars):', apiKey?.substring(0, 20));

	const model = getModel('github-copilot', 'gpt-5-mini');
	console.log('Model:', model?.id, model?.provider);

	const agent = new Agent({
		initialState: {
			systemPrompt: 'You are a helpful assistant.',
			model: model,
			tools: [],
			messages: [],
			thinkingLevel: 'off',
			isStreaming: false,
			streamMessage: null,
			pendingToolCalls: new Set(),
		},
		getApiKey: async (provider) => {
			console.log('getApiKey called with provider:', provider);
			return apiKey;
		},
	});

	// Subscribe to events
	agent.subscribe((event) => {
		console.log('Agent event:', event.type);
	});

	console.log('Sending prompt...');

	try {
		await agent.prompt('What is 2+2? Reply with just the number.');

		console.log('Prompt completed!');
		console.log('State:', agent.state);
		console.log('Messages:', agent.state.messages);
	} catch (error) {
		console.error('Error:', error);
	}
}

main().catch(console.error);
