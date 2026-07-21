const taskIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function assertValidTaskId(taskId) {
    if (!taskIdPattern.test(taskId)) {
        throw new Error(`Invalid task id: ${taskId}`);
    }
}
//# sourceMappingURL=ids.js.map