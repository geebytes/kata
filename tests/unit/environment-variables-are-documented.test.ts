import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every environment variable kata reads is documented, and the document lists nothing it does not read.
 *
 * Four of the five variables were discoverable only by reading changelogs: each was added for a real problem (a hanging
 * git operation, a runtime refresh with an undocumented 60 s cap, a CodeGraph rebuild that shared a sync's budget, the
 * response language) and each was documented in the entry that introduced it — which is not where a reader looks. This is
 * the same rule as the generated assets and the schema kinds: what is written twice drifts, so the source of truth (the
 * code) is what the test reads.
 */
describe('the environment reference matches what the code reads', () => {
    it('documents every KATA_ variable the source reads, and only those', async () => {
        const roots = ['src'];
        const variables = new Set<string>();
        const { readdir } = await import('node:fs/promises');
        const walk = async (directory: string): Promise<string[]> => {
            const entries = await readdir(join(process.cwd(), directory), { withFileTypes: true });
            const files: string[] = [];
            for (const entry of entries) {
                const path = `${directory}/${entry.name}`;
                if (entry.isDirectory()) files.push(...(await walk(path)));
                else if (entry.name.endsWith('.ts')) files.push(path);
            }
            return files;
        };
        for (const root of roots) {
            for (const file of await walk(root)) {
                const text = await readFile(join(process.cwd(), file), 'utf8');
                for (const match of text.matchAll(/(?:process\.env|inherited)\.(KATA_[A-Z_]+)/g)) variables.add(match[1]!);
            }
        }

        const docs = await readFile(join(process.cwd(), 'docs/operations.md'), 'utf8');
        const section = docs.slice(docs.indexOf('## Environment variables'), docs.indexOf('## Worktrees'));
        const documented = new Set([...section.matchAll(/`(KATA_[A-Z_]+)`/g)].map((match) => match[1]!));

        // Every variable the code reads has a row…
        expect([...variables].filter((name) => !documented.has(name))).toEqual([]);
        // …and every row is a variable the code reads, so the reference cannot outlive the code either.
        expect([...documented].filter((name) => !variables.has(name))).toEqual([]);
    });
});
