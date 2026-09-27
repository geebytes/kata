import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { wikiEnrichPacketPath } from '../core/layout.js';
import type { LlmWikiTaskPacket } from './llmwiki.js';

/**
 * **The enrichment packet's only writer.**
 *
 * It was written from two places — `install` (`src/adapters/ownership.ts`) and the wiki rebuild
 * (`src/wiki/llmwiki.ts`) — each constructing the path itself, into a directory in the governed task store named after a
 * task that does not exist. Three things were wrong with that and this function is the answer to all three: one path
 * construction (so the two callers cannot drift), outside the store (so enumerating the store enumerates tasks), and
 * written atomically (so a crash cannot leave a half-written packet where the next reader would parse it).
 *
 * It takes the packet rather than building it, because `buildLlmWikiTask` lives in `llmwiki.ts` and this module is
 * imported by it: building here would make the two import each other, and a circular import is legal to the type checker
 * and fatal at load — a trap this line has already paid for once.
 */
export interface WriteWikiEnrichPacketInput {
    root: string;
    packet: LlmWikiTaskPacket;
}

export async function writeWikiEnrichPacket(input: WriteWikiEnrichPacketInput): Promise<{ path: string }> {
    const root = resolve(input.root);
    const target = wikiEnrichPacketPath(root);
    await mkdir(dirname(target), { recursive: true });

    // Replace, never truncate in place: a reader that opens this file while a write is part-way through would otherwise
    // parse a fragment, and this file's whole purpose is to be read by whoever the packet is addressed to.
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(input.packet, null, 2)}\n`, 'utf8');
    await rename(temporary, target);

    return { path: relative(root, target) };
}
