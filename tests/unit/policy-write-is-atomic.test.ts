import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { readLedger, reviewDir } from '../../src/store/ledger.js';

/**
 * **A refused policy write must not have written anything.**
 *
 * Measured by an independent review: `ledger policy --set-file` appended the floor-change claims first and called
 * `writePolicy` afterwards, so a policy the store refuses (a retired assurance floor) had already modified the change's
 * `claims.json` — a rejected operation with a side effect, while the refusal reads as though nothing happened. The order
 * is the fix: the store's decision comes first, and only a write that succeeded has consequences recorded beside it.
 */
let root: string;
const changeId = 'policy-write-atomicity';

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-policy-atomic-'));
    await initLayout(root);
    await createTask({
        root,
        id: changeId,
        title: 'Policy write atomicity',
        acceptance: [{ id: 'AC-1', statement: 'A refused write has no side effect.' }],
        ownedPaths: ['src/a.ts'],
    });
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'tmp'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
});

afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
});

async function ledger(argv: string[]): Promise<{ ok?: boolean; error?: string }> {
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    const previousExitCode = process.exitCode;
    try {
        await runLedgerCommand(argv, { root, changeId });
    } finally {
        stdout.mockRestore();
    }
    process.exitCode = previousExitCode;
    const line = chunks.join('').trim().split('\n').filter((entry) => entry.trim().startsWith('{')).at(-1);
    return line ? (JSON.parse(line) as { ok?: boolean; error?: string }) : {};
}

describe('a refused policy write leaves nothing behind', () => {
    it('records no floor-change claim when the store refuses the policy', async () => {
        // A policy whose floor table moved *and* whose security floor is retired: the move would produce claims, and the
        // retirement is what the store refuses. Nothing of either may survive the refusal.
        const policy = defaultPolicy();
        const withRetired = {
            ...policy,
            tiers: { ...policy.tiers, security: { ...policy.tiers.security, assuranceFloor: 'sandboxed' } },
            riskFloors: { ...policy.riskFloors, 'src/other/**': { floor: 'medium' as const, riskClasses: ['consistency' as const] } },
        };
        await mkdir(reviewDir(root, changeId), { recursive: true });
        await writeFile(join(root, 'tmp', 'offered.json'), `${JSON.stringify(withRetired)}\n`);

        const before = (await readLedger(root, changeId)).claims.length;
        const refusal = await ledger(['policy', '--set-file', join(root, 'tmp', 'offered.json')]);

        expect(refusal.ok).toBe(false);
        expect(String(refusal.error)).toContain('cannot write retired assurance floor');
        // The side effect that must not exist: claims the refused write would have recorded.
        expect((await readLedger(root, changeId)).claims.length).toBe(before);
        // And the policy itself is untouched.
        const written = await readFile(join(reviewDir(root, changeId), 'policy.json'), 'utf8').catch(() => '');
        expect(written).not.toContain('sandboxed');
    });

    it('still records the floor-change claims when the write succeeds', async () => {
        // The other direction, so the ordering fix cannot be read as "claims are never written".
        const policy = defaultPolicy();
        const moved = { ...policy, riskFloors: { ...policy.riskFloors, 'src/other/**': { floor: 'medium' as const, riskClasses: ['consistency' as const] } } };
        await writeFile(join(root, 'tmp', 'moved.json'), `${JSON.stringify(moved)}\n`);

        const before = (await readLedger(root, changeId)).claims.length;
        const written = await ledger(['policy', '--set-file', join(root, 'tmp', 'moved.json')]);

        expect(written.ok, JSON.stringify(written)).toBe(true);
        const after = (await readLedger(root, changeId)).claims;
        expect(after.length).toBeGreaterThan(before);
        expect(after.every((claim) => claim.riskClass === 'privilege')).toBe(true);
    });
});
