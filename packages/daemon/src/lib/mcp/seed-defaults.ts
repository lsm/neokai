/**
 * seedDefaultMcpEntries
 *
 * Seeds two useful default MCP entries into the application-level registry on
 * daemon startup. The operation is idempotent — entries that already exist
 * (by name) are left untouched.
 *
 * Defaults:
 *   • fetch-mcp   — Fetch web pages and convert to Markdown (enabled).
 *   • brave-search — Web search via Brave Search API (disabled until the user
 *                    configures BRAVE_API_KEY).
 */

import type { Database } from '../../storage/database';

export function seedDefaultMcpEntries(db: Database): void {
	const repo = db.appMcpServers;

	if (!repo.getByName('fetch-mcp')) {
		repo.create({
			name: 'fetch-mcp',
			description: 'Fetch web pages and convert to Markdown for reading documentation and articles',
			sourceType: 'stdio',
			command: 'npx',
			args: ['-y', '@tokenizin/mcp-npx-fetch'],
			env: {},
			enabled: true,
		});
	}

	if (!repo.getByName('brave-search')) {
		repo.create({
			name: 'brave-search',
			description: 'Web search via Brave Search API (requires BRAVE_API_KEY env var)',
			sourceType: 'stdio',
			command: 'npx',
			args: ['-y', '@modelcontextprotocol/server-brave-search'],
			env: {},
			enabled: false,
		});
	}
}
