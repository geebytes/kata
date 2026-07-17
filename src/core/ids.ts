const taskIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertValidTaskId(taskId: string): void {
  if (!taskIdPattern.test(taskId)) {
    throw new Error(`Invalid task id: ${taskId}`);
  }
}
