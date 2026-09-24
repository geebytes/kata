import { describe, expect, it } from 'vitest';
import { salvageRecord } from '../../src/quality/record-salvage.js';

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
