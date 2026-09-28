import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEvaluationManifest } from '../../src/eval/runner.js';

/**
 * **A manifest in the wrong format is refused by name, not by token.**
 *
 * The loader parses JSON and always has. What it did not do was say so: this repository's own second manifest,
 * `evals/dogfood-app.yaml`, is unreferenced and left over from before the format was settled, and running it produced
 *
 *     Unexpected token '#', "#Strata d"... is not valid JSON
 *
 * which tells the operator about a token rather than about the rule — and the deeper problem is that a YAML manifest is a
 * *second copy* of a manifest that already exists as JSON, so the two drift while both look runnable. That file is gone;
 * this pins the refusal so the next one gets an instruction instead of a parse error.
 */
let root: string;

afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
});

async function write(name: string, content: string): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'kata-manifest-'));
    const path = join(root, name);
    await writeFile(path, content, 'utf8');
    return path;
}

describe('an evaluation manifest must be JSON, and says so', () => {
    it('refuses a YAML manifest with the rule and the alternative', async () => {
        const path = await write('manifest.yaml', '# a YAML manifest\nname: x\nroot: /app\n');
        const error = await loadEvaluationManifest(path).catch((thrown: Error) => thrown);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('must be JSON');
        expect((error as Error).message).toContain('second copy in another format');
        // Not a token complaint: the message must not be JSON.parse's own.
        expect((error as Error).message).not.toContain('Unexpected token');
    });

    it('refuses unreadable JSON, and says which file', async () => {
        // A `.json` extension is not evidence of JSON content, which is the other way this was reachable.
        const path = await write('manifest.json', '{ not json at all\n');
        const error = await loadEvaluationManifest(path).catch((thrown: Error) => thrown);
        expect((error as Error).message).toContain('must be JSON');
        expect((error as Error).message).toContain('manifest.json');
    });

    it('still loads a JSON manifest', async () => {
        const path = await write('ok.json', '{"name":"x","root":"/app","taskFixtures":[]}\n');
        await expect(loadEvaluationManifest(path)).resolves.toMatchObject({ name: 'x' });
    });
});
