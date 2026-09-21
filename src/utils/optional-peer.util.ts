import { createRequire } from "module";
import { dirname, join } from "path";

/**
 * What loading an optional peer produced.
 *
 * `installed: false` is the normal case for a service that does not use the
 * feature - not a misconfiguration, and callers should stay silent about it.
 * `installed: true` with no `module` means the package is present but the
 * requested entry could not be loaded; `error` carries the cause so the
 * caller can say something truthful instead of guessing.
 */
export type OptionalPeerResult<T> =
  | { installed: false }
  | { installed: true; module: T | undefined; error?: unknown };

/**
 * Loads an optional peer dependency without a static import, so a service
 * that does not use the feature need not install the package.
 *
 * Synchronous on purpose: every caller patches or subscribes during provider
 * instantiation or `onModuleInit`, strictly before the peer's own lifecycle
 * runs, and a dynamic `import()` would resolve too late. All current peers
 * ship CommonJS, so `require` can load them.
 *
 * The package's presence is probed with `require.resolve(packageName)` before
 * `specifier` (which may be a deep path into the package) is required, so
 * "not installed" is kept apart from "installed but broken or reshaped".
 * `createRequire` itself failing - a CJS bundle that erased `import.meta.url`,
 * say - is treated as "not installed": with no resolver there is nothing to
 * load, and crashing the constructor would defeat the point of the peer being
 * optional.
 *
 * A deep specifier that an `exports` map refuses (Nest v12 added one to
 * several packages) is retried as an absolute path built from the package's
 * own `package.json` - always exported, and an absolute path is not subject
 * to the map. The file still has to be there, so a genuinely moved or removed
 * entry keeps reporting its own failure.
 */
/** Names a load failure for a log line: the message for an `Error`, `String` otherwise. */
export function describePeerLoadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function loadOptionalPeer<T>(
  packageName: string,
  specifier: string = packageName,
): OptionalPeerResult<T> {
  let require: ReturnType<typeof createRequire>;
  try {
    require = createRequire(import.meta.url);
    require.resolve(packageName);
  } catch {
    return { installed: false };
  }
  try {
    return { installed: true, module: require(specifier) as T };
  } catch (error) {
    const withinPackage = resolveWithinPackage(require, packageName, specifier);
    if (withinPackage) {
      try {
        return { installed: true, module: require(withinPackage) as T };
      } catch {
        // Fall through and report the original failure: it names the
        // specifier the caller actually asked for.
      }
    }
    return { installed: true, module: undefined, error };
  }
}

/**
 * Turns a deep specifier such as `@nestjs/schedule/dist/schedule.explorer.js`
 * into an absolute path inside the installed package, so an `exports` map
 * that hides the subpath is bypassed. Returns `undefined` when the specifier
 * is not a subpath of `packageName` or the package cannot be located.
 */
function resolveWithinPackage(
  require: ReturnType<typeof createRequire>,
  packageName: string,
  specifier: string,
): string | undefined {
  const prefix = `${packageName}/`;
  if (!specifier.startsWith(prefix)) {
    return undefined;
  }
  try {
    const manifest = require.resolve(`${packageName}/package.json`);
    return join(dirname(manifest), specifier.slice(prefix.length));
  } catch {
    return undefined;
  }
}

/**
 * Loads `specifier` the way another installed package would resolve it, or
 * `undefined` when that package is absent or resolves nothing of its own.
 *
 * For a driver that an ORM depends on directly. npm gives the ORM a nested
 * copy whenever the application's own version of the driver is outside the
 * range the ORM asks for - `mongodb@6` beside a Mongoose that wants 7 - and a
 * patch applied to the copy *this* package resolves never touches the one the
 * ORM runs on. Queries through the ORM would then go unrecorded with nothing
 * to say why. When both resolve to the same file the caller patches one
 * prototype twice, which `patchMethod` is built to shrug off.
 */
export function loadAsResolvedBy<T>(
  dependentPackage: string,
  specifier: string,
): T | undefined {
  try {
    const require = createRequire(import.meta.url);
    let anchor: string;
    try {
      anchor = require.resolve(`${dependentPackage}/package.json`);
    } catch {
      // An `exports` map that does not list its own package.json. Any file
      // inside the package anchors resolution equally well.
      anchor = require.resolve(dependentPackage);
    }
    return createRequire(anchor)(specifier) as T;
  } catch {
    return undefined;
  }
}
