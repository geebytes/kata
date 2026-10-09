import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { carriesSealMark, computePathDigests, sealDeclarationOf } from '../../src/workflow/revision.js';

/**
 * **AC-22 — the content-identity claim states its real enforcement boundary, and the guard rejects the mechanism it retired.**
 *
 * Two dishonesties to remove, one about words and one about a guard.
 *
 * The words: the claim about "what is content" was written as if it were universal, while its own guard can only enumerate
 * kinds a fixture carries — measured three rounds running, each time a filter keyed on a kind the fixture did not carry slid
 * past every selector. What the mechanism actually enforces is narrower and statable: **one derivation** (the ledger records
 * the map the seal produced, not a re-derivation of it), a **runtime** refusal that does not depend on knowing the kind, and
 * finite generators as *witnesses* of representative kinds — never a proof of traversal completeness. A claim that overstates
 * its enforcement is the same defect as a guard that does not enforce what it names.
 *
 * The guard: the retired mechanism was a **property** on the map (`Symbol.for('kata.seal.pathDigests')`), and the guard that
 * replaced it must reject the mechanism — any property-based mark, any exported constant a copy could reproduce — rather than
 * the one spelling that happened to be used. A guard keyed on a historical spelling would pass forever after somebody chose a
 * different symbol.
 */
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('the guard rejects the retired mechanism, not one spelling of it', () => {
    it('refuses every property-based mark, whatever symbol or key carries it', async () => {
        // The shapes a copy could carry: the retired `Symbol.for` constant, a locally invented symbol, a plain string key, a
        // non-enumerable property (what the first replacement used), and the prototype.
        const retired = Symbol.for('kata.seal.pathDigests');
        const invented = Symbol('kata.seal.pathDigests');
        const candidates: Array<Record<PropertyKey, unknown>> = [];
        for (const key of [retired, invented, 'kata.seal.pathDigests', '__kataSeal']) {
            const plain = { 'src/a.ts': 'hash' } as Record<PropertyKey, unknown>;
            plain[key] = true;
            candidates.push(plain);
            const hidden = { 'src/a.ts': 'hash' } as Record<PropertyKey, unknown>;
            Object.defineProperty(hidden, key, { value: true, enumerable: false });
            candidates.push(hidden);
        }
        const onPrototype = Object.create({ [retired]: true }) as Record<PropertyKey, unknown>;
        onPrototype['src/a.ts'] = 'hash';
        candidates.push(onPrototype);

        for (const candidate of candidates) {
            // **A property is not a registry entry.** Nothing a caller writes onto an object can reach the module-private
            // WeakSet, so every one of these is refused — and the refusal is by identity, not by inspecting what the object
            // says about itself.
            expect(carriesSealMark(candidate), `a property-based mark must not pass: ${String(Object.getOwnPropertySymbols(candidate)[0] ?? Object.keys(candidate).at(-1))}`).toBe(false);
            expect(sealDeclarationOf(candidate)).toBeUndefined();
        }
    });

    it('has no property-marking mechanism left in the module, in any spelling', async () => {
        const raw = await readFile(join(process.cwd(), 'src', 'workflow', 'revision.ts'), 'utf8');
        // **Code, not prose.** The file documents what was retired — a mention in a comment is documentation, and a guard that
        // forbade naming the mechanism would forbid explaining it. The same limit the repository's own wiring check states:
        // this is not a parser, and its failure direction is safe here because the assertions are about *absence*.
        const source = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

        // The mechanism, not the spelling: no global symbol register, no exported mark constant, no property written onto a
        // map to mark it, and no property read to recognise one. Each of these is what made the earlier guard defeatable by
        // choosing a different key.
        expect(source).not.toContain('Symbol.for');
        expect(source).not.toMatch(/defineProperty/);
        expect(source).not.toMatch(/export const .*[Mm]ark\s*=/);
        expect(source).not.toMatch(/\[\s*['"`][^'"`]*seal[^'"`]*['"`]\s*\]\s*=/i);
        // And the mechanism that replaced it is the registry the module keeps to itself.
        expect(source).toContain('new WeakSet<object>()');
        expect(source).toContain('new WeakMap<object, string>()');
    });

    it('keeps the register private: the map cannot be marked from outside', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-identity-boundary-'));
        roots.push(root);
        await initLayout(root);
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');

        const real = await computePathDigests(root, ['src/a.ts']);
        // The production map is marked; a copy of it is not, however faithfully it is rebuilt.
        expect(carriesSealMark(real)).toBe(true);
        const copy = Object.assign(Object.create(null) as Record<string, string>, real);
        expect(carriesSealMark(copy)).toBe(false);
        expect(Object.isFrozen(real)).toBe(true);
    });
});

describe('the claim about content identity states what it enforces', () => {
    it('writes its boundary where the mechanism is, not in a universal voice', async () => {
        const source = await readFile(join(process.cwd(), 'src', 'workflow', 'revision.ts'), 'utf8');
        const design = await readFile(join(process.cwd(), 'docs', 'design', '2026-10-09-unify-remaining-integrity-and-workflow-gaps.md'), 'utf8');

        // The mechanism's own file says what is enforced and what is only witnessed. In a change whose subject is "a claim
        // must not overstate its enforcement", the claim's file is the first place a reader looks.
        expect(source).toContain('does not enumerate');
        expect(source).toMatch(/witness|representative kinds/);
        // And the design states the boundary as a boundary: what finite generators prove, and what they do not.
        expect(design).toContain('AC-22');
        expect(design).toMatch(/witness/i);
    });
});
