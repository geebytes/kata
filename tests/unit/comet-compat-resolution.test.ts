import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    loadCometCompatibility,
    resolveCometCompatibility,
    workspaceCometCompatibilityPath,
} from '../../src/comet/compat.js';
import { readCometCompatibility } from '../../src/comet/install.js';

/**
 * One resolution path with explicit precedence and provenance.
 *
 * The installed binary can know a newer Comet than the manifest kata shipped against, so the runtime probe is the only
 * layer that can answer authoritatively — and the answer has to say which layer it came from. Consumers that cannot
 * await read the per-process snapshot rather than choosing a layer of their own.
 */
describe('comet compatibility resolution', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-compat-resolution-'));
        roots.push(root);
        await mkdir(join(root, '.kata'), { recursive: true });
        return root;
    }

    // A v2 manifest: the comet block carries the window and at least one capability.
    const workspaceManifest = 'version: 2\n\ncomet:\n  minVersion: 9.9.9\n  maxVersion: 9.9.10\n  capabilities:\n    compat: true\n';

    it('reports the workspace override when one was recorded', async () => {
        const root = await tempRoot();
        await writeFile(workspaceCometCompatibilityPath(root), workspaceManifest, 'utf8');

        const compatibility = await resolveCometCompatibility({ cometBinary: 'definitely-not-installed', root });

        expect(compatibility).toMatchObject({ source: 'workspace-override', minVersion: '9.9.9' });
    });

    it('falls back to the bundled manifest and says so', async () => {
        const root = await tempRoot();

        const compatibility = await resolveCometCompatibility({ cometBinary: 'definitely-not-installed', root });

        expect(compatibility.source).toBe('kata-bundled');
        expect(compatibility.minVersion).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('prefers the installed binary and records the runtime source', async () => {
        const root = await tempRoot();
        await writeFile(workspaceCometCompatibilityPath(root), workspaceManifest, 'utf8');
        const binary = join(root, 'comet');
        await writeFile(binary, '#!/bin/sh\nprintf \'version: 2\\n\\ncomet:\\n  minVersion: 7.7.7\\n  maxVersion: 7.7.8\\n  capabilities:\\n    compat: true\\n\'\n', 'utf8');
        await chmod(binary, 0o755);

        const compatibility = await resolveCometCompatibility({ cometBinary: binary, root });

        expect(compatibility).toMatchObject({ source: 'runtime', minVersion: '7.7.7' });
    });

    it('answers synchronous callers with the resolved snapshot, and an explicit root from that root', async () => {
        const root = await tempRoot();
        await writeFile(workspaceCometCompatibilityPath(root), workspaceManifest, 'utf8');

        await resolveCometCompatibility({ cometBinary: 'definitely-not-installed', root });

        // No arguments: the answer this process already resolved.
        expect(loadCometCompatibility().source).toBe('workspace-override');
        // An explicit root asks about that workspace, so it is read rather than answered from another root's snapshot.
        expect(loadCometCompatibility(undefined, process.cwd()).source).not.toBe('runtime');
    });

    it('reports the window with its provenance, and never claims compatibility it did not check', async () => {
        const root = await tempRoot();
        await writeFile(workspaceCometCompatibilityPath(root), workspaceManifest, 'utf8');
        await resolveCometCompatibility({ cometBinary: 'definitely-not-installed', root });

        const window = await readCometCompatibility(root);

        expect(window).toEqual({ minVersion: '9.9.9', maxVersion: '9.9.10', source: 'workspace-override' });
    });
});
