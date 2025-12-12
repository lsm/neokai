import type { SDKMessage } from '@liuboer/shared/sdk';
import { Logger } from './logger';

const logger = new Logger('TitleGenerator');

export async function generateTitle(
	firstUserMsg: SDKMessage,
	firstAssistantMsg: SDKMessage,
	apiKey: string
): Promise<string | null> {
	try {
		const userMessage = firstUserMsg as {
			message: { content: Array<{ type: string; text?: string }> };
		};
		const userText = userMessage.message.content
			.filter((b) => b.type === 'text')
			.map((b) => b.text)
			.join(' ')
			.slice(0, 500);

		if (!userText) return null;

		logger.log('Generating title with Haiku...');

		const res = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify({
				model: 'claude-haiku-4-5-20250929',
				max_tokens: 50,
				messages: [
					{
						role: 'user',
						content: `Generate a concise 3-7 word title for this conversation (no quotes): ${userText}`,
					},
				],
			}),
		});

		if (!res.ok) {
			logger.error(`Haiku API error: ${res.status}`);
			return null;
		}

		const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
		const title = data.content.find((b) => b.type === 'text')?.text?.trim();

		if (title) {
			logger.log(`Generated title: "${title}"`);
			return title;
		}

		return null;
	} catch (error) {
		logger.error('Title generation failed:', error);
		return null;
	}
}
