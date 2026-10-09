import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentDefinitions, renderAgentDefinition } from '../../src/adapters/manifest.js';
import { platformAgentPath, platformAgentsDir } from '../../src/adapters/platforms.js';
import { update } from '../../src/adapters/ownership.js';
import { adaptersManifestPath, initLayout } from '../../src/core/layout.js';

/**
 * **AC-15 — an agent definition is a rendered artefact, not a hand-maintained copy.**
 *
 * The definitions were hand-written files that `kata-cli update` knew nothing about: the `subAgents` capability was declared
 * for eight platforms and read by nothing, so every checkout carried its own copy and 55 of them drifted together when the
 * protocol changed under them. They are rendered now, through the same path and the same conflict rules as the skills.
 *
 * The last clause of this criterion has its own case, because it is a defect a renderer could reintroduce: `isolated: true`
 * **overrides `extensions` to `false`** in the runner, so an agent that declares the extension it needs to reach its model
 * provider gets a dispatch that cannot resolve it — a failure that reads like a missing provider rather than like a
 * configuration conflict.
 */
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('every declared agent has one rendered definition', () => {
    it('writes one file per declared agent, at the path the platform owns, and records it as its own kind', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-agent-render-'));
        roots.push(root);
        await initLayout(root);

        const report = await update('pi', 'project', { root, force: true });

        const dir = platformAgentsDir('pi', 'project');
        expect(dir).not.toBeNull();
        for (const spec of agentDefinitions) {
            const relative = platformAgentPath('pi', 'project', spec.id);
            expect(relative, `${spec.id} has a path for this platform`).not.toBeNull();
            if (relative === null) continue;
            expect(report.written, JSON.stringify(report)).toContain(relative);
            await expect(readFile(join(root, relative), 'utf8')).resolves.toContain(`name: ${spec.id}`);
        }
        // **The manifest names the kind.** A bare `kata-reviewer` id reads to the obsolete-artefact sweep as a retired *skill*
        // — which deleted both definitions on the first run of this writer (measured: `写入 2 · 移除 2`).
        // The manifest on disk, which is what a later `update` reads — not an in-memory copy.
        const manifest = JSON.parse(await readFile(adaptersManifestPath(root), 'utf8')) as { files: Record<string, { path: string; commandId: string }> };
        const entries = Object.values(manifest.files).filter((file) => file.path.includes('/agents/'));
        expect(entries.map((entry) => entry.commandId).sort()).toEqual(agentDefinitions.map((spec) => `agent:${spec.id}`).sort());
    });

    it('reports a conflict rather than overwriting a definition an operator wrote', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-agent-conflict-'));
        roots.push(root);
        await initLayout(root);
        const relative = platformAgentPath('pi', 'project', 'kata-reviewer');
        expect(relative).not.toBeNull();
        if (relative === null) return;
        // A definition nobody owns, already on disk: the same rule every managed artefact answers to.
        await mkdir(dirname(join(root, relative)), { recursive: true });
        await writeFile(join(root, relative), '---\nname: kata-reviewer\n---\n\nmine\n');

        const report = await update('pi', 'project', { root });

        expect(report.conflicts).toContain(relative);
        await expect(readFile(join(root, relative), 'utf8')).resolves.toContain('mine');
    });

    it('never emits `isolated: true`, which would cut the extension the agent needs', async () => {
        for (const spec of agentDefinitions) {
            const rendered = renderAgentDefinition(spec.id, 'pi') ?? '';
            const frontmatter = rendered.split('---')[1] ?? '';
            // The frontmatter is where the host reads it: a mention in the prose is documentation of the boundary, and one
            // line above the prose is the defect.
            expect(frontmatter, `${spec.id} frontmatter`).not.toMatch(/^isolated:/m);
            // The implementer is the case the criterion names, and it needs the provider like the reviewer does.
            if (spec.id === 'kata-implementer') {
                expect(frontmatter).toContain('extensions: [pi-esuyo-custom-provider]');
            }
        }
        // And the boundary is written down where a reader meets it, because "why is there no isolation flag here" is the first
        // question a careful reader asks.
        expect(renderAgentDefinition('kata-implementer', 'pi')).toContain('isolated: true` would set `extensions` to `false`');
    });
});
