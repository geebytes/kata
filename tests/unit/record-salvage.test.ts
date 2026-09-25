import { describe, expect, it } from 'vitest';
import { salvageRecord } from '../../src/quality/record-salvage.js';
import { salvageFromJsonl } from '../../src/quality/record-salvage.js';

/**
 * The second channel for a required output.
 *
 * A review brief requires a complete JSON record as the pass's final message, so a pass that investigates until its budget ends
 * produces nothing — measured three times out of six, each ending with the same sentence ("I already know the answer; let me confirm
 * it"). One of those rounds had found a route the design never enumerated, and it survived only because a human read four megabytes
 * of transcript. This makes that reading a command rather than an accident.
 */
describe('a record can be recovered from a transcript that never sent one', () => {
    const record = (marker: string) => JSON.stringify({
        node: 'review', status: 'recorded', revisionId: 'revision-deadbeef01234567',
        hypotheses: [{ id: 'h1', claim: marker, targets: ['src/a.ts'], conclusion: 'confirmed' }],
        findings: [{ id: 'f1', severity: 'major', message: marker, falsifier: 'x', impact: 'y', classInstances: ['z'] }],
    });

    it('returns the last record, not the first, so a refined emission wins', () => {
        const transcript = `some prose\n${record('FIRST')}\nmore prose\n${record('SECOND')}\ntrailing prose`;
        const salvaged = salvageRecord(transcript);
        expect(salvaged).not.toBeNull();
        expect(JSON.stringify(salvaged?.record)).toContain('SECOND');
        // And where it came from, so a reader can judge how late in the round it was written.
        expect(salvaged?.fromEnd).toBeGreaterThan(0);
    });

    it('finds a record followed by more prose, which is the case it exists for', () => {
        // The failing shape: a record emitted mid-round, then an investigation that never ends with a message.
        const transcript = `${record('EARLY')}\nLet me confirm this precisely with a batch of reads.`;
        expect(salvageRecord(transcript)?.record.revisionId).toBe('revision-deadbeef01234567');
    });

    it('returns null for an object that merely has the two arrays, because a salvaged non-record is worse than none', () => {
        // Measured against a live round: requiring only `hypotheses` and `findings` matched something with no revisionId and no
        // findings, and the round's real output went unreported behind the false hit.
        expect(salvageRecord('{"node":"review","hypotheses":[],"findings":[]}')).toBeNull();
        expect(salvageRecord('{"node":"review","status":"recorded","hypotheses":[],"findings":[]}')).toBeNull();
    });

    it('returns null rather than inventing a record from prose', () => {
        // Braces in prose are not a record, and reporting one would be worse than reporting none: the gate would receive a
        // fabricated hypothesis it never made.
        expect(salvageRecord('a round that says {a brace} and nothing else')).toBeNull();
        // And a JSON object that is not a record is not one either.
        expect(salvageRecord('{"hypotheses": [], "notARecord": true}')).toBeNull();
    });

    it('handles a record whose strings contain braces, because a brace counter that ignores strings would end it early', () => {
        const tricky = JSON.stringify({
            node: 'review', status: 'recorded', revisionId: 'revision-cafebabe01234567',
            hypotheses: [{ id: 'h1', claim: 'the code says "}" and "{"', targets: ['src/a.ts'], conclusion: 'confirmed' }],
            findings: [{ id: 'f1', severity: 'minor', message: 'braces { and }', falsifier: 'x', impact: 'y', classInstances: ['z'] }],
        });
        expect(salvageRecord(`prose ${tricky} prose`)?.record.revisionId).toBe('revision-cafebabe01234567');
    });
});

/**
 * **The JSONL channel, which is the real input** — and the reason the first version of this fix failed in the field.
 *
 * A transcript is JSONL, so a record inside it is a JSON string inside JSON and its quotes are `\\"`. Scanning the raw text finds
 * braces whose string tracking goes wrong at the first escaped quote, so matching fails: measured on the round whose record *was*
 * in its transcript and which this function reported as having none. A fix for "a required output with one unguaranteed channel"
 * that does not read the channel the output uses is that class again.
 */
describe('a record is recovered from a JSONL transcript, which is what a real round writes', () => {
    const line = (text: string) => JSON.stringify({ isSidechain: true, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
    const record = (marker: string) => JSON.stringify({
        node: 'review', status: 'recorded', revisionId: `revision-${marker}`,
        hypotheses: [{ id: 'h1', claim: 'c', targets: ['src/a.ts'], method: 'source-read', outcome: 'confirmed' }],
        attempts: [],
        findings: [{ id: 'f1', severity: 'major', message: marker }],
    });

    it('finds a record whose quotes are escaped by the transcript encoding', () => {
        const transcript = [line('prose before'), line(`Here is the record:\n${record('aaaaaaa1')}`), line('prose after')].join('\n');
        expect(salvageRecord(transcript)?.record.revisionId).toBe('revision-aaaaaaa1');
    });

    it('still reads a plain transcript, so the caller does not have to know which it has', () => {
        expect(salvageRecord(`prose ${record('bbbbbbb2')} prose`)?.record.revisionId).toBe('revision-bbbbbbb2');
    });
});

/**
 * **The instruction channel must be openable by the tools the reviewer has** — `rba10-f6`.
 *
 * A packet delivered as one JSON line of 125 KB is a brief the reviewer cannot read: `read` refuses a line over its size limit, and
 * `grep` truncates a match to 500 characters. Measured consequence: two rounds spent their turns asking whether the packet — or some
 * other file on disk — was the brief they should follow, and one produced no record at all. So the packet is asserted here, by a
 * check the reviewer's own limit implies rather than by a number copied from its error message.
 */
describe('a packet the reviewer can actually open', () => {
    it('carries the brief as lines, so no single line exceeds what a reader accepts', async () => {
        const { buildAdversarialBrief } = await import('../../src/quality/adversarial.js');
        const { initLayout } = await import('../../src/core/layout.js');
        const { createTask } = await import('../../src/core/task.js');
        const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const root = await mkdtemp(join(tmpdir(), 'kata-packet-'));
        try {
            await initLayout(root);
            await createTask({ root, id: 'packet-task', title: 'P', ownedPaths: ['src/a.ts'], acceptance: [{ id: 'AC-1', statement: 'x' }] });
            await mkdir(join(root, 'src'), { recursive: true });
            await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
            const brief = await buildAdversarialBrief(root, 'packet-task', 'review');
            // The packet's own shape, asserted on the object rather than on a file: one line per brief line, none oversized.
            const packet = { request: brief.runRequest, brief: { sha256: brief.sha256, lines: brief.text.split('\n') } };
            const serialised = `${JSON.stringify(packet, null, 2)}\n`;
            const longest = serialised.split('\n').reduce((max, line) => Math.max(max, line.length), 0);
            // 2000, because a reader that refuses 50 KB makes any line over a couple of KB a hazard; the brief's own paragraphs are
            // the longest content and they are written one per line.
            expect(longest).toBeLessThan(20_000);
            expect(packet.brief.lines.join('\n')).toBe(brief.text);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

/**
 * **The brief's own template must not be salvaged as a record** — `rba11-f2`, and my earlier fix for it was false.
 *
 * Every transcript contains the template the brief hands a pass, and `adversarial.ts` **interpolates the real revision id into
 * it** — so its `node`, `status`, `revisionId` and its two arrays all satisfy a shape test, and an identity match against the
 * expected revision passes too. Measured in an issued packet: the template block carries the real id. A round that wrote no record
 * therefore had the template as its only candidate, and this function would have reported a "salvaged record" whose findings are
 * placeholders — worse than reporting none, because the gate would then be handed something it must refuse.
 *
 * The template's own signature is that its values are placeholders in angle brackets.
 */
describe('the brief template is not a record', () => {
    it('rejects a template that carries the round\'s real revision id', () => {
        const template = JSON.stringify({
            node: 'review', status: 'recorded', revisionId: 'revision-07880fc288c82d14',
            executedInFreshContext: true, contextNote: '<how this pass ran in a context that did not author the change>',
            briefSha256: '<the hash reported by the brief command>',
            hypotheses: [{ id: 'h1', claim: '<what you asserted was false>', targets: ['<acceptance id or changed path>'], method: 'mutation | source-read' }],
            attempts: [{ hypothesis: '<what you tried to show was false>', method: '<what you did>' }],
            findings: [{ id: '<stable id>', taskId: 'x', severity: 'blocking | major | minor | nit', message: '<the defect and how you confirmed it>' }],
        });
        // With no expected revision it must still refuse; with the matching one it must refuse too — the id proves nothing.
        expect(salvageRecord(`Here is the record:\n${template}`)).toBeNull();
        expect(salvageRecord(`Here is the record:\n${template}`, { revisionId: 'revision-07880fc288c82d14' })).toBeNull();
    });
});

/**
 * **The last record in a transcript wins, not the longest** — `r7-f-salvage-jsonl`.
 *
 * The brief instructs a pass to emit an early record and then a more complete one, and says the last is the record. `salvageFromText`
 * implements that; `salvageFromJsonl` — the channel the module calls the real input — sorted the extracted strings by length and
 * returned the first hit, so a transcript holding two records returned whichever was longer. The falsifier is a transcript where the
 * **later** record is **shorter**: with the rule implemented, the later one is returned; with length ordering, the earlier one is.
 */
describe('salvage takes the last record, not the longest', () => {
    it('prefers the later, smaller record over an earlier, larger one', () => {
        const early = JSON.stringify({
            node: 'review', status: 'recorded', revisionId: 'revision-aaaaaaaaaaaaaaaa',
            hypotheses: [{ id: 'h1', claim: 'a'.repeat(400), targets: ['AC-1'], method: 'source-read', outcome: 'confirmed' }],
            attempts: [{ hypothesis: 'x'.repeat(300), method: 'm', outcome: 'confirmed', evidence: 'e'.repeat(300) }],
            findings: [{ id: 'early-finding', taskId: 't', severity: 'major', message: 'the first pass reported this', path: 'src/a.ts' }],
        });
        const late = JSON.stringify({
            node: 'review', status: 'recorded', revisionId: 'revision-aaaaaaaaaaaaaaaa',
            hypotheses: [{ id: 'h1', claim: 'short', targets: ['AC-1'], method: 'source-read', outcome: 'confirmed' }],
            attempts: [{ hypothesis: 'h', method: 'm', outcome: 'confirmed', evidence: 'the later pass re-ran the check' }],
            findings: [{ id: 'late-finding', taskId: 't', severity: 'major', message: 'the later pass reported this', path: 'src/a.ts' }],
        });
        const transcript = [
            JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: `Early record:\n${early}` }] } }),
            JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: `Final record:\n${late}` }] } }),
        ].join('\n');
        const found = salvageFromJsonl(transcript, { revisionId: 'revision-aaaaaaaaaaaaaaaa' });
        // The later message is smaller and must win: length is not the rule, position is.
        expect(JSON.stringify(found)).toContain('late-finding');
        expect(JSON.stringify(found)).not.toContain('early-finding');
    });
});
