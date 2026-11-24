/**
 * Module resolution for the self-hosted build.
 *
 * Run as `node --import tsx --import ./server/register.ts server/index.ts`:
 *   tsx     compiles TypeScript on the fly (server and backend are .ts)
 *   register resolves the platform package names to this repository's code
 *
 * The backend imports the platform packages by name (`@appdeploy/sdk`,
 * `@appdeploy/client`). In an AppDeploy deployment those are injected. Here they
 * are this repository's own implementations, wired in explicitly by path.
 *
 * Without this, Node would resolve `@appdeploy/sdk` through node_modules — which
 * after a test run contains the local *test harness* stub. Loading that instead of
 * the real adapter silently changes storage semantics, so production refuses to
 * start unless the real module is what gets resolved.
 */

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const hooks = `
import { pathToFileURL } from 'node:url';

const SDK = ${JSON.stringify(pathToFileURL('server/sdk.ts').href)};
const CLIENT = ${JSON.stringify(pathToFileURL('src/platform/client.ts').href)};

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@appdeploy/sdk') {
    return { url: SDK, format: 'module', shortCircuit: true };
  }
  if (specifier === '@appdeploy/client') {
    return { url: CLIENT, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;

register('data:text/javascript,' + encodeURIComponent(hooks), import.meta.url);

// Fail fast rather than serve with the wrong storage layer.
const sdk = (await import('@appdeploy/sdk')) as Record<string, unknown>;
if (typeof (sdk as { adapter?: unknown }).adapter !== 'object') {
  throw new Error(
    'FATAL: @appdeploy/sdk resolved to a module without the file adapter. ' +
      'Refusing to start with the wrong storage backend.'
  );
}
