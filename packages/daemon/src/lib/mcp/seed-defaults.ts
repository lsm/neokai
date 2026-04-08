/**
 * seedDefaultMcpEntries
 *
 * Seeds useful default MCP entries into the application-level registry on
 * daemon startup. The operation is idempotent — entries that already exist
 * (by name) are left untouched.
 *
 * Defaults:
 *   • fetch-mcp      — Fetch web pages and convert to Markdown (enabled).
 *   • chrome-devtools — Browser automation via Chrome DevTools MCP (disabled,
 *                      opt-in).
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

	if (!repo.getByName('chrome-devtools')) {
		repo.create({
			name: 'chrome-devtools',
			description:
				'Browser automation and DevTools integration via Chrome DevTools MCP (isolated mode)',
			sourceType: 'stdio',
			command: 'bunx',
			args: ['chrome-devtools-mcp@latest', '--isolated'],
			env: {},
			enabled: false,
		});
	}
}
