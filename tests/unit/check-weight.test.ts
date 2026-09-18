import { describe, expect, it } from 'vitest';
import { checkConcurrency, checkWeight, collectEvidence } from '../../src/quality/evidence.js';
import type { CheckCommand } from '../../src/quality/evidence.js';

/**
 * A check declares how much of the machine it takes (the per-check concurrency proposal).
 *
 * The measurement that forced this: a project whose checks are themselves parallel (`pytest -n auto`) sizes each of them
 * for one machine, so running N at once multiplies the load by N — measured here as 4 × `-n auto` oversubscribing 48 cores
 * and making the checks slower *and* flakier than serial. A per-project environment variable cannot express that, because
 * the answer differs per check: the cheap probes want to share, the parallel suites want the machine to themselves.
 */
describe('a check may declare its weight', () => {
    it('defaults to one slot, and reads a declared weight', () => {
        const plain: CheckCommand = { kind: 'test', command: 'node', args: ['-e', 'process.exit(0)'] };
        const heavy: CheckCommand = { ...plain, weight: 8 };
        expect(checkWeight(plain)).toBe(1);
        expect(checkWeight(heavy)).toBe(8);
        // A nonsense weight is treated as the default rather than as a licence to run unbounded.
        expect(checkWeight({ ...plain, weight: 0 })).toBe(1);
        expect(checkWeight({ ...plain, weight: -3 })).toBe(1);
    });

    it('serial by default: the limit is one unless the project opts in', () => {
        expect(checkConcurrency()).toBe(1);
    });

    it('runs a check whose weight fills the budget alone, and never two heavy ones together', async () => {
        const { tmpdir } = await import('node:os');
        const { mkdtemp } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const root = await mkdtemp(join(tmpdir(), 'kata-weight-'));
        const events: string[] = [];
        const probe = (name: string, weight: number): CheckCommand => ({
            id: name,
            name,
            kind: 'test',
            weight,
            command: 'node',
            args: ['-e', `setTimeout(() => {}, 60); console.log('${name}')`],
            cwd: root,
        });

        // Limit two, and both checks want all of it: they must not overlap, because each already uses the whole machine.
        const previous = process.env.KATA_CHECK_CONCURRENCY;
        process.env.KATA_CHECK_CONCURRENCY = '2';
        try {
            await collectEvidence('weights', [probe('heavy-a', 2), probe('heavy-b', 2)], {
                onProgress: (event) => events.push(`${event.state}:${(event as { name?: string }).name ?? ''}`),
            });
        } finally {
            if (previous === undefined) delete process.env.KATA_CHECK_CONCURRENCY;
            else process.env.KATA_CHECK_CONCURRENCY = previous;
        }

        const started = events.filter((event) => event.startsWith('started:'));
        // Two `started` events is expected; what must not happen is the second starting before the first has finished.
        expect(started.length).toBe(2);
        const firstFinish = events.findIndex((event) => event.startsWith('passed:') || event.startsWith('failed:') || event.startsWith('terminal:'));
        const secondStart = events.findIndex((event, index) => index > 0 && event.startsWith('started:'));
        expect(firstFinish).toBeLessThan(secondStart);
    });

    it('still lets a light check share the budget with another light one', async () => {
        const { tmpdir } = await import('node:os');
        const { mkdtemp } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const root = await mkdtemp(join(tmpdir(), 'kata-weight-light-'));
        const order: string[] = [];
        const light = (name: string): CheckCommand => ({
            id: name,
            name,
            kind: 'test',
            command: 'node',
            args: ['-e', `console.log('${name}')`],
            cwd: root,
        });

        const previous = process.env.KATA_CHECK_CONCURRENCY;
        process.env.KATA_CHECK_CONCURRENCY = '2';
        try {
            const evidence = await collectEvidence('lights', [light('a'), light('b')], {
                onProgress: (event) => order.push(`${event.state}:${(event as { name?: string }).name ?? ''}`),
            });
            expect(evidence.every((envelope) => envelope.exitCode === 0)).toBe(true);
        } finally {
            if (previous === undefined) delete process.env.KATA_CHECK_CONCURRENCY;
            else process.env.KATA_CHECK_CONCURRENCY = previous;
        }
        // Both ran: the default weight means they can share two slots.
        expect(order.filter((event) => event.startsWith('started:')).length).toBe(2);
    });
});

describe('a project can declare the weight, and it survives resolution', () => {
    it('carries quality.buildChecks[].weight into the resolved check', async () => {
        const { tmpdir } = await import('node:os');
        const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const { initLayout } = await import('../../src/core/layout.js');
        const { resolveBuildChecks } = await import('../../src/quality/project-checks.js');
        const { loadConfig } = await import('../../src/core/config.js');

        const root = await mkdtemp(join(tmpdir(), 'kata-weight-config-'));
        await mkdir(root, { recursive: true });
        await initLayout(root);
        await writeFile(
            join(root, '.kata-config.json'),
            JSON.stringify({
                quality: {
                    discoverChecks: false,
                    buildChecks: [
                        { id: 'suite', name: 'suite', kind: 'test', command: 'make', args: ['test-parallel'], weight: 8 },
                        { id: 'lint', name: 'lint', kind: 'lint', command: 'make', args: ['lint'] },
                    ],
                },
            }),
            'utf8',
        );

        const checks = await resolveBuildChecks(root, await loadConfig(root), ['src/a.ts']);
        // The heavy one says so; the light one keeps the default that lets it share.
        expect(checks.find((check) => check.id === 'suite')?.weight).toBe(8);
        expect(checks.find((check) => check.id === 'lint')?.weight).toBeUndefined();
    });

    it('rejects a nonsense weight at the config boundary, where the project can see the error', async () => {
        const { tmpdir } = await import('node:os');
        const { mkdtemp, writeFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const { loadConfig } = await import('../../src/core/config.js');

        const root = await mkdtemp(join(tmpdir(), 'kata-weight-bad-'));
        await writeFile(
            join(root, '.kata-config.json'),
            JSON.stringify({ quality: { buildChecks: [{ command: 'make', args: ['test'], weight: 0 }] } }),
            'utf8',
        );
        await expect(loadConfig(root)).rejects.toThrow(/weight must be a positive number/);
    });
});
