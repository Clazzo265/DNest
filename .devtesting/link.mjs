/**
 * LOCAL HARNESS ONLY.
 *
 * Wires the AppDeploy stand-in packages into node_modules so the backend and
 * client adapter resolve exactly the same module names the platform injects.
 * npm installs can prune these links, so this is idempotent and cheap.
 */
import { mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const modules = join(root, 'node_modules', '@appdeploy');

const targets = [
  { name: 'sdk', source: join(here, 'sdk', 'index.ts'), pkg: join(here, 'sdk', 'package.json') },
  { name: 'client', source: join(here, 'client.ts'), pkg: null },
];

for (const target of targets) {
  const dir = join(modules, target.name);
  mkdirSync(dir, { recursive: true });
  copyFileSync(target.source, join(dir, 'index.ts'));
  if (target.pkg) copyFileSync(target.pkg, join(dir, 'package.json'));
  else
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify(
        {
          name: '@appdeploy/' + target.name,
          type: 'module',
          main: 'index.ts',
          exports: { '.': './index.ts' },
        },
        null,
        2
      )
    );
}

console.log('linked @appdeploy stand-ins');
