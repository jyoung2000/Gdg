#!/usr/bin/env node
/**
 * Authenticode signing for the Windows build.
 *
 * Tauri calls this once per artefact it produces (`bundle.windows.signCommand`),
 * with the path to sign. It is a hook, not a policy: this repository holds no
 * certificate and invents none. What it does is make signing a configuration
 * change rather than a code change, and make an *accidentally* unsigned release
 * impossible to publish.
 *
 *   MERIDIAN_WINDOWS_SIGN_THUMBPRINT   sign with a certificate already in the
 *                                      signer's store — the preferred route,
 *                                      because no secret ever leaves it
 *   MERIDIAN_WINDOWS_SIGN_PFX_BASE64   a base64 PFX (a CI secret)
 *   MERIDIAN_WINDOWS_SIGN_PFX_PASSWORD its password
 *   MERIDIAN_WINDOWS_SIGN_TIMESTAMP    RFC-3161 timestamp server
 *   MERIDIAN_REQUIRE_SIGNING=1         refuse to produce an unsigned artefact
 *
 * With none of them set the artefact is left unsigned and this says so, loudly,
 * on stderr. That is the right behaviour for a fork, a pull request and a local
 * build; it is the wrong behaviour for a release, which is why the release job
 * sets MERIDIAN_REQUIRE_SIGNING and this exits nonzero without a certificate.
 *
 * On the handling of the secret: the PFX password is never passed as an
 * argument. Command lines on Windows are readable by any process on the machine
 * through WMI, so `signtool /p <password>` hands the password to anything that
 * is looking. Instead the PFX is imported through PowerShell, which reads the
 * password from this process's environment, and the signature is then made
 * against the imported certificate's thumbprint. The temporary PFX is written
 * with an owner-only ACL and deleted, and the imported certificate is removed
 * from the store, whatever happens.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

function fail(message) {
  process.stderr.write(`\nsign-windows: ${message}\n\n`);
  process.exit(1);
}

function note(message) {
  process.stderr.write(`sign-windows: ${message}\n`);
}

const required = process.env.MERIDIAN_REQUIRE_SIGNING === '1';
const thumbprintFromEnv = (process.env.MERIDIAN_WINDOWS_SIGN_THUMBPRINT ?? '').replace(/[^0-9a-fA-F]/g, '');
const pfxBase64 = process.env.MERIDIAN_WINDOWS_SIGN_PFX_BASE64 ?? '';
const pfxPassword = process.env.MERIDIAN_WINDOWS_SIGN_PFX_PASSWORD ?? '';
const timestampUrl = process.env.MERIDIAN_WINDOWS_SIGN_TIMESTAMP ?? 'http://timestamp.digicert.com';

const target = process.argv[2];
if (!target) fail('no file to sign. Tauri passes the artefact path as the first argument.');

const path = [target, join(ROOT, target)].find((p) => existsSync(p));
if (!path) fail(`nothing to sign at ${target} (cwd ${process.cwd()})`);

if (!thumbprintFromEnv && !pfxBase64) {
  const reason = 'no signing certificate is configured';
  if (required) {
    fail(
      `${reason}, and MERIDIAN_REQUIRE_SIGNING=1.\n` +
        '  Set MERIDIAN_WINDOWS_SIGN_THUMBPRINT for a certificate in the machine store,\n' +
        '  or MERIDIAN_WINDOWS_SIGN_PFX_BASE64 with MERIDIAN_WINDOWS_SIGN_PFX_PASSWORD.\n' +
        '  See docs/RELEASE_WINDOWS.md.'
    );
  }
  note(`${reason}; leaving ${target} UNSIGNED.`);
  note('Windows SmartScreen will warn anyone who runs it. This is fine for a local or fork build.');
  process.exit(0);
}

if (process.platform !== 'win32') {
  // signtool is a Windows SDK tool. Refusing here is better than a confusing
  // failure three lines later, and better than silently "succeeding".
  fail(`Authenticode signing needs Windows; this is ${process.platform}.`);
}

/** The SDK does not put signtool on PATH, and there is usually more than one. */
function findSignTool() {
  const onPath = which('signtool.exe');
  if (onPath) return onPath;

  const roots = [
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Windows Kits', '10', 'bin'),
  ].filter((d) => existsSync(d));

  const found = [];
  for (const root of roots) {
    for (const version of readdirSync(root)) {
      for (const arch of ['x64', 'x86', 'arm64']) {
        const candidate = join(root, version, arch, 'signtool.exe');
        if (existsSync(candidate)) found.push({ version, candidate });
      }
    }
  }
  if (found.length === 0) return null;
  // Newest SDK wins; version directories sort correctly as strings here
  // (10.0.22621.0 and friends are zero-padded by their own scheme only in the
  // last component, so compare numerically component by component).
  found.sort((a, b) => compareVersions(b.version, a.version));
  return found[0].candidate;
}

function compareVersions(a, b) {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

function which(name) {
  try {
    const out = execFileSync('where', [name], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    return out[0] ?? null;
  } catch {
    return null;
  }
}

function powershell(script, env = process.env) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', env }
  ).trim();
}

const signtool = findSignTool();
if (!signtool) {
  fail(
    'signtool.exe was not found. Install the Windows SDK ("Windows SDK Signing Tools for Desktop Apps").\n' +
      '  Looked on PATH and under "Windows Kits\\10\\bin".'
  );
}
note(`using ${signtool}`);

let thumbprint = thumbprintFromEnv;
let importedThumbprint = null;
let scratch = null;

try {
  if (!thumbprint) {
    if (!pfxPassword) {
      fail('MERIDIAN_WINDOWS_SIGN_PFX_BASE64 is set but MERIDIAN_WINDOWS_SIGN_PFX_PASSWORD is not.');
    }
    const pfx = Buffer.from(pfxBase64, 'base64');
    if (pfx.length === 0) fail('MERIDIAN_WINDOWS_SIGN_PFX_BASE64 did not decode to anything.');

    scratch = mkdtempSync(join(tmpdir(), 'meridian-sign-'));
    const pfxPath = join(scratch, 'certificate.pfx');
    writeFileSync(pfxPath, pfx, { mode: 0o600 });
    chmodSync(pfxPath, 0o600);
    // Windows ignores the POSIX mode; set a real ACL as well.
    powershell(
      `$acl = Get-Acl -LiteralPath '${pfxPath}'; $acl.SetAccessRuleProtection($true, $false); ` +
        `$acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(` +
        `[System.Security.Principal.WindowsIdentity]::GetCurrent().Name, 'FullControl', 'Allow'))); ` +
        `Set-Acl -LiteralPath '${pfxPath}' -AclObject $acl`
    );

    // The password is read from the environment inside PowerShell. It is never
    // an argument, so it never appears in a command line, a process listing, or
    // an installer log.
    importedThumbprint = powershell(
      `$p = ConvertTo-SecureString -String $env:MERIDIAN_WINDOWS_SIGN_PFX_PASSWORD -AsPlainText -Force; ` +
        `$c = Import-PfxCertificate -FilePath '${pfxPath}' -CertStoreLocation Cert:\\CurrentUser\\My -Password $p; ` +
        `$c.Thumbprint`
    );
    if (!/^[0-9A-Fa-f]{40}$/.test(importedThumbprint)) {
      fail(`importing the PFX did not yield a thumbprint (got ${JSON.stringify(importedThumbprint)}).`);
    }
    thumbprint = importedThumbprint;
    note('certificate imported into the current user store');
  }

  const before = statSync(path).size;
  execFileSync(
    signtool,
    ['sign', '/sha1', thumbprint, '/fd', 'SHA256', '/td', 'SHA256', '/tr', timestampUrl, '/v', path],
    { stdio: 'inherit' }
  );
  execFileSync(signtool, ['verify', '/pa', '/v', path], { stdio: 'inherit' });
  const after = statSync(path).size;
  note(`signed and verified ${target} (${before} → ${after} bytes)`);
} finally {
  if (importedThumbprint) {
    try {
      powershell(`Remove-Item -LiteralPath 'Cert:\\CurrentUser\\My\\${importedThumbprint}' -Force`);
      note('imported certificate removed from the store');
    } catch (error) {
      // Worth knowing about on a shared machine, not worth failing a build that
      // otherwise produced a correctly signed artefact.
      note(`WARNING: could not remove the imported certificate: ${error.message}`);
    }
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
