import { cwd, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (resolve(cwd()) === repoRoot) {
	console.error("Error: This is a monorepo. Do not run 'bun test' from the root.");
	console.error('');
	console.error('For daemon tests: ./scripts/test-daemon.sh');
	console.error('For web tests: cd packages/web && bunx vitest run');
	console.error('For e2e tests: make run-e2e TEST=tests/features/foo.e2e.ts');
	console.error('See CLAUDE.md for more details.');
	exit(1);
}
