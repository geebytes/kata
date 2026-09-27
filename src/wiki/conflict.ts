import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { WikiRecord } from './record.js';
import { rulesDir } from '../core/layout.js';

export interface ConflictEntry {
  type: 'rule' | 'spec' | 'test' | 'code';
  source: string;
  snippet: string;
}

export interface ConflictReport {
  hasConflict: boolean;
  conflicts: ConflictEntry[];
  analysis: string;
}

async function collectFiles(directory: string, extension: string): Promise<string[]> {
  // `directory` is absolute: the callers know their own location, and joining a root onto an absolute path would
  // duplicate it.
  const dirPath = directory;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true, recursive: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(extension))
      .map((e) => join(e.parentPath ?? dirPath, e.name));
  } catch {
    return [];
  }
}

async function readTextFile(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath, 'utf8');
    return content;
  } catch {
    return '';
  }
}

function extractKeywords(statement: string): string[] {
  const tokens = statement
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 3);
  const unique = [...new Set(tokens)];
  return unique.slice(0, 10);
}

function findKeywordMatches(source: string, keywords: string[]): string[] {
  const lower = source.toLowerCase();
  return keywords.filter((keyword) => lower.includes(keyword));
}

function extractSnippet(content: string, statement: string): string {
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
