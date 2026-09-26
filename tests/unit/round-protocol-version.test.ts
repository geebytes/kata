import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createRoundParser, ROUND_EVENT_KINDS, ROUND_PROTOCOL_VERSION } from '../../src/quality/round-protocol.js';
import { validate } from '../../src/core/schema.js';

/**
 * **The protocol has one versioned definition** — criterion AC-4.
 *
 * One schema with a unique `$id`, whose event kinds are the code's, and a host that speaks another version is refused by name rather than
 * guessed at. The parser's other refusals are here too, because they are the same question: whether a stream describes a round at all.
 */

const feed = (text: string, options: Parameters<typeof createRoundParser>[0] = {}) => {
    const parser = createRoundParser(options);
    parser.feed(text);
    return parser.parse();
};

describe('the protocol is one versioned definition', () => {
    it('accepts a stream whose first line launches and whose last describes an ending', () => {
        const parsed = feed(`${JSON.stringify({ kind: 'launched', protocol: ROUND_PROTOCOL_VERSION, capabilities: ['fresh_context'] })}\n`
            + `${JSON.stringify({ kind: 'tool_call', tool: 'read' })}\n`
            + `${JSON.stringify({ kind: 'result', text: '{}' })}\n`
            + `${JSON.stringify({ kind: 'ended', status: 'completed' })}\n`);
        expect(parsed.refusal).toBeNull();
        expect(parsed.events.map((event) => event.kind)).toEqual(['launched', 'tool_call', 'result', 'ended']);
    });
    it('refuses a stream whose first line is not `launched`, naming the line', () => {
        const parsed = feed(`${JSON.stringify({ kind: 'tool_call', tool: 'read' })}\n`);
        expect(parsed.refusal?.detail).toContain('the first line was `tool_call`, not `launched`');
        expect(parsed.refusal?.line).toBe(1);
    });
    it('refuses a host that speaks another protocol, and says which it speaks', () => {
        const parsed = feed(`${JSON.stringify({ kind: 'launched', protocol: 99, capabilities: [] })}\n`);
        expect(parsed.refusal?.detail).toContain('this host speaks protocol 99, kata speaks 1');
    });
    it('refuses a line that is not a protocol event, naming the line and quoting it', () => {
        const parsed = feed(`${JSON.stringify({ kind: 'launched', protocol: ROUND_PROTOCOL_VERSION, capabilities: [] })}\nnot json at all\n`);
        expect(parsed.refusal?.line).toBe(2);
        expect(parsed.refusal?.detail).toContain('is not JSON');
    });
    it('refuses an event after `ended`, because the stream is over', () => {
        const parsed = feed(`${JSON.stringify({ kind: 'launched', protocol: ROUND_PROTOCOL_VERSION, capabilities: [] })}\n`
            + `${JSON.stringify({ kind: 'ended', status: 'completed' })}\n`
            + `${JSON.stringify({ kind: 'output', bytes: 1 })}\n`);
        expect(parsed.refusal?.detail).toContain('followed `ended`');
    });
    it('treats a line split across two chunks as one event', () => {
        const parser = createRoundParser();
        const line = `${JSON.stringify({ kind: 'launched', protocol: ROUND_PROTOCOL_VERSION, capabilities: ['fresh_context'] })}\n`;
        parser.feed(line.slice(0, 20));
        parser.feed(line.slice(20));
        const parsed = parser.parse();
        expect(parsed.refusal).toBeNull();
        expect(parsed.events).toHaveLength(1);
    });
    it('refuses a line past the byte bound rather than buffering a host out of memory', () => {
        // 32 MB in production; the bound is a parameter so the rule is testable without allocating it here.
        const parsed = feed(`${JSON.stringify({ kind: 'launched', protocol: ROUND_PROTOCOL_VERSION, capabilities: [] })}\n${'x'.repeat(50)}\n`, { maxLineBytes: 40 });
        expect(parsed.refusal).not.toBeNull();
        expect(parsed.refusal?.detail).toContain('the 40-byte bound');
    });
    it('is registered, so the definition ships and is applied where it is claimed', () => {
        // **Registered, not merely well-formed.** The first version of this case checked `$id` truthiness and the `kind` enum, and
        // `round-events` was in no bundle list and no registration table — so the "bundled schema" this criterion promises did not ship, and
        // two guards (`every-bundled-schema-has-an-id`) passed because neither walks file → registered. `validate` is that walk.
        expect(() => validate('round-events', { kind: 'ended', status: 'completed' })).not.toThrow();
        expect(() => validate('round-events', { kind: 'ended' })).toThrow();
        expect(() => validate('round-events', { kind: 'launched', protocol: 1, capabilities: ['telepathy'] })).toThrow();
    });

    it('declares every event kind the schema names, and no kind the schema does not', async () => {
        const schema = JSON.parse(await readFile('schemas/round-events.schema.json', 'utf8')) as {
            $id?: string;
            properties: { kind: { enum: string[] } };
        };
        expect(schema.$id, 'a bundled schema without an $id cannot be registered or looked up').toBeTruthy();
        expect([...schema.properties.kind.enum].sort()).toEqual([...ROUND_EVENT_KINDS].sort());
    });
});
