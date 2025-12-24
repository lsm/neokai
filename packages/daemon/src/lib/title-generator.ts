import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKUserMessage } from '@liuboer/shared/sdk';
import { isSDKAssistantMessage } from '@liuboer/shared/sdk/type-guards';

const TITLE_GENERATION_MODEL = 'haiku';
const MAX_CONTEXT_LENGTH = 2000;

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

		console.log('Generating title with Haiku...');

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

					console.log(`Generated title: "${title}"`);
					return title;
				}
			}
		}

		return null;
	} catch (error) {
		console.error('Title generation failed:', error);
		return null;
	}
}

/**
 * Extract text content from a user message
 */
function extractUserMessageText(message: SDKUserMessage): string {
	const userMessage = message as {
		message: { content: Array<{ type: string; text?: string }> };
	};
	return userMessage.message.content
		.filter((b) => b.type === 'text')
		.map((b) => b.text)
		.join(' ')
		.trim();
}

/**
 * Generate title from user messages only (no assistant context needed)
 *
 * This approach is more reliable than waiting for assistant responses:
 * - Triggers immediately after first user message
 * - No dependency on assistant response timing
 * - Can retry on subsequent user messages if initial attempt fails
 * - Works even if assistant response is slow or fails
 */
export async function generateTitleFromUserInput(
	userMessages: SDKUserMessage[],
	workspacePath: string
): Promise<string> {
	// Combine all user message texts
	const userTexts = userMessages.map((msg) => extractUserMessageText(msg)).filter(Boolean);

	if (userTexts.length === 0) {
		throw new Error('No user message text available for title generation');
	}

	// Combine and truncate context to avoid excessive API calls
	const combinedContext = userTexts.join('\n\n');
	const truncatedContext = combinedContext.slice(0, MAX_CONTEXT_LENGTH);

	console.log(
		`Generating title from ${userMessages.length} user message(s) (${combinedContext.length} chars)...`
	);

	// Use Agent SDK with Haiku for fast, cheap title generation
	const result = await query({
		prompt: `Based on the user's request below, generate a concise 3-7 word title that captures the main intent or topic.

IMPORTANT: Return ONLY the title text itself, with NO formatting whatsoever:
- NO quotes around the title
- NO asterisks or markdown
- NO backticks
- NO punctuation at the end
- Just plain text words

User's request:
${truncatedContext}`,
		options: {
			model: TITLE_GENERATION_MODEL,
			maxTurns: 1,
			permissionMode: 'bypassPermissions',
			allowDangerouslySkipPermissions: true,
			cwd: workspacePath,
		},
	});

	// Extract and clean title from SDK response
	for await (const message of result) {
		if (isSDKAssistantMessage(message)) {
			const textBlocks = message.message.content.filter((b: { type: string }) => b.type === 'text');
			let title = textBlocks
				.map((b: { text?: string }) => b.text)
				.join(' ')
				.trim();

			if (title) {
				// Strip any markdown formatting that might have slipped through
				title = title.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');

				// Remove wrapping quotes (handles multiple layers)
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

				if (!title) {
					throw new Error('Title generation returned empty string after cleaning');
				}

				console.log(`Generated title: "${title}"`);
				return title;
			}
		}
	}

	throw new Error('No title extracted from SDK response');
}
