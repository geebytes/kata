import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// AC-1. The check has to be able to *gate*, which means three states rather than two: clean, findings, and the instrument
// could not run. The third one matters most here — a check that exits 0 when it could not do its job is precisely the
// defect class this change exists to detect (§17, exit-code constraint 5).

async function fixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-wiring-cmd-'));
    await mkdir(join(root, 'src'), { recursive: true });
    return root;
}

describe('the wiring check as one command', () => {
    it('exits 0 when the surface holds nothing unreferenced', async () => {
        const root = await fixture();
        try {
            await writeFile(join(root, 'src/a.ts'), 'export function used(): number { return 1; }\n', 'utf8');
            await writeFile(join(root, 'src/b.ts'), "import { used } from './a.js';\nexport const value = used();\n", 'utf8');

            const { runWiringCheck } = await import('../../src/quality/wiring-check.js');
            const run = await runWiringCheck({ root, surface: ['src/a.ts', 'src/b.ts'], checks: ['reference'] });

            expect(run.findings).toEqual([]);
            expect(run.exitCode).toBe(0);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('exits 1 when a finding exists, and every finding carries a location', async () => {
        const root = await fixture();
        try {
            await writeFile(join(root, 'src/a.ts'), 'export function orphan(): number { return 1; }\n', 'utf8');

            const { runWiringCheck } = await import('../../src/quality/wiring-check.js');
            const run = await runWiringCheck({ root, surface: ['src/a.ts'], checks: ['reference'] });

            expect(run.exitCode).toBe(1);
            expect(run.findings.length).toBeGreaterThan(0);
            for (const finding of run.findings) {
                expect(finding.file).toBeTruthy();
                expect(finding.line).toBeGreaterThan(0);
                expect(finding.subject).toBeTruthy();
                expect(finding.check).toBeTruthy();
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('exits 2 when the surface cannot be read, so an instrument failure is never a pass', async () => {
        const root = await fixture();
        try {
            const { runWiringCheck } = await import('../../src/quality/wiring-check.js');
            const run = await runWiringCheck({ root, surface: ['src/does-not-exist.ts'], checks: ['reference'] });

            expect(run.exitCode).toBe(2);
            expect(run.instrument.length).toBeGreaterThan(0);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

/**
 * f4 of the independent pass's findings: the exit-code path had **no test at all**.
 *
 * AC-1's claim is that the command "exits non-zero when any finding is present and zero when none is, so it can gate rather
 * than merely advise" — and what was tested was the *library* return value. `runWiringCheckCommand` and the wrapper that
 * turns its value into a process exit code appeared in no test, so a regression making the command exit 0 with findings
 * present — the short-circuited-gate class this change exists to detect — would have left the suite green.
 */
describe('the command gates: three exit states, and the process code the wrapper produces', () => {
    const cleanup: string[] = [];

    async function fixture(): Promise<string> {
        const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const root = await mkdtemp(join(tmpdir(), 'kata-wiring-command-'));
        cleanup.push(root);
        await mkdir(join(root, 'src'), { recursive: true });
        // Referenced within its own file, so neither check reports anything.
        await writeFile(join(root, 'src/clean.ts'), 'export const used = 1;\nconsole.log(used);\n', 'utf8');
        // Referenced nowhere: a finding, and nothing else.
        await writeFile(join(root, 'src/dirty.ts'), 'export function dead(): number { return 1; }\n', 'utf8');
        return root;
    }

    afterEach(async () => {
        const { rm } = await import('node:fs/promises');
        await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('returns 0 clean, 1 with a finding, and 2 when the instrument cannot run', async () => {
        const { runWiringCheckCommand } = await import('../../src/quality/wiring-check.js');
        const root = await fixture();

        const clean = await runWiringCheckCommand({ root, surface: ['src/clean.ts'], print: () => undefined });
        expect(clean).toBe(0);

        const dirty = await runWiringCheckCommand({ root, surface: ['src/dirty.ts'], print: () => undefined });
        expect(dirty).toBe(1);

        // The third state is the point: "could not do its job" must not be readable as "clean".
        const unreadable = await runWiringCheckCommand({ root, surface: ['src/absent.ts'], print: () => undefined });
        expect(unreadable).toBe(2);
    }, 30000);

    it('turns that value into the process exit code a CI would read', async () => {
        const { execFile } = await import('node:child_process');
        const { join } = await import('node:path');
        const { promisify } = await import('node:util');
        const run = promisify(execFile);
        const root = await fixture();
        // The wrapper resolves its own entry relative to itself and takes the *workspace* from the cwd, so a fixture can be
        // checked without the repository being built first.
        const wrapper = join(process.cwd(), 'scripts', 'wiring-check.mjs');

        const codeOf = async (surface: string): Promise<number> => {
            try {
                await run('node', [wrapper, '--surface', surface], { cwd: root });
                return 0;
            } catch (error) {
                const code = (error as { code?: number | string }).code;
                if (typeof code !== 'number') throw error;
                return code;
            }
        };

        expect(await codeOf('src/clean.ts')).toBe(0);
        expect(await codeOf('src/dirty.ts')).toBe(1);
    }, 120000);
});
