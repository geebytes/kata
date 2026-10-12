import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { revalidateWikiRecord, verifySources } from '../../src/wiki/drift.js';
import { findWikiRecord } from '../../src/wiki/store.js';
import { computeFileHash } from '../../src/wiki/record.js';
import { statementForPage } from '../../src/wiki/llmwiki.js';

/**
 * **Re-derivation recomputes; it does not flip a status.**
 *
 * `revalidateWikiRecord` refreshed `sourceHashes` and set `status: 'candidate'` — but the record's `statement` was left as
 * the text derived from the page **as it was when the record was written**. So a record could be "re-derived" while still
 * describing an older page: the closure gate and every reader then treat prose about a version that no longer exists as the
 * current summary.
 *
 * The composition that turns a page into a statement is `register`'s (`frontmatter ? … : oneLineSummary`), so it lives once
 * (`statementForPage`) and both callers ask it — this case asserts the record against that same function rather than
 * against a second copy of the rule.
 */
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function seeded(page: string, shape: 'ingested' | 'distilled' = 'ingested'): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-wiki-rederive-'));
    roots.push(root);
    await initLayout(root);
    await mkdir(join(root, '.llmwiki/concepts'), { recursive: true });
    const pagePath = '.llmwiki/concepts/rule.md';
    await writeFile(join(root, pagePath), page, 'utf8');
    await writeFile(
        join(root, '.kata/wiki/rule-page.json'),
        `${JSON.stringify({
            id: 'rule-page',
            statement: shape === 'ingested' ? statementForPage(page) : 'A durable finding of the change.',
            scope: [pagePath],
            kind: shape === 'ingested' ? 'llmwiki-summary' : 'convention',
            sourceRefs: [pagePath],
            sourceHashes: { [pagePath]: computeFileHash(page) },
            validationTaskId: shape === 'ingested' ? 'llmwiki-register' : 'some-change',
            // Declared, because the fixture cites a `.llmwiki/` path and `inferProvenance` reads that as ingested — the rule
            // is about what the record is, and a distilled record that happens to cite a page is still a distillation.
            ...(shape === 'distilled' ? { provenance: 'distilled' as const } : {}),
            evidenceIds: ['evidence-1'],
            status: 'candidate',
            lastVerifiedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }, null, 2)}\n`,
        'utf8',
    );
    return root;
}

describe('re-deriving a stale record recomputes what the record says about its source', () => {
    it('recomputes the recorded hash and the statement from the page as it is now', async () => {
        const root = await seeded('# Rule\n\nFirst version.\n');
        await writeFile(join(root, '.llmwiki/concepts/rule.md'), '# Second rule\n\nSecond version.\n', 'utf8');
        await verifySources(root);

        const result = await revalidateWikiRecord(root, 'rule-page');
        const record = await findWikiRecord(root, 'rule-page');

        expect(result).toMatchObject({ id: 'rule-page', status: 'candidate', refreshed: ['.llmwiki/concepts/rule.md'] });
        expect(record?.sourceHashes['.llmwiki/concepts/rule.md']).toBe(computeFileHash('# Second rule\n\nSecond version.\n'));
        // The statement follows the page: the same derivation registration uses, against the current content.
        expect(record?.statement).toBe(statementForPage('# Second rule\n\nSecond version.\n'));
        expect(record?.statement).toBe('Second rule');
    });

    it('is a recomputation, so a later edit of the page marks the record stale again', async () => {
        // **The half that separates a recomputation from a status flip.** An implementation that only sets the status would
        // pass the case above if the hash happened to match, and would then report a record as derivable while its recorded
        // hash still describes an older page — which is the state the drift check exists to catch.
        const root = await seeded('# First rule\n\nFirst version.\n');
        await writeFile(join(root, '.llmwiki/concepts/rule.md'), '# Second rule\n\nSecond version.\n', 'utf8');
        await verifySources(root);
        await revalidateWikiRecord(root, 'rule-page');

        await writeFile(join(root, '.llmwiki/concepts/rule.md'), '# Third rule\n\nThird version.\n', 'utf8');
        const after = await verifySources(root);

        expect(after.stale.map((entry) => entry.id)).toEqual(['rule-page']);
        expect(after.stale[0]?.reason).toBe('source_changed');
    });

    it('refreshes hashes for a record another writer composed, and says the statement was not recomputed', async () => {
        // **The rule is "did this writer compose the statement out of the page", not "is this record ingested".** `wiki
        // ingest` writes `sourceRefs: [raw, page]` with `statement: oneLineSummary(external body)`, so its first ref is the
        // raw import rather than the page, and its statement is not this composition at all. Taking `summaries[0]` there
        // (the first version did) would have rewritten the prose of every ingested record from the wrong file. Both halves
        // are asserted: the hash moves, the statement does not, and the answer says which happened.
        const raw = '# Alpha\n\nImported body.\n';
        const page = '# Alpha page\n\nBody.\n';
        const root = await seeded(page, 'distilled');
        await mkdir(join(root, '.llmwiki/raw'), { recursive: true });
        await writeFile(join(root, '.llmwiki/raw/alpha.md'), raw, 'utf8');
        await writeFile(
            join(root, '.kata/wiki/rule-page.json'),
            `${JSON.stringify({
                id: 'rule-page', statement: 'Imported body.', scope: ['.llmwiki/concepts/rule.md'], kind: 'llmwiki-summary',
                sourceRefs: ['.llmwiki/raw/alpha.md', '.llmwiki/concepts/rule.md'],
                sourceHashes: {
                    '.llmwiki/raw/alpha.md': computeFileHash(raw),
                    '.llmwiki/concepts/rule.md': computeFileHash(page),
                },
                validationTaskId: 'llmwiki-ingest', provenance: 'ingested', evidenceIds: ['e1'], status: 'candidate',
                lastVerifiedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            }, null, 2)}\n`,
            'utf8',
        );
        await writeFile(join(root, '.llmwiki/raw/alpha.md'), `${raw}\nSecond edition.\n`, 'utf8');
        await verifySources(root);

        const result = await revalidateWikiRecord(root, 'rule-page');
        const record = await findWikiRecord(root, 'rule-page');

        expect(result.refreshed).toEqual(['.llmwiki/raw/alpha.md']);
        expect(record?.sourceHashes['.llmwiki/raw/alpha.md']).toBe(computeFileHash(`${raw}\nSecond edition.\n`));
        expect(record?.sourceHashes['.llmwiki/concepts/rule.md']).toBe(computeFileHash(page));
        expect(record?.statement).toBe('Imported body.');
        expect(result.statement).toMatchObject({ recomputed: false });
        expect(result.statement.why).toContain('llmwiki-ingest');
    });

    it('does not trust the writer id alone: a record claiming it with a non-page source keeps its prose', async () => {
        // **The eligibility test is the writer AND the shape that writer produces.** A record carrying `llmwiki-register`
        // whose single source is some other file (hand-made, or its ref edited later) was recomputed from that file — its
        // prose replaced by that file's first line, while the reply repeated the id as if the id were the evidence
        // (measured by an independent round). The clause checks the ref the same writer would have built.
        const root = await seeded('# Rule\n\nFirst version.\n', 'distilled');
        const path = join(root, '.kata/wiki/rule-page.json');
        await mkdir(join(root, 'docs'), { recursive: true });
        await writeFile(join(root, 'docs/rule.md'), '# Rule\n\nFirst version.\n', 'utf8');
        const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        record.validationTaskId = 'llmwiki-register';
        record.statement = 'Prose a person wrote.';
        record.sourceRefs = ['docs/rule.md'];
        record.sourceHashes = { 'docs/rule.md': computeFileHash('# Rule\n\nFirst version.\n') };
        await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
        await writeFile(join(root, 'docs/rule.md'), '# Rule\n\nSecond version.\n', 'utf8');
        await verifySources(root);

        const result = await revalidateWikiRecord(root, 'rule-page');
        const after = await findWikiRecord(root, 'rule-page');

        expect(after?.statement).toBe('Prose a person wrote.');
        expect(result.statement.recomputed).toBe(false);
    });

    it('follows the frontmatter too, which is the other branch of the derivation', async () => {
        // **Both branches of `statementForPage` are exercised, not only the summary one.** A page with the frontmatter the
        // repository's own pages carry takes the `frontmatter ? … : …` branch, where the statement is the header rather than
        // the first line — so a re-derivation that only handled the summary branch would leave a record describing the
        // previous header while looking recomputed.
        // The fields `parsePageFrontmatter` requires, and no others: without all six it returns null and the summary branch is
        // taken instead, which is how the first version of this fixture managed to assert nothing about frontmatter.
        const header = (title: string): string =>
            `---\ntitle: ${title}\ncreated: 2026-10-12\nupdated: 2026-10-12\ntype: concept\ntags: wiki\nsources:\n  - .llmwiki/concepts/rule.md\n---\n\n# Body\n\nProse.\n`;
        const page = header('First title');
        const root = await seeded(page);
        const edited = header('Second title');
        await writeFile(join(root, '.llmwiki/concepts/rule.md'), edited, 'utf8');
        await verifySources(root);

        await revalidateWikiRecord(root, 'rule-page');
        const record = await findWikiRecord(root, 'rule-page');

        expect(record?.statement).toBe(statementForPage(edited));
        expect(record?.statement).toContain('Second title');
    });

    it('refreshes the hash of a distilled record but leaves its statement, which its file does not contain', async () => {
        // **The boundary, asserted rather than only written down.** "The statement is the page's summary" holds for an
        // ingested record. A distilled record's statement is the change's own finding: recomputing it here would replace
        // knowledge with the first line of whatever the record happens to cite. AC-1's wording is about the page case; this
        // case pins the other direction so a later edit cannot quietly start overwriting distilled prose.
        const root = await seeded('# First rule\n\nFirst version.\n', 'distilled');
        await writeFile(join(root, '.llmwiki/concepts/rule.md'), '# Second rule\n\nSecond version.\n', 'utf8');
        await verifySources(root);

        await revalidateWikiRecord(root, 'rule-page');
        const record = await findWikiRecord(root, 'rule-page');

        expect(record?.sourceHashes['.llmwiki/concepts/rule.md']).toBe(computeFileHash('# Second rule\n\nSecond version.\n'));
        expect(record?.statement).toBe('A durable finding of the change.');
    });
});
