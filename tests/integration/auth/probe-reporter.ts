import { writeFileSync } from 'node:fs';
import type { Reporter, TestModule } from 'vitest/node';

// Vitest's JSON report omits unhandled errors; the negative probe must reject them.
export default class ProbeReporter implements Reporter {
  onTestRunEnd(modules: readonly TestModule[], errors: readonly unknown[], reason: string) {
    const path = process.env.ISKRA_TEST_PROBE_METADATA;
    if (!path) throw new Error('Negative probe metadata path is required.');
    const suiteErrors = modules.reduce((total, module) => total + module.errors().length
      + [...module.children.allSuites()].reduce((count, suite) => count + suite.errors().length, 0), 0);
    writeFileSync(path, JSON.stringify({ unhandledErrors: errors.length, suiteErrors, reason }));
  }
}
