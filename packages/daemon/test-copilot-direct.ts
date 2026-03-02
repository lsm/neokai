import { getModel, streamSimple } from '@mariozechner/pi-ai';
import * as fs from 'fs';

async function main() {
	const token = JSON.parse(fs.readFileSync(process.env.HOME + '/.neokai/auth.json', 'utf-8'));
	const apiKey = token['github-copilot'].access_token;

	console.log('API Key (first 20 chars):', apiKey?.substring(0, 20));

	const model = getModel('github-copilot', 'gpt-5-mini');
	console.log('Model:', model?.id, model?.provider, model?.api, model?.baseUrl);

	const context = {
		systemPrompt: 'You are a helpful assistant.',
		messages: [{ role: 'user', content: 'What is 2+2? Reply with just the number.' }],
		tools: [],
	};

	console.log('Starting stream...');

	try {
		const stream = streamSimple(model, context, { apiKey });

		for await (const event of stream) {
			console.log('Event:', event.type);
			if (event.type === 'text_delta') {
				console.log('  Delta:', event.delta);
			} else if (event.type === 'done' || event.type === 'error') {
				console.log('  Reason:', event);
			}
		}

		const result = await stream.result();
		console.log('Result:', JSON.stringify(result, null, 2));
	} catch (error) {
		console.error('Error:', error);
	}
}

main().catch(console.error);
