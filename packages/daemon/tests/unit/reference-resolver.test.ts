/**
 * ReferenceResolver Unit Tests
 *
 * Tests for the reference parsing and file/folder resolution logic.
 * Covers:
 *   - extractReferences: pattern matching, deduplication, invalid formats
 *   - resolveReference (file): happy path, missing file, binary, large file truncation
 *   - resolveReference (folder): happy path, missing folder, large directory limit
 *   - Path traversal prevention (../, absolute paths, empty path, symlinks outside workspace)
 *   - task/goal references return null (stubs pending Task 3.1)
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReferenceResolver } from '../../src/lib/agent/reference-resolver';
import type { ResolutionContext } from '../../src/lib/agent/reference-resolver';
import type { ResolvedFileReference, ResolvedFolderReference } from '@neokai/shared';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

async function createWorkspace(): Promise<string> {
	const dir = join(
		tmpdir(),
		`ref-resolver-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	await mkdir(dir, { recursive: true });
	return dir;
}

function assertFileResult(
	result: Awaited<ReturnType<ReferenceResolver['resolveReference']>>
): asserts result is ResolvedFileReference {
	if (result?.type !== 'file') {
		throw new Error(`Expected file result, got: ${result?.type ?? 'null'}`);
	}
}

function assertFolderResult(
	result: Awaited<ReturnType<ReferenceResolver['resolveReference']>>
): asserts result is ResolvedFolderReference {
	if (result?.type !== 'folder') {
		throw new Error(`Expected folder result, got: ${result?.type ?? 'null'}`);
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('ReferenceResolver', () => {
	let workspace: string;
	let resolver: ReferenceResolver;
	let ctx: ResolutionContext;

	beforeEach(async () => {
		workspace = await createWorkspace();
		resolver = new ReferenceResolver();
		ctx = { workspacePath: workspace };
	});

	afterEach(async () => {
		await rm(workspace, { recursive: true, force: true });
	});

	// ──────────────────────────────────────────────────────────────────────────
	// extractReferences
	// ──────────────────────────────────────────────────────────────────────────

	describe('extractReferences', () => {
		it('parses a file reference', () => {
			const mentions = resolver.extractReferences('Look at @ref{file:src/utils.ts}');
			expect(mentions).toHaveLength(1);
			expect(mentions[0]).toEqual({
				type: 'file',
				id: 'src/utils.ts',
				displayText: '@ref{file:src/utils.ts}',
			});
		});

		it('parses a folder reference', () => {
			const mentions = resolver.extractReferences('Browse @ref{folder:src/components}');
			expect(mentions).toHaveLength(1);
			expect(mentions[0].type).toBe('folder');
			expect(mentions[0].id).toBe('src/components');
		});

		it('parses a task reference', () => {
			const mentions = resolver.extractReferences('Fix @ref{task:t-42}');
			expect(mentions).toHaveLength(1);
			expect(mentions[0].type).toBe('task');
			expect(mentions[0].id).toBe('t-42');
		});

		it('parses a goal reference', () => {
			const mentions = resolver.extractReferences('Goal: @ref{goal:g-7}');
			expect(mentions).toHaveLength(1);
			expect(mentions[0].type).toBe('goal');
		});

		it('parses multiple references in one string', () => {
			const text = '@ref{file:a.ts} and @ref{folder:src} and @ref{task:t-1}';
			const mentions = resolver.extractReferences(text);
			expect(mentions).toHaveLength(3);
		});

		it('deduplicates identical mentions', () => {
			const text = '@ref{file:a.ts} @ref{file:a.ts} @ref{file:a.ts}';
			const mentions = resolver.extractReferences(text);
			expect(mentions).toHaveLength(1);
		});

		it('returns empty array for text with no references', () => {
			expect(resolver.extractReferences('Hello world')).toHaveLength(0);
			expect(resolver.extractReferences('')).toHaveLength(0);
		});

		it('ignores unknown reference types', () => {
			const mentions = resolver.extractReferences('@ref{unknown:foo}');
			expect(mentions).toHaveLength(0);
		});

		it('does not match partial or malformed patterns', () => {
			expect(resolver.extractReferences('@ref{file}')).toHaveLength(0); // no id
			expect(resolver.extractReferences('@ref{:id}')).toHaveLength(0); // empty type
			expect(resolver.extractReferences('ref{file:a.ts}')).toHaveLength(0); // no @
		});

		it('preserves displayText as the full @ref{} string', () => {
			const [m] = resolver.extractReferences('@ref{file:path/to/file.ts}');
			expect(m.displayText).toBe('@ref{file:path/to/file.ts}');
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	// resolveReference — file
	// ──────────────────────────────────────────────────────────────────────────

	describe('resolveReference — file', () => {
		it('resolves a text file to its content and metadata', async () => {
			await writeFile(join(workspace, 'hello.txt'), 'Hello World');

			const result = await resolver.resolveReference(
				{ type: 'file', id: 'hello.txt', displayText: '@ref{file:hello.txt}' },
				ctx
			);

			assertFileResult(result);
			expect(result.data.content).toBe('Hello World');
			expect(result.data.binary).toBe(false);
			expect(result.data.size).toBe(11);
			expect(result.data.path).toBe('hello.txt');
			expect(result.data.mtime).toBeDefined();
		});

		it('resolves a nested file path', async () => {
			await mkdir(join(workspace, 'src', 'lib'), { recursive: true });
			await writeFile(join(workspace, 'src', 'lib', 'utils.ts'), 'export const x = 1;');

			const result = await resolver.resolveReference(
				{ type: 'file', id: 'src/lib/utils.ts', displayText: '@ref{file:src/lib/utils.ts}' },
				ctx
			);

			assertFileResult(result);
			expect(result.data.content).toBe('export const x = 1;');
		});

		it('returns null for a non-existent file', async () => {
			const result = await resolver.resolveReference(
				{ type: 'file', id: 'missing.txt', displayText: '@ref{file:missing.txt}' },
				ctx
			);
			expect(result).toBeNull();
		});

		it('returns null when referencing a directory as a file', async () => {
			await mkdir(join(workspace, 'src'), { recursive: true });

			const result = await resolver.resolveReference(
				{ type: 'file', id: 'src', displayText: '@ref{file:src}' },
				ctx
			);
			expect(result).toBeNull();
		});

		it('marks text files as non-binary', async () => {
			await writeFile(join(workspace, 'text.ts'), 'const a = 1;');

			const result = await resolver.resolveReference(
				{ type: 'file', id: 'text.ts', displayText: '@ref{file:text.ts}' },
				ctx
			);

			assertFileResult(result);
			expect(result.data.binary).toBe(false);
		});

		it('marks binary files with binary:true and null content', async () => {
			// Write a file with null bytes (binary signature)
			const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
			await writeFile(join(workspace, 'image.png'), binaryContent);

			const result = await resolver.resolveReference(
				{ type: 'file', id: 'image.png', displayText: '@ref{file:image.png}' },
				ctx
			);

			assertFileResult(result);
			expect(result.data.binary).toBe(true);
			expect(result.data.content).toBeNull();
		});

		it('truncates large text files at a line boundary', async () => {
			// Build a file > 50KB: many lines of 100 bytes each
			const lineContent = 'x'.repeat(99) + '\n'; // 100 bytes per line
			const totalLines = 600; // ~60KB total
			await writeFile(join(workspace, 'big.txt'), lineContent.repeat(totalLines));

			const result = await resolver.resolveReference(
				{ type: 'file', id: 'big.txt', displayText: '@ref{file:big.txt}' },
				ctx
			);

			assertFileResult(result);
			expect(result.data.size).toBeGreaterThan(50 * 1024);
			expect(result.data.truncated).toBe(true);
			expect(result.data.content).not.toBeNull();
			expect(Buffer.byteLength(result.data.content as string, 'utf-8')).toBeLessThanOrEqual(
				50 * 1024
			);
			if ((result.data.content as string).length > 0) {
				expect((result.data.content as string).endsWith('\n')).toBe(true);
			}
		});

		it('returns full content for files exactly at the 50KB limit', async () => {
			const content = 'a'.repeat(50 * 1024);
			await writeFile(join(workspace, 'exact.txt'), content);

			const result = await resolver.resolveReference(
				{ type: 'file', id: 'exact.txt', displayText: '@ref{file:exact.txt}' },
				ctx
			);

			assertFileResult(result);
			expect(result.data.content).toBe(content);
			expect(result.data.truncated).toBe(false);
		});

		it('handles empty files', async () => {
			await writeFile(join(workspace, 'empty.txt'), '');

			const result = await resolver.resolveReference(
				{ type: 'file', id: 'empty.txt', displayText: '@ref{file:empty.txt}' },
				ctx
			);

			assertFileResult(result);
			expect(result.data.content).toBe('');
			expect(result.data.size).toBe(0);
		});

		it('handles unicode content correctly', async () => {
			const text = '// 你好世界\nconst x = "🌍";\n';
			await writeFile(join(workspace, 'unicode.ts'), text);

			const result = await resolver.resolveReference(
				{ type: 'file', id: 'unicode.ts', displayText: '@ref{file:unicode.ts}' },
				ctx
			);

			assertFileResult(result);
			expect(result.data.content).toBe(text);
		});

		it('works without room or space context', async () => {
			await writeFile(join(workspace, 'standalone.txt'), 'content');

			const result = await resolver.resolveReference(
				{ type: 'file', id: 'standalone.txt', displayText: '@ref{file:standalone.txt}' },
				{ workspacePath: workspace }
			);

			expect(result).not.toBeNull();
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	// resolveReference — folder
	// ──────────────────────────────────────────────────────────────────────────

	describe('resolveReference — folder', () => {
		it('resolves a folder to its file listing', async () => {
			await mkdir(join(workspace, 'src'), { recursive: true });
			await writeFile(join(workspace, 'src', 'a.ts'), 'a');
			await writeFile(join(workspace, 'src', 'b.ts'), 'b');

			const result = await resolver.resolveReference(
				{ type: 'folder', id: 'src', displayText: '@ref{folder:src}' },
				ctx
			);

			assertFolderResult(result);
			expect(result.data.path).toBe('src');
			expect(result.data.entries).toHaveLength(2);
		});

		it('returns null for a non-existent folder', async () => {
			const result = await resolver.resolveReference(
				{ type: 'folder', id: 'missing', displayText: '@ref{folder:missing}' },
				ctx
			);
			expect(result).toBeNull();
		});

		it('returns null when referencing a file as a folder', async () => {
			await writeFile(join(workspace, 'file.txt'), 'content');

			const result = await resolver.resolveReference(
				{ type: 'folder', id: 'file.txt', displayText: '@ref{folder:file.txt}' },
				ctx
			);
			expect(result).toBeNull();
		});

		it('limits large directories to 200 entries', async () => {
			await mkdir(join(workspace, 'big'), { recursive: true });
			for (let i = 0; i < 250; i++) {
				await writeFile(join(workspace, 'big', `file${i}.txt`), String(i));
			}

			const result = await resolver.resolveReference(
				{ type: 'folder', id: 'big', displayText: '@ref{folder:big}' },
				ctx
			);

			assertFolderResult(result);
			expect(result.data.entries).toHaveLength(200);
		});

		it('returns all entries for directories with fewer than 200 files', async () => {
			await mkdir(join(workspace, 'small'), { recursive: true });
			for (let i = 0; i < 5; i++) {
				await writeFile(join(workspace, 'small', `f${i}.txt`), String(i));
			}

			const result = await resolver.resolveReference(
				{ type: 'folder', id: 'small', displayText: '@ref{folder:small}' },
				ctx
			);

			assertFolderResult(result);
			expect(result.data.entries).toHaveLength(5);
		});

		it('handles empty directories', async () => {
			await mkdir(join(workspace, 'empty'), { recursive: true });

			const result = await resolver.resolveReference(
				{ type: 'folder', id: 'empty', displayText: '@ref{folder:empty}' },
				ctx
			);

			assertFolderResult(result);
			expect(result.data.entries).toHaveLength(0);
		});

		it('works without room or space context', async () => {
			await mkdir(join(workspace, 'lib'), { recursive: true });
			await writeFile(join(workspace, 'lib', 'index.ts'), 'export {}');

			const result = await resolver.resolveReference(
				{ type: 'folder', id: 'lib', displayText: '@ref{folder:lib}' },
				{ workspacePath: workspace }
			);

			expect(result).not.toBeNull();
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	// Path traversal prevention
	// ──────────────────────────────────────────────────────────────────────────

	describe('path traversal prevention', () => {
		it('rejects empty file path', async () => {
			const result = await resolver.resolveReference(
				{ type: 'file', id: '', displayText: '@ref{file:}' },
				ctx
			);
			expect(result).toBeNull();
		});

		it('rejects empty folder path', async () => {
			const result = await resolver.resolveReference(
				{ type: 'folder', id: '', displayText: '@ref{folder:}' },
				ctx
			);
			expect(result).toBeNull();
		});

		it('rejects file path with .. segment', async () => {
			const result = await resolver.resolveReference(
				{ type: 'file', id: '../secret.txt', displayText: '@ref{file:../secret.txt}' },
				ctx
			);
			expect(result).toBeNull();
		});

		it('rejects file path with embedded ..', async () => {
			const result = await resolver.resolveReference(
				{
					type: 'file',
					id: 'src/../../../etc/passwd',
					displayText: '@ref{file:src/../../../etc/passwd}',
				},
				ctx
			);
			expect(result).toBeNull();
		});

		it('rejects absolute file path', async () => {
			const result = await resolver.resolveReference(
				{ type: 'file', id: '/etc/passwd', displayText: '@ref{file:/etc/passwd}' },
				ctx
			);
			expect(result).toBeNull();
		});

		it('rejects folder path with ..', async () => {
			const result = await resolver.resolveReference(
				{ type: 'folder', id: '../outside', displayText: '@ref{folder:../outside}' },
				ctx
			);
			expect(result).toBeNull();
		});

		it('rejects absolute folder path', async () => {
			const result = await resolver.resolveReference(
				{ type: 'folder', id: '/tmp', displayText: '@ref{folder:/tmp}' },
				ctx
			);
			expect(result).toBeNull();
		});

		it('rejects a symlink pointing outside the workspace', async () => {
			const linkPath = join(workspace, 'evil-link');
			await symlink(tmpdir(), linkPath);

			const result = await resolver.resolveReference(
				{ type: 'folder', id: 'evil-link', displayText: '@ref{folder:evil-link}' },
				ctx
			);
			expect(result).toBeNull();
		});

		it('rejects a file symlink pointing outside the workspace', async () => {
			const linkPath = join(workspace, 'evil-file');
			try {
				await symlink('/etc/hosts', linkPath);
			} catch {
				// /etc/hosts not available in this environment — skip
				return;
			}

			const result = await resolver.resolveReference(
				{ type: 'file', id: 'evil-file', displayText: '@ref{file:evil-file}' },
				ctx
			);
			expect(result).toBeNull();
		});

		it('allows legitimate paths within the workspace', async () => {
			await mkdir(join(workspace, 'src', 'lib'), { recursive: true });
			await writeFile(join(workspace, 'src', 'lib', 'utils.ts'), 'ok');

			const result = await resolver.resolveReference(
				{ type: 'file', id: 'src/lib/utils.ts', displayText: '@ref{file:src/lib/utils.ts}' },
				ctx
			);
			expect(result).not.toBeNull();
		});

		it('allows symlinks that point within the workspace', async () => {
			await mkdir(join(workspace, 'real'), { recursive: true });
			await writeFile(join(workspace, 'real', 'file.txt'), 'hello');
			await symlink(join(workspace, 'real'), join(workspace, 'link-within'));

			const result = await resolver.resolveReference(
				{ type: 'folder', id: 'link-within', displayText: '@ref{folder:link-within}' },
				ctx
			);
			expect(result).not.toBeNull();
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	// Task / goal references (stubs)
	// ──────────────────────────────────────────────────────────────────────────

	describe('task and goal references', () => {
		it('returns null for task references (not yet implemented)', async () => {
			const result = await resolver.resolveReference(
				{ type: 'task', id: 't-42', displayText: '@ref{task:t-42}' },
				ctx
			);
			expect(result).toBeNull();
		});

		it('returns null for goal references (not yet implemented)', async () => {
			const result = await resolver.resolveReference(
				{ type: 'goal', id: 'g-7', displayText: '@ref{goal:g-7}' },
				ctx
			);
			expect(result).toBeNull();
		});
	});

	// ──────────────────────────────────────────────────────────────────────────
	// resolveAllReferences
	// ──────────────────────────────────────────────────────────────────────────

	describe('resolveAllReferences', () => {
		it('resolves all valid references in a text', async () => {
			await writeFile(join(workspace, 'a.ts'), 'const a = 1;');
			await mkdir(join(workspace, 'lib'), { recursive: true });
			await writeFile(join(workspace, 'lib', 'b.ts'), 'export {};');

			const text = 'Check @ref{file:a.ts} and @ref{folder:lib}';
			const result = await resolver.resolveAllReferences(text, ctx);

			expect(Object.keys(result)).toHaveLength(2);
			expect(result['@ref{file:a.ts}'].type).toBe('file');
			expect(result['@ref{folder:lib}'].type).toBe('folder');
		});

		it('returns empty object for text with no references', async () => {
			const result = await resolver.resolveAllReferences('plain text', ctx);
			expect(Object.keys(result)).toHaveLength(0);
		});

		it('skips unresolvable references without throwing', async () => {
			const result = await resolver.resolveAllReferences(
				'@ref{file:missing.txt} and @ref{file:../escape}',
				ctx
			);
			expect(Object.keys(result)).toHaveLength(0);
		});

		it('returns partial results when some references fail', async () => {
			await writeFile(join(workspace, 'good.txt'), 'ok');

			const text = '@ref{file:good.txt} @ref{file:bad.txt}';
			const result = await resolver.resolveAllReferences(text, ctx);

			expect(result['@ref{file:good.txt}']).toBeDefined();
			expect(result['@ref{file:bad.txt}']).toBeUndefined();
		});
	});
});
