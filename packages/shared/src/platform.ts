import { homedir, tmpdir } from 'node:os';
import { posix, resolve, win32 } from 'node:path';

/**
 * Where Meridian's state lives, per operating system.
 *
 * Meridian was written as a container: `./data` relative to the working
 * directory is exactly right when the working directory is `/app` and the
 * volume is mounted at `/data`. It is exactly wrong for a desktop install,
 * where the working directory is wherever the shell happened to launch from and
 * the application directory is `C:\Program Files\Meridian` — a location a
 * standard user cannot write to, and should not.
 *
 * So the default becomes per-user and per-OS, and the container keeps working
 * because it sets `MERIDIAN_DATA_DIR` explicitly, as it always has. An operator
 * who has set the variable is never second-guessed.
 *
 * The conventions here are the platforms' own, not an invention:
 *
 * | | Data | Logs | Cache |
 * | --- | --- | --- | --- |
 * | Windows | `%APPDATA%\Meridian` | `%LOCALAPPDATA%\Meridian\logs` | `%LOCALAPPDATA%\Meridian\cache` |
 * | macOS | `~/Library/Application Support/Meridian` | `~/Library/Logs/Meridian` | `~/Library/Caches/Meridian` |
 * | Linux | `$XDG_DATA_HOME/meridian` | `$XDG_STATE_HOME/meridian/logs` | `$XDG_CACHE_HOME/meridian` |
 *
 * On Windows the split between roaming (`%APPDATA%`) and local
 * (`%LOCALAPPDATA%`) is deliberate. The database and credentials are the user's
 * own state and belong in roaming, where a managed profile follows them between
 * machines. Logs and caches are large, machine-specific and regenerable, and
 * putting those in a roaming profile is how you make someone's login slow.
 */

/** The application name, used as the directory name on every platform. */
const APP_DIR_WINDOWS = 'Meridian';
const APP_DIR_POSIX = 'meridian';

/**
 * Compose paths in the TARGET platform's grammar, not the host's.
 *
 * `path.join` is the host's flavour. That is right at runtime and useless for
 * verification: asked on Linux where a Windows install keeps its database, it
 * answers `C:\\Users\\ada\\AppData\\Roaming\\Meridian/meridian.db` — a mongrel
 * that happens to work when Windows opens it and is wrong the moment anyone
 * renders it back to the user or compares two of them.
 *
 * Selecting the flavour from the platform argument is what lets the Windows
 * layout be tested from a Linux CI runner. On Windows `win32.join` IS
 * `path.join`, so nothing about the shipped behaviour changes.
 */
export function joinFor(platform: NodeJS.Platform): (...parts: string[]) => string {
  return platform === 'win32' ? win32.join : posix.join;
}

export interface PlatformPaths {
  /** Durable user state: the database, assets, synced catalogs. */
  data: string;
  /** Rotating logs. Regenerable, and never roamed. */
  logs: string;
  /** Discardable derived data. Losing it must cost nothing but time. */
  cache: string;
  /**
   * Runtime state for a *running* instance: the port it bound, its pid.
   *
   * Separate from `data` because it is meaningless once the process is gone,
   * and separate from `cache` because something else reads it while it matters.
   */
  runtime: string;
  /** Agent workspaces. Large, and the user may want them somewhere else. */
  workspaces: string;
}

/**
 * `%APPDATA%` and friends, with a fallback that does not silently write to the
 * wrong place.
 *
 * A Windows session without `APPDATA` set is broken rather than exotic, but
 * falling back to the home directory keeps a stripped service account working
 * instead of throwing during config load — which would take the gateway down
 * before it could say why.
 */
function windowsRoots(env: NodeJS.ProcessEnv, join: (...p: string[]) => string): { roaming: string; local: string } {
  const home = env.USERPROFILE || homedir();
  return {
    roaming: env.APPDATA || join(home, 'AppData', 'Roaming'),
    local: env.LOCALAPPDATA || join(home, 'AppData', 'Local'),
  };
}

/**
 * Resolve every path Meridian writes to, for one platform.
 *
 * `platform` and `env` are parameters rather than reads of `process` so this is
 * testable on any host: the Windows layout has to be verifiable from a Linux
 * CI runner, or it is only ever verified by shipping it.
 */
export function platformPaths(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): PlatformPaths {
  if (platform === 'win32') {
    const join = win32.join;
    const { roaming, local } = windowsRoots(env, join);
    const data = join(roaming, APP_DIR_WINDOWS);
    const localRoot = join(local, APP_DIR_WINDOWS);
    return {
      data,
      logs: join(localRoot, 'logs'),
      cache: join(localRoot, 'cache'),
      runtime: join(localRoot, 'runtime'),
      workspaces: join(data, 'workspaces'),
    };
  }

  const join = posix.join;

  const home = env.HOME || homedir();

  if (platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support', APP_DIR_WINDOWS);
    return {
      data: support,
      logs: join(home, 'Library', 'Logs', APP_DIR_WINDOWS),
      cache: join(home, 'Library', 'Caches', APP_DIR_WINDOWS),
      runtime: join(home, 'Library', 'Caches', APP_DIR_WINDOWS, 'runtime'),
      workspaces: join(support, 'workspaces'),
    };
  }

  // Linux and everything else: the XDG base directory spec, with its own
  // documented defaults.
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const stateHome = env.XDG_STATE_HOME || join(home, '.local', 'state');
  const cacheHome = env.XDG_CACHE_HOME || join(home, '.cache');
  // XDG_RUNTIME_DIR is the correct home for a pid/port file and is usually a
  // tmpfs cleared at logout, which is exactly the lifetime wanted. It is not
  // always set, so the state directory stands in.
  const runtimeHome = env.XDG_RUNTIME_DIR || stateHome;
  return {
    data: join(dataHome, APP_DIR_POSIX),
    logs: join(stateHome, APP_DIR_POSIX, 'logs'),
    cache: join(cacheHome, APP_DIR_POSIX),
    runtime: join(runtimeHome, APP_DIR_POSIX),
    workspaces: join(dataHome, APP_DIR_POSIX, 'workspaces'),
  };
}

/**
 * Is this process running inside the desktop application?
 *
 * The desktop shell sets this, and it is the switch between "behave like a
 * server" and "behave like part of an app someone launched from a Start menu".
 * Inferring it from, say, the absence of a TTY would misfire on every
 * `docker run` without `-t`.
 */
export function isDesktopRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MERIDIAN_DESKTOP === '1';
}

/**
 * The default data directory for this environment.
 *
 * The container's `./data` is kept for a plain `node dist/gateway/main.js` in a
 * checkout, because that is what every existing script, doc and compose file
 * expects and changing it would move an existing operator's database out from
 * under them. The per-user location applies to the desktop runtime, which has
 * no legacy to protect.
 */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (isDesktopRuntime(env)) return platformPaths(platform, env).data;
  return './data';
}

/**
 * A temporary directory Meridian may write to.
 *
 * Exists so nothing hardcodes `/tmp`, which on Windows is not a directory at
 * all — `os.tmpdir()` returns `%TEMP%` there and the right thing everywhere.
 */
export function meridianTmpDir(platform: NodeJS.Platform = process.platform): string {
  return joinFor(platform)(tmpdir(), APP_DIR_POSIX);
}

/**
 * The file a running instance publishes so other tools can find it.
 *
 * A desktop install may not be on the documented port — the user might already
 * have something on 4639 — and `uag` should still work without being told. This
 * is how it finds out.
 *
 * It carries no secret, only what is already observable to anyone who can list
 * local sockets: a pid, a port, a version. That is deliberate; a discovery file
 * that carried a token would be a credential sitting in a predictable path.
 */
export function runtimeStatePath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env.MERIDIAN_RUNTIME_STATE;
  if (override) return resolve(override);
  return joinFor(platform)(platformPaths(platform, env).runtime, 'instance.json');
}

/** What a running instance publishes about itself. No secrets, by construction. */
export interface RuntimeState {
  pid: number;
  port: number;
  host: string;
  /** The URL a browser or CLI should use. */
  url: string;
  version: string;
  startedAt: number;
  /** True when a desktop shell owns this process's lifecycle. */
  desktop: boolean;
}
