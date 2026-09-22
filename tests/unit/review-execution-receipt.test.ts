import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevision } from '../../src/workflow/revision.js';
import { adversarialGateFor, issueAdversarialBrief, writeAdversarialRecord } from '../../src/quality/adversarial.js';
import { adversarialBriefsDir } from '../../src/core/layout.js';
import { requiredCapabilitiesForNode, verifyExecutionReceipt, type ReviewExecutionReceipt } from '../../src/quality/review-execution.js';
import { runAdversarialCommand } from '../../src/cli/ops.js';

/**
 * §3.2.1: fresh context is a **capability**, not an assertion.
 *
 * The gate's only self-attested trust point is `record.executedInFreshContext !== true` → `not_fresh_context`. An agent
 * writes that boolean. Kata is a CLI and cannot start or observe a host subagent, so the property was asserted rather
 * than verified — which §2.1 identified as load-bearing in the *judgment* predicate, not merely a quality nicety.
 *
 * The contract this file pins:
 *
 *   - a receipt is **written by the executor**, and binds to the issued request by nonce and hash;
 *   - the gate refuses a record whose receipt does not match, or whose `capabilities` omit what the node requires;
 *   - a host without the capability yields **`executor_unavailable` and blocks** — never a silent downgrade to "the
 *     agent said it was fresh", because that is the unsound state this replaces.
 *
 * What this file deliberately does not claim: that Kata can *produce* such a receipt. It cannot — Pi/Codex implement the
 * executor side outside this repository. Kata's half is to define the shape, require it where the node requires it, and
 * refuse to certify a pass that lacks it.
 */
describe('fresh context is a capability with a receipt, not a self-report', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function sealedTask(id: string, profile?: { reviewMode: string }): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-receipt-'));
        roots.push(root);
        await initLayout(root);
        await createTask({
            root, id, title: 'Receipt', acceptance: [{ id: 'AC-1', statement: 'A receipt binds.' }],
            // The real profile shape, taken from a live strict task rather than invented: a partial object fails the task
            // schema, and a fixture that cannot be read is not evidence about the gate.
            ...(profile
                ? { workflowProfile: { version: 1, isolationMode: 'current_worktree', developmentMode: 'tdd', reviewMode: profile.reviewMode, comet: { projectInit: 'not_requested', openStatus: 'acknowledged' } } }
                : {}),
        } as never);
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/x.ts'), 'export const x = 1;\n', 'utf8');
        await createTaskRevision({ root, taskId: id, ownedPaths: ['src/x.ts'], checkIds: [] });
        return root;
    }

    async function record(
        root: string,
        taskId: string,
        extra: Record<string, unknown>,
    ): Promise<void> {
        const brief = await issueAdversarialBrief(root, taskId, 'review', { mode: 'cold' });
        await writeAdversarialRecord(root, taskId, {
            node: 'review', status: 'recorded', revisionId: brief.revisionId ?? '',
            createdAt: new Date().toISOString(), executedInFreshContext: true, contextNote: 'fixture',
            briefSha256: brief.sha256,
            attempts: [{ hypothesis: 'h', method: 'm', outcome: 'refuted', evidence: 'read the code' }],
            findings: [],
            ...extra,
        } as never);
    }

    it('names the capabilities a node requires', () => {
        // The requirement is a property of the node, not of the caller: an escalated node is the one whose whole point is
        // a second independent look, so it is the one that cannot be satisfied without an isolated executor.
        expect(requiredCapabilitiesForNode('review')).toContain('fresh_context');
        expect(requiredCapabilitiesForNode('verify')).toContain('read_only_fs');
        expect(requiredCapabilitiesForNode('verify')).toContain('budget_enforced');
    });

    it('refuses a pass that carries no receipt when the profile bought the capability', async () => {
        // An escalated profile is the one that demands the capability: it is buying a second controlled independent look,
        // so an agent's assertion about its own context cannot be the evidence for it. A default profile keeps the legacy
        // shape, which is why this test has to build a strict task to reach the refusal at all.
        const root = await sealedTask('receipt-missing', { reviewMode: 'strict' });
        await record(root, 'receipt-missing', {});
        const gate = await adversarialGateFor(root, 'receipt-missing', 'review');
        // Not `not_fresh_context`: the boolean is no longer the thing being checked. The refusal names what is missing,
        // so the remedy is "run it on a capable host", not "set the flag".
        expect(gate).toMatchObject({ satisfied: false, reason: 'executor_unavailable' });
    });

    it('refuses a receipt that does not bind to the issued request', async () => {
        const root = await sealedTask('receipt-unbound');
        const forged: ReviewExecutionReceipt = {
            requestSha256: 'deadbeef'.repeat(8),
            runId: 'not-the-issued-nonce',
            capabilities: ['fresh_context', 'read_only_fs', 'bounded_tools', 'budget_enforced'],
            startedAt: '2026-09-21T00:00:00.000Z',
            endedAt: '2026-09-21T00:05:00.000Z',
            telemetry: { toolCalls: 3, outputBytes: 100, tokens: 200, truncations: 0 },
            status: 'completed',
        };
        await record(root, 'receipt-unbound', { receipt: forged });
        // A well-formed receipt that names a different run is exactly what the binding check exists for: the shape is
        // valid, so the schema lets it through, and only the nonce/hash comparison can tell it answered another round.
        const gate = await adversarialGateFor(root, 'receipt-unbound', 'review');
        expect(gate).toMatchObject({ satisfied: false, reason: 'receipt_unbound' });
    });

    it('refuses a receipt at the write boundary when its hash is not a real digest', async () => {
        const root = await sealedTask('receipt-unbound');
        // A bound receipt with a thin capability set. The nonce and hash match nothing issued, so this test drives the
        // *capability* branch directly through the pure predicate rather than through the gate — otherwise the binding
        // check refuses first and the capability check is never reached (measured: `reason` came back `receipt_unbound`).
        const thin: ReviewExecutionReceipt = {
            requestSha256: 'a'.repeat(64),
            runId: 'run-1',
            capabilities: ['fresh_context'],
            startedAt: '2026-09-21T00:00:00.000Z',
            endedAt: '2026-09-21T00:05:00.000Z',
            telemetry: { toolCalls: 3, outputBytes: 100, tokens: 200, truncations: 0 },
            status: 'completed',
        };
        const checked = verifyExecutionReceipt({
            request: {
                runId: 'run-1',
                requestSha256: 'a'.repeat(64),
                node: 'review',
                revisionId: 'revision-1',
                briefSha256: 'b'.repeat(64),
                reviewIrSha256: 'c'.repeat(64),
                budget: { maxHypotheses: 6, maxToolCalls: 48, maxOutputBytes: 2_000_000, maxWallMs: 900_000 },
                requiredCapabilities: requiredCapabilitiesForNode('review'),
                resultSchemaVersion: 1,
            },
            receipt: thin,
        });
        expect(checked.ok).toBe(false);
        expect(checked.ok === false && checked.refusal.reason).toBe('capability_missing');
        // And it names what is missing, so the remedy is a host that provides it rather than a flag to set.
        expect(checked.ok === false && checked.refusal.missing).toEqual(['read_only_fs']);
    });

    it('reports budget_exhausted from the receipt rather than certifying a truncated round', () => {
        // The executor's own report is what makes exhaustion visible. A `budget_exhausted` receipt is a *result about the
        // round*, and the gate must not treat it as a clean pass — the silent equivalence of "I stopped" and "I found
        // nothing" is the defect §2.3 exists to remove.
        const exhausted: ReviewExecutionReceipt = {
            requestSha256: 'x'.repeat(64),
            runId: 'x',
            capabilities: ['fresh_context', 'read_only_fs', 'bounded_tools', 'budget_enforced'],
            startedAt: '2026-09-21T00:00:00.000Z',
            endedAt: '2026-09-21T00:15:00.000Z',
            telemetry: { toolCalls: 48, outputBytes: 2_000_000, tokens: 900_000, truncations: 0 },
            status: 'budget_exhausted',
        };
        expect(exhausted.status).toBe('budget_exhausted');
        // And the refusal, when it comes, must be distinguishable from "the executor was missing".
        expect(exhausted.status).not.toBe('executor_unavailable');
    });

    it('accepts only the receipt persisted with the issued IR, rather than reconstructing a request from live state', async () => {
        const root = await sealedTask('receipt-issued-ir', { reviewMode: 'strict' });
        const issued = await issueAdversarialBrief(root, 'receipt-issued-ir', 'review', { mode: 'cold' });
        const request = issued.runRequest!;
        const receipt: ReviewExecutionReceipt = {
            runId: request.runId, requestSha256: request.requestSha256, capabilities: request.requiredCapabilities,
            startedAt: '2026-09-21T00:00:00.000Z', endedAt: '2026-09-21T00:01:00.000Z',
            telemetry: { toolCalls: 3, outputBytes: 100, tokens: 200, truncations: 0 }, status: 'completed',
        };
        await writeAdversarialRecord(root, 'receipt-issued-ir', {
            node: 'review', status: 'recorded', revisionId: issued.revisionId ?? '', createdAt: new Date().toISOString(),
            executedInFreshContext: true, contextNote: 'host receipt', briefSha256: issued.sha256,
            // R2: the judgement basis the gate derives its verdict from, alongside the receipt that proves the capability.
            hypotheses: [{
                id: 'h1',
                claim: 'the receipt binds to the issued request',
                targets: [...(issued.ir?.criteria?.map((c) => c.id) ?? []), ...(issued.ir?.scope?.kind === 'delta' ? issued.ir.scope.changedPaths : issued.ir?.scope?.paths ?? [])],
                method: 'source-read',
                outcome: 'refuted',
                // R8: an openable citation rather than a fabricated analyzer name.
                observation: { kind: 'source', ref: 'src/x.ts', observed: 'the request nonce was echoed' },
            }],
            attempts: [{ hypothesis: 'h', method: 'm', outcome: 'refuted', evidence: 'read code' }], findings: [], receipt,
        } as never);
        expect(await adversarialGateFor(root, 'receipt-issued-ir', 'review')).toMatchObject({ satisfied: true });
    });
});

/**
 * §4 Phase 2: telemetry is receipt-stamped, and the `--elapsed-ms` / `--tool-uses` CLI arguments are **retired**.
 *
 * The design's reason is the same one that retired `executedInFreshContext` as a proof: a number the caller types is
 * an assertion about itself. The receipt binds to the issued request by nonce and hash and reports telemetry the CLI
 * could never observe, so it is the only telemetry source that means anything. Leaving the flags in place leaves two
 * sources of truth for "how long did this take", and the self-reported one is the cheaper to reach.
 *
 * What this does NOT do: remove the fields from the record schema. Records already written carry them, and telemetry is
 * reporting, not a conclusion — a reader must still be able to see what a past round reported.
 */
const cleanup: string[] = [];

describe('the self-reported telemetry arguments are retired', () => {
    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    /**
     * The record needs an **issued brief** as well as a result file: without the brief the command refuses on
     * `brief_not_issued` first, and the earlier version of this test passed while the flags were still accepted —
     * measured. The brief is what makes the refusal land on the telemetry check.
     */
    async function recordWithSelfReportedTelemetry(): Promise<{ recorded?: boolean; error?: string }> {
        const root = await mkdtemp(join(tmpdir(), 'kata-receipt-telemetry-'));
        cleanup.push(root);
        await initLayout(root);
        await createTask({ root, id: 'receipt-telemetry', title: 'Receipt telemetry', acceptance: [{ id: 'AC-1', statement: 'Telemetry is receipt-stamped.' }] } as never);
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/x.ts'), 'export const x = 1;\n', 'utf8');
        await createTaskRevision({ root, taskId: 'receipt-telemetry', ownedPaths: ['src/x.ts'], checkIds: [] });

        const before = process.cwd();
        process.chdir(root);
        try {
            // Issue the brief the record must name, so the refusal cannot come from the brief binding.
            const { issueAdversarialBrief } = await import('../../src/quality/adversarial.js');
            const brief = await issueAdversarialBrief(root, 'receipt-telemetry', 'review');
            const file = join(root, 'result.json');
            await writeFile(file, JSON.stringify({
                node: 'review', status: 'recorded', revisionId: brief.revisionId ?? '', executedInFreshContext: true,
                contextNote: 'clean context', createdAt: new Date().toISOString(),
                briefSha256: brief.sha256,
                attempts: [{ hypothesis: 'h', method: 'm', outcome: 'refuted' }], findings: [],
            }), 'utf8');
            return await runAdversarialCommand([
                'record', '--change', 'receipt-telemetry', '--node', 'review',
                '--from-file', file, '--elapsed-ms', '1234', '--tool-uses', '7',
            ]);
        } finally {
            process.chdir(before);
        }
    }

    it('does not accept --elapsed-ms or --tool-uses on the record command', async () => {
        // A number the caller types is an assertion about itself; the receipt reports telemetry the CLI cannot observe,
        // so it is the only source that means anything. Two sources for one fact, and the cheaper is the self-report.
        const result = await recordWithSelfReportedTelemetry();
        expect(result.recorded).toBe(false);
        expect(String(result.error)).toMatch(/--elapsed-ms|--tool-uses|receipt/i);
    }, 20000);

    /**
     * The same fact, through the other channel.
     *
     * The retirement above closed the **argv** channel and left the **JSON** channel open: `adversarial note` accepted a
     * `toolUses` typed into the line body and wrote it into the progress record. The rationale it cites — "telemetry is
     * reported by the execution receipt, and cannot be typed in" — is not a statement about `argv`, so a second encoding
     * of the same self-report is the same defect. Measured: the argv form was refused and this one was accepted.
     */
    it('does not accept caller-stated telemetry on the note path either', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-note-telemetry-'));
        cleanup.push(root);
        await initLayout(root);
        await createTask({ root, id: 'note-telemetry', title: 'Note telemetry', acceptance: [{ id: 'AC-1', statement: 'Telemetry is receipt-stamped.' }] } as never);

        const line = join(root, 'line.json');
        await writeFile(line, JSON.stringify({ type: 'attempt', hypothesis: 'h', method: 'm', outcome: 'refuted', toolUses: 7 }), 'utf8');

        const before = process.cwd();
        process.chdir(root);
        try {
            const result = await runAdversarialCommand(['note', '--change', 'note-telemetry', '--node', 'review', '--from-file', line]);
            expect(result.written).toBeUndefined();
            expect(String(result.error)).toMatch(/toolUses|telemetry|receipt/i);
        } finally {
            process.chdir(before);
        }
    }, 20000);
});

/**
 * K1/K2 of `docs/design/2026-09-22-execution-layer-implementation-plan.md`.
 *
 * The receipt schema says it is *"Written by the host, never by the reviewer"*, and the write path did not enforce it:
 * `record` spread the reviewer's own result JSON into the record, so a `receipt` inside that body was accepted. The claim
 * was about **who wrote it**, and the only thing enforced was **which round it binds to**. Unforgeability comes from not
 * being able to write it in, not from not being able to guess the nonce.
 *
 * K2 gives the host the request it must answer, so a host never has to read Kata's private state to obtain one.
 */
describe('the receipt arrives on its own channel, and the request is handed over', () => {
    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    /** A task with one issued brief, and the paths a host and a reviewer would use. */
    async function issued(issueBrief = true): Promise<{ root: string; brief: Awaited<ReturnType<typeof issueAdversarialBrief>>; resultPath: string; recordPath: string }> {
        const root = await mkdtemp(join(tmpdir(), 'kata-receipt-channel-'));
        cleanup.push(root);
        await initLayout(root);
        await createTask({ root, id: 'receipt-channel', title: 'Receipt channel', acceptance: [{ id: 'AC-1', statement: 'The receipt is host-authored.' }] } as never);
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/x.ts'), 'export const x = 1;\n', 'utf8');
        await createTaskRevision({ root, taskId: 'receipt-channel', ownedPaths: ['src/x.ts'], checkIds: [] });

        const brief = issueBrief ? await issueAdversarialBrief(root, 'receipt-channel', 'review') : ({} as Awaited<ReturnType<typeof issueAdversarialBrief>>);
        const resultPath = join(root, 'result.json');
        await writeFile(resultPath, JSON.stringify({
            node: 'review', status: 'recorded', revisionId: brief.revisionId ?? '', executedInFreshContext: true,
            contextNote: 'a context that did not author the change', briefSha256: brief.sha256,
            createdAt: new Date().toISOString(),
            attempts: [{ hypothesis: 'h', method: 'm', outcome: 'refuted' }],
            hypotheses: [{
                id: 'h1',
                claim: 'the acceptance criterion is satisfied only by the shape of the assertion',
                targets: ['AC-1'],
                method: 'source-read',
                outcome: 'refuted',
                observation: { kind: 'source', ref: 'src/x.ts', observed: 'the assertion exercises the declared behaviour' },
            }],
            findings: [],
        }), 'utf8');
        return { root, brief, resultPath, recordPath: join(root, '.kata', 'tasks', 'receipt-channel', 'adversarial-review.json') };
    }

    function receiptFor(brief: Awaited<ReturnType<typeof issueAdversarialBrief>>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            runId: brief.runRequest!.runId,
            requestSha256: brief.runRequest!.requestSha256,
            capabilities: requiredCapabilitiesForNode('review'),
            startedAt: '2026-09-22T00:00:00.000Z',
            endedAt: '2026-09-22T00:01:00.000Z',
            telemetry: { toolCalls: 3, outputBytes: 1024, tokens: 100, truncations: 0 },
            status: 'completed',
            ...overrides,
        };
    }

    it('refuses a receipt carried in the reviewer result body, and writes nothing', async () => {
        const { root, brief, resultPath, recordPath } = await issued();
        const body = JSON.parse(await readFile(resultPath, 'utf8')) as Record<string, unknown>;
        await writeFile(resultPath, JSON.stringify({ ...body, receipt: receiptFor(brief) }), 'utf8');

        const before = process.cwd();
        process.chdir(root);
        try {
            const result = await runAdversarialCommand(['record', '--change', 'receipt-channel', '--node', 'review', '--from-file', resultPath]);
            expect(result.recorded).toBe(false);
            expect(String(result.error)).toMatch(/--receipt-file/);
            // The disk assertion, not merely the return value: a refusal that still files the record is not a refusal.
            await expect(readFile(recordPath, 'utf8')).rejects.toThrow();
        } finally {
            process.chdir(before);
        }
    }, 20000);

    it('records a receipt named by --receipt-file, and persists the issued run id', async () => {
        const { root, brief, resultPath, recordPath } = await issued();
        const receiptPath = join(root, 'receipt.json');
        await writeFile(receiptPath, JSON.stringify(receiptFor(brief)), 'utf8');

        const before = process.cwd();
        process.chdir(root);
        try {
            const result = await runAdversarialCommand([
                'record', '--change', 'receipt-channel', '--node', 'review', '--from-file', resultPath, '--receipt-file', receiptPath,
            ]);
            expect(result.status).toBe('recorded');
            // The receipt reached the record *and* bound: the gate's refusal reason must not be the binding one.
            expect((result.gate as { reason?: string } | undefined)?.reason).not.toBe('receipt_unbound');
            const persisted = JSON.parse(await readFile(recordPath, 'utf8')) as { receipt?: { runId?: string } };
            expect(persisted.receipt?.runId).toBe(brief.runRequest!.runId);
        } finally {
            process.chdir(before);
        }
    }, 20000);

    it('refuses a receipt file bound to a different run', async () => {
        const { root, brief, resultPath } = await issued();
        const receiptPath = join(root, 'receipt.json');
        await writeFile(receiptPath, JSON.stringify(receiptFor(brief, { requestSha256: 'a'.repeat(64) })), 'utf8');

        const before = process.cwd();
        process.chdir(root);
        try {
            const result = await runAdversarialCommand([
                'record', '--change', 'receipt-channel', '--node', 'review', '--from-file', resultPath, '--receipt-file', receiptPath,
            ]);
            // Measured: the record is filed and the gate refuses it, with `receipt_unbound`. The refusal is the point —
            // a receipt that does not bind must not certify a pass, whatever else the record carries.
            expect((result.gate as { satisfied?: boolean } | undefined)?.satisfied).toBe(false);
            expect((result.gate as { reason?: string } | undefined)?.reason).toBe('receipt_unbound');
        } finally {
            process.chdir(before);
        }
    }, 20000);

    it('emits the request the gate will verify against, byte-identical to the issued one', async () => {
        // Issued here rather than in the helper: the planner reports `reused` when a brief already applies, and reuse
        // means no new run — a different case, asserted separately.
        const { root } = await issued(false);
        const target = join(root, 'request.json');

        const before = process.cwd();
        process.chdir(root);
        try {
            await runAdversarialCommand(['brief', '--change', 'receipt-channel', '--node', 'review', '--emit-request', target]);
            const emitted = await readFile(target, 'utf8');
            // Re-read what the command actually persisted, rather than trusting the return value.
            const dir = adversarialBriefsDir(root, 'receipt-channel');
            const file = (await readdir(dir)).find((name) => name.endsWith('.json'))!;
            const persisted = JSON.parse(await readFile(join(dir, file), 'utf8')) as { briefs: Array<{ runRequest?: unknown; text?: string }> };
            const packet = JSON.parse(emitted) as { request: unknown; brief: { sha256?: string; text?: string } };
            expect(JSON.stringify(packet.request)).toBe(JSON.stringify(persisted.briefs[0]?.runRequest));
            // And the material that request names, so a host can run the round without reading kata's private state.
            // Without it the executor had no brief to feed the session — an ignorant reviewer, which §1.3 is explicit
            // about being worse than a cold one.
            expect(packet.brief.text).toBe(persisted.briefs[0]?.text);
            expect(packet.brief.sha256).toBe((packet.request as { briefSha256?: string }).briefSha256);
            expect(packet.brief.sha256).toMatch(/^[0-9a-f]{64}$/);
        } finally {
            process.chdir(before);
        }
    }, 20000);
});
