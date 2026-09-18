import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask, readTask, stampEngineVersion } from '../../src/core/task.js';
import { engineChangeNote, engineVersion, engineVersionChanged } from '../../src/core/engine-version.js';

/**
 * C7: the engine is versioned, and a mid-task change **reports itself** instead of silently applying new rules.
 *
 * §17.4 recorded what an unversioned engine cost: the review gate gained a node requirement and the brief gained a framing
 * mode while passes were in flight — both improvements, both a diagnostic cycle, because the flow could not tell "the rules
 * changed" from "I did something wrong".
 */
describe('the engine version travels with the task', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    it('is read from the package the bundle was built from', () => {
        expect(engineVersion()).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('is stamped when a task is created, so a mid-task change is comparable', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-engine-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'e-task', title: 'E', acceptance: [{ id: 'AC-1', statement: 'x' }] });

        const task = await readTask(root, 'e-task');
        expect(task.engine).toMatchObject({ version: engineVersion() });
        expect(task.engine?.stampedAt).toBeTruthy();
    });

    it('reports a change and restamps, and stays quiet when the version is unchanged', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-engine-2-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'e-task', title: 'E', acceptance: [{ id: 'AC-1', statement: 'x' }] });

        // Same version: nothing changed, nothing to say.
        await stampEngineVersion(root, 'e-task');
        expect(engineChangeNote((await readTask(root, 'e-task')).engine)).toBeNull();

        // A task last run under another version: the note names both sides and says what it explains.
        const note = engineChangeNote({ version: '0.0.9', stampedAt: '2026-09-18T00:00:00.000Z' });
        expect(note).toContain('kata 0.0.9');
        expect(note).toContain(engineVersion());
        expect(note).toMatch(/engine change, not a mistake in your run/);
        expect(engineVersionChanged({ version: '0.0.9', stampedAt: '' })).toBe(true);

        // A task with no stamp (created before the field existed) is "unknown", never "changed".
        expect(engineVersionChanged(undefined)).toBe(false);
        expect(engineChangeNote(null)).toBeNull();
    });

    it('restamps under the lock and reports what it replaced', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-engine-3-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'e-task', title: 'E', acceptance: [{ id: 'AC-1', statement: 'x' }] });

        // Simulate a task last run by an older engine.
        const path = join(root, '.kata/tasks/e-task/task.json');
        const task = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        task.engine = { version: '0.0.9', stampedAt: '2026-09-18T00:00:00.000Z' };
        await writeFile(path, `${JSON.stringify(task, null, 2)}\n`, 'utf8');

        const stamped = await stampEngineVersion(root, 'e-task');
        expect(stamped).toMatchObject({ changed: true, previous: '0.0.9', running: engineVersion() });
        expect((await readTask(root, 'e-task')).engine?.version).toBe(engineVersion());
    });
});

describe('the stamp rides along with the state transition', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    it('restamps as a task advances, and reports the previous version in status', async () => {
        const { transition, readCurrentState } = await import('../../src/core/state.js');
        const root = await mkdtemp(join(tmpdir(), 'kata-engine-advance-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'adv', title: 'Adv', ownedPaths: ['src/'], acceptance: [{ id: 'AC-1', statement: 'x' }] });

        // Simulate a task last advanced by an older engine.
        const path = join(root, '.kata/tasks/adv/task.json');
        const task = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        task.engine = { version: '0.0.9', stampedAt: '2026-09-18T00:00:00.000Z' };
        await writeFile(path, `${JSON.stringify(task, null, 2)}\n`, 'utf8');

        await transition('adv', 'plan', { id: 'agent', role: 'designer', platform: 'pi' }, { root });

        // The stamp moved with the run — so the *next* reader sees the current version and no false "changed" note, while
        // the run itself was comparable against the old one.
        const advanced = await readTask(root, 'adv');
        expect(advanced.engine?.version).toBe(engineVersion());
        expect(advanced.engine?.stampedAt).not.toBe('2026-09-18T00:00:00.000Z');
        expect((await readCurrentState(root, 'adv')).phase).toBe('plan');

        // And a status read now reports the running version with no note, because they agree.
        const { runLocalStatusCommand } = await import('../../src/cli/tasks.js');
        const status = await runLocalStatusCommand('adv', null, root);
        expect(status.engine).toMatchObject({ running: engineVersion(), task: { version: engineVersion() } });
        expect(status.engineNote).toBeUndefined();
    });
});
