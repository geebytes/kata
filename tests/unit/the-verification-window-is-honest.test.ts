import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyAll } from '../../src/producers/verifiers.js';
import { withVerificationWindow } from '../../src/store/verify-context.js';
import type { VerifyContext } from '../../src/producers/port.js';

/**
 * **A reading has to say what it ran.**
 *
 * Every falsifier persisted the same `{"before":0,"mutated":1,"after":0}`, so four readings were indistinguishable in the
 * store: a reader could not tell which mutation produced which verdict. The observed string now carries the evidence id and
 * the mutated file, which is what makes the record answer "which reading is this".
 */
const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('a reading names its falsifier', () => {
    it('records the evidence id and the mutated file in the observation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-observed-'));
        roots.push(root);
        const file = 'a.ts';
        await writeFile(join(root, file), 'const x = 1;\n');
        const context = {
            root,
            subject: { revision: `rev:${'a'.repeat(16)}`, pathDigests: { [file]: 'a'.repeat(64) } },
            run: async () => {
                const content = await readFile(join(root, file), 'utf8');
                return { code: content.includes('const x = 2;') ? 1 : 0, stdout: '', stderr: '', timedOut: false };
            },
            now: () => '2026-10-08T00:00:00.000Z',
            producer: () => 'fixture',
            readText: async (path: string) => (path === file ? await readFile(join(root, file), 'utf8') : null),
            writeText: async (path: string, content: string) => { if (path === file) await writeFile(join(root, file), content); },
        } as unknown as VerifyContext;
        const item = { id: 'E7', type: 'executable_falsifier' as const, command: 'true', mutation: { file, find: 'const x = 1;', replace: 'const x = 2;' } };

        const verdicts = await verifyAll([item], context);
        expect(verdicts[0].observed).toContain('E7');
        expect(verdicts[0].observed).toContain(file);
    });
});

/**
 * **The window is exclusive, and a run that cannot get one is told rather than handed a verdict.**
 *
 * The cycle used to hold the file only from the injection to the restore, so the *closing* check ran outside it. An
 * independent round measured the consequence: a valid evidence item was downgraded to `inconclusive … the tree was not
 * restored to green` because the closing check landed inside another cycle's injection while the checkout was byte-identical
 * to clean. The first case arranges that interleaving instead of hoping for it — the second cycle is started exactly while
 * the first is at its closing check, and the first cycle's closing check waits for the second to inject.
 */
describe('the window is exclusive and honest to observers', () => {
    const clean = 'const a = 1;\nconst b = 1;\n';
    const file = 'a.ts';

    /** Red exactly when the file holds an injected defect, whichever cycle put it there. */
    const measure = async (root: string) => {
        const content = await readFile(join(root, file), 'utf8');
        return { code: content.includes('= 2;') ? 1 : 0, stdout: '', stderr: '', timedOut: false };
    };

    const contextFor = (root: string, plan: { mutated?: () => void | Promise<void>; closing?: () => Promise<void> }) => {
        let calls = 0;
        return {
            root,
            subject: { revision: `rev:${'a'.repeat(16)}`, pathDigests: { [file]: 'a'.repeat(64) } },
            run: async () => {
                calls += 1;
                if (calls === 2) await plan.mutated?.();
                if (calls === 3) await plan.closing?.();
                return measure(root);
            },
            now: () => '2026-10-08T00:00:00.000Z',
            producer: () => 'fixture',
            readText: async (path: string) => (path === file ? await readFile(join(root, file), 'utf8') : null),
            writeText: async (path: string, content: string) => { if (path === file) await writeFile(join(root, file), content); },
        } as unknown as VerifyContext;
    };

    it('does not let a closing check land inside another cycle, and does not downgrade either reading', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-window-'));
        roots.push(root);
        await writeFile(join(root, file), clean);

        let reachedClosing: () => void = () => {};
        const closingCheck = new Promise<void>((resolve) => { reachedClosing = resolve; });
        let secondInjected: () => void = () => {};
        const secondWindowLive = new Promise<void>((resolve) => { secondInjected = resolve; });

        const first = verifyAll(
            [{ id: 'E1', type: 'executable_falsifier' as const, command: 'true', mutation: { file, find: 'const a = 1;', replace: 'const a = 2;' } }],
            contextFor(root, {
                // **The closing check waits for the other cycle to inject, or gives up after a bound.** With the cycle inside
                // one window the other cycle cannot get in at all, so the bound is what it waits out — and the reading it then
                // takes is of a tree this run owns.
                closing: async () => { reachedClosing(); await Promise.race([secondWindowLive, new Promise((resolve) => setTimeout(resolve, 400))]); },
            }),
        );
        await closingCheck;
        const second = verifyAll(
            [{ id: 'E2', type: 'executable_falsifier' as const, command: 'true', mutation: { file, find: 'const b = 1;', replace: 'const b = 2;' } }],
            contextFor(root, {
                mutated: async () => { secondInjected(); await new Promise((resolve) => setTimeout(resolve, 200)); },
            }),
        );
        const [firstVerdicts, secondVerdicts] = await Promise.all([first, second]);

        // Neither reading is downgraded, and neither blames the tree for a defect it does not hold.
        expect(firstVerdicts[0].verdict).toBe('supported');
        expect(secondVerdicts[0].verdict).toBe('supported');
        for (const verdict of [...firstVerdicts, ...secondVerdicts]) {
            expect(verdict.observed).not.toContain('not restored to green');
            expect(verdict.observed).not.toContain('already failing before any mutation');
        }
        expect(await readFile(join(root, file), 'utf8')).toBe(clean);
    });

    it('tells a run that a window is live instead of handing it a verdict', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-live-window-'));
        roots.push(root);
        await writeFile(join(root, file), clean);
        // A short bound, so the guard measures the *answer* rather than waiting out the production envelope.
        const context = { ...contextFor(root, {}), windowDeadlineMs: 80 } as unknown as VerifyContext;
        const item = { id: 'E3', type: 'executable_falsifier' as const, command: 'true', mutation: { file, find: 'const a = 1;', replace: 'const a = 2;' } };

        // The window is held here, the way a cycle holds it: this run's file is mutated by somebody else right now.
        await withVerificationWindow(root, file, async () => {
            const outcome = await Promise.allSettled([verifyAll([item], context)]);
            expect(outcome[0].status).toBe('rejected');
            const reason = String((outcome[0] as PromiseRejectedResult).reason);
            expect(reason).toContain('a verification window is live');
            // **And it is not a verdict.** A caller that received `inconclusive` here would be reading a statement about a
            // tree this run never owned, which is the misdiagnosis the window exists to remove.
            expect(reason).not.toContain('inconclusive');
        });
        // With the window released the same run is ordinary: the mechanism refuses to answer only while it must.
        expect((await verifyAll([item], context))[0].verdict).toBe('supported');
    });
});
