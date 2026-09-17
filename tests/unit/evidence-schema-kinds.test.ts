import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evidenceKinds } from '../../src/quality/evidence.js';

/**
 * The evidence schema and the code agree on which evidence kinds exist.
 *
 * They drifted once: `evidenceKinds` gained `integration` and `entrypoint` for the acceptance matrix's verification
 * levels, but `evidence.schema.json`'s `kind` enum kept the original seven. The seal then wrote an evidence artefact of
 * the new kind and could not read it back — its own product failed its own schema, which is the failure this test
 * exists to make impossible.
 *
 * The schema is an asset (kata writes it into projects for other tooling to read), so it cannot import the constant; the
 * agreement is asserted here instead.
 */
describe('evidence schema kinds', () => {
    const schemasDir = join(import.meta.dirname, '..', '..', 'schemas');

    async function schema(name: string): Promise<Record<string, unknown>> {
        return JSON.parse(await readFile(join(schemasDir, name), 'utf8')) as Record<string, unknown>;
    }

    it('lists exactly the kinds the code knows, in the same order', async () => {
        const evidence = await schema('evidence.schema.json');
        const kind = (evidence.properties as { kind: { enum: string[] } }).kind;

        expect(kind.enum).toEqual([...evidenceKinds]);
    });

    it('accepts every kind the acceptance matrix may declare', async () => {
        const [evidence, task] = await Promise.all([schema('evidence.schema.json'), schema('task.schema.json')]);
        const evidenceEnum = (evidence.properties as { kind: { enum: string[] } }).kind.enum;
        const matrixKindEnum = (
            (task.properties as { acceptanceMatrix: { properties: { rows: { items: { properties: { evidence: { items: { properties: { kind: { enum: string[] } } } } } } } } } })
                .acceptanceMatrix
        ).properties.rows.items.properties.evidence.items.properties.kind.enum;

        // A matrix may declare these; a check of such a kind must be recordable as evidence.
        for (const kind of matrixKindEnum) expect(evidenceEnum).toContain(kind);
    });
});
