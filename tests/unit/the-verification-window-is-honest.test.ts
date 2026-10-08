import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyAll } from '../../src/producers/verifiers.js';
import type { VerifyContext } from '../../src/producers/port.js';

/**
 * **A reading has to say what it ran.**
 *
 * Every falsifier persisted the same `{"before":0,"mutated":1,"after":0}`, so four readings were indistinguishable in the
 * store: a reader could not tell which mutation produced which verdict. The observed string now carries the evidence id and
 * the mutated file, which is what makes the record answer "which reading is this".
 */
const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('a reading names its falsifier', () => {
    it('records the evidence id and the mutated file in the observation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-observed-'));
        roots.push(root);
        const file = 'a.ts';
        await writeFile(join(root, file), 'const x = 1;\n');
        const context = {
            root,
            subject: { revision: `rev:${'a'.repeat(16)}`, pathDigests: { [file]: 'a'.repeat(64) } },
            run: async () => {
                const content = await readFile(join(root, file), 'utf8');
                return { code: content.includes('const x = 2;') ? 1 : 0, stdout: '', stderr: '', timedOut: false };
            },
            now: () => '2026-10-08T00:00:00.000Z',
            producer: () => 'fixture',
            readText: async (path: string) => (path === file ? await readFile(join(root, file), 'utf8') : null),
            writeText: async (path: string, content: string) => { if (path === file) await writeFile(join(root, file), content); },
        } as unknown as VerifyContext;
        const item = { id: 'E7', type: 'executable_falsifier' as const, command: 'true', mutation: { file, find: 'const x = 1;', replace: 'const x = 2;' } };

        const verdicts = await verifyAll([item], context);
        expect(verdicts[0].observed).toContain('E7');
        expect(verdicts[0].observed).toContain(file);
    });
});
