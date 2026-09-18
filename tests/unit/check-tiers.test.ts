import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectEvidence, type CheckCommand } from '../../src/quality/evidence.js';

/**
 * The frozen tier is opt-in, per project and per run.
 *
 * A project can declare verification it wants when the artefact is frozen (judge/archive) rather than on every seal; the
 * default keeps every check running exactly where it ran before, and a seal that deferred one names it.
 */
describe('check tiers', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    const ok = (name: string, extra: Partial<CheckCommand> = {}): CheckCommand => ({
        id: name,
        name,
        kind: 'test',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 10_000,
        ...extra,
    });

    it('runs every check when nothing declares a tier', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-tier-'));
        roots.push(root);
        const evidence = await collectEvidence('tier-task', [ok('a', { cwd: root }), ok('b', { cwd: root })]);
        expect(evidence.map((entry) => entry.name)).toEqual(['a', 'b']);
    });

    it('defers a frozen-tier check, and says why', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-tier-defer-'));
        roots.push(root);
        const events: Array<Record<string, unknown>> = [];
        const evidence = await collectEvidence(
            'tier-task',
            [ok('quick', { cwd: root }), ok('slow-suite', { cwd: root, tier: 'frozen' })],
            { onProgress: (event) => events.push(event as unknown as Record<string, unknown>) },
        );

        expect(evidence.map((entry) => entry.name)).toEqual(['quick']);
        expect(events.find((event) => event.check === 'slow-suite')).toMatchObject({ state: 'skipped', reason: 'frozen_tier' });
        expect(events.some((event) => event.check === 'slow-suite' && event.state === 'started')).toBe(false);
    });

    it('runs it when the caller asks for the frozen tier', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-tier-frozen-'));
        roots.push(root);
        const evidence = await collectEvidence(
            'tier-task',
            [ok('quick', { cwd: root }), ok('slow-suite', { cwd: root, tier: 'frozen' })],
            { includeFrozen: true },
        );

        expect(evidence.map((entry) => entry.name)).toEqual(['quick', 'slow-suite']);
    });

    it('does not run a frozen check that another check covers', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-tier-covered-'));
        roots.push(root);
        const evidence = await collectEvidence(
            'tier-task',
            [ok('suite', { cwd: root }), ok('row', { cwd: root, tier: 'frozen', coveredBy: 'suite' })],
            { includeFrozen: true },
        );

        // Covered wins: the row is credited with the covering check's evidence, so running it would be the duplicate the
        // pointer exists to remove.
        expect(evidence.map((entry) => entry.name)).toEqual(['suite']);
    });
});
