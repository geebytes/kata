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

    it('canonicalises even when a caller supplies paths, so no caller can bypass the content surface', async () => {
        // **There is no bypass branch.** The first version of this repair canonicalised only when `paths` was absent, and
        // the production ReviewRequest call site (`src/store/review-request.ts:130`) passes the task's raw declaration —
        // so a change declaring a directory produced `strict` from the request and `security` from the plan, and the
        // request refused with a remedy that could not change the answer (measured by an independent round, R4-F1). A
        // supplied set is canonicalised again rather than trusted: for an already-canonical set that is an identity, and
        // for a directory or a `./`-prefixed spelling it is the expansion the subject will record.
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

        const withDeclaration = await ledgerTierForDeclaredPaths({ root, changeId: 't', policy });
        const withSuppliedRawPaths = await ledgerTierForDeclaredPaths({ root, changeId: 't', policy, paths: ['src/kernel'] });
        expect(withSuppliedRawPaths.tier).toBe(withDeclaration.tier);
        expect(withSuppliedRawPaths.classification.matched.map((entry) => entry.path).sort()).toEqual([
            'src/kernel/decide.ts',
            'src/kernel/policy.ts',
        ]);
    });

    it('keeps a declared high-floor path in the classification even when it cannot be read', async () => {
        // **A named path that has become unreadable is still named by the declaration.** Keeping only the covered content
        // dropped it the moment it was deleted, so `ledger decide` published the policy ceiling -- `strict` and one
        // reviewer -- while `ledger plan` refused the very same declaration by name: the security floor's two-reviewer
        // quorum became unreachable through a state the operator had not declared (measured by an independent round,
        // R5-F1). The surface is the union of the names and the covered content, so the floor the spelling implies stays.
        const root = await mkdtemp(join(tmpdir(), 'kata-tier-'));
        roots.push(root);
        await mkdir(join(root, '.kata', 'tasks', 't'), { recursive: true });
        await mkdir(join(root, 'src', 'kernel'), { recursive: true });
        await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
        await writeFile(join(root, 'src', 'kernel', 'decide.ts'), 'export const gate = true;\n');
        await writeFile(
            join(root, '.kata', 'tasks', 't', 'task.json'),
            `${JSON.stringify({ id: 't', ownedPaths: ['src/a.ts', 'src/kernel/decide.ts'] }, null, 2)}\n`,
        );
        const readable = await ledgerTierForDeclaredPaths({ root, changeId: 't', policy });
        expect(readable.tier).toBe('security');

        await rm(join(root, 'src', 'kernel', 'decide.ts'));

        const unreadable = await ledgerTierForDeclaredPaths({ root, changeId: 't', policy });
        expect(unreadable.tier, 'the unreadable declared path keeps its floor').toBe('security');
        expect(unreadable.classification.matched.map((entry) => entry.path)).toContain('src/kernel/decide.ts');
    });

    it('keeps the floor of an unreadable declared path whose recorded spelling is not canonical', async () => {
        // **The union must be built from the walk's spelling, not the recorded one.** The first version of the union used
        // the declaration as written, so `./src/kernel/decide.ts` — exactly the spelling `normalizeDeclaredPaths` exists to
        // accept — matched no exact floor pattern once its file was unreadable, and the tier fell to `strict` with one
        // reviewer while `ledger plan` refused the same declaration by name (measured by an independent round, R6-F1). The
        // canonical name was already computed and discarded in `covered.unreadable`.
        const root = await mkdtemp(join(tmpdir(), 'kata-tier-'));
        roots.push(root);
        await mkdir(join(root, '.kata', 'tasks', 't'), { recursive: true });
        await mkdir(join(root, 'src', 'kernel'), { recursive: true });
        await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
        await writeFile(join(root, 'src', 'kernel', 'decide.ts'), 'export const gate = true;\n');
        await writeFile(
            join(root, '.kata', 'tasks', 't', 'task.json'),
            `${JSON.stringify({ id: 't', ownedPaths: ['src/a.ts', './src/kernel/decide.ts'] }, null, 2)}\n`,
        );
        expect((await ledgerTierForDeclaredPaths({ root, changeId: 't', policy })).tier).toBe('security');

        await rm(join(root, 'src', 'kernel', 'decide.ts'));

        const unreadable = await ledgerTierForDeclaredPaths({ root, changeId: 't', policy });
        expect(unreadable.tier, 'the canonical spelling of an unreadable declaration keeps its floor').toBe('security');
        expect(unreadable.classification.matched.map((entry) => entry.path)).toContain('src/kernel/decide.ts');
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
