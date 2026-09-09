import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assessProviderBaseUrl, assessUrl, isPrivateHost, normalizeIpv4 } from '@meridian/shared';

/**
 * The address guard, tested from the attacker's side.
 *
 * Every case here is a way of writing an address that reaches somewhere it
 * should not while looking like something else. Three of them defeated the
 * version of this code that shipped before it was consolidated.
 */

describe('IPv4, in all the ways it can be written', () => {
  it('recognises the spellings inet_aton accepts', () => {
    // `curl http://2130706433/` connects to 127.0.0.1. So does the operating
    // system underneath any HTTP client, which is why a guard that only knows
    // dotted quad is not a guard.
    assert.equal(normalizeIpv4('2130706433'), '127.0.0.1');
    assert.equal(normalizeIpv4('0177.0.0.1'), '127.0.0.1');
    assert.equal(normalizeIpv4('0x7f.0.0.1'), '127.0.0.1');
    assert.equal(normalizeIpv4('127.1'), '127.0.0.1');
    assert.equal(normalizeIpv4('127.0.1'), '127.0.0.1');
    assert.equal(normalizeIpv4('0x7f000001'), '127.0.0.1');
  });

  it('leaves ordinary addresses alone', () => {
    assert.equal(normalizeIpv4('8.8.8.8'), '8.8.8.8');
    assert.equal(normalizeIpv4('192.0.2.1'), '192.0.2.1');
  });

  it('says "not an address" rather than guessing', () => {
    for (const host of ['example.com', 'api.openai.com', '', '1.2.3.4.5', '256.0.0.1', '127.0.0.999', 'v1']) {
      assert.equal(normalizeIpv4(host), null, `${host} was read as an address`);
    }
  });
});

describe('Private space', () => {
  it('blocks every cloud metadata service', () => {
    // These are the addresses that hand out instance credentials to anything
    // that asks from inside the machine.
    for (const host of [
      '169.254.169.254', // AWS, GCP, Azure, DigitalOcean, Oracle
      '100.100.100.200', // Alibaba Cloud
      'metadata.google.internal',
      'fd00:ec2::254', // AWS over IPv6
      '[fd00:ec2::254]',
    ]) {
      assert.ok(isPrivateHost(host), `${host} was allowed`);
    }
  });

  it('blocks loopback however it is spelled', () => {
    for (const host of ['127.0.0.1', 'localhost', '2130706433', '0177.0.0.1', '127.1', '::1', '[::1]', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      assert.ok(isPrivateHost(host), `${host} reached loopback`);
    }
  });

  it('blocks the IPv6 forms that carry an IPv4 address inside them', () => {
    // 6to4 and NAT64 embed a v4 address, so they reach whatever it reaches.
    assert.ok(isPrivateHost('::ffff:169.254.169.254'), 'IPv4-mapped');
    assert.ok(isPrivateHost('64:ff9b::169.254.169.254'), 'NAT64');
    assert.ok(isPrivateHost('2002:a9fe:a9fe::'), '6to4 wrapping 169.254.169.254');
  });

  it('blocks RFC1918, CGNAT and link-local', () => {
    for (const host of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '169.254.1.1', '0.0.0.0']) {
      assert.ok(isPrivateHost(host), `${host} was allowed`);
    }
  });

  it('blocks names that resolve inside a network by convention', () => {
    for (const host of ['redis.internal', 'db.local', 'app.localhost', 'kubernetes.svc', 'postgres.svc.cluster.local']) {
      assert.ok(isPrivateHost(host), `${host} was allowed`);
    }
  });

  it('allows the public internet, which is the point', () => {
    for (const host of ['api.openai.com', 'openrouter.ai', '8.8.8.8', '1.1.1.1', '2606:4700::1111', 'huggingface.co']) {
      assert.ok(!isPrivateHost(host), `${host} was blocked`);
    }
  });

  it('does not confuse a public address for a private one', () => {
    // 172.32 is outside RFC1918 and 100.128 is outside CGNAT. Over-blocking is
    // a real cost: it makes a legitimate provider unreachable with a security
    // message, which is the kind of bug people work around by disabling guards.
    assert.ok(!isPrivateHost('172.32.0.1'));
    assert.ok(!isPrivateHost('172.15.0.1'));
    assert.ok(!isPrivateHost('100.128.0.1'));
    assert.ok(!isPrivateHost('11.0.0.1'));
  });
});

describe('Judging a URL', () => {
  it('refuses a scheme that is not http or https', () => {
    for (const raw of ['file:///etc/passwd', 'gopher://x/', 'ftp://x/', 'data:text/plain,hi']) {
      const v = assessUrl(raw);
      assert.equal(v.ok, false, `${raw} was allowed`);
      if (!v.ok) assert.equal(v.reason, 'scheme');
    }
  });

  it('refuses credentials in the URL', () => {
    // A key in a URL is a key in the access log, the error message, and the
    // string the UI echoes back when the request fails.
    const v = assessUrl('https://sk-abc123@api.example.com/v1');
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.reason, 'credentials');
  });

  it('refuses plain http to a public host', () => {
    const v = assessUrl('http://api.example.com/v1');
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.reason, 'scheme');
  });

  it('allows plain http to loopback, when loopback is allowed', () => {
    // Ollama does not serve TLS, and telling people to put a certificate on
    // 127.0.0.1 to satisfy a checkbox is how a guard gets turned off.
    const v = assessUrl('http://127.0.0.1:11434', { allowPrivate: true });
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.private, true);
  });

  it('refuses private space by default', () => {
    const v = assessUrl('http://169.254.169.254/latest/meta-data/');
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.equal(v.reason, 'private-address');
      assert.match(v.message, /API key/);
    }
  });

  it('says what is wrong, not merely that something is', () => {
    const v = assessUrl('not a url at all');
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.reason, 'unparseable');
  });
});

describe('A provider’s base URL', () => {
  it('lets a local provider point at the machine it runs on', () => {
    for (const raw of ['http://127.0.0.1:11434', 'http://localhost:1234/v1', 'http://[::1]:8080/v1']) {
      assert.equal(assessProviderBaseUrl(raw, { local: true }).ok, true, `${raw} was refused`);
    }
  });

  it('refuses to point a hosted provider at private space', () => {
    // The attack this stops: repoint "openai" at an address that logs what it
    // receives, and every subsequent call delivers the operator's API key.
    for (const raw of [
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://127.0.0.1:8080/v1',
      'http://2130706433/v1',
      'http://[::ffff:169.254.169.254]/v1',
      'http://metadata.google.internal/computeMetadata/v1/',
    ]) {
      const v = assessProviderBaseUrl(raw, { local: false });
      assert.equal(v.ok, false, `${raw} was allowed for a hosted provider`);
      if (!v.ok) assert.equal(v.reason, 'private-address');
    }
  });

  it('allows a real endpoint', () => {
    for (const raw of ['https://api.openai.com/v1', 'https://openrouter.ai/api/v1', 'https://generativelanguage.googleapis.com/v1beta']) {
      assert.equal(assessProviderBaseUrl(raw, { local: false }).ok, true, `${raw} was refused`);
    }
  });
});
