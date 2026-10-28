import { registerHooks } from 'node:module';

// Resolve this repository's extensionless TypeScript imports in a local Node runner.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/i.test(specifier)) {
        try {
          return nextResolve(`${specifier}.ts`, context);
        } catch {
          throw error;
        }
      }
      throw error;
    }
  },
});

const { runDemoResetCli } = await import('./reset-demo.ts');
runDemoResetCli().catch((error) => {
  const message = error instanceof Error ? error.message : 'Unknown reset failure.';
  console.error(`Demo reset stopped: ${message}`);
  process.exitCode = 1;
});
