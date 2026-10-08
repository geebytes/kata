import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';

/**
 * **A reviewer must not be handed a compiled artefact as the content worth reading.**
 *
 * The sampling surface is built from the declared content, so the defect that let `__pycache__` into the frozen subject
 * also promoted `.pyc` paths into the reviewer's reading list — the report measured four of them under
 * `sampling.promoted`. This file asks the same question of the plan: no path the identity table excludes may appear in
 * `sampling.seed` or in `sampling.promoted`, while the real files still may.
 */
const changeId = 'sampling-surface';
let root = '';
let previousExitCode: number | string | null | undefined;
const chunks: string[] = [];

const REAL = Array.from({ length: 12 }, (_, index) => `src/pkg/mod${index}.ts`);
const NOT_CONTENT = [
    'src/pkg/__pycache__/mod0.cpython-312.pyc',
    'src/pkg/__pycache__/mod1.cpython-312.pyc',
    'src/pkg/.pytest_cache/v/lastfailed',
    'src/pkg/dist/bundle.js',
];

async function ledger(argv: string[]): Promise<Record<string, unknown>> {
    chunks.length = 0;
    process.exitCode = 0;
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    try {
        await runLedgerCommand(argv, { root, changeId });
    } finally {
        spy.mockRestore();
    }
    const text = chunks.join('');
    const start = text.indexOf('{');
    return start < 0 ? {} : (JSON.parse(text.slice(start)) as Record<string, unknown>);
}

const sampling = async (): Promise<{ seed?: string; promoted?: string[]; rate?: number }> => {
    const plan = JSON.parse(await readFile(join(root, '.kata', 'tasks', changeId, 'review', 'plan.json'), 'utf8')) as {
        sampling?: { seed?: string; promoted?: string[]; rate?: number };
    };
    return plan.sampling ?? {};
};

beforeEach(async () => {
    previousExitCode = process.exitCode;
    root = await mkdtemp(join(tmpdir(), 'kata-sampling-surface-'));
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    for (const path of [...REAL, ...NOT_CONTENT]) {
        await mkdir(join(root, path.split('/').slice(0, -1).join('/')), { recursive: true });
        await writeFile(join(root, path), `content of ${path}\n`);
    }
    await writeTaskRecord(root, { id: changeId, phase: 'implement', ownedPaths: ['src/pkg'] });
});

afterEach(async () => {
    process.exitCode = previousExitCode;
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('the sampling surface holds no caches', () => {
    it('samples the declared source and none of the build or cache paths', async () => {
        expect((await ledger(['freeze'])).ok).toBe(true);
        expect((await ledger(['plan'])).ok).toBe(true);

        const { seed, promoted } = await sampling();
        expect(seed).toBeTruthy();

        // The precondition, so this file cannot pass because the fixture stopped producing candidates: the real files are
        // in the seed, and the sampler is asked to promote something.
        expect(seed).toContain('src/pkg/mod0.ts');
        expect((promoted ?? []).length).toBeGreaterThan(0);

        for (const path of NOT_CONTENT) {
            expect(seed, path).not.toContain(path);
            expect(promoted ?? [], path).not.toContain(path);
        }
        // And nothing else that looks like a build artefact slipped in by another name.
        expect((promoted ?? []).filter((path) => /__pycache__|\.pytest_cache|\/dist\//.test(path))).toEqual([]);
    });
});
