import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mostRecentDifferentContent } from '../../src/workflow/revision.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';
import { revisionsDir } from '../../src/core/layout.js';

/**
 * **The reference must not depend on the order the filesystem happens to return.**
 *
 * `mostRecentDifferentContent` sorts by `createdAt` alone, so two revisions sealed inside the same millisecond resolved by
 * `readdir` order — ext4 hash order and a sorted tmpfs disagree, which means the same store could name a different
 * reference (and therefore a different plan and declared subject) on another host. The revision id is the secondary key.
 *
 * The guard does not assume an order: it builds the same two revisions in **opposite insertion orders** in two roots and
 * requires both roots to name the same reference.
 */
const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const AT = '2026-10-08T00:00:00.000Z';
const current = { 'a.ts': 'a'.repeat(64) };
// The shape `schemas/revision.schema.json` requires: id, taskId, ownedPaths, manifestHash, createdAt.
const revision = (id: string, digest: string) => ({
    id,
    taskId: 'tie',
    ownedPaths: ['a.ts'],
    manifestHash: 'b'.repeat(64),
    pathDigests: { 'a.ts': digest },
    contentDigests: { 'a.ts': digest },
    createdAt: AT,
});

/** Each revision carries its own digest, so the guard can say *which* one the reference is. */
const DIGESTS: Record<string, string> = {
    'revision-aaaaaaaaaaaaaaaa': '1'.repeat(64),
    'revision-bbbbbbbbbbbbbbbb': '2'.repeat(64),
};

async function store(order: string[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-tie-'));
    roots.push(root);
    const dir = revisionsDir(root, 'tie');
    await mkdir(dir, { recursive: true });
    for (const name of order) await writeFile(join(dir, `${name}.json`), `${JSON.stringify(revision(name, DIGESTS[name]))}\n`);
    return root;
}

describe('the reference does not depend on directory order', () => {
    it('names the same reference whichever order the two revisions were written in', async () => {
        const first = await store(['revision-aaaaaaaaaaaaaaaa', 'revision-bbbbbbbbbbbbbbbb']);
        const second = await store(['revision-bbbbbbbbbbbbbbbb', 'revision-aaaaaaaaaaaaaaaa']);
        const fromFirst = await mostRecentDifferentContent(first, 'tie', current);
        const fromSecond = await mostRecentDifferentContent(second, 'tie', current);
        expect(fromSecond).toEqual(fromFirst);
        // **And it names a specific one**, not merely the same one twice: with `createdAt` equal the id decides, so the
        // greater id wins. Asserting stability alone was blind here — this filesystem returns `readdir` sorted, so removing
        // the tie-break still produced the same answer twice and the guard could not see it.
        expect(fromFirst).toEqual({ kind: 'found', digests: { 'a.ts': DIGESTS['revision-bbbbbbbbbbbbbbbb'] } });
    });
});

/**
 * **One case per site, because a catch-all is per site.** Each of these three readers wrapped its read in
 * `.catch(() => null)`, so a damaged record answered the same value as a missing one — and the consumers below each
 * turned that answer into a *weaker* fact: no freeze hash in an identity, empty surfaces in a decision binding, and
 * "this change produced no record". The measurement is the same in all three: write a record that cannot be parsed and
 * require the reader to name it rather than shrug.
 */
async function taskRoot(taskId: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-unreadable-site-'));
    roots.push(root);
    await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
    return root;
}

describe('a damaged record is not an absent one, at every site that reads one', () => {
    it('refuses to derive a freeze hash from a task record it cannot read', async () => {
        const taskId = 'freeze-hash-site';
        const root = await taskRoot(taskId);
        await writeFile(join(root, '.kata', 'tasks', taskId, 'task.json'), '{ "id": "freeze-hash-site" }\n');
        const { candidateFreezeHashFor } = await import('../../src/quality/review-ir.js');
        await expect(candidateFreezeHashFor(root, taskId, 'review')).rejects.toThrow(/task\.json/);
    });

    it('refuses to derive a decision identity from a task record it cannot read', async () => {
        const taskId = 'identity-site';
        const root = await taskRoot(taskId);
        await writeFile(join(root, '.kata', 'tasks', taskId, 'task.json'), '{ "id": "identity-site" }\n');
        const { currentRevisionIdentityFrom } = await import('../../src/workflow/verdict-binding.js');
        await expect(currentRevisionIdentityFrom({ kind: 'absent' }, root, taskId)).rejects.toThrow(/task\.json/);
    });

    it('refuses to call a damaged change record an absent one', async () => {
        const taskId = 'change-record-site';
        const root = await taskRoot(taskId);
        const { readChangeRecord } = await import('../../src/quality/change-record.js');
        expect(await readChangeRecord(root, taskId)).toBeNull();
        await writeFile(join(root, '.kata', 'tasks', taskId, 'change-record.json'), '{ "taskId": "change-record-site" }\n');
        await expect(readChangeRecord(root, taskId)).rejects.toThrow(/change-record\.json/);
    });
});

/**
 * **The same collapse, one layer up: the surfaces an operator reads to decide what to do next.**
 *
 * Round 1 found three readers of `current-state.json` folding a parse/schema error into "no state": `readTaskCandidate`
 * reported a task mid-review as `intake` under a comment claiming corruption was surfaced, `runOrientCommand` took the phase
 * from an older handoff packet, and the candidate listing dropped the task entirely. Each presented "I could not read this"
 * as a fact about the workflow, and the listing's version is the worst of the three: the task vanishes from the only place
 * that would have shown it.
 */
describe('a damaged state is not an absent one at the surfaces that decide what to do next', () => {
    const damagedState = async (root: string, taskId: string) => {
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeTaskRecord(root, { id: taskId, phase: 'review' });
        await writeFile(join(root, '.kata', 'tasks', taskId, 'current-state.json'), '{not json}\n');
    };

    it('refuses to present a task whose current-state.json cannot be read as intake', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-state-read-'));
        roots.push(root);
        await damagedState(root, 'mid-review');
        const { readTaskCandidate } = await import('../../src/cli/tasks.js');
        await expect(readTaskCandidate(root, 'mid-review')).rejects.toThrow(/cannot be read/);
    });

    it('names the task it cannot read in the candidate listing instead of dropping it', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-state-list-'));
        roots.push(root);
        await damagedState(root, 'mid-review');
        const { listTaskCandidates } = await import('../../src/cli/tasks.js');
        const listed = await listTaskCandidates(root);
        // Present, and saying why — not absent, which is what a dropped entry says.
        expect(listed.map((task) => task.taskId)).toContain('mid-review');
        expect(listed.find((task) => task.taskId === 'mid-review')?.phase).toBe('unreadable');
        expect(listed.find((task) => task.taskId === 'mid-review')?.upstream.unreadable).toMatch(/cannot be read/);
    });

    it('refuses to build an orient packet from a phase it could not read', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-state-orient-'));
        roots.push(root);
        await damagedState(root, 'mid-review');
        const { runOrientCommand } = await import('../../src/cli/tasks.js');
        // `orient` is the packet every governed step starts from; a phase borrowed from an older handoff is a guess.
        await expect(runOrientCommand(['--change', 'mid-review', '--root', root])).rejects.toThrow(/cannot be read/);
    });
});

/**
 * **Two more readers of a record, found by an independent round after the first five were fixed.**
 *
 * Both are the same fold with the same consequence as the ones above, and one of them is the worst direction this class
 * takes: a corrupt sibling record made an ownership claim disappear, so a scope addition was admitted without the flag that
 * exists to make shared ownership an explicit decision.
 */
describe('a damaged record cannot remove a claim, and cannot be reported as an unknown', () => {
    it('names the state record it cannot read at the wiki distill boundary', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-wiki-state-'));
        roots.push(root);
        const taskId = 'wiki-state';
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeTaskRecord(root, { id: taskId, phase: 'archive' });
        await writeFile(join(root, '.kata', 'tasks', taskId, 'judge.json'), `${JSON.stringify({ taskId, result: 'PASS', acceptance: [{ id: 'AC-1', result: 'PASS' }] })}\n`);
        await writeFile(join(root, '.kata', 'tasks', taskId, 'current-state.json'), '{not json}\n');
        const { distillPassedTaskKnowledge } = await import('../../src/wiki/provenance.js');
        const result = await distillPassedTaskKnowledge(root, taskId);
        // `deferred` either way — what must differ is that the *reason* names the record rather than reporting an unknown.
        expect(result.decision).toBe('deferred');
        expect(result.decision === 'deferred' ? result.reason : '').toMatch(/cannot be read/);
    });

    it('refuses a scope change when a sibling ownership claim cannot be read', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-scope-conflict-'));
        roots.push(root);
        const changeId = 'admitter';
        const sibling = 'owner';
        await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
        await mkdir(join(root, '.kata', 'tasks', sibling), { recursive: true });
        await writeTaskRecord(root, { id: changeId, phase: 'plan' });
        await writeTaskRecord(root, { id: sibling, phase: 'plan', ownedPaths: ['shared.ts'] });
        const { previewScopeChange } = await import('../../src/quality/scope-change.js');
        const { writeFile: write } = await import('node:fs/promises');

        // **With a readable sibling the conflict is found** — so the case measures a difference, not just a refusal.
        const readable = await previewScopeChange(root, changeId, [], ['shared.ts']);
        expect(readable.conflicts).toEqual([{ taskId: sibling, path: 'shared.ts' }]);

        // **With the sibling's record damaged the claim must not vanish.** It used to: `[]` meant "no conflict", and the
        // caller admitted the addition.
        await write(join(root, '.kata', 'tasks', sibling, 'task.json'), '{not json}\n');
        await expect(previewScopeChange(root, changeId, [], ['shared.ts'])).rejects.toThrow(/cannot decide whether the added paths conflict/);
    });
});

/**
 * **Two more folds of the same class, both found by round 3 as notes.**
 *
 * One of them is a gate in disguise: `mutateTaskArtefact` handed a callback `''` for an artefact that exists and cannot be
 * read, and a callback that ignores `current` — `writeChangeRecord` writes fixed bytes — replaced a governance record nobody
 * could read with a fresh one. The other is reporting only: the ledger's scan already named a damaged `plan.json`, but with
 * **no reason**, so an operator reading `malformedReasons` learned nothing.
 */
describe('a record that cannot be read is not handed to a writer as empty', () => {
    it('refuses to mutate an artefact it cannot read, naming it', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-mutate-unreadable-'));
        roots.push(root);
        const taskId = 'mutate-unreadable';
        const artefact = join(root, '.kata', 'tasks', taskId, 'change-record.json');
        await mkdir(artefact, { recursive: true });
        const { mutateTaskArtefact } = await import('../../src/core/state.js');
        await expect(mutateTaskArtefact(root, taskId, artefact, async () => 'replaced\n'))
            .rejects.toThrow(/cannot read .*change-record\.json before mutating it/);
    });

    it('names why a damaged plan cannot be compared, not just that it is malformed', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-plan-reason-'));
        roots.push(root);
        const taskId = 'plan-reason';
        const dir = join(root, '.kata', 'tasks', taskId, 'review');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'plan.json'), '{not json}\n');
        const { readLedger } = await import('../../src/store/ledger.js');
        const ledger = await readLedger(root, taskId);
        expect(ledger.malformedFiles).toContain('plan.json');
        // The scan named the file but not the reason; an operator reading the ledger has to be able to tell what to fix.
        expect(String(ledger.malformedReasons?.['plan.json'] ?? '')).toMatch(/cannot be read, so the request it describes cannot be compared/);
    });
});

/**
 * **Two more permissive folds, both found by round 4.**
 *
 * `findOwnershipConflicts` answered `[]` when the task store could not be listed — the answer that admits a scope addition
 * without `--allow-ownership-conflicts` — and the wiki distill boundary read a damaged `design.md` as an empty design.
 */
describe('an unreadable store or design is not an empty one', () => {
    it('refuses to decide ownership conflicts when the task store cannot be listed', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-store-unreadable-'));
        roots.push(root);
        // `.kata/tasks` is a file, so listing it cannot succeed for a reason that is not "there are no tasks".
        await mkdir(join(root, '.kata'), { recursive: true });
        await writeFile(join(root, '.kata', 'tasks'), 'not a directory\n');
        const { findOwnershipConflicts } = await import('../../src/workflow/revision.js');
        await expect(findOwnershipConflicts(root, 'any', ['shared.ts'])).rejects.toThrow(/cannot list the task store/);
    });

    it('names a design that cannot be read instead of deciding from an empty one', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-design-unreadable-'));
        roots.push(root);
        const taskId = 'design-unreadable';
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeTaskRecord(root, { id: taskId, phase: 'distill' });
        await writeFile(join(root, '.kata', 'tasks', taskId, 'judge.json'), `${JSON.stringify({ taskId, result: 'PASS', acceptance: [{ id: 'AC-1', result: 'PASS' }] })}\n`);
        await writeFile(join(root, '.kata', 'tasks', taskId, 'current-state.json'), `${JSON.stringify({ taskId, phase: 'distill' })}\n`);
        // A directory where the design should be: present, and unreadable as a file.
        await mkdir(join(root, '.kata', 'tasks', taskId, 'design.md'), { recursive: true });
        const { distillPassedTaskKnowledge } = await import('../../src/wiki/provenance.js');
        const result = await distillPassedTaskKnowledge(root, taskId);
        expect(result.decision).toBe('deferred');
        expect(result.decision === 'deferred' ? result.reason : '').toMatch(/design\.md exists and cannot be read/);
    });
});
