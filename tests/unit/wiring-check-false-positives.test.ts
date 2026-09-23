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
    await writeFile(join(root, 'scripts/run.mjs'), "import { usedFromScript } from '../src/x.ts';\nconsole.log(usedFromScript);\n", 'utf8');
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
});

/**
 * wcc2-f4: the f6 repair traded a false positive for a **false negative**, which is the worse direction.
 *
 * f6's fix decided "is this list consumed by iteration?" by counting occurrences of the list's name — in raw text. So a
 * **comment** that merely mentions the list made every member count as consumed, and the check stopped reporting members
 * nothing consumes. Both directions now have a test, because a one-directional fix is what produced this.
 */
describe('neither a comment nor a string consumes a declaration', () => {
    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('still reports a member whose list appears only in a comment', async () => {
        const root = await fixture('comment-only');
        const { writeFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        await writeFile(
            join(root, 'src/mentioned.ts'),
            [
                "export const labels = ['only-a-comment'] as const;",
                '// the labels list above is described here, and a reader might think that is a use',
                'export const other = 1;',
                '',
            ].join('\n'),
            'utf8',
        );

        const subjects = (await findUnconsumedDeclaredMembers({ root, surface: ['src/mentioned.ts'] })).map((f) => f.subject);
        // The comment mentions the list and the member, and neither is a consumer.
        expect(subjects).toContain('only-a-comment');
    });

    it('still accepts a member its list consumes by iteration', async () => {
        const root = await fixture('iteration');
        const subjects = (await findUnconsumedDeclaredMembers({ root, surface: ['src/x.ts'] })).map((f) => f.subject);
        // The control from f6, kept: `modes.includes(mode)` names no member, and both are consumed as a set.
        expect(subjects).not.toContain('standard');
        expect(subjects).not.toContain('tdd');
    });
});
