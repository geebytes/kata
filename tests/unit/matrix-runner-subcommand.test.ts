import { describe, expect, it } from 'vitest';
import { resolveCheckForRow, matrixRunners } from '../../src/quality/check-resolver.js';
import type { AcceptanceCriterion, AcceptanceMatrixRow } from '../../src/core/task.js';

/**
 * A declared test selector has to *run*, not start a watcher.
 *
 * `matrixRunners.vitest` names the node entry (`node_modules/vitest/vitest.mjs`), and kata launches it through the Node
 * binary. With no subcommand that is **watch mode**: vitest prints `DEV`, runs the selector, and then sits on
 * `PASS  Waiting for file changes...` forever. Every matrix-derived test check therefore hung to its timeout — measured on
 * the declaring task as `exitCode: 124` on all five matrix checks, against a `vitest run` that finishes a focused selector
 * in about two seconds — so a task whose matrix declares test selectors could never seal at all.
 *
 * The runner table is data, so the subcommand is data too: the next runner that needs one has somewhere to say it.
 */
describe('matrix test runners run once', () => {
    const row: AcceptanceMatrixRow = {
        acceptanceId: 'AC-1',
        implementationPaths: ['src/x.ts'],
        testPaths: ['tests/unit/x.test.ts'],
        evidence: [{ id: 'ac-1', kind: 'test', command: 'vitest', testSelector: 'tests/unit/x.test.ts' }],
        verificationLevel: 'unit',
    };
    const acceptance: AcceptanceCriterion[] = [{ id: 'AC-1', statement: 'x' }];

    it('passes the runner the subcommand it needs to exit, ahead of the caller args and the selector', () => {
        const resolved = resolveCheckForRow(row, row.evidence[0]!, '/w');
        expect(resolved).not.toBeInstanceOf(Error);
        if (resolved instanceof Error) return;
        expect(resolved.command).toBe(process.execPath);
        // …/vitest.mjs run <selector> — the `run` is what stops it watching.
        expect(resolved.args?.[1]).toBe('run');
        expect(resolved.args?.at(-1)).toBe('tests/unit/x.test.ts');
        expect(resolved.testSelector).toBe('tests/unit/x.test.ts');
    });

    it('declares that subcommand as part of the runner table, so it is a fact rather than a special case in the builder', () => {
        expect(matrixRunners.vitest?.nodeEntryArgs).toEqual(['run']);
        // A runner whose entry runs once and exits declares nothing, and nothing is inserted for it.
        expect(matrixRunners.tsc?.nodeEntryArgs).toBeUndefined();
    });

    it('does not insert args for a runner with no declared entry args', () => {
        const tscRow: AcceptanceMatrixRow = {
            ...row,
            evidence: [{ id: 'tc', kind: 'typecheck', command: 'tsc' }],
        };
        const resolved = resolveCheckForRow(tscRow, tscRow.evidence[0]!, '/w');
        expect(resolved).not.toBeInstanceOf(Error);
        if (resolved instanceof Error) return;
        expect(resolved.args).toEqual([expect.stringContaining('tsc')]);
    });
});
