import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
async function collectFiles(root, subDir, extension) {
    const dirPath = join(root, subDir);
    try {
        const entries = await readdir(dirPath, { withFileTypes: true, recursive: true });
        return entries
            .filter((e) => e.isFile() && e.name.endsWith(extension))
            .map((e) => join(e.parentPath ?? dirPath, e.name));
    }
    catch {
        return [];
    }
}
async function readTextFile(filePath) {
    try {
        const content = await readFile(filePath, 'utf8');
        return content;
    }
    catch {
        return '';
    }
}
function extractKeywords(statement) {
    const tokens = statement
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 3);
    const unique = [...new Set(tokens)];
    return unique.slice(0, 10);
}
function findKeywordMatches(source, keywords) {
    const lower = source.toLowerCase();
    return keywords.filter((keyword) => lower.includes(keyword));
}
function extractSnippet(content, statement) {
    const lowerContent = content.toLowerCase();
    const words = statement.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    for (const word of words) {
        const index = lowerContent.indexOf(word);
        if (index !== -1) {
            const start = Math.max(0, index - 40);
            const end = Math.min(content.length, index + word.length + 40);
            return content.slice(start, end).replace(/\n/g, ' ');
        }
    }
    return content.slice(0, 120).replace(/\n/g, ' ');
}
export async function checkConflicts(root, record) {
    const conflicts = [];
    const keywords = extractKeywords(record.statement);
    if (keywords.length === 0) {
        return { hasConflict: false, conflicts: [], analysis: 'No meaningful keywords to check.' };
    }
    const ruleFiles = await collectFiles(root, '.kata/rules', '.md');
    for (const filePath of ruleFiles) {
        const content = await readTextFile(filePath);
        const matches = findKeywordMatches(content, keywords);
        if (matches.length > 0) {
            const snippet = extractSnippet(content, record.statement);
            conflicts.push({ type: 'rule', source: filePath, snippet });
        }
    }
    const specFiles = await collectFiles(root, 'docs/superpowers/specs', '.md');
    for (const filePath of specFiles) {
        const content = await readTextFile(filePath);
        const matches = findKeywordMatches(content, keywords);
        if (matches.length > 0) {
            conflicts.push({ type: 'spec', source: filePath, snippet: extractSnippet(content, record.statement) });
        }
    }
    const testFiles = await collectFiles(root, 'tests', '.ts');
    for (const filePath of testFiles.slice(0, 15)) {
        const content = await readTextFile(filePath);
        const moduleMatch = record.sourceRefs.some((ref) => {
            const modulePath = ref.replace(/^src\//, '').replace(/\.ts$/, '');
            return filePath.includes(modulePath);
        });
        if (moduleMatch) {
            const matches = findKeywordMatches(content, keywords);
            if (matches.length > 0) {
                conflicts.push({ type: 'test', source: filePath, snippet: extractSnippet(content, record.statement) });
            }
        }
    }
    for (const sourceRef of record.sourceRefs) {
        const codePath = join(root, sourceRef);
        try {
            const content = await readTextFile(codePath);
            const matches = findKeywordMatches(content, keywords);
            if (matches.length > 0) {
                conflicts.push({ type: 'code', source: codePath, snippet: extractSnippet(content, record.statement) });
            }
        }
        catch {
            continue;
        }
    }
    return {
        hasConflict: conflicts.length > 0,
        conflicts,
        analysis: conflicts.length > 0
            ? `Found ${conflicts.length} potential conflict(s): ${conflicts.map((c) => `${c.type}:${c.source}`).join(', ')}`
            : 'No conflicts detected.',
    };
}
//# sourceMappingURL=conflict.js.map