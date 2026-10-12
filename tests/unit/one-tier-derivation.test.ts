import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyRisk, resolveTier } from '../../src/kernel/risk.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { planReview } from '../../src/producers/planner.js';
import { ledgerTierForDeclaredPaths } from '../../src/store/verdict.js';

/**
 * **One derivation for the tier, so the plan cannot be weaker than its own gate.**
 *
 * Measured on a real change: `ledger plan` reported tier `standard` while `ledger decide` reported `strict`. Both were
 * reading the same policy; only the decision applied `ledgerTierCeiling`. The ceiling exists because a floor is only as
 * good as its patterns — a change to what evidence is accepted sits under a pattern no risk rule names — so the command
 * that skipped it was computing the plan's required evidence and risk classes for a weaker tier than the one being
 * enforced. A plan weaker than its gate is worse than no plan, because it reads like a specification.
 */
const policy = defaultPolicy();

describe('the tier is derived once', () => {
    it('applies the policy ceiling, so a low-risk path set is still reviewed at the ceiling', () => {
        const classification = classifyRisk({ paths: ['src/wiki/llmwiki.ts'], policy });
        expect(classification.tier, 'the classification alone says standard').toBe('standard');
        expect(resolveTier({ classification, policy }), 'the tier the decision uses is the ceiling').toBe(policy.ledgerTierCeiling);
        expect(policy.ledgerTierCeiling).toBe('strict');
    });

    it('keeps a higher classification, because the ceiling is a floor on the tier and not a cap', () => {
        // `src/kernel/decide.ts` carries a `high` risk floor, so a change touching it classifies above the ceiling.
        const classification = classifyRisk({ paths: ['src/kernel/decide.ts'], policy });
        expect(resolveTier({ classification, policy })).toBe('security');
    });

    it('lets an explicit override raise a tier but never lower the complete-surface floor', () => {
        const lowClassification = classifyRisk({ paths: ['src/wiki/llmwiki.ts'], policy });
        const highClassification = classifyRisk({ paths: ['src/kernel/decide.ts'], policy });
        expect(resolveTier({ classification: lowClassification, policy, override: 'security' })).toBe('security');
        expect(resolveTier({ classification: highClassification, policy, override: 'standard' })).toBe('security');
    });
});

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * **The tier reads the declared *content* surface, not the declaration's spelling.**
 *
 * Measured by an independent round (R3d-F1) on a scratch root whose task record declared the directory `src/kernel`:
 * `freeze` recorded the two files under it (both policy `high`), while `ledger plan` published `tier: strict,
 * reviewers: 1, risk.tier: standard, matched: []` — the resolver classified the raw declaration string, which matches no
 * risk pattern, so a `security`-floor change was gated at `strict` and its two-reviewer quorum was never demanded. The same
 * happened for the non-canonical spelling `./src/kernel/decide.ts` that `normalizeDeclaredPaths` exists to accept.
 */
describe('the tier classifies the declared content surface', () => {
    it('expands a declared directory before the risk floor is applied', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-tier-'));
        roots.push(root);
        await mkdir(join(root, '.kata', 'tasks', 't'), { recursive: true });
        await mkdir(join(root, 'src', 'kernel'), { recursive: true });
        await writeFile(join(root, 'src', 'kernel', 'decide.ts'), 'export const a = 1;\n');
        await writeFile(join(root, 'src', 'kernel', 'policy.ts'), 'export const b = 1;\n');
        await writeFile(
            join(root, '.kata', 'tasks', 't', 'task.json'),
            `${JSON.stringify({ id: 't', ownedPaths: ['src/kernel'] }, null, 2)}\n`,
        );

        const { classification, tier } = await ledgerTierForDeclaredPaths({ root, changeId: 't', policy });
        expect(classification.matched.map((entry) => entry.path).sort()).toEqual([
            'src/kernel/decide.ts',
            'src/kernel/policy.ts',
        ]);
        expect(tier).toBe('security');
    });

    it('canonicalises a declaration before classifying it, so the spelling does not decide the gate', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-tier-'));
        roots.push(root);
        await mkdir(join(root, '.kata', 'tasks', 't'), { recursive: true });
        await mkdir(join(root, 'src', 'kernel'), { recursive: true });
        await writeFile(join(root, 'src', 'kernel', 'decide.ts'), 'export const a = 1;\n');
        await writeFile(
            join(root, '.kata', 'tasks', 't', 'task.json'),
            `${JSON.stringify({ id: 't', ownedPaths: ['./src/kernel/decide.ts'] }, null, 2)}\n`,
        );

        const { classification, tier } = await ledgerTierForDeclaredPaths({ root, changeId: 't', policy });
        expect(classification.matched.map((entry) => entry.path)).toEqual(['src/kernel/decide.ts']);
        expect(tier).toBe('security');
    });

    it('never classifies the diff as the change risk when a caller omits the classification', () => {
        // The planner's own fallback used to be `contentPaths ?? changedPaths`, so a caller passing only a diff got the
        // R2-F1 shape back — the plan's published classification derived from what this round happened to touch (measured
        // by an independent round, R3d-F2). The diff scopes review focus; it is not the declared surface.
        const plan = planReview({
            subject: { revision: 'rev:aaaaaaaaaaaaaaaa', pathDigests: {} } as never,
            claims: [],
            policy,
            tier: 'strict',
            changedPaths: ['src/kernel/decide.ts'],
        });
        expect(plan.risk.matched).toEqual([]);
        expect(plan.risk.tier).toBe('standard');
    });
});
