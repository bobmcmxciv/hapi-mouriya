import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

export function resolveOmpLaunchCommand(command = 'omp'): { command: string; args: string[] } {
 const resolved = Bun.which(command);
 if (!resolved) throw new Error(`OMP executable not found: ${command}`);
 if (process.platform !== 'win32' || extname(resolved).toLowerCase() === '.exe') {
  return { command: resolved, args: [] };
 }
 const directory = dirname(resolved);
 const candidates = [
  join(directory, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'dist', 'cli.js'),
  join(dirname(realpathSync(resolved)), '..', 'lib', 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'dist', 'cli.js')
 ];
 const entry = candidates.find((candidate) => existsSync(candidate));
 const bunShim = Bun.which('bun');
 const bun = Bun.which('bun.exe') ?? (bunShim ? [
  join(dirname(bunShim), 'bun.exe'),
  join(dirname(bunShim), 'node_modules', 'bun', 'bin', 'bun.exe')
 ].find((candidate) => existsSync(candidate)) : undefined);
 if (!entry || !bun) throw new Error('Cannot resolve shell-free OMP launch; install OMP and Bun on PATH');
 const isBunBinary = basename(bun).toLowerCase().startsWith('bun');
 return { command: bun, args: isBunBinary ? ['--smol', entry] : [entry] };
}

export const OMP_MODEL_ENV = 'OMP_MODEL';

export type OmpModelSource = 'explicit' | 'env' | 'default';

export type OmpRuntimeConfig = {
 /**
  * The model id to hand omp via `--model`. When undefined, omp resolves the
  * model itself from its own `~/.omp` config / role defaults — omp ships with
  * 40+ providers and no single canonical default, so hapi never forces one.
  */
 model: string | undefined;
 modelSource: OmpModelSource;
};

export function resolveOmpRuntimeConfig(opts: { model?: string } = {}): OmpRuntimeConfig {
 if (opts.model && opts.model.trim().length > 0) {
  return { model: opts.model.trim(), modelSource: 'explicit' };
 }

 const envModel = process.env[OMP_MODEL_ENV];
 if (envModel && envModel.trim().length > 0) {
  return { model: envModel.trim(), modelSource: 'env' };
 }

 return { model: undefined, modelSource: 'default' };
}

export function buildOmpEnv(opts: { model?: string } = {}): NodeJS.ProcessEnv {
 const env: NodeJS.ProcessEnv = {
  ...process.env
 };

 if (opts.model) {
  env[OMP_MODEL_ENV] = opts.model;
 }

 return env;
}
