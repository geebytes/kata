import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLocalStatusCommand } from '../../src/cli/tasks.js';
import { runGateCommand } from '../../src/cli/workflow.js';
import { isWorkflowCommand, runWorkflowCommand } from '../../src/cli/workflow.js';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createContextPacket, acknowledgeContextPacket } from '../../src/workflow/context-fabric.js';
import { runCommand, type KataCommand } from '../../src/workflow/orchestrator.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { writeWikiClosure } from '../../src/wiki/closure.js';
import { createUserChoiceGate, GATE_CONSUMED_BY, GATE_CREATED_BY, approveUserChoiceGate, gateConsumedInstruction, gateRebuildInstruction, requireUserChoiceGate, type UserChoiceBoundary } from '../../src/workflow/user-choice-gate.js';
import { seedLedger } from '../helpers/ledger.js';

/**
 * AC-3 — every boundary's remedy runs in the phase that prints it.
 *
 * The measured state (I-37): a `judge_gate` that had been consumed printed `Run \`kata-cli review --approve\` … then
 * approve it again`, and `review --approve` requires the phase to be `review` — while a task whose `judge` succeeded sits
 * in `judge`. `gate approve` refuses a consumed gate, `judge` refuses without a fresh choice, and the printed remedy is
 * inert in exactly the state that printed it: three roads, all closed. The task was unlocked by hand-writing the record.
 *
 * The criterion is the property, not the sentence. The cases below **run the commands the tables name**, through the
 * entry point the CLI uses, in a fixture driven into the phase each command accepts, and observe the result on disk — a
 * gate file appearing or being consumed, and the phase the run reports. A row whose `command` or `phase` is false about
 * the command it names reddens here, because the observation is the run rather than the table the row lives in.
 *
 * **What this file cannot decide, stated rather than implied.** The refusal sentences are prose, so "the sentence carries
 * no imperative road" is decided by a declared vocabulary of imperative phrasings (`IMPERATIVE_ROAD`), not by parsing
 * English; a sentence that told the operator to run a closed command in a phrasing the vocabulary does not hold would
 * pass. The run-based cases do not have that limit: they read what the CLI did.
 */
const roots: string[] = [];

async function fixture(name: string): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), `kata-gate-remedy-${name}-`));
    roots.push(root);
    await initLayout(root);
    await createTask({
        root,
        id: 'held',
        title: 'Held',
        acceptance: [{ id: 'AC-1', statement: 'x' }],
        ownedPaths: ['src/a.ts'],
    });
    return root;
}

function gatePath(root: string, boundary: string): string {
    return join(root, '.kata', 'tasks', 'held', `user-choice-${boundary}.json`);
}

/** Mark a gate consumed without running a phase command, so the refusal can be driven in one fixture. */
function consume(root: string, boundary: string): void {
    const path = gatePath(root, boundary);
    const record = JSON.parse(execFileSync('node', ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(path)}, 'utf8'))`], { encoding: 'utf8' })) as Record<string, unknown>;
    writeFileSync(path, `${JSON.stringify({ ...record, choice: 'continue_current', approvedAt: new Date().toISOString(), consumedAt: new Date().toISOString() }, null, 2)}\n`);
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('a gate remedy runs where it is printed', () => {
    it('has a consumed-by entry for every boundary, so a new boundary cannot arrive without a road', () => {
        // The table check. `GATE_CREATED_BY` said how each gate is made; nothing said what consumes it, so the refusal for
        // a consumed gate had to guess a road — and guessed one that is refused in that state.
        for (const boundary of Object.keys(GATE_CREATED_BY)) {
            expect(GATE_CONSUMED_BY, boundary).toHaveProperty(boundary);
            expect(GATE_CONSUMED_BY[boundary as keyof typeof GATE_CONSUMED_BY].command.length, boundary).toBeGreaterThan(0);
        }
    });

    it('does not name the creating command as the road for a gate that was already consumed', async () => {
        // **The measured case.** After `judge` succeeded, the judge gate is consumed and the task is in `judge`; the old
        // sentence named `review --approve`, which refuses in that phase. The refusal must not send the operator to a road
        // that is closed where it is printed.
        const root = await fixture('consumed');
        await createUserChoiceGate({ root, taskId: 'held', boundary: 'judge_gate' });
        consume(root, 'judge_gate');

        let message = '';
        try {
            await approveUserChoiceGate({ root, taskId: 'held', boundary: 'judge_gate', choice: 'continue_current' });
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message).toMatch(/consumed/u);
        expect(message).not.toMatch(/review --approve/u);
        expect(gateConsumedInstruction('judge_gate')).not.toMatch(/review --approve/u);
    });

    it('states the consumer, the next boundary and where that boundary gets its gate — from its own tables', () => {
        // **This case reads the sentence; the cases below decide it.** The properties here are read from the tables, so a
        // table that loses an entry, or a row whose `next` names a boundary with no creating entry, is red — but a row
        // whose `command` or `phase` is simply false about the command it names is not, because each row matches itself by
        // construction. That is the limit the run-based cases below remove; this one stays as the sentence's shape.
        for (const boundary of Object.keys(GATE_CREATED_BY) as Array<keyof typeof GATE_CREATED_BY>) {
            const entry = GATE_CONSUMED_BY[boundary];
            const instruction = gateConsumedInstruction(boundary);
            // The consumer is stated, from the table.
            expect(instruction, boundary).toContain(entry.command);
            if (entry.next === undefined) {
                // The last boundary says so rather than promising a step that does not exist.
                expect(instruction, boundary).toMatch(/ladder ends/u);
                continue;
            }
            // The next boundary is named, and it has a creating entry — so the ladder this sentence describes is total.
            expect(instruction, boundary).toContain(entry.next);
            const created = GATE_CREATED_BY[entry.next];
            expect(created, `${boundary} -> ${entry.next}`).toBeDefined();
            const creator = entry.next === 'judge_gate' ? 'kata-cli review --approve' : `kata-cli ${created.command}`;
            expect(instruction, boundary).toContain(creator);
            // And the phase is stated whenever the table has one, because that is what makes the sentence checkable.
            if (created.phase !== undefined) expect(instruction, boundary).toContain(created.phase);
        }
    });

    it('says "concludes in", never "runs in", because a command runs from another phase', () => {
        // Round 3's F1: `kata-cli judge` is refused from phase `judge` ("Judge requires review phase"), so a sentence saying
        // the creating command "runs in phase judge" was false about the command it named.
        for (const boundary of Object.keys(GATE_CREATED_BY) as Array<keyof typeof GATE_CREATED_BY>) {
            for (const sentence of [gateConsumedInstruction(boundary), gateRebuildInstruction(boundary)]) {
                expect(sentence, boundary).not.toMatch(/runs in phase/u);
                if (/phase/u.test(sentence)) expect(sentence, boundary).toMatch(/concludes in phase/u);
            }
        }
    });

    it('orders the ladder consistently, so a row that skips or repeats a boundary is red', () => {
        // What it asserts, and what can redden: the ladder the sentence describes is total and ordered. Each row's
        // `next` is the boundary whose creating entry exists, no row is its own successor, and every boundary is reachable
        // from the first.
        const order: Array<keyof typeof GATE_CREATED_BY> = ['implementation_gate', 'review_gate', 'judge_gate', 'archive_gate'];
        const seen: string[] = [];
        let current: keyof typeof GATE_CREATED_BY | undefined = order[0];
        while (current !== undefined) {
            expect(seen, `the ladder repeats ${current}`).not.toContain(current);
            seen.push(current);
            const next: keyof typeof GATE_CREATED_BY | undefined = GATE_CONSUMED_BY[current].next;
            if (next === undefined) break;
            expect(next, `${current} -> ${next} is not a boundary`).toContain(next);
            expect(GATE_CREATED_BY[next], `${current} -> ${next} has no creating entry`).toBeDefined();
            current = next;
        }
        expect(seen).toEqual(order);
    });

    it('does not claim a road runs now: it states what happened and where the next gate comes from', async () => {
        // The sentence the first round measured as inert named `kata-cli archive` for a consumed `judge_gate`, and `archive`
        // is refused from phase `judge` because its own gate is not approved. The instruction therefore contains no promise
        // about what will run; this asserts the shape rather than the wording.
        const instruction = gateConsumedInstruction('judge_gate');
        expect(instruction).not.toMatch(/Continue with/u);
        expect(instruction).toMatch(/already crossed/u);
        expect(instruction).toMatch(/archive_gate/u);
        expect(gateRebuildInstruction('judge_gate')).toContain('review');
        expect(gateRebuildInstruction('implementation_gate')).toContain('plan');
    });

    it('says the state instead of asking for a decision that was already made', async () => {
        const root = await fixture('state');
        await createUserChoiceGate({ root, taskId: 'held', boundary: 'review_gate' });
        consume(root, 'review_gate');
        let message = '';
        try {
            await approveUserChoiceGate({ root, taskId: 'held', boundary: 'review_gate', choice: 'continue_current' });
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message).toMatch(/kata-cli review/u);
        expect(message).toMatch(/continue|next|proceed/iu);
    });

    // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    // The walker. Everything above reads sentences; everything below runs the commands they are built from.

    /**
     * The scenario each run-based case drives, per boundary: the phase the command accepts, the phase the gate is read
     * back from, and the flags the invocation needs.
     *
     * **Why this map is written here rather than read from the tables.** The tables are the subject under test, so a
     * fixture derived from them would move with a mutation and observe nothing. This map is the *state* the case drives —
     * a task in `plan`, in `hardVerify`, in `review`, in `judge` — which is knowledge a reviewer can check against the
     * phase guards in `src/workflow/orchestrator.ts` rather than against the table under test.
     */
    /**
     * The state each run-based case drives, per boundary: where the task sits for the *creating* invocation, and where it
     * sits when the boundary's gate is read back.
     *
     * **Why this map is written here rather than read from the tables.** The tables are the subject under test, so a
     * fixture derived from them would move with a mutation and observe nothing. These are the states themselves — a task
     * in `plan`, in `hardVerify`, in `review`, in `judge` — which a reviewer can check against the phase guards in
     * `src/workflow/orchestrator.ts` (`cmdJudge` requires `review`; `cmdArchive` requires `judge`, `distill` or
     * `archive`) rather than against the table under test.
     */
    const CREATION: Record<UserChoiceBoundary, { state: State; flags: string[]; receipt?: string }> = {
        // A task in `intake` needs no receipt: `runWorkflowCommand` enforces them once the task has crossed intake.
        implementation_gate: { state: 'intake', flags: [] },
        review_gate: { state: 'hardVerify', flags: [], receipt: 'reviewer' },
        // A *recording* approval crosses no boundary, so it asks for no gate; it does need the reviewer's receipt.
        judge_gate: { state: 'review-entered', flags: ['--approve', '--review-evidence', 'the ledger decided pass'], receipt: 'reviewer' },
        archive_gate: { state: 'review-approved', flags: [], receipt: 'judge' },
    };
    /** The state whose command reads each boundary's gate back — where its refusal is printed. */
    const READ_BACK: Record<UserChoiceBoundary, { state: State; command: string }> = {
        implementation_gate: { state: 'plan', command: 'build' },
        review_gate: { state: 'hardVerify', command: 'review' },
        judge_gate: { state: 'review-approved', command: 'judge' },
        archive_gate: { state: 'judge', command: 'archive' },
    };
    /** The role each reading command runs as, so the receipt it needs can be created; see `roleForCommand` in `src/cli/workflow.ts`. */
    const RECEIPT_ROLE: Record<UserChoiceBoundary, 'implementer' | 'reviewer' | 'judge' | 'distiller'> = {
        implementation_gate: 'implementer',
        review_gate: 'reviewer',
        judge_gate: 'judge',
        archive_gate: 'distiller',
    };
    const BOUNDARIES = Object.keys(GATE_CREATED_BY) as UserChoiceBoundary[];

    /**
     * The imperative phrasings a remedy has carried, declared and pinned below. The retired `gateRebuildInstruction`
     * clause told the operator to `run it against the current content`, and the retired `gateConsumedInstruction` clause
     * said `Continue with \`kata-cli archive\`` — the two forms this vocabulary must not lose. A sentence that told the
     * operator to run a closed command in a phrasing this does not hold is the limit the file's header states.
     */
    const IMPERATIVE_ROAD = /\b(run|re-?run|execute|invoke)\b|\bcontinue with\b|\bproceed with\b/iu;

    const OWNED = 'task-owned.txt';

    /** The states a case drives: each is a task driven there by the orchestrator, which asks for no gate. */
    type State = 'intake' | 'plan' | 'hardVerify' | 'review-entered' | 'review-approved' | 'judge';

    /** One task in `intake`, with the file its revision seals, so a seal and a move are possible from any phase. */
    async function intakeFixture(id: string): Promise<string> {
        const root = mkdtempSync(join(tmpdir(), `kata-gate-remedy-${id}-`));
        roots.push(root);
        await initLayout(root);
        writeFileSync(join(root, OWNED), 'the sealed implementation\n');
        await createTask({ root, id, title: id, acceptance: [{ id: 'AC-1', statement: 'the fixture holds' }], ownedPaths: [OWNED] });
        return root;
    }
    async function verifiedFixture(id: string): Promise<string> {
        const root = await intakeFixture(id);
        await runCommand('design', id, root);
        await runCommand('build', id, root, {
            ownedPaths: [OWNED],
            checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
        } as never);
        await writeWikiClosure(root, id, { decision: 'not_applicable', reason: 'the fixture establishes no reusable knowledge' });
        await seedLedger(root, id);
        return root;
    }
    async function fixtureIn(id: string, state: State): Promise<string> {
        if (state === 'intake') return intakeFixture(id);
        if (state === 'plan') {
            const root = await intakeFixture(id);
            await runCommand('design', id, root);
            return root;
        }
        const root = await verifiedFixture(id);
        if (state === 'hardVerify') return root;
        await runCommand('review', id, root, { confirmHostModel: true } as never);
        if (state === 'review-entered') return root;
        await runCommand('review', id, root, { approve: true, reviewEvidence: 'the ledger decided pass' } as never);
        if (state === 'review-approved') return root;
        await runCommand('judge', id, root, { confirmHostModel: true } as never);
        return root;
    }
    /** An acknowledged receipt for the role the reading command runs as, which `runWorkflowCommand` requires. */
    async function receiptFor(root: string, id: string, role: string): Promise<void> {
        const packet = await createContextPacket({ root, taskId: id, fromRole: 'implementer', toRole: role as never });
        await acknowledgeContextPacket({ root, taskId: id, id: packet.id, platform: 'pi', role: role as never });
    }
    /** The boundaries whose gate file exists, read off the directory rather than from a table. */
    function gateBoundaries(root: string, id: string): string[] {
        return readdirSync(join(root, '.kata', 'tasks', id))
            .filter((name) => name.startsWith('user-choice-') && name.endsWith('.json'))
            .map((name) => name.slice('user-choice-'.length, -'.json'.length));
    }
    /** Whether that boundary's gate was crossed — the fact the consumed sentence states about the command it names. */
    function isConsumed(root: string, id: string, boundary: UserChoiceBoundary): boolean {
        try {
            const record = JSON.parse(readFileSync(join(root, '.kata', 'tasks', id, `user-choice-${boundary}.json`), 'utf8')) as { consumedAt?: string };
            return record.consumedAt !== undefined;
        } catch {
            return false;
        }
    }
    const verbOf = (road: string): string => road.replace(/^kata-cli\s+/u, '').split(/\s+/u)[0] ?? '';

    /**
     * **Is this printed road a command the CLI accepts here?** A road is driven through the same entry point the CLI
     * dispatches to, in the fixture that printed it: the workflow family in-process, and `status` through its own reader.
     * A refusal is an answer, not an accept — and a phase guard is exactly the refusal this property is about.
     */
    async function commandRuns(root: string, id: string, road: string): Promise<boolean> {
        // **The operator's placeholders are substituted, the road's vocabulary is not.** `<choice>` and `<why>` are values a
        // human supplies; leaving them literal would make a valid road answer a refusal about its argument rather than about
        // the state it runs in.
        const filled = road.replace(/<choice>/gu, 'continue_current').replace(/<why>/gu, 'driven by the walker');
        const argv = filled.replace(/^kata-cli\s+/u, '').split(/\s+/u).filter(Boolean);
        const verb = argv[0] ?? '';
        if (verb === 'status') {
            try {
                await runLocalStatusCommand(id, null, root, {});
                return true;
            } catch {
                return false;
            }
        }
        if (verb === 'gate') {
            // **The gate family is not a `workflow` command**, so the generic branch below answered `false` for a road that
            // runs: `isWorkflowCommand('gate')` is false, the road was never attempted, and the walker called a working
            // road closed. Measured while the sentence began naming `kata-cli gate reset` as its remedy.
            try {
                const reply = await runGateCommand(argv.slice(1), root);
                const failure = (reply as { error?: unknown }).error;
                return failure === undefined || failure === null;
            } catch {
                return false;
            }
        }
        if (!isWorkflowCommand(verb as KataCommand)) return false;
        try {
            // **\"Runs\" means \"was not refused\", not \"echoed the dispatcher's success flag\".** The first version returned
            // `result.success === true`, which the gate family never sets — so a road that ran perfectly (it removed the
            // obsolete record) was reported as closed, and the case was measuring the reply's shape rather than the state.
            const result = (await runWorkflowCommand(verb as KataCommand, id, root, 'pi', argv)) as { error?: unknown; ok?: unknown; success?: unknown } | null;
            if (result === null || typeof result !== 'object') return true;
            if (result.error !== undefined && result.error !== null) return false;
            return result.ok !== false && result.success !== false;
        } catch {
            return false;
        }
    }

    it('the row of every boundary is true of the command it names: running it creates that boundary, in the phase the row states', async () => {
        // **The walker AC-3 asks for.** For each row, the command the *row* names is run through the CLI in the state that
        // command accepts, and what the run did is read from the disk: which gate appeared, and which phase the run
        // reported. A row whose `command` names a verb that creates no boundary never creates one; a row whose `phase`
        // contradicts the phase its command concludes in is caught by the comparison below. Neither can be caught by a
        // case that builds its expectation from the table — each row matches itself by construction — which is why this
        // one builds nothing from the table but the row under test.
        for (const boundary of BOUNDARIES) {
            const row = GATE_CREATED_BY[boundary];
            const id = `creates-${boundary.replace(/_/gu, '-')}`;
            const root = await fixtureIn(id, CREATION[boundary].state);
            if (boundary === 'archive_gate') {
                // The invocation under test is `judge`, which asks for the judge gate before it runs.
                await createUserChoiceGate({ root, taskId: id, boundary: 'judge_gate' });
                await approveUserChoiceGate({ root, taskId: id, boundary: 'judge_gate', choice: 'continue_current' });
            }
            if (CREATION[boundary].receipt) await receiptFor(root, id, CREATION[boundary].receipt as string);
            const before = gateBoundaries(root, id);
            const result = await runWorkflowCommand(row.command as KataCommand, id, root, 'pi', [row.command, ...CREATION[boundary].flags]);
            const created = gateBoundaries(root, id).filter((entry) => !before.includes(entry));

            expect(result.success, `${boundary}: the row names \`${row.command}\`, which must run in ${CREATION[boundary].state}; it answered ${JSON.stringify(result.error ?? result)}`).toBe(true);
            if (row.phase !== undefined) {
                expect(result.phase, `${boundary}: the row states phase \`${row.phase}\`, and the run must conclude in it`).toBe(row.phase);
            }
            expect(created, `${boundary}: running the row's own command must create that boundary and no other`).toEqual([boundary]);
        }
    });

    it('the row of every boundary is true of the command that crosses it: running the row\'s command consumes that boundary', async () => {
        // **The consumed sentence's fact, decided by running it.** The sentence says the boundary "was already crossed by"
        // the command its row names, and the fact that a command crosses a boundary is observable: the CLI marks the gate
        // consumed. A row naming a verb that crosses no boundary leaves the gate un-consumed, and a row naming a verb the
        // CLI does not have cannot run at all — both redden here.
        for (const boundary of BOUNDARIES) {
            const row = GATE_CONSUMED_BY[boundary];
            const crossing = verbOf(row.command);
            const id = `crosses-${boundary.replace(/_/gu, '-')}`;
            const root = await fixtureIn(id, READ_BACK[boundary].state);
            await createUserChoiceGate({ root, taskId: id, boundary });
            await approveUserChoiceGate({ root, taskId: id, boundary, choice: 'continue_current' });
            await receiptFor(root, id, RECEIPT_ROLE[boundary]);
            const result = await runWorkflowCommand(crossing as KataCommand, id, root, 'pi', [crossing])
                .catch((error: Error) => ({ success: false, error: error.message }) as never);

            expect(result.success, `${boundary}: the row names \`${row.command}\` as the command that crosses it, and that command must run in ${READ_BACK[boundary].state}; it answered ${JSON.stringify((result as { error?: unknown }).error)}`).toBe(true);
            expect(isConsumed(root, id, boundary), `${boundary}: \`${row.command}\` must really cross this boundary — the gate is still un-consumed`).toBe(true);
        }
    });

    it('the stale-gate remedy is not closed where it is printed, and carries no imperative road', async () => {
        // **Property 2 of the finding, per boundary.** The refusal is driven from the state whose command reads the gate
        // back — `archive_gate` by `kata-cli archive` while the task sits in `judge` — with a gate answered against
        // content that has since moved. Every road the sentence names that is not the boundary's own creating command (a
        // fact) must be a command the CLI accepts *there*; a road named after an imperative must run there even when it is
        // the creator; and the sentence must still point the operator at something that runs.
        for (const boundary of BOUNDARIES) {
            const id = `stale-${boundary.replace(/_/gu, '-')}`;
            const { state, command } = READ_BACK[boundary];
            const root = await fixtureIn(id, state);
            // A revision must exist before the gate is answered, or the gate carries no content binding to go stale.
            await createTaskRevisionIfChanged({ root, taskId: id, ownedPaths: [OWNED], checkIds: [] });
            await createUserChoiceGate({ root, taskId: id, boundary });
            await approveUserChoiceGate({ root, taskId: id, boundary, choice: 'continue_current' });
            // Move the content the gate was answered about, so the reading command reports the stale binding.
            writeFileSync(join(root, OWNED), 'content moved after the choice\n');
            await createTaskRevisionIfChanged({ root, taskId: id, ownedPaths: [OWNED], checkIds: [] });

            const refusal = await runWorkflowCommand(command as KataCommand, id, root, 'pi', [command])
                .catch((error: Error) => error.message);
            const sentence = gateRebuildInstruction(boundary, id);
            expect(String(refusal), `${boundary}: \`kata-cli ${command}\` from state ${state} must print this boundary's refusal`).toContain(sentence);

            const roads = [...sentence.matchAll(/`(kata-cli [^`]+)`/gu)].map((match) => match[1] as string);
            const creatorVerb = verbOf(`kata-cli ${GATE_CREATED_BY[boundary].command}`);
            // **The first step of the remedy must run where it is printed**; the steps after it may answer a refusal, because
            // asking a boundary is not a failure (measured: `kata-cli build` from state `plan` answers "requires an explicit
            // user choice", which is the question, not a closed road). Requiring every named road to run was the version that
            // called a working remedy broken, and requiring only `some` to run was the version round 4 measured as deciding
            // nothing; what decides the state is the unblocked check below.
            const firstRoad = roads.find((road) => verbOf(road) !== creatorVerb);
            expect(firstRoad, `${boundary}: the remedy names no road besides the creating command (${roads.join(', ')})`).toBeDefined();
            expect(await commandRuns(root, id, firstRoad!), `${boundary}: the first road the remedy names (\`${firstRoad}\`) must run in state ${state}`).toBe(true);
            // A road the sentence names after an imperative must run there even when it is the creating command.
            for (const part of sentence.split(/(?<=[.;])\s+/u)) {
                if (!IMPERATIVE_ROAD.test(part)) continue;
                for (const road of [...part.matchAll(/`(kata-cli [^`]+)`/gu)].map((match) => match[1] as string)) {
                    expect(await commandRuns(root, id, road), `${boundary}: "${part.trim()}" tells the operator to run \`${road}\`, which must run in state ${state}`).toBe(true);
                }
            }
            // **The remedy is not closed, decided by running the sequence it names.** A road that runs is not enough on its
            // own — round 4's F1 measured a state where every road was refused while the sentence still looked satisfied — and a
            // remedy is an ordered sequence (`gate reset` unblocks the boundary; the command that reports it is what asks again).
            // So the roads the sentence names are attempted in order and the reporting command is asked again: the stale refusal
            // must be gone, which is exactly "the repair unblocks the state the refusal is printed from". A road that refuses is
            // not a failure by itself; leaving the operator where they were is.
            const pointers = roads.filter((road) => verbOf(road) !== creatorVerb);
            expect(pointers.length, `${boundary}: the remedy names no road the operator can run (it names ${roads.join(', ') || 'none'})`).toBeGreaterThan(0);
            for (const road of pointers) await commandRuns(root, id, road);
            // **"The operator can proceed", not "the sentence is gone".** Round 5's F2 measured this case green on a state
            // where the record had been removed and the boundary could not be answered any more: `gate approve` refused
            // "No ... record exists" and the creating command is refused in the phase that prints the refusal, so the case
            // had confirmed a repair that moved the operator from a stale record to no road. What decides it is whether the
            // boundary is answerable afterwards, asked of the mechanism's own reader.
            await runWorkflowCommand(command as KataCommand, id, root, 'pi', [command]).catch((error: Error) => error.message);
            const answerable = await requireUserChoiceGate({ root, taskId: id, boundary }).then(() => true).catch(() => false);
            expect(answerable, `${boundary}: after the roads the remedy names (${pointers.join(', ')}), the boundary still cannot be answered`).toBe(true);
        }
    });

    it('recognises the imperative the retired remedies carried, so a green check means something', () => {
        // **The vocabulary's own reddening case.** Both forms were measured in this change: the round-1 consumed sentence
        // said `Continue with \`kata-cli archive\`` for a `judge_gate` that sits in `judge`, and round 3's `F1` found the
        // rebuild sentence ending `run it against the current content and approve the gate again.` — both closed roads.
        // Without this case, "no imperative road" could mean the pattern matches nothing at all.
        const retiredConsumed = 'This boundary was already crossed by `kata-cli judge`. Continue with `kata-cli archive`.';
        const retiredRebuild = "This boundary's gate is created by `kata-cli judge` when it concludes in phase `judge`; run it against the current content and approve the gate again.";
        expect(retiredConsumed, 'the round-1 form must be recognised as an imperative').toMatch(IMPERATIVE_ROAD);
        expect(retiredRebuild, "round 3's F1 form must be recognised as an imperative").toMatch(IMPERATIVE_ROAD);
        // And the forms the shipped module uses must not be: they state facts.
        for (const boundary of BOUNDARIES) {
            expect(gateConsumedInstruction(boundary), boundary).not.toMatch(IMPERATIVE_ROAD);
            expect(gateRebuildInstruction(boundary), boundary).not.toMatch(IMPERATIVE_ROAD);
        }
    });
});
