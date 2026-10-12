import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * **The consumer inventory for "what a declaration covers" — one question, every reader named.**
 *
 * `declaredContentPaths` answers two things at once: which content a declaration covers (`.paths`) and which declarations
 * cannot be read (`.unreadable`, in the *canonical* spelling it normalised them to). That pair is the shape of the defect
 * class this change exists to remove. An independent round found `ledgerTierForDeclaredPaths` keeping only `.paths`, so a
 * declared path the moment it became unreadable stopped contributing a risk floor — `ledger plan` refused the declaration by
 * name while `ledger decide` published one reviewer instead of the security floor's two (R5-F1); the next round found the
 * repair rebuilding that union from the *recorded* spelling while the canonical name sat unused in `.unreadable`, so the
 * asymmetry survived for a `./`-prefixed declaration (R6-F1).
 *
 * So this case is the inventory. It does not test behaviour — each consumer's behaviour is pinned by its own selector
 * (`one-tier-derivation.test.ts` for the resolver, `review-request-preserves-its-named-facts.test.ts` for the request path,
 * the ledger's own cases for the freeze refusal). It asserts what no behavioural case can: that **every** reader of the walk
 * appears below with a stated answer, so a new one cannot be added without deciding what it does with a declaration it
 * cannot read.
 *
 * **Boundary (written down rather than claimed).** The scan reads *this file's own* `import`/`export … from` statements
 * naming the module, so a named import, an aliased import and a namespace import are all seen. Three shapes are beyond any
 * per-file scan and are therefore stated rather than implied: a **transitive** re-export (the file imports the name from an
 * intermediate module, not from `repository-identity`), a **dynamic** property access
 * (`module['declaredContentPaths'](…)`), and a binding stored in a variable. Those are caught only by a reviewer reading the
 * diff — which is why the case below asserts what the scan can see instead of claiming completeness.
 */
const ROOT = process.cwd();

/** Every module that reaches `declaredContentPaths`, and what that reader does with a declaration it cannot read. */
const CONSUMERS: Record<string, { reads: 'refuses-on-unreadable' | 'classifies-the-union' | 'paths-only'; why: string }> = {
    'src/store/ledger.ts': {
        reads: 'refuses-on-unreadable',
        why: 'The freeze path asks `declaredContentPaths` for readability and refuses the whole declaration by name when any part of it cannot be read, so a sentinel can never be recorded as content.',
    },
    'src/store/verdict.ts': {
        reads: 'classifies-the-union',
        why: 'The tier resolver classifies everything the walk accounted for — the covered content, the canonical names it could not read, and the canonical names it calls never content — so a declared path cannot vanish from the surface by becoming unreadable, and a name the policy does not recognise contributes no match (R5-F1, R6-F1).',
    },
    'src/quality/defect-classes.ts': {
        reads: 'paths-only',
        why: "The instrument coverage rule asks whether the covered content contains a generator. It reads `.paths` only, so a generator inside a declared path that cannot be read is reported as outside the declared surface — a deficit, never a pass, though the reason text calls the surface incomplete rather than unreadable.",
    },
    'src/quality/undeclared-changes.ts': {
        reads: 'paths-only',
        why: "The seal's undeclared-content reading asks two questions: is this path named by the declaration (answered from the declaration itself), and does the walk cover it (answered from `.paths`). Dropping `.unreadable` is sound here because the named half already covers an unreadable declaration by name — a declaration that cannot be read still declares its own path.",
    },
};

/** Local names bound to `declaredContentPaths` by this file's own imports, aliases and namespaces included. */
function importedNames(text: string): string[] {
    const names: string[] = [];
    // Both statements that can bind the name from this module: an import, and a re-export of it.
    for (const match of text.matchAll(/(?:import|export)\s+(?:type\s+)?([^'"]+?)\s+from\s+['"]([^'"]*repository-identity[^'"]*)['"]/g)) {
        const clause = match[1];
        const braced = clause.match(/\{([^}]*)\}/);
        if (braced) {
            for (const part of braced[1].split(',')) {
                const [original, alias] = part.trim().split(/\s+as\s+/).map((piece) => piece?.trim());
                if (original === 'declaredContentPaths') names.push(alias ?? original);
            }
        }
        const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
        if (namespace) names.push(`${namespace[1]}.declaredContentPaths`);
    }
    return names;
}

function sourceFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) sourceFiles(path, found);
        else if (entry.endsWith('.ts')) found.push(path);
    }
    return found;
}

describe('every reader of the declared surface says what it does with an unreadable declaration', () => {
    it('lists exactly the modules that reach declaredContentPaths, each with a stated answer', () => {
        const callers = sourceFiles(join(ROOT, 'src'))
            .filter((path) => {
                const text = readFileSync(path, 'utf8');
                return importedNames(text).some((name) => text.includes(`${name}(`)) || text.includes('declaredContentPaths(');
            })
            // The function's own module defines it; it is not a consumer of its own two halves.
            .filter((path) => relative(ROOT, path) !== 'src/core/repository-identity.ts')
            .map((path) => relative(ROOT, path))
            .sort();

        expect(
            callers,
            'a new reader of the declared surface must be added to CONSUMERS with what it does with `.unreadable`',
        ).toEqual(Object.keys(CONSUMERS).sort());
    });

    it('sees an aliased import and a namespace import, not only the literal name', () => {
        // The first version scanned for the literal `declaredContentPaths(`, so `import { declaredContentPaths as dcp }`
        // and `import * as identity` were invisible and its completeness claim was false (measured by an independent round,
        // R6-F4). These two shapes are the ones a static scan can fix; a dynamic property access is beyond any of them.
        expect(importedNames("import { declaredContentPaths } from '../core/repository-identity.js';")).toEqual(['declaredContentPaths']);
        expect(importedNames("import { declaredContentPaths as dcp } from '../core/repository-identity.js';")).toEqual(['dcp']);
        expect(importedNames("import * as identity from '../core/repository-identity.js';")).toEqual(['identity.declaredContentPaths']);
        expect(importedNames("import { isIgnoredRepositoryPath } from '../core/repository-identity.js';")).toEqual([]);
        // A re-export binds the name just as an import does, and the first version of this scan missed it while its own doc
        // claimed it was seen (measured by an independent round, R7-F3).
        expect(importedNames("export { declaredContentPaths } from '../core/repository-identity.js';")).toEqual(['declaredContentPaths']);
        expect(importedNames("export { declaredContentPaths as passthrough } from '../core/repository-identity.js';")).toEqual(['passthrough']);
    });

    it('requires an answer that is one of the three recorded shapes, and a reason', () => {
        for (const [path, entry] of Object.entries(CONSUMERS)) {
            expect(['refuses-on-unreadable', 'classifies-the-union', 'paths-only']).toContain(entry.reads);
            expect(entry.why.length, `${path} must say why this answer is right`).toBeGreaterThan(40);
        }
    });

    it('keeps the resolver in the union shape, so nothing accounted for can disappear', () => {
        // The one entry whose answer is load-bearing for a gate: reading `.paths` alone lets a declared path that becomes
        // unreadable stop contributing a risk floor (R5-F1), and rebuilding the union from the *recorded* spelling instead
        // of the walk's canonical one leaves that hole open for a `./`-prefixed declaration (R6-F1).
        expect(CONSUMERS['src/store/verdict.ts']?.reads).toBe('classifies-the-union');
        const resolver = readFileSync(join(ROOT, 'src/store/verdict.ts'), 'utf8');
        expect(resolver).toContain('new Set([...covered.paths, ...covered.unreadable, ...covered.neverContent])');
    });
});
