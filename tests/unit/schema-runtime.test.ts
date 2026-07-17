import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { validate } from '../../src/core/schema.js';
import { transition, type Actor } from '../../src/core/state.js';
import { createTask } from '../../src/core/task.js';

describe('runtime records match shipped JSON schemas', () => {
  const roots: string[] = [];
  const actor: Actor = { id: 'agent-1', role: 'implementer' };

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-schema-runtime-'));
    roots.push(root);
    await initLayout(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('validates persisted task, current state, and state event records produced by runtime code', async () => {
    const root = await tempRoot();
    const task = await createTask({
      root,
      id: 'task-schema-runtime',
      title: 'Persist schema-valid runtime records',
      acceptance: [{ statement: 'Acceptance ids may be assigned before implement.' }],
    });

    const taskPath = join(root, '.kata/tasks', task.id, 'task.json');
    const statePath = join(root, '.kata/tasks', task.id, 'current-state.json');
    const eventsPath = join(root, '.kata/tasks', task.id, 'state-events.jsonl');

    const persistedTask = JSON.parse(await readFile(taskPath, 'utf8')) as unknown;
    expect(validate('task', persistedTask)).toEqual(persistedTask);

    const initialState = JSON.parse(await readFile(statePath, 'utf8')) as unknown;
    expect(validate('workflow-state-record', initialState)).toEqual(initialState);

    const initialEvents = (await readFile(eventsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    expect(initialEvents).toHaveLength(1);
    for (const event of initialEvents) expect(validate('workflow-state-event', event)).toEqual(event);

    await transition(task.id, 'plan', actor, { root, activeSession: 'session-1' });

    const nextState = JSON.parse(await readFile(statePath, 'utf8')) as unknown;
    expect(validate('workflow-state-record', nextState)).toEqual(nextState);

    const events = (await readFile(eventsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    expect(events).toHaveLength(2);
    for (const event of events) expect(validate('workflow-state-event', event)).toEqual(event);
  });
});
