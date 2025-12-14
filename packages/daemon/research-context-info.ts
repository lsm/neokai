#!/usr/bin/env bun

/**
 * Research Script: Context Window Info Investigation
 *
 * This script uses Claude Agent SDK in streaming mode to investigate
 * how context window information is provided during agent execution.
 * Prints all SDK messages as JSON to analyze the structure.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import * as dotenv from 'dotenv';

// Load environment variables from root
dotenv.config({ path: '../../.env' });

async function main() {
	console.log('🔬 Starting SDK Context Info Research');
	console.log('='.repeat(70));
	console.log('');

	// Create a simple message generator
	async function* messageGenerator() {
		// First message: simple hello
		yield {
			type: 'user' as const,
			uuid: crypto.randomUUID(),
			session_id: 'research-session',
			parent_tool_use_id: null,
			message: {
				role: 'user' as const,
				content: '/context',
			},
		};

		// Wait a bit then send /context command
		// await new Promise((resolve) => setTimeout(resolve, 5000));

		// yield {
		// 	type: 'user' as const,
		// 	uuid: crypto.randomUUID(),
		// 	session_id: 'research-session',
		// 	parent_tool_use_id: null,
		// 	message: {
		// 		role: 'user' as const,
		// 		content: '/context',
		// 	},
		// };
	}

	try {
		// Start the query
		const sdkQuery = query({
			prompt: messageGenerator(),
			options: {
				model: 'claude-sonnet-4-5-20250929',
				maxTurns: 1,
				cwd: process.cwd(),
				systemPrompt: {
					type: 'preset',
					preset: 'claude_code',
				},
			},
		});

		console.log('📡 Streaming SDK messages:\n');

		let messageCount = 0;

		// Stream and print all SDK messages
		for await (const message of sdkQuery) {
			messageCount++;

			// Print each message as formatted JSON with a separator
			console.log(`\n${'='.repeat(70)}`);
			console.log(`MESSAGE #${messageCount}`);
			console.log('='.repeat(70));
			console.log(JSON.stringify(message, null, 2));
		}

		console.log('\n' + '='.repeat(70));
		console.log(`📊 Total messages received: ${messageCount}`);
		console.log('='.repeat(70));
	} catch (error) {
		console.error('\n❌ Error during SDK execution:');
		console.error(error);
		process.exit(1);
	}

	console.log('\n✨ Research complete');
}

// Run the script
main();
