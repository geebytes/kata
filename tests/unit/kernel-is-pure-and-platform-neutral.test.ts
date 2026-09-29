import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/kernel/decide.js';
import { KERNEL_ALLOWED_BUILTINS, KERNEL_BANNED_BUILTINS } from '../../src/kernel/subject.js';
import { makeClaim, makeEvidence, makePolicy, makeSubject, makeVerdict } from '../helpers/review.js';

/**
 * **The kernel is the one thing every platform must implement together, so what it may touch is not a style question.**
 *
 * Two checks that are cheap and that catch a real drift: the source may not import an I/O builtin, and it may not name a
 * platform. The first is a text check on today's files; the substantive one — that two different adapters reach the same
 * decision — lives in `kernel-two-adapters-reach-the-same-decision.test.ts`.
 */
const KERNEL_DIR = join(process.cwd(), 'src/kernel');
const KERNEL_FILES = readdirSync(KERNEL_DIR).filter((name) => name.endsWith('.ts'));
const PLATFORM_WORDS = ['claude', 'opencode', 'litellm', 'deepseek', 'subagent', 'session', 'receipt', 'fresh_context'];

/**
 * Comments are blanked before scanning, and only comments: the invariant is about code, and a comment may name a concept
 * precisely in order to say the kernel does not use it. Blanking keeps line structure, so a reported position still
 * points at the line it came from.
 */
function codeOnly(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//gu, (match) => match.replace(/[^\n]/gu, ' '))
        .replace(/\/\/[^\n]*/gu, (match) => ' '.repeat(match.length));
}

describe('the kernel is pure and platform-neutral', () => {
    it('reads sources at all', () => {
        expect(KERNEL_FILES.length).toBeGreaterThan(5);
    });

    it('imports no I/O builtin, and only the builtin that is a pure computation', () => {
        for (const file of KERNEL_FILES) {
            const source = codeOnly(readFileSync(join(KERNEL_DIR, file), 'utf8'));
            const specifiers = [...source.matchAll(/from '([^']+)'/gu)].map((match) => match[1] as string);
            for (const specifier of specifiers) {
                if (!specifier.startsWith('node:')) continue;
                expect(KERNEL_BANNED_BUILTINS, `src/kernel/${file} imports ${specifier}`).not.toContain(specifier);
                expect(KERNEL_ALLOWED_BUILTINS, `src/kernel/${file} imports ${specifier}`).toContain(specifier);
            }
            expect(source, `src/kernel/${file} uses process.env`).not.toMatch(/\bprocess\.env\b/u);
            expect(source, `src/kernel/${file} uses Math.random`).not.toMatch(/Math\.random/u);
            expect(source, `src/kernel/${file} reads the clock`).not.toMatch(/new Date\(\)|Date\.now\(\)/u);
        }
    });

    it('names no platform concept', () => {
        for (const file of KERNEL_FILES) {
            const source = codeOnly(readFileSync(join(KERNEL_DIR, file), 'utf8')).toLowerCase();
            for (const word of PLATFORM_WORDS) {
                const pattern = new RegExp(`\\b${word}\\b`, 'u');
                expect(pattern.test(source), `src/kernel/${file} names "${word}"`).toBe(false);
            }
        }
    });

    it('decides from data alone, the same way twice', () => {
        const subject = makeSubject({ 'src/a.ts': 'holds' });
        const input = {
            subject,
            claims: [makeClaim({ severity: 'major' as const })],
            evidence: [makeEvidence({})],
            verdicts: [makeVerdict({ subjectRevision: subject.revision })],
            challenges: [],
            policy: makePolicy(),
            tier: 'strict' as const,
            declaredRiskClasses: ['consistency' as const],
            touchedRiskClasses: ['consistency' as const],
            assurance: 'observed' as const,
            usage: { tokens: 10, wallMs: 10, toolCalls: 1 },
            discovery: { independentChallenges: 1, verifiedChallenges: 1 },
        };
        const first = decide(input);
        const second = decide(input);
        expect(first).toEqual(second);
        expect(first.verdict).toBe('pass');
        expect(first.reasons).toEqual([]);
    });
});
