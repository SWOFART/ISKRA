import { registerHooks } from 'node:module';

// Node's built-in TypeScript stripping does not resolve this repository's
// extensionless TypeScript imports, so install a local-only resolver before loading the CLI.
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

await import('./seed-demo.ts');
