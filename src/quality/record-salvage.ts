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
 * The class is the fifth, and it is not any of the four: it is not one concept derived twice, not a declaration read as
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
export function salvageRecord(
    transcript: string,
    /**
     * The brief the round was issued: a transcript holds the brief's own history, which includes **complete records of earlier
     * rounds** — measured: a live transcript's longest record-shaped object was the round-4 record quoted inside the brief, so a
     * salvage that returns "the biggest record" returns a round that is not the one being salvaged. Matching the identity is what
     * the gate does before accepting a record, so it is what this must do before reporting one.
     */
    expected?: { readonly revisionId?: string; readonly briefSha256?: string },
): SalvagedRecord | null {
    // **A transcript is JSONL, so a record inside it is a JSON string inside JSON** — its quotes are `\"`. Scanning the raw text
    // finds braces whose string tracking is wrong from the first escaped quote, and matching fails: measured on the round whose
    // record *was* in the transcript and which this function reported as having none. So a JSONL transcript is parsed first and
    // each message's text is scanned where its quotes are ordinary again. The fix for the fifth class failed on the real input
    // format, which is the fifth class itself.
    // **Both channels**: a JSONL transcript where the record is a JSON string inside JSON, and a plain transcript where its
    // quotes are ordinary. Falling back rather than choosing keeps the caller from having to know which it has — which is what
    // the function is for.
    return salvageFromJsonl(transcript, expected) ?? salvageFromText(transcript, expected);
}

/**
 * Brace-scanning for a plain transcript, where a record's quotes are ordinary characters.
 *
 * Kept for the case the JSONL parse cannot serve, and used by `salvageFromJsonl` on each extracted message text.
 */
function salvageFromText(transcript: string, expected?: { readonly revisionId?: string; readonly briefSha256?: string }): SalvagedRecord | null {
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
            // **A record is a record, not merely an object with two arrays.** Requiring only `hypotheses` and `findings` made
            // this match a schema example or a test fixture quoted in the transcript: measured against a live round it returned a
            // hit with no `revisionId` and no findings, which is worse than returning none — a salvaged "record" the gate would
            // refuse anyway, with the round's real output discarded behind it. The fields a recorded pass always writes are the
            // test.
            const matchesTheBrief = matches(parsed, expected);
            const looksLikeARecord = matchesTheBrief &&
                Array.isArray(parsed.hypotheses) &&
                Array.isArray(parsed.findings) &&
                typeof parsed.revisionId === 'string' &&
                parsed.revisionId.length > 0 &&
                (parsed.status === 'recorded' || parsed.status === 'waived') &&
                typeof parsed.node === 'string' &&
                /^revision-[0-9a-f]{8,}$/.test(String(parsed.revisionId)) &&
                // **Not the brief's own template** (`rba11-f2`, and my earlier comment here was false). Every transcript holds
                // the template the brief hands a pass — and `adversarial.ts` **interpolates the real revision id into it**, so
                // the template's `node`, `status`, `revisionId` and its two arrays all satisfy a shape test, and `matches()`
                // passes too. Measured in the issued packet: line 636 carries the real id inside the template block. The
                // template's own signature is that its values are **placeholders in angle brackets**, and a real record never
                // carries `<…>` in place of a hypothesis's method or a finding's id.
                // **Narrow enough not to drop a real record** (`rba12-f3`): testing the first 6000 characters of the whole serialised
                // record for any angle-bracketed token excluded a record whose *own content* quotes one — a finding message about the
                // template, or an observation naming `<something>`. The template's signature is narrower than that: its values are
                // placeholders, so what identifies it is an angle-bracketed token **as a value**, in the fields the template fills
                // with prose. Measured on a real round: its template has `<what you asserted was false>` in `hypotheses[].claim`.
                !templatePlaceholder(parsed);
            if (looksLikeARecord) candidates.push({ record: parsed, at: start });
        } catch {
            // Not JSON from this brace; the next one may be.
        }
    }
    if (candidates.length === 0) return null;
    const best = candidates[candidates.length - 1] as { record: Record<string, unknown>; at: number };
    return { record: best.record, fromEnd: transcript.length - best.at };
}

/** The longest string value in a parsed transcript, scanned for a record — the text a pass actually wrote. */
export function salvageFromJsonl(transcript: string, expected?: { readonly revisionId?: string; readonly briefSha256?: string }): SalvagedRecord | null {
    const texts: string[] = [];
    let parsedAny = false;
    for (const line of transcript.split('\n')) {
        if (!line.trim()) continue;
        try {
            const parsed = JSON.parse(line) as unknown;
            parsedAny = true;
            collectStrings(parsed, texts);
        } catch {
            // Not a JSONL line; the raw scan handles a plain transcript.
        }
    }
    if (!parsedAny) return null;
    // **Last, not longest** (`r7-f-salvage-jsonl`, and the docstring above states the rule the code did not follow). This sorted by
    // length and returned the first hit, so a transcript holding two records — which is exactly the shape the brief asks for, an
    // early one and a later, more complete one — returned whichever happened to be longer, and the brief's own instruction ("the
    // last record you emit is the record") was contradicted by the channel the module calls the real input.
    //
    // The cost the old comment was avoiding is real: a multi-megabyte transcript should not be walked string by string. So the
    // strings are still length-filtered for the expensive parse, but the **result is chosen by position**: every candidate is
    // collected and the latest one wins, because that is the rule.
    // **Length decides nothing about candidacy** (`rba-r3-f2`). This collected only strings over 200 characters and scanned the 400
    // longest, so a record's candidacy depended on how much prose surrounded it — and on the transcript shape the module exists for (a
    // pass that wrote a short record and a long analysis) a real record could be excluded while a longer non-record was examined. The
    // filter is a *cost* one and stays, but the scan is over every string above the floor, and the winner is by position.
    const byPosition = [...texts].map((text, index) => ({ text, index }));
    const candidates: Array<{ found: NonNullable<ReturnType<typeof salvageFromText>>; index: number }> = [];
    for (const { text, index } of byPosition) {
        const found = salvageFromText(text, expected);
        if (found) candidates.push({ found, index });
    }
    if (candidates.length === 0) return null;
    return candidates.sort((a, b) => b.index - a.index)[0].found;
}

/**
 * Whether an object is the brief's own **template** rather than a record a pass wrote.
 *
 * The template's values are placeholders in angle brackets, and the fields that carry them are the ones a pass fills with prose. Testing
 * the whole serialised record for `/<[a-z][^>]*>/` was too broad (`rba12-f3`): a record quoting one of those placeholders — a finding
 * about the template, an observation naming `<something>` — was excluded, and an excluded real record is worse than a salvaged template.
 */
function templatePlaceholder(parsed: Record<string, unknown>): boolean {
    const value = (v: unknown): boolean => typeof v === 'string' && /^<[^>]+>$/.test(v.trim());
    const hypotheses = (parsed.hypotheses ?? []) as Array<Record<string, unknown>>;
    const attempts = (parsed.attempts ?? []) as Array<Record<string, unknown>>;
    const findings = (parsed.findings ?? []) as Array<Record<string, unknown>>;
    // The template's own fields, and the shape a pass never produces: every one of them a bare placeholder.
    const probe = [hypotheses[0]?.claim, hypotheses[0]?.method, attempts[0]?.method, findings[0]?.message, parsed.contextNote, parsed.briefSha256];
    return probe.filter((v) => v !== undefined).some(value);
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
    if (depth > 12) return;
    if (typeof value === 'string') {
        if (value.length > 200) out.push(value);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectStrings(item, out, depth + 1);
        return;
    }
    if (value && typeof value === 'object') {
        for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out, depth + 1);
    }
}

/** Whether a record answers the brief in hand. Both values when known, one when only one is, and anything when neither is. */
function matches(record: Record<string, unknown>, expected?: { readonly revisionId?: string; readonly briefSha256?: string }): boolean {
    if (!expected) return true;
    if (expected.revisionId && record.revisionId !== expected.revisionId) return false;
    if (expected.briefSha256 && record.briefSha256 !== expected.briefSha256) return false;
    return true;
}
