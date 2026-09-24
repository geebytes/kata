import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every bundled schema carries a `$id`, and the module that compiles them reads the ids.
 *
 * **This is the class, not an instance.** `review.schema.json`'s `findings.items` and `review-finding.schema.json` were two
 * definitions of one concept that disagreed in four fields, and the disagreement let a single routed finding block `findings add`
 * permanently — a change could not record a finding at all. The fix was to make one definition a `$ref` to the other, and that
 * needed `compile()` to resolve by `$id`; four schemas had no `$id` at all, so registration skipped them and the lookup failed
 * with "Schema repair-batch is not registered by an $id".
 *
 * A rule enforced per instance is a rule that gets rediscovered. This asks the question of the whole directory, so the next schema
 * added without an `$id` fails here rather than in whichever command happens to read it first.
 */
describe('the schema layer holds together as a set', () => {
    const schemasDir = join(import.meta.dirname, '..', '..', 'schemas');
    const files = readdirSync(schemasDir).filter((file) => file.endsWith('.json'));

    it('gives every schema a unique $id', () => {
        const ids = new Map<string, string>();
        const missing: string[] = [];
        for (const file of files) {
            const parsed = JSON.parse(readFileSync(join(schemasDir, file), 'utf8')) as { $id?: string };
            if (!parsed.$id) {
                missing.push(file);
                continue;
            }
            const previous = ids.get(parsed.$id);
            // A duplicate `$id` is what made Ajv raise "schema with key or id already exists" during registration.
            expect(previous, `duplicate $id: ${parsed.$id} in ${file} and ${String(previous)}`).toBeUndefined();
            ids.set(parsed.$id, file);
        }
        expect(missing, `schemas without an $id: ${missing.join(', ')}`).toEqual([]);
        // And the count is asserted, so the directory cannot be emptied to make this pass.
        expect(files.length).toBeGreaterThan(10);
    });

    it('names the compiled schemas by names the registry carries', () => {
        // `compile()` looks each schema up by `$id` now, so a name in `schemaText` that has no `$id` would throw at read time
        // rather than at import. This checks the two halves agree.
        const source = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'core', 'schema.ts'), 'utf8');
        const registry = source.match(/const schemaText: Record<string, string> = \{([\s\S]*?)\n\};/);
        expect(registry).not.toBeNull();
        const names = [...(registry?.[1] ?? '').matchAll(/^\s*'?([a-z0-9-]+)'?:/gm)].map((match) => match[1]);
        expect(names.length).toBeGreaterThan(10);
        // Every registered name must correspond to a file, or the import would fail before any of this runs.
        const byBase = new Set(files.map((file) => file.replace(/\.schema\.json$/, '')));
        const unbacked = names.filter((name) => !byBase.has(name));
        expect(unbacked, `registered names with no schema file: ${unbacked.join(', ')}`).toEqual([]);
    });
});
