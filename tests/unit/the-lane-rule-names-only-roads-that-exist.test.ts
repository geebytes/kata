import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { renderSkill, skillCommands, type Platform } from '../../src/adapters/manifest.js';

const PLATFORM: Platform = 'codex';
const projectRoot = process.cwd();

function render(id: string): string {
    const command = skillCommands.find((entry) => entry.id === id);
    expect(command, `${id} is a registered lane surface`).toBeDefined();
    return renderSkill(command!, PLATFORM, { language: 'en' });
}

describe('the lane rule names only roads the workflow exposes', () => {
    it.each(['kata-open', 'kata-hotfix', 'kata-tweak'])('%s classifies before open and gives a real input path', (id) => {
        const text = render(id);
        expect(text).toContain('--classification-file <path>');
        expect(text).toContain('Do not read kata-cli ledger plan before open');
        expect(text).toContain('at least strict');
        expect(text).toContain('classification.json');
        expect(text).toContain('path floor');
        expect(text).not.toMatch(/raising the lane is always allowed/i);
    });

    it('kata-design names the actual successor relation command, not an in-place lane edit', () => {
        const text = render('kata-design');
        expect(text).toContain('classification.json');
        expect(text).toContain('plan.risk');
        expect(text).toContain('tasks relate --from <old-task> --to <successor-task> --type merged_into');
        expect(text).not.toMatch(/raising the lane is always allowed/i);
    });

    it('the checked-in generated lane skills match the source renderer', async () => {
        for (const id of ['kata-open', 'kata-hotfix', 'kata-tweak']) {
            const generated = await readFile(`${projectRoot}/.agents/skills/${id}/SKILL.md`, 'utf8');
            expect(generated, `${id} must be regenerated from the canonical renderer`).toContain('--classification-file <path>');
            expect(generated).toContain('Do not read kata-cli ledger plan before open');
            expect(generated).toContain('classification.json');
        }
        const design = await readFile(`${projectRoot}/.agents/skills/kata-design/SKILL.md`, 'utf8');
        expect(design).toContain('plan.risk');
        expect(design).toContain('tasks relate --from <old-task> --to <successor-task> --type merged_into');
        expect(design).toContain('lane may not be below the classification');
    });

    it('the English and Chinese READMEs and CLI usage describe the same reachable inputs and route', async () => {
        const [english, chinese, usage] = await Promise.all([
            readFile(`${projectRoot}/README.md`, 'utf8'),
            readFile(`${projectRoot}/README_ZH.md`, 'utf8'),
            readFile(`${projectRoot}/src/cli/usage.ts`, 'utf8'),
        ]);
        for (const [label, text] of [['README.md', english], ['README_ZH.md', chinese]] as const) {
            expect(text, `${label} names the classification input`).toContain('--classification-file <path>');
            expect(text, `${label} names the real relation command`).toContain('tasks relate --from <old-task> --to <successor-task> --type merged_into');
            expect(text, `${label} must not tell the operator to read a pre-open plan`).not.toMatch(/before opening[\s\S]{0,100}ledger plan/i);
            expect(text, `${label} must not promise an in-place lane raise`).not.toMatch(/raising the lane is always allowed/i);
        }
        expect(usage).toContain('--classification-file <path>');
    });
});
