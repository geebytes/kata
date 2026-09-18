import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { isIdempotentPhaseEntry, isLegalPhaseTransition, readCurrentState, transition } from '../../src/core/state.js';

/**
 * C6: entering the phase you are already in is a re-evaluation, not an error.
 *
 * §17.4 found this the hard way: an interrupted seal left the phase set at `hardVerify`, and the re-run failed with
 * `Illegal transition from hardVerify to hardVerify` **while all six checks passed**. The gate refused to re-answer a
 * question about content that had not changed — which is the one thing a content-addressed system must do for free.
 */
describe('re-entering the phase a task is already in', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function advanced(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-idem-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'idem', title: 'Idem', ownedPaths: ['src/'], acceptance: [{ id: 'AC-1', statement: 'x' }] });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/a.py'), 'x = 1\n', 'utf8');
        await createTaskFixture(root);
        const actor = { id: 'agent', role: 'implementer', platform: 'pi' };
        for (const phase of ['plan', 'implement', 'hardVerify'] as const) await transition('idem', phase, actor, { root });
        return root;
    }

    async function createTaskFixture(root: string): Promise<void> {
        await writeFile(join(root, '.kata-config.json'), JSON.stringify({ quality: { discoverChecks: false, buildChecks: [{ id: 'noop', kind: 'lint', command: 'true' }] } }), 'utf8');
    }

    it('answers with the state as it stands, and writes nothing', async () => {
        const root = await advanced();
        const actor = { id: 'agent', role: 'implementer', platform: 'pi' };
        const before = await readCurrentState(root, 'idem');
        const events = join(root, '.kata/tasks/idem/state-events.jsonl');
        const beforeCount = (await readFile(events, 'utf8')).trim().split('\n').length;

        const after = await transition('idem', 'hardVerify', actor, { root });

        // Identical: a caller cannot tell "moved" from "already there", which is the point.
        expect(after).toEqual(before);
        expect((await readFile(events, 'utf8')).trim().split('\n').length).toBe(beforeCount);
    });

    it('is a separate question from legality, so recovery cannot be fooled by it', () => {
        // `isLegalPhaseTransition` is what recovery replays events against. A self-transition that read as legal there
        // would let a corrupt log look like a legitimate chain, so C6 is asked by `transition()` and nowhere else.
        expect(isLegalPhaseTransition('hardVerify', 'hardVerify')).toBe(false);
        expect(isIdempotentPhaseEntry('hardVerify', 'hardVerify')).toBe(true);
        expect(isIdempotentPhaseEntry('implement', 'hardVerify')).toBe(false);
    });

    it('a real seal re-run over unchanged content succeeds instead of refusing', async () => {
        const root = await advanced();

        // This is the failure §17.4 recorded: the phase is already `hardVerify` and the seal asks for it again.
        await expect(transition('idem', 'hardVerify', { id: 'agent', role: 'implementer', platform: 'pi' }, { root })).resolves.toMatchObject({
            phase: 'hardVerify',
        });
    });
});
