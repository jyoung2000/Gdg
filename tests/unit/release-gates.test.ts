import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
// @ts-expect-error — plain ESM, shared with the release script.
import { gateStatus, gatesPass } from '../../scripts/release-gates.mjs';

/**
 * The rule that decides whether a release may call itself verified.
 *
 * It lived inline in a script that takes minutes to run, so nobody had ever
 * exercised it directly — and it had a hole: `blocked` is prose a gate carries
 * on every machine, and it was treated as proof that the evidence *could not*
 * run. A gate with a reason string therefore could never FAIL. Delete its
 * tests and the release went green, explaining itself by citing a Docker
 * daemon the machine might well have had.
 */
describe('Release gate status', () => {
  const NOTHING_BLOCKED = { docker: () => false, 'live-providers': () => false };
  const ALL_BLOCKED = { docker: () => true, 'live-providers': () => true };

  const plain = { id: 'routing', title: 'Core routing', tests: ['a', 'b'] };
  const blockable = {
    id: 'sandbox',
    title: 'Sandbox isolation',
    tests: ['a', 'b'],
    blockedBy: 'docker',
    blocked: 'needs a Docker daemon',
  };

  it('passes a gate whose evidence all ran', () => {
    assert.equal(gateStatus(plain, [], NOTHING_BLOCKED), 'VERIFIED');
  });

  it('fails a gate whose evidence is missing for no external reason', () => {
    assert.equal(gateStatus(plain, ['a'], NOTHING_BLOCKED), 'FAILED');
  });

  it('fails a blockable gate when the blocker is NOT present', () => {
    // The hole. Docker is available, the sandbox tests did not run, and the
    // only honest reading is that the evidence is gone.
    assert.equal(
      gateStatus(blockable, ['a', 'b'], NOTHING_BLOCKED),
      'FAILED',
      'a reason string is not proof; the machine has Docker and the tests still did not run',
    );
  });

  it('blocks a blockable gate only when the blocker really is present', () => {
    assert.equal(gateStatus(blockable, ['a', 'b'], ALL_BLOCKED), 'BLOCKED_EXTERNAL');
  });

  it('calls a blockable gate PARTIAL when its evidence did run', () => {
    // Its named tests passed, but the gate covers more than they do.
    assert.equal(gateStatus(blockable, [], ALL_BLOCKED), 'PARTIAL');
  });

  it('fails a gate that names a blocker nobody observes', () => {
    // A typo in blockedBy must not become a free pass.
    const typo = { ...blockable, blockedBy: 'dokcer' };
    assert.equal(gateStatus(typo, ['a'], ALL_BLOCKED), 'FAILED');
  });

  it('stops the release on any FAILED gate, and only on that', () => {
    assert.equal(gatesPass([{ status: 'VERIFIED' }, { status: 'BLOCKED_EXTERNAL' }, { status: 'PARTIAL' }]), true);
    assert.equal(gatesPass([{ status: 'VERIFIED' }, { status: 'FAILED' }]), false);
  });

  it('keeps every gate in the shipped list answerable', () => {
    // Each blockedBy must name a blocker the script actually evaluates,
    // otherwise the gate silently becomes unfailable-by-typo in the other
    // direction: always FAILED, whatever the machine.
    const script = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/verify-release.mjs'), 'utf8');
    const declared = [...script.matchAll(/blockedBy:\s*'([^']+)'/g)].map((m) => m[1]);
    const known = [...script.matchAll(/^\s{2}'?([a-z-]+)'?:\s*\(\)\s*=>/gm)].map((m) => m[1]);
    assert.ok(declared.length > 0, 'the script must declare at least one blockable gate');
    for (const b of declared) {
      assert.ok(known.includes(b), `gate blockedBy '${b}' has no entry in BLOCKERS — it could never be blocked`);
    }
  });
});

/**
 * The preview screenshots are the artefact people actually look at, and a PNG
 * cannot carry a fingerprint, so a sidecar records one beside them. A sidecar
 * that parses but carries no fingerprint used to pass silently — the staleness
 * comparison was guarded on the stamp existing.
 */
describe('Offline artefact gate: the previews sidecar', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const ROOT = resolve(HERE, '../..');

  const runGate = (): { code: number; out: string } => {
    try {
      const out = execFileSync(process.execPath, ['scripts/check-offline-ui.mjs'], { cwd: ROOT, encoding: 'utf8' });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      return { code: err.status ?? 1, out: err.stdout ?? '' };
    }
  };

  it('refuses a sidecar that records no fingerprint', () => {
    const sidecar = join(ROOT, 'docs/mockup/previews.json');
    const backup = mkdtempSync(join(tmpdir(), 'meridian-previews-'));
    const saved = join(backup, 'previews.json');
    copyFileSync(sidecar, saved);
    try {
      // Everything else about the artefacts is untouched; only the stamp goes.
      writeFileSync(sidecar, JSON.stringify({ shots: 7 }, null, 2));
      const { code, out } = runGate();
      assert.notEqual(code, 0, 'a sidecar with no fingerprint must fail the gate');
      assert.match(out, /records no uiFingerprint/, `the gate must say what is missing, got: ${out}`);
    } finally {
      copyFileSync(saved, sidecar);
      rmSync(backup, { recursive: true, force: true });
    }

    // And the real sidecar still passes, so the check is about the hole rather
    // than about being generally unhappy.
    assert.equal(runGate().code, 0, 'the shipped artefacts must still pass');
  });
});
