export interface GuardResult {
  passed: boolean;
  phase: string;
  output?: string;
  reason?: string;
}

export interface GuardRunner {
  (action: 'check' | 'apply', change: string, phase: string): Promise<GuardResult>;
}

export class CometGuard {
  private readonly run: GuardRunner;

  constructor(run: GuardRunner) {
    this.run = run;
  }

  check(change: string, phase: string): Promise<GuardResult> {
    return this.run('check', change, phase);
  }

  apply(change: string, phase: string): Promise<GuardResult> {
    return this.run('apply', change, phase);
  }
}
