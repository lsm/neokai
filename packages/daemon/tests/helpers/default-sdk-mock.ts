/**
 * Default SDK Mock Helper
 *
 * Re-registers the @anthropic-ai/claude-agent-sdk mock that setup.ts installs.
 * Used by test files that temporarily override the SDK mock (e.g. with
 * mock.module()) and need to restore the default behaviour for subsequent
 * test files in the same bun test process.
 *
 * This must mirror the mock installed by tests/unit/setup.ts so that calling
 * it in afterEach restores the exact same behaviour other test files expect.
 */

import { mock } from 'bun:test';

class DefaultMockMcpServer {
	readonly _registeredTools: Record<string, object> = {};

	connect(): void {}
	disconnect(): void {}
}

let _toolBatch: Array<{ name: string; def: object }> = [];

function tool(name: string, description: string, inputSchema: unknown, handler: unknown): object {
	const def = { name, description, inputSchema, handler };
	_toolBatch.push({ name, def });
	return def;
}

export function registerDefaultSdkMock(): void {
	// Re-register the same mock that setup.ts installs.
	// Bun's mock.module() replaces the module for the rest of the process,
	// so calling it again here restores the default behaviour.
	mock.module('@anthropic-ai/claude-agent-sdk', () => ({
		query: mock(async () => ({
			interrupt: () => {},
		})),
		interrupt: mock(async () => {}),
		supportedModels: mock(async () => {
			throw new Error('SDK unavailable in unit test');
		}),
		createSdkMcpServer: mock((_options: { name: string; version?: string; tools?: unknown[] }) => {
			const server = new DefaultMockMcpServer();
			for (const { name, def } of _toolBatch) {
				server._registeredTools[name] = def;
			}
			_toolBatch = [];

			return {
				type: 'sdk' as const,
				name: _options.name,
				version: _options.version ?? '1.0.0',
				tools: _options.tools ?? [],
				instance: server,
			};
		}),
		tool,
	}));
}
