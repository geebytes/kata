import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { ensureAssurance, reviewDir, setUsage } from '../../src/store/ledger.js';

let root: string;
const changeId = 'unreadable-usage';

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-unreadable-usage-'));
    await initLayout(root);
    await createTask({ root, id: changeId, title: 'Unreadable usage', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/a.ts'] });
    await mkdir(reviewDir(root, changeId), { recursive: true });
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

/**
 * **"No usage recorded" and "the record is damaged" are different facts, and the second must not be overwritten.**
 *
 * Measured: `ensureAssurance` read an unparseable `usage.json` as `null` and defaulted it to `{ usage: {}, assurance:
 * 'none' }`, then wrote that fabricated value back with its metadata. A historical record whose bytes were damaged
 * therefore came back as `none` on the next verification — the one case C-4's "reading does not rewrite the historical
 * value" does not cover, because the reader cannot tell a corrupt file from an absent one.
 */
describe('an unreadable usage record is refused, not replaced', () => {
    it('refuses the write and names the file instead of inventing a default', async () => {
        const path = join(reviewDir(root, changeId), 'usage.json');
        await writeFile(path, '{"usage": {"spentTokens": 12}, "assurance": "sandboxed"');

        await expect(ensureAssurance(root, changeId, 'observed')).rejects.toThrow(/usage\.json/);
        await expect(ensureAssurance(root, changeId, 'observed')).rejects.toThrow(/not valid JSON|unreadable|cannot be read/i);

        // The damaged bytes are still there: a refusal must not be a rewrite.
        expect(await readFile(path, 'utf8')).toContain('sandboxed');
    });

    it('still treats an absent record as absent, so a first round records its assurance', async () => {
        expect(await ensureAssurance(root, changeId, 'observed')).toBe('observed');
        const written = JSON.parse(await readFile(join(reviewDir(root, changeId), 'usage.json'), 'utf8')) as { assurance: string };
        expect(written.assurance).toBe('observed');
    });

    it('refuses a damaged record on the usage write path too', async () => {
        const path = join(reviewDir(root, changeId), 'usage.json');
        await writeFile(path, 'not json at all');
        await expect(setUsage(root, changeId, { toolCalls: 3 })).rejects.toThrow(/usage\.json/);
        expect(await readFile(path, 'utf8')).toBe('not json at all');
    });
});
