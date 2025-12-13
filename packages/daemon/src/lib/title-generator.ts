import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@liuboer/shared/sdk';
import { isSDKAssistantMessage } from '@liuboer/shared/sdk/type-guards';
import { Logger } from './logger';

const logger = new Logger('TitleGenerator');

export async function generateTitle(
	firstUserMsg: SDKMessage,
	_firstAssistantMsg: SDKMessage,
	workspacePath: string
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
			prompt: `Generate a concise 3-7 word title for this conversation.

IMPORTANT: Return ONLY the title text itself, with NO formatting whatsoever:
- NO quotes around the title
- NO asterisks or markdown
- NO backticks
- NO punctuation at the end
- Just plain text words

User's message: ${userText}`,
			options: {
				model: 'haiku',
				maxTurns: 1,
				permissionMode: 'bypassPermissions',
				allowDangerouslySkipPermissions: true,
				cwd: workspacePath,
			},
		});

		// Extract title from SDK response
		for await (const message of result) {
			if (isSDKAssistantMessage(message)) {
				const textBlocks = message.message.content.filter(
					(b: { type: string }) => b.type === 'text'
				);
				let title = textBlocks
					.map((b: { text?: string }) => b.text)
					.join(' ')
					.trim();

				if (title) {
					// Strip any markdown formatting that might have slipped through
					// Remove bold/italic: **text** or *text*
					title = title.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');
					// Remove wrapping quotes (handles multiple layers like ""text"")
					while (
						(title.startsWith('"') && title.endsWith('"')) ||
						(title.startsWith("'") && title.endsWith("'"))
					) {
						title = title.slice(1, -1).trim();
					}
					// Remove backticks
					title = title.replace(/`/g, '');
					// Final trim
					title = title.trim();

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
