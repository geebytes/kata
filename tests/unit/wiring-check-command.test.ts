import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
