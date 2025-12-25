/**
 * SDK Session File Manager
 *
 * Manages the .jsonl session files created by Claude Agent SDK in ~/.claude/projects/
 * These files store the conversation history and can grow very large with tool outputs.
 *
 * File path structure:
 * ~/.claude/projects/{workspace-path-with-slashes-replaced}/{sdk-session-id}.jsonl
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Get the SDK project directory for a workspace path
 * SDK replaces both / and . with - (e.g., /.liuboer/ -> --liuboer-)
 *
 * @param workspacePath - The session's workspace path
 * @returns Absolute path to the SDK project directory
 */
function getSDKProjectDir(workspacePath: string): string {
	const projectKey = workspacePath.replace(/[/.]/g, '-');
	return join(homedir(), '.claude', 'projects', projectKey);
}

/**
 * Construct the path to the SDK session .jsonl file
 *
 * @param workspacePath - The session's workspace path
 * @param sdkSessionId - The SDK session ID from Query.sessionId
 * @returns Absolute path to the .jsonl file
 */
export function getSDKSessionFilePath(workspacePath: string, sdkSessionId: string): string {
	return join(getSDKProjectDir(workspacePath), `${sdkSessionId}.jsonl`);
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
		const sessionDir = getSDKProjectDir(workspacePath);

		if (!existsSync(sessionDir)) {
			return null;
		}

		// Search all .jsonl files for the Liuboer session ID
		const files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'));

		// Track all matching files with their modification times
		const matchingFiles: Array<{ path: string; mtime: number }> = [];

		for (const file of files) {
			const filePath = join(sessionDir, file);
			const content = readFileSync(filePath, 'utf-8');

			// Check if this file contains the Liuboer session ID
			if (content.includes(liuboerSessionId)) {
				const stats = statSync(filePath);
				matchingFiles.push({ path: filePath, mtime: stats.mtimeMs });
			}
		}

		// Return the most recently modified file
		if (matchingFiles.length === 0) {
			return null;
		}

		matchingFiles.sort((a, b) => b.mtime - a.mtime);
		return matchingFiles[0].path;
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

		// Primary: Use SDK session ID for direct file path construction
		// This is 100% reliable - the filename IS the SDK session ID
		if (sdkSessionId) {
			sessionFile = getSDKSessionFilePath(workspacePath, sdkSessionId);
			if (!existsSync(sessionFile)) {
				console.error(
					`[SDKSessionFileManager] SDK session file not found: ${sessionFile}. SDK session may have been deleted.`
				);
				return false;
			}
		}
		// Fallback: Search by Liuboer session ID (only when session not currently running)
		// This is less reliable as the same Liuboer ID can appear in 100+ SDK files
		else if (liuboerSessionId) {
			sessionFile = findSDKSessionFile(workspacePath, liuboerSessionId);
			if (!sessionFile) {
				console.error(
					'[SDKSessionFileManager] Could not find session file by searching for Liuboer session ID'
				);
				return false;
			}
		} else {
			console.error(
				'[SDKSessionFileManager] Neither SDK session ID nor Liuboer session ID provided'
			);
			return false;
		}

		// Read the .jsonl file (each line is a JSON object)
		const content = readFileSync(sessionFile, 'utf-8');
		const lines = content.split('\n').filter((line) => line.trim());

		// Process each line to find and modify the target message
		let modified = false;
		let foundMessage = false;
		const updatedLines = lines.map((line) => {
			const message = JSON.parse(line) as Record<string, unknown>;

			// Check if this is the target message
			if (message.uuid === messageUuid) {
				foundMessage = true;
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
			if (!foundMessage) {
				console.error(
					`[SDKSessionFileManager] Message UUID ${messageUuid} not found in session file. File contains ${lines.length} messages.`
				);
			} else {
				console.error(
					`[SDKSessionFileManager] Message ${messageUuid} found but has no tool_result blocks`
				);
			}
			return false;
		}

		// Write back to file
		writeFileSync(sessionFile, updatedLines.join('\n') + '\n', 'utf-8');

		console.info(
			`[SDKSessionFileManager] Successfully removed tool_result from message ${messageUuid}`
		);
		return true;
	} catch (error) {
		console.error('[SDKSessionFileManager] Failed to remove tool_result:', error);
		return false;
	}
}
