import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ingestLlmWiki, initLlmWiki } from '../../src/wiki/llmwiki.js';

/**
 * **`ingest` renders a stub, so it must never be written over a page that exists.**
 *
 * Measured while walking a real change: `wiki ingest --from .llmwiki/concepts/a-check-that-can-only-pass.md` replaced the
 * page of that name — 3,535 bytes of written concept — with 355 bytes of generated summary, and registered a duplicate
 * governed record for it. The original survived only because the raw copy under `raw/docs/` happened to hold it, which is
 * luck, not a backup: the raw copy is a copy of an *external* source and is refreshed on every ingest.
 *
 * A destructive write that looks like an import is the worst shape for it, because bringing a document into the wiki
 * sounds additive. The refusal names the routes that do say what they do.
 */
let root: string;

afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
});

describe('ingest refuses to overwrite an existing page', () => {
    it('leaves the page byte-identical and reports the refusal', async () => {
        root = await mkdtemp(join(tmpdir(), 'kata-ingest-refusal-'));
        await mkdir(join(root, 'docs'), { recursive: true });
        await writeFile(join(root, 'docs/seed.md'), '# Seed\n', 'utf8');
        await initLlmWiki({ root, from: join(root, 'docs') });
        const page = join(root, '.llmwiki/concepts/notes.md');
        await mkdir(join(root, '.llmwiki/concepts'), { recursive: true });
        const original = '# Notes\n\nThe real content, written by a person and not generated.\n';
        await writeFile(page, original, 'utf8');

        const source = join(root, 'notes.md');
        await writeFile(source, '# Notes\n\nA source document with the same slug.\n', 'utf8');

        const result = await ingestLlmWiki({ root, from: source });

        // Nothing was written over the page, and the refusal says why and what to do.
        expect(result.pagesWritten).toEqual([]);
        expect(result.refused).toHaveLength(1);
        expect(result.refused[0]?.page).toBe('concepts/notes.md');
        expect(result.refused[0]?.reason).toContain('revalidate');
        await expect(readFile(page, 'utf8')).resolves.toBe(original);
        // And no governed record was registered for a page that was not written.
        expect(result.governedRecords).toEqual([]);
    });

    it('still imports a source whose slug has no page yet', async () => {
        // The other direction: the refusal must not make ingest unusable.
        root = await mkdtemp(join(tmpdir(), 'kata-ingest-import-'));
        await mkdir(join(root, 'docs'), { recursive: true });
        await writeFile(join(root, 'docs/seed.md'), '# Seed\n', 'utf8');
        await initLlmWiki({ root, from: join(root, 'docs') });
        const source = join(root, 'fresh.md');
        await writeFile(source, '# Fresh\n\nA document nobody has imported before.\n', 'utf8');

        const result = await ingestLlmWiki({ root, from: source });

        expect(result.refused).toEqual([]);
        expect(result.pagesWritten).toEqual(['concepts/fresh.md']);
        expect(result.governedRecords).toEqual(['llmwiki-fresh']);
    });
});
