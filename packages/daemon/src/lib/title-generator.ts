import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@liuboer/shared/sdk';
import { isSDKAssistantMessage } from '@liuboer/shared/sdk/type-guards';
import { Logger } from './logger';

const logger = new Logger('TitleGenerator');

export async function generateTitle(
	firstUserMsg: SDKMessage,
	_firstAssistantMsg: SDKMessage,
	workspacePath?: string
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

		// Use Agent SDK with maxTurns: 1 for simple title generation
		const result = await query({
			prompt: `Generate a concise 3-7 word title for this conversation (no quotes): ${userText}`,
			options: {
				model: 'claude-haiku-4-5-20250929',
				maxTurns: 1,
				permissionMode: 'bypassPermissions',
				allowDangerouslySkipPermissions: true,
				...(workspacePath && { cwd: workspacePath }),
			},
		});

		// Extract title from SDK response
		for await (const message of result) {
			if (isSDKAssistantMessage(message)) {
				const textBlocks = message.message.content.filter(
					(b: { type: string }) => b.type === 'text'
				);
				const title = textBlocks
					.map((b: { text?: string }) => b.text)
					.join(' ')
					.trim();

				if (title) {
					logger.log(`Generated title: "${title}"`);
					return title;
				}
			}
		}

		return null;
	} catch (error) {
		logger.error('Title generation failed:', error);
		return null;
	}
}
