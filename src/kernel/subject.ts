/**
 * Subject — the content-addressed freeze, and the only thing a decision is about.
 *
 * Pure: `node:crypto` is a computation library, not an I/O surface, so it is the one builtin allowed in the kernel. The
 * kernel's test asserts that no I/O module is imported here (see `tests/unit/kernel-is-pure-and-platform-neutral.test.ts`).
 */
import { createHash } from 'node:crypto';
import type { Subject } from './types.js';

export const KERNEL_ALLOWED_BUILTINS: readonly string[] = ['node:crypto'];
export const KERNEL_BANNED_BUILTINS: readonly string[] = [
    'node:fs',
    'node:fs/promises',
    'node:child_process',
    'node:net',
    'node:http',
    'node:https',
    'node:os',
    'node:worker_threads',
    'node:dns',
    'node:process',
    'node:stream',
    'node:module',
];

/** A stable revision id from a digest map: the same content yields the same id, byte for byte. */
export function revisionOf(pathDigests: Record<string, string>): string {
    const canonical = Object.keys(pathDigests)
        .sort()
        .map((path) => `${path}\u0000${pathDigests[path] ?? ''}`)
        .join('\n');
    return `rev:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

export function subjectOf(pathDigests: Record<string, string>): Subject {
    return { revision: revisionOf(pathDigests), pathDigests };
}

export type SubjectDiff = { changed: string[]; added: string[]; removed: string[]; unchanged: string[] };

/** What moved between two freezes, path by path. Used by risk classification and by the delta calculation. */
export function diffSubjects(previous: Subject, next: Subject): SubjectDiff {
    const changed: string[] = [];
    const added: string[] = [];
    const removed: string[] = [];
    const unchanged: string[] = [];
    const paths = new Set([...Object.keys(previous.pathDigests), ...Object.keys(next.pathDigests)]);
    for (const path of [...paths].sort()) {
        const before = previous.pathDigests[path];
        const after = next.pathDigests[path];
        if (before === undefined) added.push(path);
        else if (after === undefined) removed.push(path);
        else if (before === after) unchanged.push(path);
        else changed.push(path);
    }
    return { changed, added, removed, unchanged };
}

/** The identity check the delta rule rests on: did everything this claim rests on stay byte-identical? */
export function dependencyDigestsMatch(previous: Subject, next: Subject, paths: string[]): boolean {
    return paths.every((path) => previous.pathDigests[path] !== undefined && previous.pathDigests[path] === next.pathDigests[path]);
}
