import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { evidenceKinds } from '../../src/quality/evidence.js';

describe('Kata config evidence kinds', () => {
    const roots: string[] = [];

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-config-kinds-'));
        roots.push(root);
        return root;
    }

    async function writeChecks(root: string, kind: string): Promise<void> {
        await writeFile(
            join(root, '.kata-config.json'),
            `${JSON.stringify({ quality: { buildChecks: [{ name: kind, kind, command: 'npm' }] } }, null, 2)}\n`,
            'utf8',
        );
    }

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it('accepts the acceptance-matrix verification levels as configured check kinds', async () => {
        const root = await tempRoot();

        for (const kind of ['integration', 'entrypoint'] as const) {
            await writeChecks(root, kind);
            const config = await loadConfig(root);
            expect(config.quality?.buildChecks?.[0]?.kind).toBe(kind);
        }
    });

    it('rejects an unknown evidence kind', async () => {
        const root = await tempRoot();
        await writeChecks(root, 'not-a-kind');

        await expect(loadConfig(root)).rejects.toThrow(/kind is invalid/);
    });

    it('accepts every canonical evidence kind', async () => {
        const root = await tempRoot();
        await writeFile(
            join(root, '.kata-config.json'),
            `${JSON.stringify({
                quality: { buildChecks: evidenceKinds.map((kind) => ({ name: kind, kind, command: 'npm' })) },
            }, null, 2)}\n`,
            'utf8',
        );

        const config = await loadConfig(root);

        expect(config.quality?.buildChecks?.map((check) => check.kind)).toEqual([...evidenceKinds]);
    });
});
