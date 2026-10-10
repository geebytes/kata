import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { readWaivers } from '../../src/quality/acceptance-matrix.js';
import { waiversPath } from '../../src/core/layout.js';
import { readRecordedEvidence } from '../../src/quality/evidence.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { readDirectoryState } from '../../src/core/record-read.js';

/**
 * **AC-20, the sites an independent round found outside the change's surface: a store that cannot be *listed*, and a record
 * that cannot be *parsed*, are not an empty one.**
 *
 * The round measured three readers that answered `[]` for every failure, so a damaged record and an absent one were the same
 * answer everywhere a consumer asks:
 *
 * - `readWaivers` — `catch { return [] }`, no shape check. A damaged `waivers.json` therefore read as "no waivers were
 *   recorded", silently dropping an operator's exemption, and `{"waivers": "AC-1 is fine"}` returned a *string* typed as a
 *   list (the seal then spreads it into one phantom waiver per character).
 * - `readRecordedEvidence` — a failed `readdir` of the evidence directory read as "no evidence recorded".
 * - `listEvidenceFiles` — the same fold one layer up, in the summary a decision is made from.
 *
 * The fix is the derivation that already existed for single files (`readRecordState`: only `ENOENT` is absent) plus its
 * sibling for a directory (`readDirectoryState`), used at every one of these sites rather than re-decided three times. The
 * cases below are written so that each one fails if its own site regresses to the `[]`-for-everything shape, and the
 * absent-direction control is asserted beside each: the point is not "never return an empty list" but "never return one for
 * a store you could not read".
 */
const roots: string[] = [];
const taskId = 'unreadable-store';

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'kata-unreadable-store-'));
    roots.push(directory);
    await initLayout(directory);
    await mkdir(join(directory, '.kata', 'tasks', taskId), { recursive: true });
    return directory;
}

describe('a store that cannot be read is never reported as an empty one', () => {
    it('refuses by name for a damaged waivers record, and says nothing about an absent one', async () => {
        const directory = await root();

        // Absent: no waivers were recorded, which is a state rather than a failure.
        await expect(readWaivers(directory, taskId)).resolves.toEqual([]);

        // Damaged: not JSON.
        await mkdir(join(directory, '.kata', 'tasks', taskId), { recursive: true });
        await writeFile(waiversPath(directory, taskId), '{ not json');
        await expect(readWaivers(directory, taskId)).rejects.toThrow(/Cannot read the waivers recorded for/);

        // Wrong shape, which used to come back as whatever the file held.
        await writeFile(waiversPath(directory, taskId), JSON.stringify({ waivers: 'AC-1 is fine' }));
        await expect(readWaivers(directory, taskId)).rejects.toThrow(/Cannot read the waivers recorded for/);

        // And a well-formed record still reads, so the refusals above are about damage rather than about the reader.
        await writeFile(waiversPath(directory, taskId), JSON.stringify({ waivers: [{ acceptanceId: 'AC-1', reason: 'upstream', by: 'kata-agent', at: '2026-10-09T00:00:00.000Z' }] }));
        await expect(readWaivers(directory, taskId)).resolves.toHaveLength(1);
    });

    it('refuses by name when the evidence directory cannot be listed, and returns nothing when it does not exist', async () => {
        const directory = await root();

        // Absent directory: this task has recorded no evidence yet.
        await expect(readRecordedEvidence(directory, taskId)).resolves.toEqual([]);

        // **`ENOTDIR`, deterministically**: a root whose `.kata` is a file, so the evidence path cannot be a directory at all.
        // (`initLayout` creates `.kata/evidence`, so this needs its own root rather than a mutation of the one above.) It used
        // to read as "no evidence recorded".
        const broken = await mkdtemp(join(tmpdir(), 'kata-unlistable-'));
        roots.push(broken);
        await writeFile(join(broken, '.kata'), 'not a directory\n');

        await expect(readRecordedEvidence(broken, taskId)).rejects.toThrow(/Cannot read the recorded evidence for/);
    });

    it('names the directory in the shared reading, and still answers absent for a directory that is not there', async () => {
        const directory = await root();

        const absent = await readDirectoryState(join(directory, 'nowhere'));
        expect(absent.kind).toBe('absent');

        await writeFile(join(directory, 'a-file'), 'x\n');
        const unlistable = await readDirectoryState(join(directory, 'a-file'));
        expect(unlistable.kind).toBe('unreadable');
        if (unlistable.kind === 'unreadable') expect(unlistable.detail).toContain('could not be listed');
    });
});

describe('a refusal is not swallowed one layer up', () => {
    /**
     * **The reader that refuses is only as good as its callers.** An independent round re-ran R1-F3's fix and found the
     * named refusal consumed one level up: `readTaskEvidence` wrapped `readRecordedEvidence` in `catch { return …[] }`, so
     * an evidence store that cannot be listed arrived at `judge` as `evidenceCount: 0` — "no evidence recorded", which is
     * the exact fold the fix removed, wearing its caller's clothes. Measured with `.kata/evidence` as a file (ENOTDIR, not
     * ENOENT): the reader threw the named error and `judge` reported `evidenceCount: 0` and
     * `repairScope: missing_test_evidence`.
     *
     * The caller may not decide that question for itself. `readRecordedEvidence` answers three ways already — absent is
     * `[]`, anything unreadable throws — so a caller that catches everything has re-joined the two answers.
     */
    it('does not turn an unlistable evidence store into an empty one at the judge route', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'kata-unlistable-judge-'));
        roots.push(directory);
        const judgeTask = 'unlistable-store';
        await mkdir(join(directory, '.kata', 'tasks', judgeTask), { recursive: true });
        await writeFile(join(directory, 'subject.ts'), 'export const version = 1;\n');
        await writeFile(join(directory, '.kata', 'tasks', judgeTask, 'task.json'), `${JSON.stringify({
            id: judgeTask,
            title: 'Unlistable store',
            phase: 'review',
            acceptance: [{ id: 'AC-1', statement: 'The thing holds.' }],
            ownedPaths: ['subject.ts'],
            acceptanceMatrix: {
                version: 1,
                rows: [{
                    acceptanceId: 'AC-1',
                    implementationPaths: ['subject.ts'],
                    testPaths: ['subject.ts'],
                    evidence: [{ id: 'ac-1', kind: 'test', command: 'vitest', testSelector: 'subject.ts' }],
                    verificationLevel: 'unit',
                }],
            },
            createdAt: '2026-10-09T00:00:00.000Z',
            updatedAt: '2026-10-09T00:00:00.000Z',
        })}\n`);
        const sealed = await createTaskRevisionIfChanged({ root: directory, taskId: judgeTask, ownedPaths: ['subject.ts'], checkIds: [] });
        await writeFile(join(directory, '.kata', 'tasks', judgeTask, 'current-state.json'), `${JSON.stringify({ taskId: judgeTask, phase: 'review', actor: { id: 'kata-agent', role: 'implementer' }, updatedAt: '2026-10-09T00:00:00.000Z' })}\n`);
        await writeFile(join(directory, '.kata', 'tasks', judgeTask, 'review.json'), `${JSON.stringify({ revisionId: sealed.revision.id, manifestHash: sealed.revision.manifestHash, status: 'approved', reviewEvidence: 'reviewed', findings: [] })}\n`);
        // A file where the evidence directory belongs: `ENOTDIR`, which is not an absence.
        await writeFile(join(directory, '.kata', 'evidence'), 'not a directory\n');

        const judged = await runCommand('judge', judgeTask, directory, { confirmHostModel: true }).catch((error: Error) => ({ threw: error.message }));

        // Either the command refuses by name, or it throws naming the store — what it must not do is answer "no evidence".
        const asText = JSON.stringify(judged);
        expect(asText, `judge answered: ${asText.slice(0, 300)}`).toContain('evidence');
        expect(asText).not.toContain('"evidenceCount":0');
        if ('threw' in judged) expect(String(judged.threw)).toMatch(/cannot be listed|evidence/i);
        else expect(judged.success).toBe(false);
    }, 120_000);
});
