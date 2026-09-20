import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readValidated, readValidatedOptional, validate } from '../../src/core/schema.js';

/**
 * The artefact schemas are part of the contract: a reader that casts a parse result accepts anything, including a file
 * that no longer matches what the runtime writes. These tests pin the two behaviours readers rely on — a valid
 * artefact passes, and a drifted one fails where it is read, named and specific.
 */
describe('schema-validated artefact reads', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function tempFile(name: string, content: string): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-schema-'));
        roots.push(root);
        const path = join(root, name);
        await writeFile(path, content, 'utf8');
        return path;
    }

    const stateRecord = {
        taskId: 'schema-task',
        phase: 'implement',
        actor: { id: 'agent-1', role: 'implementer', platform: 'codex' },
        updatedAt: '2026-09-17T00:00:00.000Z',
    };

    it('accepts an artefact that matches its schema', async () => {
        const path = await tempFile('current-state.json', `${JSON.stringify(stateRecord)}\n`);

        await expect(readValidated('workflow-state-record', path)).resolves.toMatchObject({ taskId: 'schema-task' });
    });

    it('reports a missing artefact as a read failure and lets the tolerant variant return null', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-schema-missing-'));
        roots.push(root);
        const path = join(root, 'current-state.json');

        await expect(readValidated('workflow-state-record', path)).rejects.toThrow(/Cannot read workflow-state-record artefact .*current-state\.json/);
        await expect(readValidatedOptional('workflow-state-record', path)).resolves.toBeNull();
    });

    it('names the artefact, the path and the drifted field', async () => {
        const path = await tempFile('current-state.json', `${JSON.stringify({ ...stateRecord, phase: 'not-a-phase' })}\n`);

        await expect(readValidated('workflow-state-record', path)).rejects.toThrow(
            /workflow-state-record artefact .*current-state\.json does not match its schema: \$\.phase must be one of/,
        );
    });

    it('rejects an unexpected field rather than passing it through', async () => {
        const path = await tempFile('current-state.json', `${JSON.stringify({ ...stateRecord, surprise: true })}\n`);

        await expect(readValidated('workflow-state-record', path)).rejects.toThrow(/\$\.surprise is not allowed/);
    });

    it('rejects an artefact that is not JSON at all', async () => {
        const path = await tempFile('current-state.json', 'not json\n');

        await expect(readValidated('workflow-state-record', path)).rejects.toThrow(/is not valid JSON/);
    });

    it('honours union types where the record allows null', () => {
        const requirement = { id: 'REQ-1', statement: 'A requirement', mappedTo: null };

        expect(() => validate('task', {
            id: 'schema-task',
            title: 'Schema',
            phase: 'implement',
            acceptance: [{ id: 'AC-1', statement: 'Covered.' }],
            createdAt: '2026-09-17T00:00:00.000Z',
            updatedAt: '2026-09-17T00:00:00.000Z',
            upstreamCoverage: { version: 1, sources: [{ ref: 'docs/spec.md', requirements: [requirement] }] },
        })).not.toThrow();

        expect(() => validate('task', {
            id: 'schema-task',
            title: 'Schema',
            phase: 'implement',
            acceptance: [{ id: 'AC-1', statement: 'Covered.' }],
            createdAt: '2026-09-17T00:00:00.000Z',
            updatedAt: '2026-09-17T00:00:00.000Z',
            upstreamCoverage: { version: 1, sources: [{ ref: 'docs/spec.md', requirements: [{ ...requirement, mappedTo: 7 }] }] },
        })).toThrow(/mappedTo must be string or null/);
    });

    it('validates the artefacts that had no schema before: repair, obligations, revision and the choice gate', () => {
        expect(() => validate('repair', {
            taskId: 'schema-task',
            fromPhase: 'review',
            toPhase: 'implement',
            actor: { id: 'agent-1', role: 'implementer' },
            reason: 'review_findings',
            createdAt: '2026-09-17T00:00:00.000Z',
        })).not.toThrow();

        expect(() => validate('repair-obligations', {
            obligations: [{
                id: 'obligation-1',
                taskId: 'schema-task',
                source: 'judge',
                severity: 'blocking',
                message: 'Repair the failing acceptance.',
                createdAt: '2026-09-17T00:00:00.000Z',
            }],
            updatedAt: '2026-09-17T00:00:00.000Z',
        })).not.toThrow();

        expect(() => validate('revision', {
            id: 'revision-1',
            taskId: 'schema-task',
            ownedPaths: ['src/core/state.ts'],
            manifestHash: 'a'.repeat(64),
            createdAt: '2026-09-17T00:00:00.000Z',
        })).not.toThrow();

        expect(() => validate('user-choice-gate', {
            taskId: 'schema-task',
            boundary: 'review_gate',
            createdAt: '2026-09-17T00:00:00.000Z',
            choice: 'continue_current',
        })).not.toThrow();

        expect(() => validate('revision', { id: 'revision-1', taskId: 'schema-task', ownedPaths: [], manifestHash: 'x', createdAt: 'now' }))
            .toThrow(/ownedPaths must include at least 1 item/);
    });
describe('a validation failure names what the schema allows', () => {
    it('lists the accepted top-level fields', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-schema-hint-'));
        roots.push(root);
        const file = join(root, 'record.json');
        await writeFile(file, JSON.stringify({ id: 'x', unexpected: true }), 'utf8');

        // The remedy for "…is not allowed" is the allowed set, without opening the bundle to find the schema.
        await expect(readValidated('wiki-record', file)).rejects.toThrow(/Allowed fields: .*id/);
        await rm(root, { recursive: true, force: true });
    });
});

    it('names what a schema allows when a field is not accepted', async () => {
        const file = await tempFile('record.json', JSON.stringify({ id: 'x', unexpected: true }));

        // The remedy for "…is not allowed" is the allowed set, without opening the bundle to find the schema.
        await expect(readValidated('wiki-record', file)).rejects.toThrow(/Allowed fields: .*id/);
    });
});

/**
 * The two keywords the hand-written interpreter silently ignored, and the schema that was not a schema at all.
 *
 * These are not new rules: `task.schema.json` already said `workflowProfile.version` is `const: 1` and that `ownedPaths`
 * is `uniqueItems`, and the interpreter simply never looked. A validator that does not enforce the file it reads is the
 * failure this replace exists to end.
 */
describe('the validator enforces the whole schema, not just the keywords the interpreter knew', () => {
    const profile = { version: 1, isolationMode: 'current_worktree', developmentMode: 'tdd', reviewMode: 'std', comet: { projectInit: 'not_requested', openStatus: 'acknowledged' } };
    const task = (overrides: Record<string, unknown>) => ({
        id: 'schema-task',
        title: 'Schema task',
        phase: 'implement',
        acceptance: [{ id: 'AC-1', statement: 'x' }],
        createdAt: '2026-09-17T00:00:00.000Z',
        updatedAt: '2026-09-17T00:00:00.000Z',
        workflowProfile: profile,
        ...overrides,
    });

    it('refuses a `const` value the interpreter let through', () => {
        // `workflowProfile.version: 2` used to pass, so a task could declare a profile version nothing reads.
        expect(() => validate('task', task({ workflowProfile: { ...profile, version: 2 } })))
            .toThrow(/workflowProfile.version must be 1/);
    });

    it('refuses duplicate array items the interpreter let through', () => {
        expect(() => validate('task', task({ ownedPaths: ['src', 'src'] })))
            .toThrow(/ownedPaths must not contain duplicate items/);
    });

    it('names the offending path for a nested violation, not just the root', () => {
        // The path is the whole value of the error: `$.workflowProfile.comet.openStatus` tells the reader where to look.
        expect(() => validate('task', task({ workflowProfile: { ...profile, comet: { ...profile.comet, openStatus: 'nope' } } })))
            .toThrow(/\$\.workflowProfile\.comet\.openStatus must be one of/);
    });

    it('compiles every bundled schema, so a malformed asset fails here and not at the first real artefact', () => {
        // `wiki-record.schema.json`'s `provenance` was a bare array — valid JSON, not a schema. The interpreter ignored
        // it; Ajv refuses to compile it, which is why the corpus repair had to land in the same change as the swap.
        const names = ['task', 'workflow-state-record', 'workflow-state-event', 'evidence', 'review-finding', 'judge-result', 'wiki-record', 'handoff-packet', 'handoff-receipt', 'repair', 'repair-obligations', 'repair-batch', 'scope-changes', 'revision', 'user-choice-gate', 'task-choice', 'review', 'verify-result', 'kata-relations', 'adversarial-review'];

        for (const name of names) {
            expect(() => validate(name, {}), name).not.toThrow(/schema is invalid|must be object,boolean/);
        }
    });
});