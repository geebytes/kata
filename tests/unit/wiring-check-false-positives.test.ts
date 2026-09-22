import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findUnconsumedDeclaredMembers, findUnreferencedExports } from '../../src/quality/wiring-check.js';

/**
 * Two false-positive classes an independent pass found in the checks, both measured rather than argued.
 *
 * f1: the reference check searched `src` only while its finding said "no reference **anywhere in the repository**" — and
 * `scripts/wiring-check.mjs` consumes an export of the file being checked, so the change's own consumer was reported as
 * dead. f6: the declared-member check counted quoted literals, so a member consumed through its list
 * (`modes.includes(mode)`, `[...unmeasuredMetrics]`, `parsed[field]`) was reported as consumed nowhere — the opposite of
 * the rule the changelog states.
 */
const cleanup: string[] = [];

async function fixture(id: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `kata-wiring-fp-${id}-`));
    cleanup.push(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(
        join(root, 'src/x.ts'),
        [
            'export function usedFromScript(): number { return 1; }',
            'export function referencedNowhere(): number { return 2; }',
            "export const modes = ['standard', 'tdd'] as const;",
            'export function pick(mode: string): boolean { return modes.includes(mode); }',
            "export const unusedList = ['z'] as const;",
            '',
        ].join('\n'),
        'utf8',
    );
    // A hand-written production consumer outside `src`: the surface the old default could not see.
    await writeFile(join(root, 'src/entry.ts'), 'export function entryOnly(): number { return 3; }\n', 'utf8');
    await writeFile(
        join(root, 'scripts/run.mjs'),
        [
            "import { usedFromScript } from '../src/x.ts';",
            'console.log(usedFromScript);',
            // The declaration the classification reads: this wrapper bundles `src/entry.ts` and would call its
            // exports by minified names, exactly as `scripts/wiring-check.mjs` does with `module.n`.
            "const options = { entryPoints: [resolve(here, '..', 'src', 'entry.ts')] };",
            '',
        ].join('\n'),
        'utf8',
    );
    return root;
}

describe('the checks do not report a symbol that something consumes', () => {
    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('sees a production consumer outside src, and names the surface it searched', async () => {
        const root = await fixture('reference');
        const findings = await findUnreferencedExports({ root, surface: ['src/x.ts'] });
        const subjects = findings.map((finding) => finding.subject);

        expect(subjects).toContain('referencedNowhere');
        // The consumer lives in `scripts/`, so this is not a finding — and the old default reported it as one.
        expect(subjects).not.toContain('usedFromScript');

        // The claim is bounded by what was searched: "anywhere in the repository" was false.
        const detail = findings.find((finding) => finding.subject === 'referencedNowhere')?.detail ?? '';
        expect(detail).toMatch(/no reference in src, scripts/);
        expect(detail).not.toMatch(/anywhere in the repository/);
    });

    it('does not report a member whose list is consumed by iteration', async () => {
        const root = await fixture('declared-member');
        const subjects = (await findUnconsumedDeclaredMembers({ root, surface: ['src/x.ts'] })).map((finding) => finding.subject);

        // `modes` is consumed by `.includes(mode)` — no member is ever named, and both are consumed as a set.
        expect(subjects).not.toContain('standard');
        expect(subjects).not.toContain('tdd');
        // The control: a list nothing consumes still reports its members, so this is not a blanket silence.
        expect(subjects).toContain('z');
    });
    it('reports a build-consumed export as its own class, and does not let it gate', async () => {
        const root = await fixture('via-build');
        const findings = await findUnreferencedExports({ root, surface: ['src/entry.ts'] });
        const entry = findings.find((finding) => finding.subject === 'entryOnly');

        // Reported — the fact is auditable rather than hidden in a document.
        expect(entry?.check).toBe('reference-via-build');
        expect(entry?.detail).toMatch(/consumed by scripts\/run\.mjs/);
        expect(entry?.detail).not.toMatch(/anywhere in the repository/);
    });
});
