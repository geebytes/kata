import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acceptanceIdPattern, requirementIdPattern, taskIdPattern } from '../../src/core/ids.js';

/**
 * Kata's identifier shapes and the schemas that police them stay one rule.
 *
 * The schemas are assets — kata vendors them into projects so other tooling can validate records without kata — so they
 * cannot import the constants. They drifted once: the upstream requirement id demanded `REQ-<n>` while the ids a real
 * design document uses (`AC-R1`, `GUARD-3`, `SLICE-S2`) are what upstream coverage exists to name, so a task had to
 * rename every requirement by hand before it could be sealed. The agreement is asserted here instead of derived, the
 * same arrangement the evidence kinds use.
 */
describe('identifier rules', () => {
    const schemasDir = join(import.meta.dirname, '..', '..', 'schemas');

    async function schema(name: string): Promise<Record<string, unknown>> {
        return JSON.parse(await readFile(join(schemasDir, name), 'utf8')) as Record<string, unknown>;
    }

    function findPatterns(node: unknown, pattern: string, found: string[] = []): string[] {
        if (Array.isArray(node)) {
            for (const value of node) findPatterns(value, pattern, found);
        } else if (node && typeof node === 'object') {
            for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
                if (key === 'pattern' && value === pattern) found.push(pattern);
                findPatterns(value, pattern, found);
            }
        }
        return found;
    }

    it('accepts the requirements a real document names', () => {
        // The shapes upstream documents actually use. A rule that rejects these rejects traceability.
        for (const id of ['AC-R1', 'AC-C2', 'AC-K5', 'GUARD-3', 'PREVALIDATE-6', 'SLICE-S2', 'REQ-1']) {
            expect(requirementIdPattern.test(id), id).toBe(true);
        }
        for (const id of ['', ' leading', 'a b', 'a/b']) {
            expect(requirementIdPattern.test(id), id).toBe(false);
        }
    });

    it('keeps acceptance ids kata’s own numbering', () => {
        expect(acceptanceIdPattern.test('AC-1')).toBe(true);
        expect(acceptanceIdPattern.test('AC-R1')).toBe(false); // an upstream id, not an acceptance id
        expect(taskIdPattern.test('skill-identity-idempotency-versioning')).toBe(true);
    });

    it('matches every schema that polices an acceptance or requirement id', async () => {
        const acceptanceSchemas = ['task.schema.json', 'judge-result.schema.json', 'verify-result.schema.json', 'review-finding.schema.json'];
        for (const name of acceptanceSchemas) {
            expect(findPatterns(await schema(name), '^AC-[0-9]+$').length, name).toBeGreaterThan(0);
        }

        const task = await schema('task.schema.json');
        expect(findPatterns(task, '^[A-Za-z0-9][A-Za-z0-9._:-]*$').length).toBeGreaterThan(0);
        // The old invented namespace must be gone from the assets.
        expect(findPatterns(task, '^REQ-[0-9]+$')).toEqual([]);
    });
});
