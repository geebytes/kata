import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-assurance-copy-'));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
});

/** Operator output is the contract boundary: observed is a Kata fact, host isolation is not. */
describe('operator-facing assurance boundary', () => {
    it('states that the host platform owns command isolation', async () => {
        const chunks: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
            chunks.push(String(chunk));
            return true;
        });

        await runLedgerCommand(['status'], { root, changeId: 'assurance-copy' });
        const result = JSON.parse(chunks.join('').slice(chunks.join('').indexOf('{'))) as Record<string, unknown>;

        expect(result.assuranceScope).toBe(
            'observed means Kata executed evidence in the host-provided runtime; the host platform owns network, filesystem, process and credential isolation',
        );

        // The operator-facing design note is part of this repository rather than of a task root, so it is read where it
        // lives: the note is what an operator reads to decide what the security tier promises.
        const guidance = await readFile(new URL('../../docs/review2.md', import.meta.url), 'utf8');
        expect(guidance).not.toContain('security 档应保留可选 sandbox/observed assurance');
        expect(guidance).toContain('执行隔离由宿主 Agent 平台的运行政策负责');
    });
});
