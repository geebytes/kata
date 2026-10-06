import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLedger } from '../../src/store/ledger.js';
import { ledgerVerdict } from '../../src/store/verdict.js';

/**
 * Every schema-less ledger artefact has the same three-state boundary.
 *
 * A parseable but wrongly-shaped document is not an empty legacy record.  It is
 * unreadable: the ledger must name it before any direct reader or decision
 * consumer can mistake it for usable input.
 */
let root: string;
const changeId = 'record-read-state';

const malformedDocuments: Array<{ file: string; content: string }> = [
    { file: 'challenges.json', content: '{}\n' },
    { file: 'probes.json', content: '{}\n' },
    { file: 'probe-answers.json', content: '{}\n' },
    { file: 'runs.json', content: '{}\n' },
    { file: 'usage.json', content: '[]\n' },
    { file: 'plan.json', content: '[]\n' },
    { file: 'verdict-history.jsonl', content: 'null\n' },
];

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-ledger-read-state-'));
    await mkdir(join(root, '.kata', 'tasks', changeId, 'review'), { recursive: true });
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('schema-less ledger artefact read states', () => {
    it.each(malformedDocuments)('classifies a wrong-shaped $file as unreadable everywhere', async ({ file, content }) => {
        await writeFile(join(root, '.kata', 'tasks', changeId, 'review', file), content);

        const ledger = await readLedger(root, changeId);
        expect(ledger.malformedFiles).toContain(file);

        const verdict = await ledgerVerdict({ root, changeId });
        expect(verdict.kind).toBe('unreadable');
    });
});
