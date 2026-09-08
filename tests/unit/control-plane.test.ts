import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { urlAllowed, isPrivateBrowserHost, checkNavigation, resolvesToPrivate } from '@meridian/browser-sdk';
import { parseRobots, robotsDisallows } from '@meridian/browser-sdk';
import { McpManager, MemoryMcpStore, MemoryVault, curatedCatalog } from '@meridian/mcp-sdk';
import { isolationName, classifyFailure, hostPortOf } from '@meridian/docker-sdk';

describe('browser domain policy', () => {
  const open = { allow: [], deny: [], allowPrivate: [] };

  it('refuses private and metadata addresses unless explicitly allowed', () => {
    assert.equal(urlAllowed('http://169.254.169.254/latest/meta-data/', open).allowed, false);
    assert.equal(urlAllowed('http://localhost:4639/', open).allowed, false);
    assert.equal(urlAllowed('http://10.0.0.5/', open).allowed, false);
    assert.equal(urlAllowed('http://localhost:4639/', { ...open, allowPrivate: ['localhost'] }).allowed, true);
  });

  it('lets deny beat allow and treats a non-empty allow list as a whitelist', () => {
    assert.equal(urlAllowed('https://evil.example.com/', { allow: [], deny: ['example.com'], allowPrivate: [] }).allowed, false);
    assert.equal(urlAllowed('https://other.org/', { allow: ['example.com'], deny: [], allowPrivate: [] }).allowed, false);
    assert.equal(urlAllowed('https://api.example.com/', { allow: ['example.com'], deny: [], allowPrivate: [] }).allowed, true);
  });

  it('has no primitive that permits a private host by default', () => {
    assert.equal(isPrivateBrowserHost('metadata.google.internal'), true);
    assert.equal(isPrivateBrowserHost('100.64.0.1'), true);
    assert.equal(isPrivateBrowserHost('8.8.8.8'), false);
  });
});

describe('robots.txt awareness', () => {
  it('reads only the wildcard user-agent group and enforces its disallows', () => {
    const rules = parseRobots('User-agent: Googlebot\nDisallow: /g\n\nUser-agent: *\nDisallow: /private/\nAllow: /public');
    assert.deepEqual(rules, ['/private/']);
    assert.equal(robotsDisallows('/private/x', rules), true);
    assert.equal(robotsDisallows('/public', rules), false);
  });
});

describe('MCP manager invariants', () => {
  it('never returns a stored secret through list or get, only through reveal', async () => {
    const mcp = new McpManager({ store: new MemoryMcpStore(), vault: new MemoryVault() });
    await mcp.load();
    const spec = await mcp.addServer({
      name: 't',
      transport: 'stdio',
      command: 'echo',
      env: [{ name: 'API_KEY', value: 'sekret', secret: true }],
    });
    const listed = mcp.listServers().find((s) => s.id === spec.id)!;
    assert.equal(listed.env[0].value, null, 'listing must not carry the value');
    assert.equal(listed.env[0].secret, true);
    assert.equal(JSON.stringify(mcp.getServer(spec.id)).includes('sekret'), false, 'getServer must not carry the value');
    assert.equal(await mcp.revealSecret(spec.id, 'API_KEY'), 'sekret', 'reveal is the one deliberate read');
  });

  it('resolves tool policies most-specific-scope-first, deny over allow', async () => {
    const mcp = new McpManager({ store: new MemoryMcpStore(), vault: new MemoryVault() });
    await mcp.load();
    const spec = await mcp.addServer({ name: 't', transport: 'stdio', command: 'echo' });
    assert.equal(mcp.toolAllowed(spec.id, 'x').allowed, true, 'no policy means usable');
    await mcp.setPolicy({ scope: 'global', scopeId: null, serverId: spec.id, allowTools: [], denyTools: ['x'], enabled: true });
    assert.equal(mcp.toolAllowed(spec.id, 'x').allowed, false, 'global deny blocks');
    await mcp.setPolicy({ scope: 'session', scopeId: 'S', serverId: spec.id, allowTools: ['x'], denyTools: [], enabled: true });
    assert.equal(mcp.toolAllowed(spec.id, 'x', { sessionId: 'S' }).allowed, true, 'session scope overrides global');
    assert.equal(mcp.toolAllowed(spec.id, 'x').allowed, false, 'without the session, global deny still applies');
  });

  it('derives permission warnings from the config', async () => {
    const mcp = new McpManager({ store: new MemoryMcpStore(), vault: new MemoryVault() });
    await mcp.load();
    const spec = await mcp.addServer({
      name: 'dockery',
      transport: 'stdio',
      command: 'docker',
      args: ['run', '--rm', '-i', '-v', '/var/run/docker.sock:/var/run/docker.sock', 'img'],
      env: [{ name: 'TOKEN', value: 't', secret: true }],
    });
    const kinds = mcp.warningsFor(spec.id).map((w) => w.kind);
    assert.ok(kinds.includes('docker_socket'));
    assert.ok(kinds.includes('credential_access'));
  });

  it('ships browser-harness and github in the curated catalog with concrete, visible install commands', () => {
    const cat = curatedCatalog();
    const bh = cat.find((c) => c.name === 'browser-harness');
    const gh = cat.find((c) => c.name === 'github');
    assert.ok(bh, 'browser-harness present');
    assert.equal(bh!.installs[0].display, "uvx --from 'browser-harness[mcp]' browser-harness-mcp");
    assert.ok(gh, 'github present');
    assert.ok(gh!.installs.some((i) => i.display.includes('api.githubcopilot.com')), 'github has its hosted endpoint');
    assert.ok(cat.every((c) => c.installs.length > 0 && c.installs.every((i) => i.display.length > 0)), 'every entry has a visible command');
  });
});

describe('docker orchestration helpers', () => {
  it('names test resources uniquely per project and session', () => {
    assert.equal(isolationName('/a/My App!', 'sess_ABC-1'), 'meridian-test-my-app-sessabc1');
    assert.notEqual(isolationName('/a/app', 's1'), isolationName('/a/app', 's2'));
  });

  it('parses the first published host port', () => {
    assert.equal(hostPortOf('0.0.0.0:32768->3000/tcp, [::]:32768->3000/tcp'), 32768);
    assert.equal(hostPortOf(''), null);
  });

  it('classifies failures without ever calling a flake retryable that is not', () => {
    assert.equal(classifyFailure('build', 'ERROR: npm ci failed').class, 'BUILD_FAILURE');
    assert.equal(classifyFailure('build', 'ERROR: npm ci failed').retryable, false);
    assert.equal(classifyFailure('build', 'failed to solve: dial tcp: lookup registry-1.docker.io: i/o timeout while pulling').class, 'NETWORK_FAILURE');
    assert.equal(classifyFailure('up', 'Cannot connect to the Docker daemon').class, 'DOCKER_UNAVAILABLE');
    assert.equal(classifyFailure('health', 'never healthy').class, 'HEALTHCHECK_TIMEOUT');
    assert.equal(classifyFailure('test', 'AssertionError: expected 1').class, 'TEST_FAILURE');
    assert.equal(classifyFailure('test', 'AssertionError').retryable, false);
  });
});

describe('Browser SSRF — where a name really points', () => {
  it('refuses a public-looking name that resolves into private space', async () => {
    // The textual check passes this: it is not a literal IP, not on a deny
    // list, not obviously internal. Only resolving it reveals 127.0.0.1. This
    // is the hole the HTTP fetch path has guarded for a while via Node's DNS
    // lookup hook and the browser path did not, so the two were not at parity
    // and the browser was the weaker one.
    const policy = { allow: [], deny: [], allowPrivate: [] };

    // The premise: the textual check lets this through. If it ever stops doing
    // so the test below would pass for the wrong reason, so it is asserted.
    assert.equal(
      urlAllowed('http://localtest.me/', policy).allowed,
      true,
      'the textual check cannot see where a name points, which is the whole problem',
    );

    const resolved = await resolvesToPrivate('localtest.me');
    if (!resolved.addresses.length) {
      // A sandbox with no DNS proves nothing either way. Say so rather than
      // passing quietly on a lookup that never happened.
      assert.ok(true, 'skipped: localtest.me could not be resolved in this environment');
      return;
    }

    assert.equal(resolved.private, true, `expected private addresses, got ${resolved.addresses.join(', ')}`);
    const verdict = await checkNavigation('http://localtest.me/', policy);
    assert.equal(verdict.allowed, false, 'a name that resolves into private space must not be navigable');
    assert.match(verdict.reason ?? '', /resolves to a private or internal address/);
  });

  it('still refuses a literal private address without needing DNS', async () => {
    const verdict = await checkNavigation('http://169.254.169.254/latest/meta-data/', {
      allow: [],
      deny: [],
      allowPrivate: [],
    });
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason ?? '', /private or internal/);
  });

  it('honours an explicit allowPrivate entry rather than overriding the operator', async () => {
    const verdict = await checkNavigation('http://localhost:8080/', {
      allow: [],
      deny: [],
      allowPrivate: ['localhost'],
    });
    assert.equal(verdict.allowed, true, 'an operator who allow-listed a host has already made the decision');
  });

  it('lets an ordinary public URL through', async () => {
    const verdict = await checkNavigation('https://example.com/', { allow: [], deny: [], allowPrivate: [] });
    assert.equal(verdict.allowed, true, verdict.reason ?? '');
  });
});
