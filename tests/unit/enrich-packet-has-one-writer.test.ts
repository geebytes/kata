import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **AC-2: the packet has one writer, so two callers cannot produce two packets.**
 *
 * The packet was written from `src/adapters/ownership.ts` (install) and `src/wiki/llmwiki.ts` (wiki rebuild), each
 * constructing the path itself. Two constructions of one path is the shape this repository removes most often — a fact
 * with two entrances, where correcting one leaves the other saying something else.
 *
 * The check is a text scan because the invariant is about the *shape of the source*, not about a value: it must be
 * impossible to add a second construction without this failing. That is the same technique `kernel-purity` and
 * `generated-skills-name-live-commands` use, and for the same reason — a runtime test cannot observe a call path nobody
 * takes.
 */
const SRC = new URL('../../src/', import.meta.url).pathname;

async function sourceFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
        else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
}

describe('the enrichment packet has exactly one writer', () => {
    it('constructs the packet name in exactly one module', async () => {
        const files = await sourceFiles(SRC);
        const mentioning: string[] = [];
        for (const file of files) {
            const text = await readFile(file, 'utf8');
            if (text.includes('wiki-enrich-task-packet')) mentioning.push(file.replace(SRC, 'src/'));
        }
        // Exactly one module knows the file's name: the layout module, which owns where an artefact lives. A second
        // mentions it means somebody constructed the path again, which is what made two packets possible.
        expect(
            mentioning.sort(),
            'the packet name must be constructed in one place, so a second caller cannot build its own path',
        ).toEqual(['src/core/layout.ts']);
    });

    it('routes both former callers through the writer', async () => {
        // The two call sites that built their own path. Each must now call the writer, and neither may keep a construction.
        for (const file of ['src/adapters/ownership.ts', 'src/wiki/llmwiki.ts']) {
            const text = await readFile(join(SRC, file.replace('src/', '')), 'utf8');
            expect(text, `${file} must call the single writer`).toContain('writeWikiEnrichPacket');
            // Not `not.toContain('task-packet')`: both files legitimately *speak* about the packet — a log line, a docblock —
            // and a check that cannot tell a description from a construction would be satisfied by deleting the prose.
            expect(text, `${file} must not name a task id for a packet that is not a task`).not.toContain("'wiki-enrich'");
            expect(
                text.split('\n').filter((line) => /writeFile\([^)]*[Tt]ask-?[Pp]acket/.test(line)),
                `${file} must not write the packet itself`,
            ).toEqual([]);
        }
    });

    it('does not create a task directory for a packet that is not a task', async () => {
        // The literal that produced the phantom task: a task id used to build a path without a task existing.
        const files = await sourceFiles(SRC);
        const offenders: string[] = [];
        for (const file of files) {
            const text = await readFile(file, 'utf8');
            if (/taskDir\([^)]*'wiki-enrich'/.test(text) || /layoutTaskDir\([^)]*'wiki-enrich'/.test(text)) {
                offenders.push(file.replace(SRC, 'src/'));
            }
        }
        expect(offenders, 'a directory in the task store is built from a task id, so a non-task must not be named like one').toEqual([]);
    });
});
