import { registerHooks } from 'node:module';
import esbuild from 'esbuild';

// Native stripping cannot handle existing parameter properties; use the installed transpiler.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/i.test(specifier)) {
        try { return nextResolve(`${specifier}.ts`, context); } catch { throw error; }
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.endsWith('.ts')) return loaded;
    const source = typeof loaded.source === 'string' ? loaded.source : new TextDecoder().decode(loaded.source);
    return { format: 'module', source: esbuild.transformSync(source, {
      loader: 'ts', format: 'esm', target: 'es2022', sourcefile: url,
    }).code, shortCircuit: true };
  },
});

const { runOrphanSweep } = await import('./sweep-photo-orphans.ts');
runOrphanSweep().catch(() => {
  console.error('Staging orphan sweep stopped. No further deletion attempted; credentials/provider details withheld.');
  process.exitCode = 1;
});
