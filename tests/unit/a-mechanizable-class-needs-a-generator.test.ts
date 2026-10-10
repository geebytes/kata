import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { appendClaim, freezeSubject, writePolicy, writeSubject } from '../../src/store/ledger.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';

/**
 * **A class the change declares as mechanizable must name the machine that decides it.**
 *
 * This is the operator's chosen form (甲) of the first candidate: the change declares, on its plan, which defect classes it
 * touches; for a `mechanizable` class it must also name the generator and the relation, because "a machine can decide this"
 * without a machine is how a class keeps being paid for by 22-minute independent rounds. The declaration is what the
 * *next* round's brief is written from, and the missing generator is reported as a ledger deficit — the existing not-ready
 * route — so the archive gate (which re-runs `decide`) cannot certify a change whose mechanizable class has no instrument.
 *
 * The rejected form was refusing to dispatch the round: measured against this change's own rounds, that would have discarded
 * three blocking and two major findings, including the legacy-revision phantom — and the first change to adopt the mechanism
 * has no generators at all, so it could never be reviewed.
 */
let root: string;
const changeId = 'a-mechanizable-class-needs-a-generator';

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-class-generator-'));
    await initLayout(root);
    await createTask({
        root,
        id: changeId,
        title: 'A mechanizable class needs a generator',
        acceptance: [{ id: 'AC-1', statement: 'The declaration is checked.' }],
        ownedPaths: ['src/a.ts'],
    });
    // The declared path has to exist, or the freeze refuses before anything this suite is about can run.
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'tmp'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
});

afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
});

/** Run a ledger command and return what it printed, so a refusal is asserted rather than swallowed. */
async function ledger(argv: string[]): Promise<Record<string, unknown>> {
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    const previousExitCode = process.exitCode;
    let thrown: unknown;
    try {
        await runLedgerCommand(argv, { root, changeId });
    } catch (error) {
        // A parse refusal throws inside the dispatcher; the real CLI prints it as an error envelope, so the harness reports
        // it the same way rather than letting the test fail on the throw.
        thrown = error;
    } finally {
        stdout.mockRestore();
        process.exitCode = previousExitCode;
    }
    const line = chunks.join('').trim().split('\n').filter((entry) => entry.trim().startsWith('{')).at(-1);
    if (line) return JSON.parse(line) as Record<string, unknown>;
    return thrown === undefined ? {} : { error: (thrown as Error).message };
}

async function prepare(): Promise<void> {
    await writePolicy(root, changeId, defaultPolicy());
    const frozen = await freezeSubject({ root, paths: ['src/a.ts'] });
    if (!frozen.ok) throw new Error(frozen.error);
    await writeSubject(root, changeId, frozen.subject);
    await appendClaim(root, changeId, {
        id: 'C-1',
        statement: 'The export is present.',
        riskClass: 'consistency',
        severity: 'major',
        dependsOn: ['path:src/a.ts'],
        evidenceIds: [],
        challengeIds: [],
        status: 'open',
        at: '2026-09-30T00:00:00.000Z',
        reopens: 0,
    });
    // The plan is built by its own command, so the case tests the declaration on a plan `decide` can actually read
    // (a hand-written minimal plan lacks the fields the decision dereferences).
    const planned = await ledger(['plan', '--change', changeId]);
    if (planned.ok !== true) throw new Error(`the fixture could not plan: ${JSON.stringify(planned)}`);
    // A request speaks for the sealed revision, so the fixture seals (the freeze above hashes the same content).
    await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts'], checkIds: [] });
}

describe('a mechanizable class needs a generator', () => {
    it('refuses a class that is not in the vocabulary, by name', async () => {
        await prepare();
        const result = await ledger(['plan', '--change', changeId, '--classes', 'kind-of-racy']);
        expect(String(result.error ?? '')).toContain('kind-of-racy');
        // Nothing was written: a refused declaration leaves the plan as it was.
        const plan = JSON.parse(await readFile(join(root, '.kata', 'tasks', changeId, 'review', 'plan.json'), 'utf8')) as { defectClasses?: unknown };
        expect(plan.defectClasses).toBeUndefined();
    }, 60_000);

    it('records the declaration, with the generator and the relation it names', async () => {
        await prepare();
        const result = await ledger(['plan', '--change', changeId, '--classes', 'one-fact-derived-twice:tmp/gen.ts:two-derivations-agree;intent-omission']);
        expect(result.ok, JSON.stringify(result).slice(0, 300)).toBe(true);
        const plan = JSON.parse(await readFile(join(root, '.kata', 'tasks', changeId, 'review', 'plan.json'), 'utf8')) as {
            defectClasses?: Array<{ class: string; generator?: string; relation?: string; oracle?: string }>;
        };
        expect(plan.defectClasses).toEqual([
            { class: 'one-fact-derived-twice', oracle: 'mechanizable', generator: 'tmp/gen.ts', relation: 'two-derivations-agree' },
            { class: 'intent-omission', oracle: 'judgment' },
        ]);
    }, 60_000);

    it('reports a mechanizable class with no generator as a ledger deficit, naming what is missing', async () => {
        await prepare();
        await ledger(['plan', '--change', changeId, '--classes', 'instrument-unsound']);
        const decision = await ledger(['decide', '--change', changeId, '--tier', 'strict']);
        expect(String(decision.verdict), JSON.stringify(decision).slice(0, 400)).toBe('insufficient');
        const deficits = (decision.deficits ?? []) as Array<{ need: string }>;
        const named = deficits.find((deficit) => deficit.need.includes('instrument-unsound'));
        expect(named, JSON.stringify(deficits)).toBeDefined();
        expect(named?.need).toMatch(/generator/);
    }, 60_000);

    it('does not report a generated class, or a judgment class', async () => {
        await prepare();
        await ledger(['plan', '--change', changeId, '--classes', 'instrument-unsound:tmp/gen.ts:reddens;intent-omission']);
        const decision = await ledger(['decide', '--change', changeId, '--tier', 'strict']);
        const deficits = (decision.deficits ?? []) as Array<{ need: string }>;
        expect(deficits.some((deficit) => deficit.need.includes('instrument-unsound'))).toBe(false);
        expect(deficits.some((deficit) => deficit.need.includes('intent-omission'))).toBe(false);
    }, 60_000);

    it('carries the declaration into the request, and names what is missing there', async () => {
        await prepare();
        // A generated class is declared beside the generated-less one, so "names what is missing" cannot be satisfied by
        // naming every mechanizable class (measured: without it, a mutation that ignored the generator stayed green).
        const plan = await ledger(['plan', '--change', changeId, '--classes', 'comparison-unnamed;instrument-unsound:tmp/gen.ts:reddens;intent-omission']);
        expect(plan.ok, JSON.stringify(plan).slice(0, 200)).toBe(true);
        const request = await ledger(['run', '--change', changeId, '--out', 'tmp/request.json']);
        expect(request.ok, JSON.stringify(request).slice(0, 300)).toBe(true);
        const written = JSON.parse(await readFile(join(root, 'tmp', 'request.json'), 'utf8')) as {
            defectClasses?: Array<{ class: string; oracle: string; generator?: string }>;
            missingGenerators?: string[];
        };
        expect(written.defectClasses?.map((entry) => entry.class)).toEqual(['comparison-unnamed', 'instrument-unsound', 'intent-omission']);
        // The request tells the reviewer which instrument does not exist yet, so the round is briefed rather than surprised.
        expect(written.missingGenerators).toEqual(['comparison-unnamed']);
    }, 60_000);
});
