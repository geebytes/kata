import { select as inquirerSelect, checkbox as inquirerCheckbox, confirm as inquirerConfirm } from '@inquirer/prompts';
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
export async function select(question, options, io) {
    const input = io?.input ?? defaultInput;
    const output = io?.output ?? defaultOutput;
    if (input === defaultInput && !input.isTTY) {
        return options[0].value;
    }
    return await inquirerSelect({
        message: question,
        choices: options.map((opt) => ({ name: opt.label, value: opt.value })),
        ...(io?.input ? { input: io.input } : {}),
        ...(io?.output ? { output: io.output } : {}),
    });
}
export async function checkbox(question, options, io) {
    const input = io?.input ?? defaultInput;
    const output = io?.output ?? defaultOutput;
    if (input === defaultInput && !input.isTTY) {
        return options.filter((o) => o.checked).map((o) => o.value);
    }
    return await inquirerCheckbox({
        message: question,
        choices: options.map((opt) => ({ name: opt.label, value: opt.value, checked: opt.checked })),
        ...(io?.input ? { input: io.input } : {}),
        ...(io?.output ? { output: io.output } : {}),
    });
}
export async function confirmDestructive(message, details) {
    if (!defaultOutput.isTTY)
        return false;
    const detail = details && details.length > 0 ? `\n${details.map((d) => `  ${d}`).join('\n')}` : '';
    return await inquirerConfirm({
        message: `${message}${detail}\nContinue?`,
        default: false,
    });
}
//# sourceMappingURL=prompt.js.map