import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    loadCometCompatibility,
    loadCometCompatibilityAsync,
    persistCometCompatibilityOverride,
    workspaceCometCompatibilityPath,
} from '../../src/comet/compat.js';

describe('Comet compatibility workspace override', () => {
    const roots: string[] = [];

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-compat-override-'));
        roots.push(root);
        return root;
    }

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it('falls back to the bundled baseline when the workspace records nothing', async () => {
        const root = await tempRoot();

        const compatibility = loadCometCompatibility(undefined, root);

        expect(compatibility.source).toBe('kata-bundled');
    });

    it('records the installed version window in the workspace and loads it back', async () => {
        const root = await tempRoot();

        expect(persistCometCompatibilityOverride('9.9.9', root)).toBe(true);

        const compatibility = loadCometCompatibility(undefined, root);
        expect(compatibility.source).toBe('workspace-override');
        expect(compatibility.minVersion).toBe('9.9.9');
        expect(compatibility.maxVersion).toBe('9.9.9');
    });

    it('prefers the workspace override over the comet package manifest on the async path', async () => {
        const root = await tempRoot();
        persistCometCompatibilityOverride('8.8.8', root);

        const compatibility = await loadCometCompatibilityAsync({
            cometBinary: 'kata-missing-comet-binary',
            root,
        });

        expect(compatibility.source).toBe('workspace-override');
        expect(compatibility.minVersion).toBe('8.8.8');
    });

    it('reports a failed write instead of throwing when the workspace cannot be written', async () => {
        const root = await tempRoot();
        await writeFile(join(root, '.kata'), 'not a directory\n', 'utf8');

        expect(persistCometCompatibilityOverride('7.7.7', root)).toBe(false);
        expect(loadCometCompatibility(undefined, root).source).toBe('kata-bundled');
        expect(workspaceCometCompatibilityPath(root)).toBe(join(root, '.kata', 'comet-compat.yaml'));
    });
});
