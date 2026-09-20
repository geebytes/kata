import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildContextManifest, summarizeExcludedWiki } from '../../src/core/context.js';

/**
 * L3-03: a stale record this task asked about is a fact it needs; a stale record from elsewhere is repository noise.
 *
 * Every task used to carry the whole history of Wiki drift, and the cost was paid on every handoff. What must not
 * change is that a relevant record's reason stays visible at the point of use.
 *
 * Relevance is decided where the record is still readable — `wiki/context.ts` — and carried on `ExcludedWikiEntry`:
 * a wiki record id is `wiki-<taskId>` and cannot be matched against a path, so the partition here reads the flag rather
 * than re-deriving it. `tests/unit/context.test.ts` covers the decision against real records.
 */
describe('scoped Wiki diagnostics', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    it('keeps a relevant record with its reason and counts the rest', () => {
        const summary = summarizeExcludedWiki([
            { id: 'wiki-src-auth-1', reason: 'stale', relevant: true },
            { id: 'wiki-other-1', reason: 'stale', relevant: false },
            { id: 'wiki-other-2', reason: 'invalid', relevant: false },
        ]);

        expect(summary.relevant).toEqual([{ id: 'wiki-src-auth-1', reason: 'stale' }]);
        expect(summary.unrelated).toEqual({ count: 2, byReason: { stale: 1, invalid: 1 } });
    });

    it('reports nothing unrelated when every exclusion is relevant', () => {
        const summary = summarizeExcludedWiki([{ id: 'wiki-src-a-1', reason: 'stale', relevant: true }]);

        expect(summary.unrelated.count).toBe(0);
        expect(summary.unrelated.byReason).toEqual({});
    });

    it('counts an entry with no relevance flag as unrelated, because only the selector can say otherwise', () => {
        // A legacy entry (or one built by hand) carries no answer. Noise is the safe default: it is the direction that
        // keeps a task's packet small, and the detail stays available through the raw `excludedWiki` list.
        const summary = summarizeExcludedWiki([{ id: 'wiki-a', reason: 'stale' }]);

        expect(summary.relevant).toEqual([]);
        expect(summary.unrelated).toEqual({ count: 1, byReason: { stale: 1 } });
    });

    it('keeps the raw list intact alongside the summary', async () => {
        // The projection is additive: a caller that wants the whole picture still has it. Read through the manifest,
        // because that is the seam a consumer uses.
        const root = await mkdtemp(join(tmpdir(), 'kata-wiki-scope-'));
        roots.push(root);
        const manifest = await buildContextManifest({ root, taskId: 'scope-task', sourceRefs: [] });

        expect(manifest.excludedWiki).toEqual([]);
        expect(manifest.excludedWikiSummary).toEqual({ relevant: [], unrelated: { count: 0, byReason: {} } });
    });
});
