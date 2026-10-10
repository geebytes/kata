import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { collectSealPreflight } from '../../src/workflow/seal-preflight.js';

/**
 * **AC-17 — a gate input that is read and then dropped is a mechanism without a consumer.**
 *
 * The seal answers two halves of one question: "does the declared surface cover this change's work?" The working-tree half
 * is a blocker (a dirty tree outside the declaration refuses the seal). The committed half was computed and then read by
 * nothing at all — measured by an independent round:
 *
 *     collectSealPreflight(…) →
 *     { committedOutsideDeclaration: ['.gitignore', 'src/stowaway.ts'], committedReading: 'available', blockers: [] }
 *
 * and `grep -rn 'undeclaredCommittedChanges|committedReading' src/` returned `seal-preflight.ts` only. Two comments in the
 * same file disagreed about what happened to it (one said "the reading is published", the next said "reported as its own
 * named blocker with its own remedy") and the code did neither.
 *
 * It stays a **report** rather than a blocker, for the measured reason on the field: both anchors available for "what did
 * this change commit" include work that is not this change's, and running it as a blocker refused 23 legitimate seals. What
 * this case pins is the other half — that the report reaches a reader. The seal's own diagnostics are that reader.
 */
const execFileAsync = promisify(execFile);
const roots: string[] = [];
const taskId = 'committed-undeclared-content';

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(root: string, args: string[]): Promise<void> {
    await execFileAsync('git', args, { cwd: root });
}

async function fixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-committed-undeclared-'));
    roots.push(root);
    await git(root, ['init', '-q']);
    await git(root, ['config', 'user.email', 'kata@example.test']);
    await git(root, ['config', 'user.name', 'Kata Test']);
    await initLayout(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'declared.ts'), 'export const declared = true;\n');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'baseline']);
    await runCommand('open', taskId, root, {
        title: 'Committed undeclared content fixture',
        acceptance: [{ id: 'AC-1', statement: 'The declared surface covers the work.' }],
    });
    await runCommand('design', taskId, root);
    return root;
}

describe('the committed half of the declaration question reaches a reader', () => {
    it('publishes what this change committed outside its declaration, in the seal an operator reads', async () => {
        const root = await fixture();
        // Committed **after** the task was created, so the anchor is this change's own clock — and the tree is left clean,
        // which is exactly the state `git status` cannot see.
        await writeFile(join(root, 'src', 'stowaway.ts'), 'export const stowaway = true;\n');
        await git(root, ['add', '-A']);
        await git(root, ['commit', '-qm', 'committed outside the declaration']);

        // One trivial passing check, because the fixture has no toolchain of its own: the default project checks would fail
        // for a reason that has nothing to do with this case.
        const check = { id: 'trivial', name: 'trivial', kind: 'test' as const, command: process.execPath, cwd: root, args: ['-e', 'process.exit(0)'] };
        const seized = await runCommand('build', taskId, root, { seal: true, ownedPaths: ['src/declared.ts'], checks: [check] });

        // The seal itself is the reader: the reading travels in the diagnostics every caller receives. Before the fix the
        // value was computed in the preflight and read by nobody, so an operator could not see it at all.
        const risk = (seized.diagnostics as { declarationRisk?: { committedOutsideDeclaration?: string[]; committedReading?: string } } | undefined)?.declarationRisk;
        expect(risk, `seal diagnostics: ${JSON.stringify(seized.diagnostics).slice(0, 300)}`).toBeDefined();
        expect(risk?.committedReading).toBe('available');
        expect(risk?.committedOutsideDeclaration).toContain('src/stowaway.ts');
    }, 120_000);

    it('says the reading was impossible rather than reporting an empty list when the anchor cannot be used', async () => {
        const root = await fixture();
        // An unusable anchor is `unavailable`, never "nothing committed outside the declaration" — the fail-closed direction
        // for the other half of the same two-valued field.
        const { undeclaredChanges } = await import('../../src/quality/undeclared-changes.js');
        const reading = await undeclaredChanges({ root, declaredPaths: ['src/declared.ts'], sinceCommitted: 'not a timestamp' });

        expect(reading.committedReading).toBe('unavailable');
        expect(reading.committedOutsideDeclaration).toEqual([]);
    }, 60_000);
});
