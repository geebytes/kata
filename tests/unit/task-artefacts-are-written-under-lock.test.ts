import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **AC-3: a task-owned artefact has one writer, and it holds the lock.**
 *
 * This is the `one decision, two entrances, only one records it` class from this repository's own defect table, and it
 * has produced two real defects on this line: a scope apply that validated on the read path while trusting its input on
 * the write path, and a declaration corrected through `--owned-paths` that wrote `task.json` without the record
 * `scope change` leaves behind. Both were invisible because a second write path to an artefact looks like ordinary code.
 *
 * The check is a recorded allowlist rather than a heuristic: every raw write into the governed store must be one of the
 * sites below, with the reason it is not going through the locking writer. A new one fails this case, so the choice is
 * made deliberately instead of inherited.
 */
const SRC = new URL('../../src/', import.meta.url).pathname;

async function sourceFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
        else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
}

/** Path helpers that resolve inside `.kata/tasks/<id>/`. A write to one of these is a write to governed state. */
const TASK_STORE_HELPERS = ['taskPath(', 'repairPath(', 'reviewDir(', 'handoffPacketPath(', 'taskDir(', 'layoutTaskDir('];

/**
 * The raw writes into the governed store that are deliberate, each with the reason.
 *
 * Keyed by `<module>|<the marker that made it a store write>` rather than by line number or by the whole line: a line
 * number moves whenever anything above it changes, and a whole-line key has to reproduce the line's escaping exactly,
 * which makes the allowlist about string quoting instead of about the decision. A marker is stable, and two sites in one
 * module sharing a marker is refused below, so the key still identifies one site.
 */
const RECORDED: Record<string, string> = {
    "src/core/state.ts|repairPath(":
        'inside `withTaskLock` — the repair record is written by the repair-entry transition itself, so the lock is already held',
    "src/core/task.ts|'task.json'":
        'task creation, where the directory is mkdir-ed first so a second creation fails before any write — there is no lock to take yet because the task does not exist',
};

describe('a write into the governed store goes through the locking writer', () => {
    it('finds no raw task-store write that has not been recorded', async () => {
        const files = await sourceFiles(SRC);
        const found: Array<{ key: string; line: string }> = [];
        for (const file of files) {
            const relative = file.replace(SRC, 'src/');
            const lines = (await readFile(file, 'utf8')).split('\n');
            for (const [index, line] of lines.entries()) {
                if (!/\bwriteFile\(/.test(line)) continue;
                // `taskDirectory` and the literal are here because a task-store path does not have to come from a helper to
                // be a task-store path — the defect this case is about built one with `join(taskDirectory, 'task.json')`.
                // **Ordered most-specific-first, and the first match wins.** `join(taskDirectory, 'task.json')` matches both
                // `'task.json'` and `taskDirectory`; taking the specific one keeps the key describing the artefact rather
                // than the variable that happened to hold its directory, and leaves `taskDirectory` to catch a path built
                // from it that names no artefact this list knows.
                const markers = [...TASK_STORE_HELPERS, "'task.json'", 'taskDirectory'];
                const marker = markers.find((candidate) => line.includes(candidate));
                if (marker === undefined) continue;
                // The locking writer's own body calls `writeFile`; it is the thing everything else should use.
                if (relative === 'src/core/state.ts' && line.includes('tempPath')) continue;
                found.push({ key: `${relative}|${marker}`, line: `${relative}:${index + 1}` });
            }
        }

        // Two sites in one module that share a marker would share a key, which would let the second one hide behind the
        // first's reason. Refused rather than merged.
        const duplicateKeys = found.map((entry) => entry.key).filter((key, index, all) => all.indexOf(key) !== index);
        expect(duplicateKeys, 'two sites share an allowlist key, so one of them is unrecorded').toEqual([]);

        const unrecorded = found.filter((entry) => RECORDED[entry.key] === undefined).map((entry) => entry.line);
        expect(
            unrecorded,
            'a task-store write must go through `mutateTaskArtefact`, or be recorded here with why it cannot',
        ).toEqual([]);
        // Both directions: a recorded site that no longer exists is a stale exception, and stale exceptions are how an
        // allowlist stops describing the code.
        const stale = Object.keys(RECORDED).filter((key) => !found.some((entry) => entry.key === key));
        expect(stale, 'these recorded sites no longer exist, so remove them rather than leaving the reason behind').toEqual([]);
    });

    it('routes the packet write through the writer rather than the store', async () => {
        // The specific defect this change fixes: the packet was written with a bare `writeFile` into a task directory
        // built from a hand-written task id.
        const text = await readFile(join(SRC, 'wiki/enrich-packet.ts'), 'utf8');
        expect(text, 'the packet writer must not build a task-store path').not.toMatch(/taskDir\([^)]*wiki-enrich/);
    });
});
