import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateArtefact } from '../../src/core/schema.js';
import {
    appendChallenge, appendClaim, appendEvidence, appendProbe, appendRun, answerProbe, ensureAssurance, freezeSubject,
    readLedger, recordVerdicts, reviewDir, setUsage, writePlan, writePolicy, writeSubject,
} from '../../src/store/ledger.js';
import { ledgerVerdict } from '../../src/store/verdict.js';
import { planReview } from '../../src/producers/planner.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { createTask } from '../../src/core/task.js';
import { initLayout } from '../../src/core/layout.js';
import { makeEvidence, makeVerdict } from '../helpers/review.js';

/**
 * **Every registered schema must have a consumer, and every artefact a writer produces must satisfy one.**
 *
 * Six of the twenty-four schemas had no code path using them. They were bundled, registered, and exercised only by a case
 * that loads the JSON and compiles it directly — so the constraint was pinned against a hand-written instance, and nothing
 * validated what the code actually wrote. Measured consequences, both found by giving them consumers:
 *
 * - `review-decision` had drifted from the value it describes: `deltaEvaluated` was added to `Decision` and not to the
 *   schema, so a decision the kernel produced was rejected by its own schema and no test could see it.
 * - The five ledger artefact schemas validated nothing: `claims.json` holding strings, or a subject whose digests were not
 *   digests, was read as a healthy ledger.
 *
 * Three properties, and the third is what keeps this file from being the next version of the same mistake:
 *
 * 1. Every schema that is registered is either used by code or named — with a reason — as deliberately unconsumed.
 * 2. Every ledger file is either written under a schema or named as having none.
 * 3. A decision the kernel *actually produced* satisfies its schema, and a ledger the *real writers* filled satisfies its
 *    schemas. A hand-written fixture cannot drift from anything.
 */
let root: string;

afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
});

/** The schema names the code registers, read from the registry rather than listed here. */
async function registeredSchemas(): Promise<string[]> {
    const source = await readFile('src/core/schema.ts', 'utf8');
    const table = source.slice(source.indexOf('const schemaText: Record<string, string> = {'));
    const body = table.slice(0, table.indexOf('\n};'));
    return [...body.matchAll(/^\s+'?([a-z][a-z-]*)'?:\s/gm)].map((match) => match[1] as string).sort();
}

describe('every schema has a consumer and every artefact a schema', () => {
    it('uses every registered schema somewhere in src/', async () => {
        const schemas = await registeredSchemas();
        expect(schemas.length, 'the registry must not be empty, or this proves nothing').toBeGreaterThan(20);

        const files = (await readdir('src', { recursive: true })).filter((entry) => entry.endsWith('.ts'));
        const sources = await Promise.all(files.map((entry) => readFile(join('src', entry), 'utf8')));
        // The registry body is cut out by *range*, not by guessing at lines: the first version filtered lines containing
        // `Schema,` and read the `layout.ts` bundling table as if it were a consumer.
        const registry = sources.find((text) => text.includes('const schemaText: Record<string, string> = {')) as string;
        const start = registry.indexOf('const schemaText: Record<string, string> = {');
        const withoutRegistry = registry.slice(0, start) + registry.slice(registry.indexOf('\n};', start));
        const code = [...sources.filter((text) => text !== registry), withoutRegistry].join('\n');

        // **A `$ref` is a consumer.** `review-finding` is referenced by `review.schema.json` and validated through that
        // path, so requiring a literal mention in TypeScript would report a definition that is genuinely used.
        const referenced = (await readdir('schemas')).map((entry) => readFile(join('schemas', entry), 'utf8'));
        const schemaText = (await Promise.all(referenced)).join('\n');

        const unused = schemas.filter((name) => {
            if (new RegExp(`['"]${name}['"]`).test(code)) return false;
            // `$id` is the file name with `.schema.json` on the end for most schemas and `.json` for the ledger family,
            // so the pattern allows both: matching only one spelling is how the first version reported a used schema as unused.
            const id = (schemaText.match(new RegExp(`"\\$id": "([^"]*/${name}(?:\\.schema)?\\.json)"`)) ?? [])[1];
            return id === undefined || !schemaText.includes(`"$ref": "${id}"`);
        });
        expect(unused, 'a registered schema no code uses is a definition with no consumer — delete it or wire it').toEqual([]);
    });

    it('writes every ledger file under a schema or names it as having none', async () => {
        const source = await readFile('src/store/ledger.ts', 'utf8');
        const block = (from: string, to: string): string => source.slice(source.indexOf(from), source.indexOf(to));
        const namesIn = (text: string): string[] => [...text.matchAll(/'([a-z-]+\.jsonl?)'/g)].map((match) => match[1] as string);

        const declared = namesIn(block('const FILES = {', '} as const;'));
        expect(declared.length, 'the ledger must declare its files, or this proves nothing').toBeGreaterThan(8);
        const mapped = namesIn(block('const ARTEFACT_SCHEMAS', 'const ARTEFACTS_VALIDATED_THROUGH_THEIR_READER'));
        const throughReader = namesIn(block('const ARTEFACTS_VALIDATED_THROUGH_THEIR_READER', 'const ARTEFACTS_WITHOUT_A_SCHEMA'));
        const exemptKeys = namesIn(block('const ARTEFACTS_WITHOUT_A_SCHEMA', 'export async function appendProbe'));

        // Every declared file is on exactly one side, and both sides are keyed by the file name rather than by the `FILES`
        // key — matching the wrong one is how the first version of the map validated nothing at all.
        const decided = [...mapped, ...throughReader, ...exemptKeys].sort();
        expect(decided, 'a new ledger file must be given a schema or a written reason for having none').toEqual([...declared].sort());
        expect(new Set(decided).size, 'no file may be on both sides').toBe(decided.length);
    });

    it('accepts a decision the kernel actually produced, and a ledger the real writers filled', async () => {
        root = await mkdtemp(join(tmpdir(), 'kata-artefact-'));
        await initLayout(root);
        await createTask({ root, id: 'artefact-task', title: 'Artefact task', acceptance: [{ id: 'AC-1', statement: 'x' }] });
        await writePolicy(root, 'artefact-task', defaultPolicy());
        // A path that exists, because `freezeSubject` refuses an unreadable one — and the subject's own schema is what this
        // case is checking, so the digest has to come from a real file.
        await writeFile(join(root, 'artifact.txt'), 'the artefact holds\n', 'utf8');
        const frozen = await freezeSubject({ root, paths: ['artifact.txt'] });
        if (!frozen.ok) throw new Error(frozen.error);
        await writeSubject(root, 'artefact-task', frozen.subject);
        await ensureAssurance(root, 'artefact-task', 'observed');
        await appendClaim(root, 'artefact-task', {
            id: 'C1', statement: 'the artefact holds', riskClass: 'consistency', severity: 'major',
            dependsOn: ['path:artifact.txt'], evidenceIds: ['E1'], challengeIds: [], status: 'open', at: '2026-09-28T00:00:00.000Z', reopens: 0,
        });
        await appendEvidence(root, 'artefact-task', makeEvidence({ id: 'E1', ref: 'artifact.txt', assertion: 'contains:holds' }));
        await recordVerdicts(root, 'artefact-task', [makeVerdict({ evidenceId: 'E1', subjectRevision: frozen.subject.revision })]);
        await appendChallenge(root, 'artefact-task', {
            id: 'X1', claimId: 'C1', command: 'exit 1', failsOn: frozen.subject.revision, state: 'open', at: '2026-09-28T00:00:00.000Z',
        });
        await appendProbe(root, 'artefact-task', { id: 'P1', claimId: 'C1', kind: 'file-exists', path: 'artifact.txt', command: 'test -f artifact.txt', askedAt: '2026-09-28T00:00:00.000Z' });
        await answerProbe(root, 'artefact-task', { probeId: 'P1', command: 'test -f artifact.txt', observed: 'exit 0', answeredAt: '2026-09-28T00:00:00.000Z' });
        await setUsage(root, 'artefact-task', { tokens: 1_000, toolCalls: 3 });
        await appendRun(root, 'artefact-task', { at: '2026-09-28T00:00:00.000Z', producer: 'fixture', claims: 1, evidence: 1, diversity: 'single' });
        await writePlan(root, 'artefact-task', planReview({
            subject: frozen.subject, claims: (await readLedger(root, 'artefact-task')).claims, policy: defaultPolicy(),
            tier: 'strict', changedPaths: ['artifact.txt'], c0Tokens: null,
        }));

        // **Read through the reader that enforces.** `readLedger` scans every file and reports one that parses but is not
        // its schema's shape, which is the property a ledger of record needs.
        const ledger = await readLedger(root, 'artefact-task');
        expect(ledger.recordedFiles, 'the writers must have written the mapped files').toContain('claims.json');
        expect(ledger.malformedFiles, `a file the real writers produced was rejected: ${JSON.stringify(ledger.malformedReasons)}`).toEqual([]);

        // …and the decision, which is the sixth schema and had drifted from the value.
        const verdict = await ledgerVerdict({ root, changeId: 'artefact-task' });
        expect(verdict.kind).toBe('decided');
        if (verdict.kind !== 'decided') return;
        expect(() => validateArtefact('review-decision', verdict.decision)).not.toThrow();
    });

    it('refuses a ledger file whose shape its schema forbids, and says which file and why', async () => {
        root = await mkdtemp(join(tmpdir(), 'kata-artefact-bad-'));
        await initLayout(root);
        await createTask({ root, id: 'artefact-bad', title: 'Bad', acceptance: [{ id: 'AC-1', statement: 'x' }] });
        // A claims file that parses and is not a list of claims: the state this used to be read as a healthy ledger.
        const dir = reviewDir(root, 'artefact-bad');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'claims.json'), `${JSON.stringify(['not a claim'], null, 2)}\n`, 'utf8');
        await writeFile(join(dir, 'subject.json'), `${JSON.stringify({ revision: 'HEAD', pathDigests: {} }, null, 2)}\n`, 'utf8');

        const ledger = await readLedger(root, 'artefact-bad');
        expect(ledger.malformedFiles.sort()).toEqual(['claims.json', 'subject.json']);
        expect(ledger.malformedReasons['claims.json']).toContain('does not match review-claim');
        expect(ledger.malformedReasons['subject.json']).toContain('does not match review-subject');
        // Both reasons name something an operator can act on, which "cannot be parsed" would not have.
        expect(ledger.malformedReasons['subject.json']).toMatch(/revision|pathDigests/);
    });

    it('refuses to write a ledger file that would not match its schema, writing nothing', async () => {
        root = await mkdtemp(join(tmpdir(), 'kata-artefact-refuse-'));
        await initLayout(root);
        await createTask({ root, id: 'artefact-refuse', title: 'Refuse', acceptance: [{ id: 'AC-1', statement: 'x' }] });

        // The write entry point is the one place a bad record can be stopped before it exists. This is the mutation target:
        // remove the validation from `writeJson` and the call resolves, leaving a file no reader can use.
        await expect(writeSubject(root, 'artefact-refuse', { revision: 'HEAD', pathDigests: {} } as never))
            .rejects.toThrow(/refusing to write subject\.json for artefact-refuse: the record would not match review-subject/);
        await expect(readdir(reviewDir(root, 'artefact-refuse')).catch(() => [] as string[]))
            .resolves.not.toContain('subject.json');
    });
});
