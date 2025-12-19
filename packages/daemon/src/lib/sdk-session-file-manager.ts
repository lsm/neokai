/**
 * SDK Session File Manager
 *
 * Manages the .jsonl session files created by Claude Agent SDK in ~/.claude/projects/
 * These files store the conversation history and can grow very large with tool outputs.
 *
 * File path structure:
 * ~/.claude/projects/{workspace-path-with-slashes-replaced}/{sdk-session-id}.jsonl
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Construct the path to the SDK session .jsonl file
 *
 * @param workspacePath - The session's workspace path
 * @param sdkSessionId - The SDK session ID from Query.sessionId
 * @returns Absolute path to the .jsonl file
 */
export function getSDKSessionFilePath(workspacePath: string, sdkSessionId: string): string {
	// Convert workspace path: /foo/bar/baz -> -foo-bar-baz
	const projectKey = workspacePath.replace(/\//g, '-');

	// Construct the full path
	const sessionDir = join(homedir(), '.claude', 'projects', projectKey);
	const sessionFile = join(sessionDir, `${sdkSessionId}.jsonl`);

	return sessionFile;
}

/**
 * Find SDK session file by searching the workspace directory
 * Useful when we don't have the SDK session ID (e.g., session not currently running)
 *
 * @param workspacePath - The session's workspace path
 * @param liuboerSessionId - The Liuboer session ID to search for in files
 * @returns Path to the session file if found, null otherwise
 */
export function findSDKSessionFile(workspacePath: string, liuboerSessionId: string): string | null {
	try {
		const projectKey = workspacePath.replace(/\//g, '-');
		const sessionDir = join(homedir(), '.claude', 'projects', projectKey);

		if (!existsSync(sessionDir)) {
			return null;
		}

		// Search all .jsonl files for the Liuboer session ID
		const files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'));

		for (const file of files) {
			const filePath = join(sessionDir, file);
			const content = readFileSync(filePath, 'utf-8');

			// Check if this file contains the Liuboer session ID
			if (content.includes(liuboerSessionId)) {
				return filePath;
			}
		}

		return null;
	} catch (error) {
		console.error('[SDKSessionFileManager] Error finding session file:', error);
		return null;
	}
}

/**
 * Remove tool_result content from a specific message in the SDK session file
 *
 * Replaces large tool_result content with a placeholder to reduce file size
 * and unstick sessions with context overflow.
 *
 * @param workspacePath - The session's workspace path
 * @param sdkSessionId - The SDK session ID from Query.sessionId (optional, will search if not provided)
 * @param messageUuid - The UUID of the message to modify
 * @param liuboerSessionId - The Liuboer session ID (for fallback search)
 * @returns true if successful, false otherwise
 */
export function removeToolResultFromSessionFile(
	workspacePath: string,
	sdkSessionId: string | null,
	messageUuid: string,
	liuboerSessionId?: string
): boolean {
	try {
		let sessionFile: string | null = null;

		// Try using SDK session ID first
		if (sdkSessionId) {
			sessionFile = getSDKSessionFilePath(workspacePath, sdkSessionId);
		}

		// Fallback: search for session file by Liuboer session ID
		if ((!sessionFile || !existsSync(sessionFile)) && liuboerSessionId) {
			sessionFile = findSDKSessionFile(workspacePath, liuboerSessionId);
		}

		if (!sessionFile) {
			console.error('[SDKSessionFileManager] Could not find session file');
			return false;
		}

		// Check if file exists
		if (!existsSync(sessionFile)) {
			console.error(`[SDKSessionFileManager] File not found: ${sessionFile}`);
			return false;
		}

		// Read the .jsonl file (each line is a JSON object)
		const content = readFileSync(sessionFile, 'utf-8');
		const lines = content.split('\n').filter((line) => line.trim());

		// Process each line to find and modify the target message
		let modified = false;
		const updatedLines = lines.map((line) => {
			const message = JSON.parse(line) as Record<string, unknown>;

			// Check if this is the target message
			if (message.uuid === messageUuid) {
				// Modify tool_result content in this message
				if (
					message.type === 'user' &&
					message.message &&
					typeof message.message === 'object' &&
					'content' in message.message &&
					Array.isArray(message.message.content)
				) {
					const messageContent = message.message as Record<string, unknown>;
					const contentArray = messageContent.content as unknown[];

					messageContent.content = contentArray.map((block: unknown) => {
						const blockObj = block as Record<string, unknown>;
						if (blockObj.type === 'tool_result') {
							modified = true;
							return {
								...blockObj,
								content: [
									{
										type: 'text',
										text: '⚠️ Output removed by user. Run again with filter to narrow down the message.',
									},
								],
							};
						}
						return block;
					});
				}
			}

			return JSON.stringify(message);
		});

		if (!modified) {
			console.error(
				`[SDKSessionFileManager] Message ${messageUuid} not found or has no tool_result`
			);
			return false;
		}

		// Write back to file
		writeFileSync(sessionFile, updatedLines.join('\n') + '\n', 'utf-8');

		console.log(
			`[SDKSessionFileManager] Successfully removed tool_result from message ${messageUuid}`
		);
		return true;
	} catch (error) {
		console.error('[SDKSessionFileManager] Failed to remove tool_result:', error);
		return false;
	}
}
