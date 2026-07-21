export class CometGuard {
    run;
    constructor(run) {
        this.run = run;
    }
    check(change, phase) {
        return this.run('check', change, phase);
    }
    apply(change, phase) {
        return this.run('apply', change, phase);
    }
}
//# sourceMappingURL=guard.js.map