import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyAll } from '../../src/producers/verifiers.js';
import { buildContext } from '../../src/store/verify-context.js';
import type { VerifyContext } from '../../src/producers/port.js';

/**
 * **A restore that cannot be trusted is named, not reported as a verdict.**
 *
 * The verification cycle injects a defect, runs the check and writes the original back. If the file no longer holds what
 * this run wrote, the checkout is not as it was found — and a verdict about the *check* would hide that, because an
 * operator reading `inconclusive` has no reason to look at the tree.
 */
const item = {
    id: 'E1',
    type: 'executable_falsifier' as const,
    command: 'true',
    mutation: { file: 'a.ts', find: 'const x = 1;', replace: 'const x = 2;' },
};

async function contextWith(overrides: Partial<VerifyContext> & { files: Record<string, string> }): Promise<VerifyContext> {
    const root = await mkdtemp(join(tmpdir(), 'kata-restore-'));
    const files = overrides.files;
    // The real context, so the case exercises the code that runs in production rather than a hand-built port.
    const base = buildContext(root, { revision: `rev:${'a'.repeat(16)}`, pathDigests: { 'a.ts': 'a'.repeat(64) } }, { timeoutMs: 5000, producer: 'fixture' as never }) as unknown as VerifyContext;
    return {
        ...base,
        root,
        // **A memory-backed context declares its own identity.** The base is the real one, which reports a real inode for a
        // path in the temp root; these cases put their files in a map instead, so the inherited reader would answer `null`
        // for every path and the cycle would refuse for a reason the case is not about.
        identity: async () => 'mem:1',
        readText: async (path: string) => files[path] ?? null,
        writeText: async (path: string, content: string) => { files[path] = content; },
        run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
        ...overrides,
    } as unknown as VerifyContext;
}

describe('an unrestored mutation is named', () => {
    it('fails the run and names the file when the restore write does not land', async () => {
        // The smallest real reproduction of "the restore cannot be trusted": the second write is the restore, and it fails.
        // The run must fail and name the file — a verdict about the check would hide a tree that still holds the defect.
        const files: Record<string, string> = { 'a.ts': 'const x = 1;\n' };
        let writes = 0;
        const context = await contextWith({
            files,
            writeText: async (path: string, content: string) => {
                writes += 1;
                if (writes === 2) throw new Error('the path became un-writable');
                files[path] = content;
            },
        });

        const failure = await verifyAll([item], context).then(() => undefined, (error: Error) => error);
        expect(String(failure?.message)).toContain('could not be restored');
        expect(String(failure?.message)).toContain('a.ts');
        expect(String(failure?.message)).toContain('un-writable');
    });

    it('leaves a normal cycle alone: the file is back to its original bytes', async () => {
        const files: Record<string, string> = { 'a.ts': 'const x = 1;\n' };
        const context = await contextWith({ files });
        await verifyAll([item], context);
        expect(files['a.ts']).toBe('const x = 1;\n');
    });
});
