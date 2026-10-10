import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

/**
 * The result of reading one JSON record: absent, usable, or **unreadable**.
 *
 * `readValidatedOptional` (`core/schema.ts`) is the precedent, and this is the same contract one layer down: only `ENOENT`
 * is absent, and every other failure is a refusal that names the file. The distinction is the whole point — a reader that
 * answers `null` for a parse error cannot tell a record nobody wrote from a record that is damaged, and every consumer of
 * that answer reports "nothing here" for a file an operator has to repair.
 *
 * `T` is the caller's declared shape; a record that parses to something other than an object is unreadable rather than
 * usable, because a JSON array or number is not a record in any of the shapes this reads.
 */
export type RecordRead<T> =
    | { kind: 'absent' }
    | { kind: 'usable'; value: T }
    | { kind: 'unreadable'; detail: string };

/** A caller-defined semantic shape for a JSON object record. */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export type RecordShape<T extends Record<string, unknown>> = (value: Record<string, unknown>) => value is T;
export async function readRecordState<T extends Record<string, unknown>>(path: string, shape?: RecordShape<T>): Promise<RecordRead<T>> {
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
        return { kind: 'unreadable', detail: `${basename(path)} could not be read (${(error as Error).message})` };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        return { kind: 'unreadable', detail: `${basename(path)} is not valid JSON (${(error as Error).message})` };
    }
    if (!isJsonRecord(parsed)) {
        return { kind: 'unreadable', detail: `${basename(path)} is not a JSON object` };
    }
    if (shape !== undefined && !shape(parsed)) {
        return { kind: 'unreadable', detail: `${basename(path)} has an invalid record shape` };
    }
    return { kind: 'usable', value: parsed as T };
}

/**
 * The same three-way reading for a **directory**: absent only when it does not exist.
 *
 * The file-level rule does not transfer by itself: a reader that lists a directory and answers `[]` for *every* failure makes
 * EACCES, ENOTDIR and a damaged mount indistinguishable from "there is nothing here", and the callers that did that were
 * measured in an independent round — `readRecordedEvidence` and `listEvidenceFiles` both fold a listing failure into an empty
 * set, which reads as "no evidence recorded" for a directory an operator cannot currently see.
 */
export type DirectoryRead = { kind: 'absent' } | { kind: 'usable'; entries: string[] } | { kind: 'unreadable'; detail: string };

export async function readDirectoryState(path: string): Promise<DirectoryRead> {
    try {
        const { readdir } = await import('node:fs/promises');
        return { kind: 'usable', entries: await readdir(path) };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
        return { kind: 'unreadable', detail: `${basename(path)} could not be listed (${(error as Error).message})` };
    }
}

/** The value when the record is usable, `null` otherwise — for readers that only need the payload. */
export function usableOrNull<T>(read: RecordRead<T>): T | null {
    return read.kind === 'usable' ? read.value : null;
}
