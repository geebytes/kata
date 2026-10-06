import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLedger, readVerdictHistory } from '../../src/store/ledger.js';
import { ledgerVerdict, unsupportedClaims } from '../../src/store/verdict.js';

/**
 * Every schema-less ledger artefact has the same three-state boundary.
 *
 * A parseable but wrongly-shaped document is not an empty legacy record.  It is
 * unreadable: the ledger must name it before any direct reader or decision
 * consumer can mistake it for usable input.
 */
let root: string;
const changeId = 'record-read-state';

const malformedDocuments: Array<{ file: string; content: string }> = [
    { file: 'challenges.json', content: '{}\n' },
    { file: 'probes.json', content: '{}\n' },
    { file: 'probe-answers.json', content: '{}\n' },
    { file: 'runs.json', content: '{}\n' },
    { file: 'usage.json', content: '[]\n' },
    { file: 'plan.json', content: '[]\n' },
    { file: 'verdict-history.jsonl', content: 'null\n' },
];

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-ledger-read-state-'));
    await mkdir(join(root, '.kata', 'tasks', changeId, 'review'), { recursive: true });
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('schema-less ledger artefact read states', () => {
    it.each(malformedDocuments)('classifies a wrong-shaped $file as unreadable everywhere', async ({ file, content }) => {
        await writeFile(join(root, '.kata', 'tasks', changeId, 'review', file), content);

        const ledger = await readLedger(root, changeId);
        expect(ledger.malformedFiles).toContain(file);

        const verdict = await ledgerVerdict({ root, changeId });
        expect(verdict.kind).toBe('unreadable');
    });

    /**
     * **The container is not the whole shape.** Every round of review found the same class one layer deeper, and the last
     * one landed here: the outer container was checked while the elements and the nested fields were not, so a
     * `resolution: null` reached `discoveryProjection` and threw, a plan set without `paths` reached `focus` and threw, and
     * a `usage: 42` was handed to consumers as the usage record. The rules below live with the artefact's field spec, so
     * the scan and every writer apply the same ones.
     */
    const wrongElements: Array<{ file: string; content: string; why: string }> = [
        {
            file: 'challenges.json',
            content: `${JSON.stringify([{ id: 'X1', claimId: 'C1', command: 'true', failsOn: 'rev:x', state: 'open', at: 'now', resolution: null }])}\n`,
            why: 'a resolution that is not a record',
        },
        {
            file: 'challenges.json',
            content: `${JSON.stringify([{ id: 'X1', claimId: 'C1', command: 'true', failsOn: 'rev:x', state: 'open', at: 'now', resolution: { observed: 'exit 0' } }])}\n`,
            why: 'a resolution with no `at`',
        },
        {
            file: 'plan.json',
            content: `${JSON.stringify({ tier: 'strict', readingSets: [{ claimId: 'C1' }] })}\n`,
            why: 'a reading set with no `paths`',
        },
        {
            file: 'plan.json',
            content: `${JSON.stringify({ tier: 'strict', readingSets: [{ claimId: 'C1', paths: 'src/a.ts' }] })}\n`,
            why: 'a reading set whose `paths` is not an array',
        },
        {
            file: 'usage.json',
            content: `${JSON.stringify({ usage: 42 })}\n`,
            why: 'a usage record that is a number',
        },
        {
            file: 'usage.json',
            content: `${JSON.stringify({ usage: {}, assuranceHistory: 'zzz' })}\n`,
            why: 'an assurance history that is a string',
        },
    ];

    it.each(wrongElements)('classifies $file as unreadable when it carries $why', async ({ file, content }) => {
        await writeFile(join(root, '.kata', 'tasks', changeId, 'review', file), content);
        const ledger = await readLedger(root, changeId);
        expect(ledger.malformedFiles).toContain(file);
        expect((await ledgerVerdict({ root, changeId })).kind).toBe('unreadable');
    });

    it('reports a policy the reader rejects as an unreadable artefact', async () => {
        // **A substituted policy is not a read policy.** `policyRejected` was reported in its own field while the view handed
        // consumers `defaultPolicy()`: a stored ceiling of `security` was delivered as `strict`, the boundary gate never fired
        // (it reads `malformedFiles`), and `ledger plan` ran and wrote a plan under the substituted rule.
        await writeFile(join(root, '.kata', 'tasks', changeId, 'review', 'policy.json'), `${JSON.stringify({
            version: 1,
            ledgerTierCeiling: 'security',
            bogusField: 'x',
            tiers: {},
        })}\n`);
        const ledger = await readLedger(root, changeId);
        expect(ledger.policyRejected).not.toBeNull();
        expect(ledger.malformedFiles).toContain('policy.json');
        expect((await ledgerVerdict({ root, changeId })).kind).toBe('unreadable');
    });

    it('refuses to project an unreadable ledger as "no claims are still open"', async () => {
        // **A zero over a file nobody could read is not a zero.** `openLedgerProblems` asks the readability predicate first,
        // but the two callers that read `unsupportedClaims` directly — the change record's `findings` and the archive's
        // known-problem read — did not, so a corrupt `claims.json` became `findings: []` and `0 problems`: the same zero
        // meaning "none" that this family of fixes exists to remove, on the gate that decides whether a change may close.
        await writeFile(join(root, '.kata', 'tasks', changeId, 'review', 'claims.json'), '{ this is not JSON\n');
        const ledger = await readLedger(root, changeId);
        expect(ledger.malformedFiles).toContain('claims.json');
        expect(() => unsupportedClaims(ledger)).toThrow(/claims\.json/);

        // Absence is not that refusal: a ledger nobody wrote has no open claims, and that is a fact rather than a fault.
        const empty = await readLedger(root, 'a-change-with-no-ledger');
        expect(unsupportedClaims(empty)).toEqual([]);
    });

    it('reports an existing but unreadable history as unreadable, not as an empty one', async () => {
        // `verdict-history.jsonl` is line-delimited, so it is read by its own reader rather than by the container decoder.
        // A file that exists and cannot be read is not a file with nothing in it: only ENOENT is absence, and answering
        // `{ entries: [], malformed: 0 }` for anything else is how a history nobody could look at becomes a claim that no
        // verdict was ever reversed.
        await mkdir(join(root, '.kata', 'tasks', changeId, 'review', 'verdict-history.jsonl'), { recursive: true });
        const read = await readVerdictHistory(root, changeId);
        expect(read.entries).toEqual([]);
        expect(read.unreadable).toBeTruthy();
    });
});
