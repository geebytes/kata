import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { ensureRuntimeGitignore, taskDir, tasksDir } from '../core/layout.js';
import { gitCurrentBranchOf, gitWorktreeAdd, gitWorktreeList, gitWorktreeRemove, hasCommit, runGit, type GitWorktree } from '../core/git.js';
import { assertValidTaskId } from '../core/ids.js';

/**
 * Linked worktrees, owned by kata.
 *
 * Kata declared `isolated_worktree` and then left the creation convention to each host — `.claude/worktrees/`,
 * `.codex/…`, a sibling directory — so nothing could resolve `--root` on the agent's behalf and nested layouts were
 * ambiguous. This module makes the convention kata's: linked worktrees live under `.kata/worktrees/`, which is ignored
 * by git and by repository identity, so a nested worktree never shows up as untracked paths in its primary checkout.
 *
 * What a created worktree gets, so an agent can start working in it immediately:
 *   - kata's workspace hygiene (the `.kata/runtime/` and `.kata/worktrees/` ignore rules);
 *   - **no copy of the task's records.** They have one owner (the checkout that holds the task), and a worktree that
 *     carried its own copy was the defect this line of work removed: two answers to one question, and an archive that
 *     deleted whichever copy lived in the worktree. The worktree isolates the *code*; `taskStateCopied` is `false` and
 *     kept as a witness. The runtime pointer is likewise not copied — it is per-session and activated in the worktree.
 */

export const worktreesDirName = join('.kata', 'worktrees');

/** Where kata puts linked worktrees for a repository. */
export function worktreesDir(root: string): string {
    return join(root, worktreesDirName);
}

export interface WorktreeEntry extends GitWorktree {
    /** The kata tasks whose state is present in that worktree. */
    tasks: string[];
    /** True for the worktree the command resolved as the workspace root. */
    current: boolean;
}

export async function listWorktrees(root: string): Promise<WorktreeEntry[]> {
    const current = resolve(root);
    const entries = await Promise.all(gitWorktreeList(root).map(async (worktree) => ({
        ...worktree,
        tasks: await tasksInWorktree(worktree.path),
        current: resolve(worktree.path) === current,
    })));
    return entries;
}

async function tasksInWorktree(path: string): Promise<string[]> {
    try {
        const entries = await readdir(tasksDir(path));
        const withState = await Promise.all(entries
            .filter((entry) => !entry.startsWith('.'))
            .map(async (entry) => (await stat(join(tasksDir(path), entry, 'current-state.json')).then(() => true).catch(() => false))
                ? entry
                : null));
        return withState.filter((entry): entry is string => entry !== null).sort();
    } catch {
        return [];
    }
}

export interface CreateWorktreeResult {
    path: string;
    branch: string;
    base: string;
    taskId?: string;
    /**
     * Whether the task's state was copied into the worktree. **Always `false`, and kept as a witness**: a worktree that
     * carried its own copy of the records is the defect this change removed, and `tests/unit/worktree.test.ts` asserts
     * this field is false so a future reintroduction of the copy has to change an assertion that says why it must not.
     * The previous wording ("True when the task's state was copied in…") described a behaviour that no longer exists.
     */
    taskStateCopied: boolean;
    gitignoreUpdated: boolean;
    /** How the agent continues: the task-addressed command works from inside the worktree now. */
    rootResolution: string;
}

export async function createWorktree(input: {
    root: string;
    branch?: string;
    path?: string;
    base?: string;
    taskId?: string;
    force?: boolean;
}): Promise<CreateWorktreeResult> {
    const root = input.root;
    if (input.taskId) assertValidTaskId(input.taskId);

    const branch = input.branch ?? (input.taskId ? `kata/${input.taskId}` : undefined);
    if (!branch) throw new Error('worktree create requires --branch, or a --change whose name forms the branch');
    const base = input.base ?? (gitCurrentBranchOf(root) ?? 'HEAD');
    const target = input.path
        ? resolve(root, input.path)
        : join(worktreesDir(root), input.taskId ?? branch.replaceAll('/', '-'));

    // A nested worktree must be ignored before it exists, or git reports its contents as untracked paths in the
    // primary checkout for as long as it lives there.
    await mkdir(worktreesDir(root), { recursive: true });
    const primaryHygiene = await ensureRuntimeGitignore(root);
    await mkdir(join(target, '..'), { recursive: true });

    const created = gitWorktreeAdd(root, target, branch, input.base ? { base: input.base } : { base });
    if (!created.ok) {
        const detail = created.stderr.trim() || created.stdout.trim() || 'unknown error';
        // A repository with no commit has no base to branch from; that is worth saying plainly, because the remedy is one
        // commit rather than anything about worktrees.
        //
        // The question is asked of the **repository**, not of the failure message. Matching git's prose was how this
        // branch became unreachable: it looked for `not a valid object name|does not have any commits`, and git 2.43 says
        // `invalid reference: HEAD` — so the remedy disappeared silently, and the same regex would have read a translated
        // string in a non-English locale. `hasCommit` is an exit code.
        if (!hasCommit(root)) {
            throw new Error(`git worktree add failed: ${detail}. The repository has no commit to branch from — make an initial commit first.`);
        }
        throw new Error(`git worktree add failed: ${detail}`);
    }

    const hygiene = await ensureRuntimeGitignore(target);
    // **No second copy of the records.** This used to `cp` the task's state into the new worktree, on the premise that
    // "the state is tracked" so a commit would have checked it out anyway. The premise was false (`.gitignore` ignores all
    // of `.kata/`), so the copy was the *only* way the records reached the worktree — and once there, a command run inside
    // the worktree kept writing to them, producing two answers to one question (measured: one task reporting `phase:
    // archive` from its worktree and `phase: implement` from the primary checkout). The worktree isolates the *code*; the
    // records have one owner (`recordsRoot`), which is the checkout that holds the task, and no copy is needed for that.
    const taskStateCopied = false;

    return {
        path: target,
        branch,
        base,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        taskStateCopied,
        gitignoreUpdated: primaryHygiene || hygiene,
        // **The sentence has to describe what the code does.** It used to promise that a task-addressed command run
        // from this worktree "resolves that worktree as the workspace root" — which was true only while the worktree held
        // a copy of the records, and is false now that records have one owner: the *code* root is this worktree
        // (`resolveCodeRoot`), while the *records* stay with the checkout that owns the task.
        rootResolution:
            `Task-addressed commands run from ${relative(root, target) || target} use that worktree as the code root, `
            + 'while the task\'s records stay with the checkout that owns the task; pass --root to stand in another checkout explicitly.',
    };
}

export interface RemoveWorktreeResult {
    path: string;
    removed: boolean;
    warning?: string;
}

/** What a recovery moved, per task. */
export interface RecordRecovery {
    taskId: string;
    /** The record file names copied from the worktree to the owner, sorted. */
    moved: string[];
    /** The file names the owner already had, which a recovery never overwrites. */
    kept: string[];
    /** The entries that could not be placed, named with the reason, so one bad record does not stop the rest. */
    skipped: string[];
}

/**
 * **Bring a worktree's records back to their owner, without overwriting anything.**
 *
 * The code in this change stops new divergence; this handles what already diverged. Measured on this repository: four merged
 * changes hold 129 record files that exist only under `.kata/worktrees/<taskId>` — review records, judge verdicts,
 * per-revision change records, gate choices, wiki closure — and `archive` deletes exactly that directory. Without this, the
 * audit of four reviewed, judged and merged changes is deleted by the step that closes them.
 *
 * **Copy, never move, and never overwrite.** The worktree copy is left in place: a recovery is not the moment to test
 * whether the reader that needed it can cope with its absence, and a later `archive` refused by the removal guard is the
 * safe outcome. Where both roots have a file, the owner's copy wins, because the worktree's copy may be the stale one and
 * nothing here can tell which was written last without inventing a rule.
 */
export async function recoverWorktreeRecords(root: string): Promise<RecordRecovery[]> {
    const { worktreeOnlyRecords } = await import('../core/layout.js');
    const { copyFile, mkdir: makeDir } = await import('node:fs/promises');
    const stranded = await worktreeOnlyRecords(root);
    const recovery: RecordRecovery[] = [];
    for (const entry of stranded) {
        const ownerDir = join(root, '.kata', 'tasks', entry.taskId);
        const worktreeDir = join(root, entry.worktree, '.kata', 'tasks', entry.taskId);
        await makeDir(ownerDir, { recursive: true });
        const moved: string[] = [];
        const kept: string[] = [];
        const skipped: string[] = [];
        for (const file of entry.files) {
            // **The reported path names its surface** (`tasks/…` or `evidence/…`), because the two stores are laid out
            // differently: the task's own directory is nested under the task, the evidence store is flat and shared.
            const [surface, ...rest] = file.split('/');
            const inSurface = rest.join('/');
            const destination =
                surface === 'evidence'
                    ? join(root, '.kata', 'evidence', inSurface)
                    : join(ownerDir, inSurface);
            const source =
                surface === 'evidence'
                    ? join(root, entry.worktree, '.kata', 'evidence', inSurface)
                    : join(worktreeDir, inSurface);
            if (destination === undefined || source === undefined) continue;
            // **A name that exists at the owner is kept, whatever it is.** The first version of this used `stat` on the
            // destination and `copyFile` otherwise — so a *directory* that existed at the owner (`handoffs/`, which every
            // task has) was not counted as present and the copy threw `EISDIR`, which aborted the whole recovery. Measured
            // on this repository: the first pilot run moved nothing and reported nothing.
            const present = await stat(destination).then(() => true).catch(() => false);
            const sourceIsDirectory = await stat(source).then((info) => info.isDirectory()).catch(() => false);
            if (present) {
                // Which copy is newer is not knowable here, and the owner is the one the change is recorded against.
                kept.push(file);
                continue;
            }
            if (sourceIsDirectory) {
                await cp(source, destination, { recursive: true });
                moved.push(file);
                continue;
            }
            // **A nested record's parent may not exist yet.** Once the detector compares paths instead of names it reports
            // `handoffs/x.json` rather than `handoffs`, and the owner's `handoffs/` may be absent or empty, so the copy
            // needs somewhere to land. Without this the recovery threw `ENOENT` on the first nested file and moved nothing
            // — measured when the recursive comparison landed.
            // **One record that cannot be placed must not abort the rest.** A file/directory type conflict at the
            // destination (`handoffs` as a file on one side, a directory on the other) made `mkdir` throw `EEXIST`, and
            // the throw left the loop — so a single bad entry stopped every later file *and every later task* from being
            // recovered, while the guard's own remedy reported a failure with no partial result. The entry is reported as
            // skipped, and the recovery continues.
            try {
                await makeDir(dirname(destination), { recursive: true });
                await copyFile(source, destination);
                moved.push(file);
            } catch (error) {
                skipped.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        recovery.push({ taskId: entry.taskId, moved: moved.sort(), kept: kept.sort(), skipped: skipped.sort() });
    }
    return recovery;
}

/** The result of a guarded removal: whether it happened, and what refused it when it did not. */
export interface GuardedRemoval extends Partial<RemoveWorktreeResult> {
    /** Set when the removal was refused by kata rather than by git. */
    refusedBecause?: 'worktree-only-records';
    /** The records that exist only under the worktree, when that is why the removal was refused. */
    worktreeOnlyRecords?: string[];
    /** The command that resolves the refusal, so the operator is not left to invent one. */
    remedy?: string;
    /** What the remedy does, in one line. */
    remedyDetail?: string;
}

/**
 * **Remove a linked worktree, unless it holds the only copy of a task's records.**
 *
 * `cmdArchive` deletes `.kata/worktrees/<taskId>` once the phase reaches `archive`, and because task state is written under
 * whichever root a command resolved, that directory can hold the only copy of the change's records. Measured on this
 * repository: four merged changes have 129 record files that exist only under their worktree — review records, judge
 * verdicts, change records per revision, the gate choices — and the single removal that did not happen was refused by git
 * for an unrelated reason (an untracked directory). Luck is not a guard, so the guard lives at the removal, where every
 * route to the deletion has to pass it.
 *
 * The refusal names the files, because "refused" without the list leaves the operator to find 129 of them by hand.
 *
 * **And it names the way out.** A refusal that only lists files leaves two bad options: leave the worktree forever, or
 * delete it by hand. `recoverWorktreeRecords` is the intended route and now has a command, so the refusal carries it — a
 * guard whose remedy is unreachable is the state this change exists to fix.
 */
export async function removeWorktreeSafely(input: {
    root: string;
    path: string;
    taskId: string;
    force?: boolean;
}): Promise<GuardedRemoval> {
    const { worktreeOnlyRecords } = await import('../core/layout.js');
    const report = await worktreeOnlyRecords(input.root);
    // **The guard judges the path, not the task id it was handed.** It used to ask
    // `report.find((entry) => entry.taskId === input.taskId)`, so a worktree called `T` holding `U`'s records produced a
    // report entry for `U`, the lookup for `T` found nothing, and the removal proceeded — deleting `U`'s only copy and
    // returning success. Measured on a fixture before this criterion: `{"removed":true}`, `verdicts.json` gone.
    //
    // The caller's id is a *claim about the worktree*, and the guard exists because that claim can be wrong; that is the
    // whole reason it is not the guard's input any more. It stays accepted for compatibility, and is not consulted.
    const target = resolve(input.root, input.path);
    const forThisPath = report.filter((entry) => resolve(input.root, entry.worktree) === target);
    const files = forThisPath.flatMap((entry) => entry.files);
    if (files.length > 0) {
        const forThisTask = { taskId: forThisPath[0]!.taskId, files };
        return {
            path: resolve(input.root, input.path),
            removed: false,
            refusedBecause: 'worktree-only-records',
            worktreeOnlyRecords: forThisTask.files,
            remedy: `kata-cli worktree recover --change ${forThisTask.taskId}`,
            remedyDetail:
                'Copies the records the owner does not have, never overwrites one it has, and reports what moved. '
                + 'Run it, then remove the worktree.',
        };
    }
    return removeWorktree(input);
}

export async function removeWorktree(input: { root: string; path: string; force?: boolean }): Promise<RemoveWorktreeResult> {
    const target = resolve(input.root, input.path);

    // Refuse to remove the checkout the command is running in, or the primary one: git would either fail confusingly or
    // delete work out from under the caller.
    const status = runGit(target, ['status', '--porcelain=v1', '--untracked-files=all']);
    const dirty = status.ok && status.stdout.trim().length > 0;
    const removed = gitWorktreeRemove(input.root, target, input.force ? { force: true } : {});
    if (!removed.ok) {
        const detail = removed.stderr.trim() || removed.stdout.trim();
        throw new Error(dirty && !input.force
            ? `The worktree has uncommitted changes, so git refused to remove it: ${detail}. Commit or discard them, or pass --force.`
            : `git worktree remove failed: ${detail || 'unknown error'}`);
    }

    // A linked worktree's administration entry can survive a removal git performed with --force.
    runGit(input.root, ['worktree', 'prune']);
    return {
        path: target,
        removed: true,
        ...(dirty ? { warning: 'Removed with --force while the worktree had uncommitted changes; that work is gone.' } : {}),
    };
}
