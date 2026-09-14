/**
 * The release gates, and the rule that decides each one's status.
 *
 * Split out of `verify-release.mjs` so it can be tested. The script itself runs
 * top to bottom and takes minutes; the rule below is the part that decides
 * whether a release is allowed to call itself verified, and a rule nobody can
 * test is a rule nobody has checked.
 */

/**
 * Four outcomes, and the distinction between the last two is the whole point.
 *
 *   VERIFIED         every named test passed here
 *   PARTIAL          the evidence passed but covers only part of what the gate names
 *   BLOCKED_EXTERNAL the evidence could not run, and the reason is outside the product
 *   FAILED           the evidence did not run and nothing external explains why
 *
 * Reporting a blocked gate as FAILED is as misleading as reporting it VERIFIED:
 * it says the product is broken when what is missing is a Docker daemon.
 * Neither counts as passing.
 *
 * The trap this closes: `blocked` is prose the gate carries whatever machine it
 * runs on, and it was treated as proof. So a gate with a reason string could
 * never FAIL — delete its tests and the release went green, citing a Docker
 * daemon the machine might well have had. A reason is now only accepted when
 * the condition it names was actually observed on this run.
 *
 * @param gate     one entry from GATES
 * @param missing  named tests this run did not see pass
 * @param blockers map of blocker id -> () => boolean, observed on this machine
 */
export function gateStatus(gate, missing, blockers) {
  if (missing.length === 0) return gate.blocked ? 'PARTIAL' : 'VERIFIED';
  const check = gate.blockedBy ? blockers[gate.blockedBy] : null;
  if (!check) return 'FAILED';
  return check() ? 'BLOCKED_EXTERNAL' : 'FAILED';
}

/** A release is allowed through only when no gate FAILED. */
export function gatesPass(gates) {
  return gates.every((g) => g.status !== 'FAILED');
}
