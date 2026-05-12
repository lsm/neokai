import { argv, cwd, env, exit } from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const flagsWithValues = new Set([
	'--timeout',
	'--rerun-each',
	'--retry',
	'--bail',
	'--test-name-pattern',
	'-t',
	'--reporter',
	'--reporter-outfile',
	'--max-concurrency',
	'--path-ignore-patterns',
	'--changed',
	'--parallel',
	'--parallel-delay',
	'--shard',
	'--jobs',
	'--preload',
]);

function hasExplicitTestTarget(args: string[]) {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];

		if (arg === '--') {
			return index < args.length - 1;
		}

		if (!arg.startsWith('-')) {
			return true;
		}

		if (flagsWithValues.has(arg)) {
			index++;
		}
	}

	return false;
}

const testArgs = argv.slice(1);
const shouldBlockRootTest =
	resolve(cwd()) === repoRoot &&
	env.NEOKAI_ALLOW_ROOT_TEST !== '1' &&
	!hasExplicitTestTarget(testArgs);

if (shouldBlockRootTest) {
	console.error("Error: This is a monorepo. Do not run bare 'bun test' from the root.");
	console.error('');
	console.error('For daemon tests: ./scripts/test-daemon.sh');
	console.error('For web tests: cd packages/web && bunx vitest run');
	console.error('For e2e tests: make run-e2e TEST=tests/features/foo.e2e.ts');
	console.error('See CLAUDE.md for more details.');
	exit(1);
}
