import { realpathSync } from 'node:fs';
import { cwd, env, exit } from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const currentDir = realpathSync(cwd());

const shouldBlockRootTest = currentDir === repoRoot && env.NEOKAI_ALLOW_ROOT_TEST !== '1';

if (shouldBlockRootTest) {
	console.error("Error: This is a monorepo. Do not run bare 'bun test' from the root.");
	console.error('');
	console.error('For daemon tests: ./scripts/test-daemon.sh');
	console.error('For web tests: cd packages/web && bunx vitest run');
	console.error('For e2e tests: make run-e2e TEST=tests/features/foo.e2e.ts');
	console.error('See CLAUDE.md for more details.');
	exit(1);
}
