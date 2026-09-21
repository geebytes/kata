import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { readChangeRecord } from '../../src/quality/change-record.js';

/**
 * A governed record row that declares itself checkable.
 *
 * `claims[]` already gives an acceptance *statement* a command, and the seal runs it and reports a false sentence by claim
 * id. A governed ledger row — a wiki record's `statement`, a report assertion — had nothing: the row was written by the
 * author, read by the reviewer, and unverifiable by construction, which made it the cheapest thing a review could attack
 * (`twenty of thirty findings across thirteen passes`). This applies the mechanism that already works for acceptance
 * criteria to the rows the definition of done requires, so a false row fails the gate instead of the next round.
 */
describe('governed record assertions', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-legend-'));
        roots.push(root);
        await initLayout(root);
        execFileSync('git', ['init', '--quiet'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/real.ts'), 'export const real = 1;\n', 'utf8');
        execFileSync('git', ['add', '.'], { cwd: root });
        execFileSync('git', ['commit', '--quiet', '-m', 'base'], { cwd: root });
        return root;
    }

    it('turns a false record row into a seal failure naming the row, and shows the claim id', async () => {
        const root = await tempRoot();
        // The row says a file exists. It does not. Nothing else about the task is wrong.
        await writeFile(join(root, '.kata-config.json'), `${JSON.stringify({
            checks: [{ name: 'typecheck', command: 'true' }],
        })}\n`, 'utf8');

        await runCommand('open', 'legend-task', root, {
            title: 'Ledger claim',
            acceptance: [
                {
                    id: 'AC-1',
                    statement: 'The ledger row is true',
                    claims: [
                        {
                            id: 'row',
                            statement: 'src/not-there.ts exists',
                            // The claim's command demonstrates the row is checkable: this test fails (exit 1), so the row
                            // is false, and the seal must say so rather than let a reviewer find it next round.
                            check: { command: 'test', args: ['-f', 'src/not-there.ts'], expect: { exitCode: 0 } },
                        },
                    ],
                },
            ],
            ownedPaths: ['src/'],
        });

        await runCommand('design', 'legend-task', root);
        const sealed = await runCommand('build', 'legend-task', root, { seal: true });
        expect(sealed.success).toBe(false);
        const surfaces = JSON.stringify(sealed.diagnostics ?? {}) + (sealed.error ?? '');
        expect(surfaces).toContain('claim:AC-1:row');
        // AC-2's record must preserve the failed claim, not report an empty factual surface while diagnostics say it failed.
        const record = await readChangeRecord(root, 'legend-task');
        expect(record?.claimFailures).toMatchObject([{ checkId: 'claim:AC-1:row', actualExitCode: 1, missing: false }]);
        expect(surfaces).toMatch(/expected exit 0|contradicted/i);
    });

    it('names the row that was refused when the row declares no outcome to check', async () => {
        const root = await tempRoot();
        await writeFile(join(root, '.kata-config.json'), `${JSON.stringify({ checks: [{ name: 'typecheck', command: 'true' }] })}\n`, 'utf8');
        await runCommand('open', 'legend-refused', root, {
            title: 'Decorative row',
            acceptance: [
                {
                    id: 'AC-1',
                    statement: 'The ledger row is true',
                    // A row with no expected outcome cannot fail, so it cannot be a check — refused before anything runs.
                    claims: [{ id: 'decorative', statement: 'the row is true', check: { command: 'true', expect: undefined as never } }],
                },
            ],
            ownedPaths: ['src/'],
        });

        await runCommand('design', 'legend-refused', root);
        const sealed = await runCommand('build', 'legend-refused', root, { seal: true });
        expect(sealed.success).toBe(false);
        expect(String(sealed.error)).toMatch(/cannot fail/i);
        expect(JSON.stringify(sealed.diagnostics ?? {})).toContain('decorative');
    });
});
