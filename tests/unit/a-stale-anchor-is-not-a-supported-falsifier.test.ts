import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyAll } from '../../src/producers/verifiers.js';
import { buildContext } from '../../src/store/verify-context.js';
import { locateAnchor } from '../../src/quality/falsifier-anchors.js';
import type { VerifyContext } from '../../src/producers/port.js';

/**
 * **A falsifier whose anchor no longer matches its file proves nothing, and it says so instead of producing a verdict.**
 *
 * Measured on this repository's own instruments: one declared falsifier reddened because its `replace` string was a syntax
 * error (it proved nothing about the property it named), one silently failed to apply after the site moved and was read as a
 * green guard, and four more went `inconclusive` in a single round when a repair moved their anchors. `String.replace` with a
 * string pattern returns the input unchanged when the pattern is absent, and replaces only the **first** match when it is not —
 * so an anchor that matches zero or two times is an instrument that cannot mean what it claims, whichever way the check then
 * exits.
 */
const item = (mutation: { find: string; replace: string }) => ({
    id: 'E1',
    type: 'executable_falsifier' as const,
    command: 'true',
    mutation: { file: 'a.ts', ...mutation },
});

async function contextWith(files: Record<string, string>, overrides: Partial<VerifyContext> = {}): Promise<VerifyContext> {
    const root = await mkdtemp(join(tmpdir(), 'kata-anchor-'));
    const base = buildContext(root, { revision: `rev:${'a'.repeat(16)}`, pathDigests: { 'a.ts': 'a'.repeat(64) } }, { timeoutMs: 5000, producer: 'fixture' as never }) as unknown as VerifyContext;
    return {
        ...base,
        root,
        identity: async () => 'mem:1',
        mutationWriteRefusal: undefined,
        readText: async (path: string) => files[path] ?? null,
        writeText: async (path: string, content: string) => { files[path] = content; },
        run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
        ...overrides,
    } as unknown as VerifyContext;
}

describe('a stale anchor is not a supported falsifier', () => {
    it('tells an absent anchor from an ambiguous one', () => {
        expect(locateAnchor('const x = 1;\n', 'const x = 1;')).toEqual({ kind: 'unique' });
        expect(locateAnchor('const x = 1;\n', 'const y = 2;')).toEqual({ kind: 'absent' });
        // Two matches is the dangerous shape: `String.replace` edits the first one, so the check may redden at a site the
        // falsifier never named — or not redden at all — while its verdict reads as a statement about the property.
        expect(locateAnchor('const x = 1;\nconst x = 1;\n', 'const x = 1;')).toEqual({ kind: 'ambiguous', count: 2 });
    });

    it('reads an anchor that matches nothing as unverifiable, naming the anchor', async () => {
        const verdicts = await verifyAll([item({ find: 'const gone = 1;', replace: 'const gone = 2;' })], await contextWith({ 'a.ts': 'const x = 1;\n' }));
        expect(verdicts).toHaveLength(1);
        expect(verdicts[0].verdict).toBe('inconclusive');
        const observed = String((verdicts[0] as { observed?: string }).observed);
        expect(observed).toContain('const gone = 1;');
        expect(observed).toMatch(/0 times|does not match|absent/);
    }, 60_000);

    it('reads an anchor that matches twice as unverifiable, naming how many times', async () => {
        const verdicts = await verifyAll([item({ find: 'const x = 1;', replace: 'const x = 2;' })], await contextWith({ 'a.ts': 'const x = 1;\nconst x = 1;\n' }));
        expect(verdicts[0].verdict).toBe('inconclusive');
        expect(String((verdicts[0] as { observed?: string }).observed)).toMatch(/2 times/);
    }, 60_000);

    it('still gives a verdict for an anchor that matches exactly once', async () => {
        // The control: the rule must refuse only anchors that cannot carry the meaning, never a legal falsifier.
        const files: Record<string, string> = { 'a.ts': 'const x = 1;\n' };
        let calls = 0;
        const verdicts = await verifyAll(
            [item({ find: 'const x = 1;', replace: 'const x = 2;' })],
            // Three runs: the check passes before any mutation, fails under it, and passes again after the restore — the shape a
            // falsifier has to have to be a falsifier at all.
            await contextWith(files, { run: async () => { calls += 1; return { code: calls === 2 ? 1 : 0, stdout: '', stderr: '', timedOut: false }; } }),
        );
        expect(verdicts[0].verdict, JSON.stringify(verdicts[0])).toBe('supported');
        expect(files['a.ts']).toBe('const x = 1;\n');
    }, 60_000);
});
