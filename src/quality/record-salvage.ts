/**
 * Salvaging a record from a round that never sent one — the second channel for a required output.
 *
 * **The class, measured three times.** A review brief requires one thing above all: a complete JSON record as the pass's final
 * message. That is a **required output whose only channel is the process reaching its natural end**, so a pass that investigates
 * until its budget runs out satisfies every other requirement and loses the record — and loses the coverage and the field values
 * with it, because they lived in the message. Three of six dispatched rounds died that way, each with the same last sentence
 * ("I already know the answer; let me confirm it"), and one of them had found a route the design had never enumerated, which
 * survived only because a human read four megabytes of transcript.
 *
 * **The fix is not to make passes shorter.** It is to give the output a second channel: the transcript *is* a channel, and a record
 * emitted at any point in it is still a record. So the brief now tells a pass to emit its findings as soon as it has them and keep
 * working — the last record it sends is the record — and this module reads the last one back out.
 *
 * The class is not any of the four the change already names: it is not one concept derived twice, not a declaration read as
 * reality, not a check that cannot fail, and not a decision with two entrances. It is **a producer whose output has exactly one
 * unguaranteed channel**, and the fix has the same shape as every other class's: give the thing a consumer, and give the output a
 * second way out.
 */
export interface SalvagedRecord {
    /** The parsed record, as the pass wrote it. */
    readonly record: Record<string, unknown>;
    /** Where in the transcript it appeared, from the end, so a reader can judge how late it was. */
    readonly fromEnd: number;
}

/**
 * The last complete JSON record in a transcript, or null when the transcript holds none.
 *
 * **Last, not first**, because a pass that emits early and refines has its refinement at the end — and because a pass that emits
 * early and then finds more writes the fuller record later. Scanning backwards costs nothing and matches the instruction the brief
 * now gives.
 */
export function salvageRecord(transcript: string): SalvagedRecord | null {
    // A record is recognised by a field only a record has: `hypotheses` (review) or `attempts` (either), beside `findings`. A
    // prose message that happens to contain braces is not a record, and treating it as one would be worse than finding none.
    const candidates: Array<{ record: Record<string, unknown>; at: number }> = [];
    for (let start = transcript.indexOf('{'); start !== -1; start = transcript.indexOf('{', start + 1)) {
        // Try progressively shorter spans from this brace: a JSON object inside prose is found by matching braces.
        const depth = ((): number => {
            let level = 0;
            let inString = false;
            let escaped = false;
            for (let i = start; i < transcript.length; i++) {
                const char = transcript[i] as string;
                if (escaped) { escaped = false; continue; }
                if (char === '\\') { escaped = true; continue; }
                if (char === '"') { inString = !inString; continue; }
                if (inString) continue;
                if (char === '{') level++;
                else if (char === '}') {
                    level--;
                    if (level === 0) return i;
                }
            }
            return -1;
        })();
        if (depth === -1) continue;
        const span = transcript.slice(start, depth + 1);
        try {
            const parsed = JSON.parse(span) as Record<string, unknown>;
            const looksLikeARecord = Array.isArray(parsed.hypotheses) && Array.isArray(parsed.findings);
            if (looksLikeARecord) candidates.push({ record: parsed, at: start });
        } catch {
            // Not JSON from this brace; the next one may be.
        }
    }
    if (candidates.length === 0) return null;
    const best = candidates[candidates.length - 1] as { record: Record<string, unknown>; at: number };
    return { record: best.record, fromEnd: transcript.length - best.at };
}
