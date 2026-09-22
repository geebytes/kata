import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevision } from '../../src/workflow/revision.js';
import { issueAdversarialBrief, writeAdversarialRecord } from '../../src/quality/adversarial.js';
import { runAdversarialCommand } from '../../src/cli/ops.js';

/**
 * K3, K4 and K5 of `docs/design/2026-09-22-execution-layer-implementation-plan.md`.
 *
 * K3: a strict node that cannot be certified reported only `satisfied: false`, so an operator could not tell "this host
 * cannot do it" from "the pass was bad" — and the legacy path Phase 4 requires to stay *visible and reasoned* was
 * invisible. K4: the code and the schema claimed more than the mechanism delivers, and named a product. K5: `executedBy`
 * implies provenance and had no producer; platform is provenance, capability is the contract.
 */
const cleanup: string[] = [];

async function strictTask(id: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `kata-status-${id}-`));
    cleanup.push(root);
    await initLayout(root);
    await createTask({
        root,
        id,
        title: id,
        ownedPaths: ['src/x.ts'],
        acceptance: [{ id: 'AC-1', statement: 'x' }],
        workflowProfile: {
            version: 1,
            isolationMode: 'current_worktree',
            developmentMode: 'tdd',
            reviewMode: 'strict',
            comet: { projectInit: 'not_requested', openStatus: 'acknowledged' },
        },
    } as never);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/x.ts'), 'export const x = 1;\n', 'utf8');
    await createTaskRevision({ root, taskId: id, ownedPaths: ['src/x.ts'], checkIds: [] });
    return root;
}

async function statusAt(root: string, id: string): Promise<Record<string, unknown>> {
    const before = process.cwd();
    process.chdir(root);
    try {
        return await runAdversarialCommand(['status', '--change', id]);
    } finally {
        process.chdir(before);
    }
}

describe('capability state is visible, and the wording matches the mechanism', () => {
    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('reports the required capabilities and an absent receipt, not merely `satisfied: false`', async () => {
        const root = await strictTask('status-absent');
        const report = await statusAt(root, 'status-absent');
        const node = (report.nodes as Record<string, Record<string, unknown>>).review!;

        expect(node.receipt).toBe('absent');
        expect(node.requiredCapabilities).toEqual(['fresh_context', 'read_only_fs']);
        // The legacy path is named as such, so "no receipt" is a state with a meaning rather than an empty field.
        expect((node.path as { kind?: string }).kind).toBe('legacy');
        expect(node.satisfied).toBe(false);
    });

    it('reports what a receipt is missing rather than leaving it to be inferred', async () => {
        const root = await strictTask('status-missing');
        const brief = await issueAdversarialBrief(root, 'status-missing', 'review');
        await writeAdversarialRecord(root, 'status-missing', {
            node: 'review',
            status: 'recorded',
            revisionId: brief.revisionId ?? '',
            briefSha256: brief.sha256,
            executedInFreshContext: true,
            createdAt: new Date().toISOString(),
            scope: { kind: 'full' },
            mode: 'cold',
            hypotheses: [],
            attempts: [],
            findings: [],
            // Binds to the issued request but advertises only one of the two capabilities the node requires.
            receipt: {
                runId: brief.runRequest!.runId,
                requestSha256: brief.runRequest!.requestSha256,
                capabilities: ['fresh_context'],
                startedAt: '2026-09-22T00:00:00.000Z',
                endedAt: '2026-09-22T00:01:00.000Z',
                telemetry: { toolCalls: 1, outputBytes: 10, tokens: 10, truncations: 0 },
                status: 'completed',
            },
        } as never);

        const node = ((await statusAt(root, 'status-missing')).nodes as Record<string, Record<string, unknown>>).review!;
        expect(node.receipt).toBe('recorded');
        expect(node.missingCapabilities).toEqual(['read_only_fs']);
        expect(node.path).toEqual({ kind: 'receipt' });
    });

    it('reports a waiver with its reason, so the legacy path is reasoned rather than merely visible', async () => {
        const root = await strictTask('status-waived');
        await writeAdversarialRecord(root, 'status-waived', {
            node: 'review', status: 'waived', waivedReason: 'no host executor on this platform yet',
            revisionId: 'revision-x', createdAt: new Date().toISOString(),
        } as never);

        const node = ((await statusAt(root, 'status-waived')).nodes as Record<string, Record<string, unknown>>).review!;
        expect((node.path as { kind?: string }).kind).toBe('waived');
        expect((node.path as { reason?: string }).reason).toBe('no host executor on this platform yet');
    });

    it('never exposes a stored verdict, only the one kata derived', async () => {
        const root = await strictTask('status-derived');
        // Written to disk directly, because the **write path refuses** a new record that carries `verdict` — that
        // retirement is enforced earlier than this report. The case that remains is a historical record already on disk,
        // and the invariant under test is that the report does not re-expose its stored value.
        await mkdir(join(root, '.kata', 'tasks', 'status-derived'), { recursive: true });
        await writeFile(join(root, '.kata', 'tasks', 'status-derived', 'adversarial-review.json'), JSON.stringify({
            node: 'review', status: 'recorded', revisionId: 'revision-x', createdAt: new Date().toISOString(),
            verdict: 'no_defect_found', attempts: [], findings: [],
            hypotheses: [{ id: 'h1', claim: 'c', targets: ['AC-1'], method: 'source-read', outcome: 'confirmed', observation: { kind: 'source', ref: 'src/x.ts', observed: 'o' } }],
        }), 'utf8');

        const node = ((await statusAt(root, 'status-derived')).nodes as Record<string, Record<string, unknown>>).review!;
        expect(node.verdict).not.toBe('no_defect_found');
    });

    it('states no product name and no stronger claim than it can keep', async () => {
        const source = await readFile(join(process.cwd(), 'src/quality/review-execution.ts'), 'utf8');
        // A capability names an environment property, not a product: naming one reads as a requirement.
        expect(source).not.toMatch(/\bPi\b|\bCodex\b/);
        // The achievable claim is host-authored, measured and bound — not cryptography.
        expect(source).not.toMatch(/cannot author|unforgeable/i);
    });
});

/**
 * b1: the receipt can say which telemetry it could not measure, and `status` reports it.
 *
 * The recommended realisation is a subagent round, whose platform reports tool uses, tokens and wall clock but not output
 * bytes or truncations. Those must be recordable as *not measured* — a fabricated zero is indistinguishable from a measured
 * one, which is the defect this whole mechanism replaces.
 */
describe('telemetry distinguishes "not measured" from a measured zero', () => {
    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('accepts a receipt that could not measure every figure, and names the ones it could not', async () => {
        const root = await strictTask('telemetry-partial');
        const brief = await issueAdversarialBrief(root, 'telemetry-partial', 'review');
        await writeAdversarialRecord(root, 'telemetry-partial', {
            node: 'review',
            status: 'recorded',
            revisionId: brief.revisionId ?? '',
            briefSha256: brief.sha256,
            createdAt: new Date().toISOString(),
            scope: { kind: 'full' },
            mode: 'cold',
            hypotheses: [],
            attempts: [],
            findings: [],
            receipt: {
                runId: brief.runRequest!.runId,
                requestSha256: brief.runRequest!.requestSha256,
                capabilities: ['fresh_context', 'read_only_fs'],
                startedAt: '2026-09-22T00:00:00.000Z',
                endedAt: '2026-09-22T00:00:20.000Z',
                // What a subagent round can actually obtain from the platform: uses and tokens, not bytes or truncations.
                telemetry: { toolCalls: 2, tokens: 52_700, outputBytes: null, truncations: null },
                status: 'completed',
            },
        } as never);

        const node = ((await statusAt(root, 'telemetry-partial')).nodes as Record<string, Record<string, unknown>>).review!;
        expect(node.receipt).toBe('recorded');
        expect(node.unmeasuredTelemetry).toEqual(['outputBytes', 'truncations']);
    });

    it('reports nothing unmeasured for a receipt that measured all four figures', async () => {
        const root = await strictTask('telemetry-complete');
        const brief = await issueAdversarialBrief(root, 'telemetry-complete', 'review');
        await writeAdversarialRecord(root, 'telemetry-complete', {
            node: 'review',
            status: 'recorded',
            revisionId: brief.revisionId ?? '',
            briefSha256: brief.sha256,
            createdAt: new Date().toISOString(),
            scope: { kind: 'full' },
            mode: 'cold',
            hypotheses: [],
            attempts: [],
            findings: [],
            receipt: {
                runId: brief.runRequest!.runId,
                requestSha256: brief.runRequest!.requestSha256,
                capabilities: ['fresh_context', 'read_only_fs'],
                startedAt: '2026-09-22T00:00:00.000Z',
                endedAt: '2026-09-22T00:00:20.000Z',
                telemetry: { toolCalls: 2, tokens: 52_700, outputBytes: 4_096, truncations: 0 },
                status: 'completed',
            },
        } as never);

        const node = ((await statusAt(root, 'telemetry-complete')).nodes as Record<string, Record<string, unknown>>).review!;
        // An empty list is the claim "every figure was measured", which is why the helper must not conflate it with absent.
        expect(node.unmeasuredTelemetry).toEqual([]);
    });
});
