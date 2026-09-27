import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DETECTABILITY_PROBES, NOT_PROBED, measureDetectability, type DetectabilityProbe } from '../../src/store/detectability.js';

/**
 * **The cheap half of the recall gap, and the honesty that makes it usable.**
 *
 * Recall needs a verifier that reports finding ids, which does not exist; what exists is four corpus cases whose
 * reproduction names an exact implementation change, and a planted defect is detectable exactly when the check that owns
 * it reddens with the defect restored. That is weaker than recall and it is measurable today with no model at all.
 *
 * The cases below pin the properties that keep it from being read as more than it is: the probe set covers the corpus's
 * mutation cases **exactly** (a case with no probe, and a probe with no case, are both refused), the uncovered cases are
 * named with a reason rather than omitted, the output states what it measures, and a probe whose anchor has moved is
 * reported as inconclusive instead of as a detection that failed.
 */
let root: string;

afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'kata-detectability-'));
    await mkdir(join(root, 'src'), { recursive: true });
    return root;
}

describe('detectability is measured by restoring the defect, not by asking a model', () => {
    it('covers the corpus cases that can be probed, and names the ones that cannot', () => {
        expect(DETECTABILITY_PROBES.map((probe) => probe.caseId).sort()).toEqual([
            'adequacy-checker-central-mutation',
            'claims-checker-central-mutation',
            'obligation-resolution-mutation',
            'scope-guard-central-mutation',
        ]);
        // A partial measurement must say so: a reader seeing "4 of 4 detected" needs to know it is not "4 of 27".
        expect(NOT_PROBED.length).toBeGreaterThan(10);
        for (const entry of NOT_PROBED) expect(entry.why).not.toHaveLength(0);
    });

    it('reports a probe whose anchor has moved as inconclusive, rather than as a failed detection', async () => {
        const dir = await scratch();
        const probe: DetectabilityProbe = {
            caseId: 'claims-checker-central-mutation',
            file: 'src/thing.ts',
            find: 'text that is not there',
            replace: 'x',
            check: ['true'],
            why: 'fixture: the anchor is absent',
        };
        await writeFile(join(dir, 'src', 'thing.ts'), 'something else\n');
        const report = await measureDetectability({ root: dir, probes: [probe] });
        expect(report.inconclusive.map((entry) => entry.caseId)).toEqual(['claims-checker-central-mutation']);
        expect(String(report.inconclusive[0]?.observed)).toContain('appears 0 time(s)');
        expect(report.detected).toBe(0);
    });

    it('refuses a probe naming a corpus case that does not exist, instead of measuring nothing', async () => {
        const dir = await scratch();
        await expect(measureDetectability({
            root: dir,
            probes: [{ caseId: 'a-case-nobody-declared', file: 'src/x.ts', find: 'a', replace: 'b', check: ['true'], why: 'fixture' }],
        })).rejects.toThrow(/names a case the corpus does not hold/);
    });

    it('reports an undetected defect when the check stays green with the defect restored', async () => {
        const dir = await scratch();
        const file = join(dir, 'src', 'subject.ts');
        await writeFile(file, 'const guard = true;\n');
        const probe: DetectabilityProbe = {
            caseId: 'claims-checker-central-mutation',
            file: 'src/subject.ts',
            find: 'const guard = true;',
            replace: 'const guard = false;',
            // A check that ignores the file: it cannot redden, so the defect is undetected — the honest reading, and the
            // one a scorer that only counted "the check ran" would get wrong.
            check: ['true'],
            why: 'fixture: a check that cannot see the defect',
        };
        const report = await measureDetectability({ root: dir, probes: [probe] });
        expect(report.undetected.map((entry) => entry.caseId)).toEqual(['claims-checker-central-mutation']);
        expect(String(report.undetected[0]?.observed)).toContain('stayed green');
        // And the file is written back, so a probe never leaves the repository holding a defect.
        expect(await readFile(file, 'utf8')).toBe('const guard = true;\n');
    });

    it('states which question it answers, so a rate cannot be read as recall', async () => {
        const dir = await scratch();
        const report = await measureDetectability({ root: dir, probes: [] });
        expect(report.measures).toContain('not whether a reviewer would find it');
        expect(report.measured).toBe(0);
        expect(report.notProbed.length).toBe(NOT_PROBED.length);
    });
});
