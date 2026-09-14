import { describe, expect, it } from 'vitest';
import { findOrphanAcs, findRequirementsWithoutEvidence, validateUpstreamCoverage } from '../../src/quality/acceptance-matrix.js';

const acceptance = [
  { id: 'AC-1', statement: 'x' },
  { id: 'AC-2', statement: 'y' },
];

const matrix = {
  version: 1 as const,
  rows: [
    { acceptanceId: 'AC-1', implementationPaths: ['a'], testPaths: ['t'], evidence: [{ kind: 'test' as const, command: 'x' }], verificationLevel: 'unit' as const },
    { acceptanceId: 'AC-2', implementationPaths: ['b'], testPaths: ['t2'], evidence: [{ kind: 'test' as const, command: 'y' }], verificationLevel: 'unit' as const },
  ],
};

describe('validateUpstreamCoverage', () => {
  it('accepts valid coverage with every requirement mapped or out-of-scope', () => {
    const errors = validateUpstreamCoverage(acceptance, matrix, {
      version: 1,
      sources: [
        {
          ref: 'docs/audit.md',
          requirements: [
            { id: 'R-1', statement: 'req one', mappedTo: 'AC-1' },
            { id: 'R-2', statement: 'req two', mappedTo: 'AC-2' },
            { id: 'R-3', statement: 'req three', outOfScopeReason: 'separate task', mappedTo: null },
          ],
        },
      ],
    });
    expect(errors).toEqual([]);
  });

  it('rejects a requirement that maps to neither an AC nor out-of-scope', () => {
    const errors = validateUpstreamCoverage(acceptance, matrix, {
      version: 1,
      sources: [{ ref: 'docs/audit.md', requirements: [{ id: 'R-1', statement: 'orphan' }] }],
    });
    expect(errors.some((e) => e.message.includes('map to an AC or declare outOfScopeReason'))).toBe(true);
  });

  it('rejects a requirement mapping to an unknown AC', () => {
    const errors = validateUpstreamCoverage(acceptance, matrix, {
      version: 1,
      sources: [{ ref: 'docs/audit.md', requirements: [{ id: 'R-1', statement: 'x', mappedTo: 'AC-99' }] }],
    });
    expect(errors.some((e) => e.message.includes('unknown AC'))).toBe(true);
  });

  it('rejects a requirement mapping to an AC with no matrix row', () => {
    const errors = validateUpstreamCoverage(acceptance, { version: 1, rows: [] }, {
      version: 1,
      sources: [{ ref: 'docs/audit.md', requirements: [{ id: 'R-1', statement: 'x', mappedTo: 'AC-1' }] }],
    });
    expect(errors.some((e) => e.message.includes('no matrix row'))).toBe(true);
  });

  it('returns empty for missing coverage (legacy task)', () => {
    expect(validateUpstreamCoverage(acceptance, matrix, undefined)).toEqual([]);
  });

  it('rejects unsupported version', () => {
    const errors = validateUpstreamCoverage(acceptance, matrix, { version: 2 as never, sources: [] });
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toContain('Unsupported');
  });

  it('rejects a source ref that does not exist when root is given', () => {
    const errors = validateUpstreamCoverage(acceptance, matrix, {
      version: 1,
      sources: [
        {
          ref: 'docs/nonexistent.md',
          requirements: [
            { id: 'R-1', statement: 'x', mappedTo: 'AC-1' },
            { id: 'R-2', statement: 'y', mappedTo: 'AC-2' },
          ],
        },
      ],
    }, process.cwd());
    expect(errors.some((e) => e.message.includes('does not exist'))).toBe(true);
  });

  it('accepts existing source refs when root is given', () => {
    const { mkdtempSync, writeFileSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const { join } = require('node:path');
    const root = mkdtempSync(join(tmpdir(), 'cov-root-'));
    writeFileSync(join(root, 'audit.md'), '# audit');
    const errors = validateUpstreamCoverage(acceptance, matrix, {
      version: 1,
      sources: [
        {
          ref: 'audit.md',
          requirements: [
            { id: 'R-1', statement: 'x', mappedTo: 'AC-1' },
            { id: 'R-2', statement: 'y', mappedTo: 'AC-2' },
          ],
        },
      ],
    }, root);
    expect(errors).toEqual([]);
  });

describe('findOrphanAcs', () => {
  it('returns ACs not justified by any requirement as warnings', () => {
    const orphans = findOrphanAcs(acceptance, {
      version: 1,
      sources: [{ ref: 'docs/a.md', requirements: [{ id: 'R-1', statement: 'x', mappedTo: 'AC-1' }] }],
    });
    expect(orphans.map((o) => o.acId)).toEqual(['AC-2']);
  });

  it('returns empty when all ACs are covered', () => {
    const orphans = findOrphanAcs(acceptance, {
      version: 1,
      sources: [{ ref: 'docs/a.md', requirements: [{ id: 'R-1', statement: 'x', mappedTo: 'AC-1' }, { id: 'R-2', statement: 'y', mappedTo: 'AC-2' }] }],
    });
    expect(orphans).toEqual([]);
  });
});

describe('findRequirementsWithoutEvidence', () => {
  it('returns requirements whose mapped AC has no passing evidence', () => {
    const missing = findRequirementsWithoutEvidence(
      {
        version: 1,
        sources: [{ ref: 'docs/a.md', requirements: [{ id: 'R-1', statement: 'x', mappedTo: 'AC-1' }, { id: 'R-2', statement: 'y', mappedTo: 'AC-2' }] }],
      },
      matrix,
      [{ id: 'e1', kind: 'test', command: 'x', exitCode: 0 }], // only AC-1 has evidence
    );
    expect(missing.map((m) => m.requirementId)).toEqual(['R-2']);
  });

  it('accepts when all mapped requirements have passing evidence', () => {
    const missing = findRequirementsWithoutEvidence(
      {
        version: 1,
        sources: [{ ref: 'docs/a.md', requirements: [{ id: 'R-1', statement: 'x', mappedTo: 'AC-1' }] }],
      },
      matrix,
      [{ id: 'e1', kind: 'test', command: 'x', exitCode: 0 }],
    );
    expect(missing).toEqual([]);
  });

  it('ignores out-of-scope requirements', () => {
    const missing = findRequirementsWithoutEvidence(
      {
        version: 1,
        sources: [{ ref: 'docs/a.md', requirements: [{ id: 'R-1', statement: 'oos', mappedTo: null, outOfScopeReason: 'later' }] }],
      },
      matrix,
      [],
    );
    expect(missing).toEqual([]);
  });
});
});
