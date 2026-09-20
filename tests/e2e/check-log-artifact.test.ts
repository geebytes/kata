import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { defaultWorkflowProfile } from '../../src/core/workflow-profile.js';
import { runCommand } from '../../src/workflow/orchestrator.js';

/**
 * The transcript a truncated check points at has to exist, on a task's **first** seal too.
 *
 * The seal hands every check a log directory and the collector stamps the envelope with the artifact path when the
 * capture was bounded. The directory used to be created inside `writeEvidence`, which runs after the checks, so a first
 * seal wrote into a directory that was not there; `runProcess`'s tee discarded the ENOENT, and the envelope named a
 * file that did not exist. The evidence directory existing is the runtime's job (its `mkdir` before collecting); never
 * naming a file that is not there is the collector's.
 */
describe('the bounded check transcript', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    /** 3 MB of stdout, well past the 2 MB capture bound. */
    const noisy = "process.stdout.write('z'.repeat(3 * 1024 * 1024));\n";
    const threeMegabytes = 3 * 1024 * 1024;

    it('is written and complete on a task whose evidence directory does not exist yet', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-check-log-'));
        roots.push(root);
        await initLayout(root);
        await writeFile(join(root, 'noisy.mjs'), noisy, 'utf8');
        await writeFile(join(root, 'fixture.txt'), 'sealed implementation\n', 'utf8');
        await createTask({
            root,
            id: 'noisy-task',
            title: 'Noisy check',
            acceptance: [{ id: 'AC-1', statement: 'A check whose output exceeds the capture bound seals.' }],
            workflowProfile: defaultWorkflowProfile(),
        });
        await runCommand('design', 'noisy-task', root);
        // Reproduce the first-seal state: nothing has created the evidence directory for this task's checks yet.
        await rm(join(root, '.kata/evidence'), { recursive: true, force: true });
        await expect(stat(join(root, '.kata/evidence'))).rejects.toThrow();

        const sealed = await runCommand('build', 'noisy-task', root, {
            ownedPaths: ['fixture.txt'],
            checks: [{ kind: 'test', id: 'noisy', command: process.execPath, args: [join(root, 'noisy.mjs')], cwd: root }],
        });

        expect(sealed.success).toBe(true);
        const evidenceDir = join(root, '.kata/evidence');
        const entries = await readdir(evidenceDir);
        const logFile = entries.find((entry) => entry.endsWith('.log'));
        expect(logFile).toBeDefined();
        // The whole transcript, not the head/tail excerpt the envelope carries.
        expect((await stat(join(evidenceDir, logFile!))).size).toBe(threeMegabytes);

        // And the envelope's own pointer resolves — the property a reader relies on.
        const envelopeFile = entries.find((entry) => entry.endsWith('.json'));
        const envelope = JSON.parse(await readFile(join(evidenceDir, envelopeFile!), 'utf8')) as {
            logTruncated?: boolean;
            logArtifact?: string;
            logArtifactFailure?: string;
            exitCode?: number;
            passed?: boolean;
        };
        expect(envelope.logTruncated).toBe(true);
        expect(envelope.logArtifact).toBeTruthy();
        expect(envelope.logArtifactFailure).toBeUndefined();
        await expect(stat(envelope.logArtifact!)).resolves.toBeDefined();
        // The diagnostic channel does not move the verdict.
        expect(envelope.exitCode).toBe(0);
        expect(envelope.passed).toBe(true);
    });
});
