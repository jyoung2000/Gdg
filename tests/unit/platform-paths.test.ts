import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { defaultDataDir, loadConfig, platformPaths, runtimeStatePath } from '@meridian/shared';

/**
 * Where Meridian writes, on a platform that is not this one.
 *
 * The Windows layout has to be verifiable from a Linux CI runner, or it is only
 * ever verified by shipping it and hearing from someone whose database landed
 * in `C:\Program Files\Meridian\data` — a directory a standard user cannot
 * write to, so the failure is not a misplaced file but an application that will
 * not start.
 *
 * That is why `platformPaths` takes the platform and the environment as
 * arguments instead of reading `process`.
 */

const WINDOWS_ENV = {
  APPDATA: 'C:\\Users\\Ada Lovelace\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\Ada Lovelace\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\Ada Lovelace',
} as NodeJS.ProcessEnv;

describe('Windows paths, resolved from anywhere', () => {
  it('puts durable state in roaming and regenerable state in local', () => {
    const p = platformPaths('win32', WINDOWS_ENV);

    // The database and credentials are the user's own state: a managed profile
    // should carry them between machines.
    assert.equal(p.data, 'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\Meridian');
    assert.equal(p.workspaces, 'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\Meridian\\workspaces');

    // Logs and caches are large, machine-specific and rebuildable. Roaming
    // them is how a login becomes slow.
    assert.equal(p.logs, 'C:\\Users\\Ada Lovelace\\AppData\\Local\\Meridian\\logs');
    assert.equal(p.cache, 'C:\\Users\\Ada Lovelace\\AppData\\Local\\Meridian\\cache');
    assert.equal(p.runtime, 'C:\\Users\\Ada Lovelace\\AppData\\Local\\Meridian\\runtime');
  });

  it('survives a username with a space in it', () => {
    // Every one of these is a real path a real person has. A build that only
    // ever ran as `C:\Users\runneradmin` proves nothing about them.
    const p = platformPaths('win32', WINDOWS_ENV);
    assert.ok(p.data.includes('Ada Lovelace'), 'the path must carry the name through, spaces and all');
    assert.ok(!p.data.includes('/'), 'and must not mix separators');
  });

  it('survives a username that is not ASCII', () => {
    const p = platformPaths('win32', {
      APPDATA: 'C:\\Users\\Ольга\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Ольга\\AppData\\Local',
    } as NodeJS.ProcessEnv);
    assert.equal(p.data, 'C:\\Users\\Ольга\\AppData\\Roaming\\Meridian');
  });

  it('falls back to the profile rather than throwing when APPDATA is missing', () => {
    // A stripped service account is broken rather than exotic. Throwing here
    // would take the gateway down during config load, before it could say why.
    const p = platformPaths('win32', { USERPROFILE: 'C:\\Users\\svc' } as NodeJS.ProcessEnv);
    assert.equal(p.data, 'C:\\Users\\svc\\AppData\\Roaming\\Meridian');
    assert.equal(p.logs, 'C:\\Users\\svc\\AppData\\Local\\Meridian\\logs');
  });

  it('never puts writable state where the application is installed', () => {
    const p = platformPaths('win32', WINDOWS_ENV);
    for (const dir of [p.data, p.logs, p.cache, p.runtime, p.workspaces]) {
      assert.ok(!/program files/i.test(dir), `${dir} is under Program Files, which a standard user cannot write to`);
      assert.ok(isAbsolute(dir) || /^[A-Za-z]:\\/.test(dir), `${dir} must be absolute`);
    }
  });
});

describe('macOS and Linux follow their own conventions', () => {
  it('uses Application Support, Logs and Caches on macOS', () => {
    const p = platformPaths('darwin', { HOME: '/Users/ada' } as NodeJS.ProcessEnv);
    assert.equal(p.data, '/Users/ada/Library/Application Support/Meridian');
    assert.equal(p.logs, '/Users/ada/Library/Logs/Meridian');
    assert.equal(p.cache, '/Users/ada/Library/Caches/Meridian');
  });

  it('honours the XDG base directory variables when they are set', () => {
    const p = platformPaths('linux', {
      HOME: '/home/ada',
      XDG_DATA_HOME: '/home/ada/.data',
      XDG_STATE_HOME: '/home/ada/.state',
      XDG_CACHE_HOME: '/home/ada/.cache2',
      XDG_RUNTIME_DIR: '/run/user/1000',
    } as NodeJS.ProcessEnv);
    assert.equal(p.data, '/home/ada/.data/meridian');
    assert.equal(p.logs, '/home/ada/.state/meridian/logs');
    assert.equal(p.cache, '/home/ada/.cache2/meridian');
    assert.equal(p.runtime, '/run/user/1000/meridian');
  });

  it('uses the spec’s own defaults when they are not', () => {
    const p = platformPaths('linux', { HOME: '/home/ada' } as NodeJS.ProcessEnv);
    assert.equal(p.data, '/home/ada/.local/share/meridian');
    assert.equal(p.logs, '/home/ada/.local/state/meridian/logs');
    assert.equal(p.cache, '/home/ada/.cache/meridian');
  });
});

describe('The container’s layout is not disturbed', () => {
  it('keeps ./data for a plain server run', () => {
    // Every script, doc and compose file in this repository expects it, and an
    // existing operator's database must not move out from under them.
    assert.equal(defaultDataDir({} as NodeJS.ProcessEnv, 'linux'), './data');
    assert.equal(defaultDataDir({} as NodeJS.ProcessEnv, 'win32'), './data');
  });

  it('switches to the per-user location only inside the desktop app', () => {
    const env = { ...WINDOWS_ENV, MERIDIAN_DESKTOP: '1' } as NodeJS.ProcessEnv;
    assert.equal(defaultDataDir(env, 'win32'), 'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\Meridian');
  });

  it('never second-guesses an operator who set the variable', () => {
    const config = loadConfig({ MERIDIAN_DATA_DIR: '/data', MERIDIAN_DESKTOP: '1' } as NodeJS.ProcessEnv);
    assert.equal(config.dataDir, '/data');
  });
});

describe('Binding: a desktop backend is not a server', () => {
  it('binds loopback in the desktop runtime', () => {
    // Otherwise installing a desktop app publishes the user's models, keys and
    // workspaces to their whole network without them ever asking for a server.
    assert.equal(loadConfig({ MERIDIAN_DESKTOP: '1' } as NodeJS.ProcessEnv).host, '127.0.0.1');
  });

  it('keeps 0.0.0.0 for a container, which is unreachable without it', () => {
    assert.equal(loadConfig({} as NodeJS.ProcessEnv).host, '0.0.0.0');
  });

  it('still lets an operator say exactly what they mean', () => {
    assert.equal(loadConfig({ MERIDIAN_DESKTOP: '1', MERIDIAN_HOST: '0.0.0.0' } as NodeJS.ProcessEnv).host, '0.0.0.0');
  });
});

describe('The database path is composed, not concatenated', () => {
  it('joins a Windows data directory with the filename correctly', () => {
    const config = loadConfig({
      ...WINDOWS_ENV,
      MERIDIAN_DESKTOP: '1',
      MERIDIAN_DATA_DIR: 'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\Meridian',
    } as NodeJS.ProcessEnv);
    // A hand-written '/' between them happens to work on Windows; it works by
    // luck rather than by rule, and it renders back to the user as a mongrel.
    assert.ok(
      config.databasePath.endsWith('meridian.db'),
      `expected a database file under the data directory, got ${config.databasePath}`,
    );
    assert.ok(config.databasePath.startsWith('C:\\Users\\Ada Lovelace'));
  });
});

describe('The runtime state file', () => {
  it('lives with the other runtime state, not with the durable data', () => {
    const p = runtimeStatePath(WINDOWS_ENV, 'win32');
    assert.equal(p, 'C:\\Users\\Ada Lovelace\\AppData\\Local\\Meridian\\runtime\\instance.json');
  });

  it('can be pointed somewhere explicitly, for tests and for portable installs', () => {
    const p = runtimeStatePath({ MERIDIAN_RUNTIME_STATE: '/tmp/x/instance.json' } as NodeJS.ProcessEnv, 'linux');
    assert.equal(p, '/tmp/x/instance.json');
  });
});
