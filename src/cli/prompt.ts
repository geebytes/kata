import { select as inquirerSelect, checkbox as inquirerCheckbox, confirm as inquirerConfirm } from '@inquirer/prompts';
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import type { Readable } from 'node:stream';
import type { Writable } from 'node:stream';

export interface SelectOption<T> {
  value: T;
  label: string;
}

export interface CheckOption<T> {
  value: T;
  label: string;
  checked?: boolean;
}

export async function select<T>(question: string, options: SelectOption<T>[], io?: { input?: Readable; output?: Writable }): Promise<T> {
  const input = io?.input ?? defaultInput;
  const output = io?.output ?? defaultOutput;

  if (input === defaultInput && !(input as typeof defaultInput).isTTY) {
    return options[0].value;
  }

  return await inquirerSelect({
    message: question,
    choices: options.map((opt) => ({ name: opt.label, value: opt.value })),
    ...(io?.input ? { input: io.input as NodeJS.ReadableStream } : {}),
    ...(io?.output ? { output: io.output as NodeJS.WritableStream } : {}),
  });
}

export async function checkbox<T>(question: string, options: CheckOption<T>[], io?: { input?: Readable; output?: Writable }): Promise<T[]> {
  const input = io?.input ?? defaultInput;
  const output = io?.output ?? defaultOutput;

  if (input === defaultInput && !(input as typeof defaultInput).isTTY) {
    return options.filter((o) => o.checked).map((o) => o.value);
  }

  return await inquirerCheckbox({
    message: question,
    choices: options.map((opt) => ({ name: opt.label, value: opt.value, checked: opt.checked })),
    ...(io?.input ? { input: io.input as NodeJS.ReadableStream } : {}),
    ...(io?.output ? { output: io.output as NodeJS.WritableStream } : {}),
  });
}

export async function confirmDestructive(message: string, details?: string[]): Promise<boolean> {
  if (!defaultOutput.isTTY) return false;

  const detail = details && details.length > 0 ? `\n${details.map((d) => `  ${d}`).join('\n')}` : '';
  return await inquirerConfirm({
    message: `${message}${detail}\nContinue?`,
    default: false,
  });
}
