import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NON_SPENDING_PRICING, PRICING_KINDS, TRUST_LEVELS, type ProviderDescriptor } from '@meridian/shared';
import { PROVIDER_CATALOG, createRegistry, discoverEnvCredentials } from '@meridian/provider-sdk';

/**
 * The contract every provider integration has to satisfy, checked mechanically.
 *
 * "No fake integrations" is a promise that only means something if it is
 * enforced. Each check below turns one clause of it into a test: an adapter may
 * not advertise a surface it has no method for, a remote provider may not claim
 * to know a data-use policy it has not been told, a free tier may not be
 * described as permanent, and a provider may not name an environment variable
 * the documentation does not mention.
 *
 * Nothing here touches the network. These are claims Meridian makes about
 * itself, and they must hold before a single request is sent.
 */

const registry = createRegistry();
const providers = registry.list();

/** Every optional adapter method, paired with the capability that advertises it. */
const SURFACE_METHODS = [
  ['chat', 'chat'],
  ['streaming', 'chatStream'],
  ['embedding', 'embed'],
  ['image', 'image'],
  ['video', 'video'],
  ['speech', 'speech'],
  ['transcription', 'transcribe'],
  ['discovery', 'listModels'],
  ['health', 'healthCheck'],
] as const;

describe('Provider contract', () => {
  it('registers every catalog entry with a working adapter factory', () => {
    assert.ok(PROVIDER_CATALOG.length >= 20, `expected a real catalog, saw ${PROVIDER_CATALOG.length}`);
    for (const descriptor of PROVIDER_CATALOG) {
      assert.ok(registry.hasAdapter(descriptor), `${descriptor.id} names adapter "${descriptor.adapter}", which is not registered`);
      const adapter = registry.get(descriptor.id);
      assert.ok(adapter, `${descriptor.id} could not be instantiated`);
      assert.equal(adapter.descriptor.id, descriptor.id);
    }
  });

  it('never advertises a surface the adapter has no method for', () => {
    for (const descriptor of providers) {
      const adapter = registry.get(descriptor.id);
      assert.ok(adapter);
      const caps = adapter.surface() as unknown as Record<string, boolean>;
      const impl = adapter as unknown as Record<string, unknown>;

      for (const [capability, method] of SURFACE_METHODS) {
        if (!caps[capability]) continue;
        assert.equal(
          typeof impl[method],
          'function',
          `${descriptor.id} advertises "${capability}" but has no ${method}() — this is exactly the fake support the contract forbids`,
        );
      }
      // Tools and vision ride the chat surface rather than having their own
      // method, so they are only meaningful alongside it.
      if (caps.tools || caps.vision) {
        assert.equal(caps.chat, true, `${descriptor.id} claims tools or vision without claiming chat`);
      }
    }
  });

  it('describes data use honestly, and never guesses a policy', () => {
    for (const descriptor of providers) {
      const use = descriptor.dataUse;
      assert.ok(use, `${descriptor.id} has no data-use posture`);
      assert.ok(
        ['allowed', 'not_allowed', 'unknown', 'opt_out', 'opt_in'].includes(use.trainingUse),
        `${descriptor.id} has an unrecognised trainingUse "${use.trainingUse}"`,
      );

      if (descriptor.local) {
        // Nothing leaves the machine, so this is the one case that can be stated
        // as fact rather than read off a policy page.
        assert.equal(use.trainingUse, 'not_allowed', `${descriptor.id} runs locally; its data cannot be used for training`);
        assert.equal(descriptor.defaultPricing.kind, 'LOCAL', `${descriptor.id} runs locally and must not be priced as a service`);
        continue;
      }

      // A remote provider's policy is theirs to state and ours to link, never to
      // infer. Anything not marked unknown has to be backed by a citation.
      if (use.trainingUse !== 'unknown') {
        assert.ok(use.policyUrl, `${descriptor.id} states a training-use policy without linking one`);
      }
      assert.ok(use.policyUrl || use.trainingUse === 'unknown', `${descriptor.id} needs either a policy link or an honest "unknown"`);
    }
  });

  it('uses only the shared vocabulary for pricing and trust', () => {
    for (const descriptor of providers) {
      assert.ok(PRICING_KINDS.includes(descriptor.defaultPricing.kind), `${descriptor.id} has pricing kind "${descriptor.defaultPricing.kind}"`);
      assert.ok(TRUST_LEVELS.includes(descriptor.trust), `${descriptor.id} has trust "${descriptor.trust}"`);
    }
  });

  it('never describes a promotional credit as permanently free', () => {
    for (const descriptor of providers) {
      const pricing = descriptor.defaultPricing;
      if (pricing.kind !== 'TRIAL' && pricing.kind !== 'CREDIT') continue;
      // A trial or a credit balance runs out. Calling it FREE would send the
      // router to it under a free-only policy and the user a bill afterwards.
      assert.ok(
        !NON_SPENDING_PRICING.includes(pricing.kind),
        `${descriptor.id} treats ${pricing.kind} as non-spending; a balance that runs out is not free capacity`,
      );
      assert.ok(pricing.note, `${descriptor.id} offers ${pricing.kind} pricing without saying what the limit is`);
    }
  });

  it('names only environment variables the documentation explains', () => {
    const docs = readFileSync('docs/CONFIGURATION.md', 'utf8') + readFileSync('.env.example', 'utf8');
    const missing: string[] = [];
    for (const descriptor of providers) {
      for (const key of [...descriptor.envKeys, ...(descriptor.baseUrlEnvKeys ?? [])]) {
        if (!docs.includes(key)) missing.push(`${descriptor.id}:${key}`);
      }
    }
    assert.deepEqual(missing, [], `these credentials are read but never documented: ${missing.join(', ')}`);
  });

  it('gives every provider a base URL that is https, or is local', () => {
    for (const descriptor of providers) {
      if (descriptor.local) continue;
      assert.ok(
        descriptor.baseUrl.startsWith('https://'),
        `${descriptor.id} would send credentials over ${descriptor.baseUrl.split(':')[0]}`,
      );
    }
  });

  it('requires a credential wherever one is actually needed', () => {
    for (const descriptor of providers) {
      if (descriptor.auth === 'none') {
        // An anonymous provider must not list credential variables: everything
        // in envKeys is read as a secret, sealed and sent as this provider's
        // key, so an endpoint override in there would be stored as a credential.
        assert.deepEqual(descriptor.envKeys, [], `${descriptor.id} is anonymous but names credential env keys ${descriptor.envKeys.join(', ')}`);
        continue;
      }
      assert.ok(descriptor.envKeys.length > 0, `${descriptor.id} needs auth but names no environment variable to supply it`);
      for (const key of descriptor.envKeys) {
        assert.ok(
          !/_BASE_URL$|_URL$|_ENDPOINT$/.test(key),
          `${descriptor.id} lists ${key} as a credential; an endpoint belongs in baseUrlEnvKeys`,
        );
      }
    }
  });

  it('reports a provider with no credential as not configured rather than available', () => {
    for (const descriptor of providers) {
      if (descriptor.auth === 'none' || descriptor.local) continue;
      assert.equal(
        registry.supportState(descriptor.id),
        'not_configured',
        `${descriptor.id} claims to be usable without a credential`,
      );
    }
    assert.deepEqual(
      registry.usable().filter((p) => p.auth !== 'none' && !p.local),
      [],
      'nothing requiring a credential may appear usable before one is supplied',
    );
  });

  it('applies an endpoint override from the environment without treating it as a secret', () => {
    const overridden = createRegistry({ env: { LLAMACPP_BASE_URL: 'http://gpu-box.lan:9001/v1/' } as NodeJS.ProcessEnv });
    assert.equal(overridden.descriptor('llamacpp')?.baseUrl, 'http://gpu-box.lan:9001/v1');

    // And it must not have become a credential.
    const found = discoverEnvCredentials(overridden.list(), { LLAMACPP_BASE_URL: 'http://gpu-box.lan:9001/v1' } as NodeJS.ProcessEnv);
    assert.deepEqual(found, [], 'an endpoint override must never be stored as this provider\'s key');

    // A malformed override is ignored rather than producing an unexplained
    // failure on the first request.
    const bad = createRegistry({ env: { LLAMACPP_BASE_URL: 'not a url' } as NodeJS.ProcessEnv });
    assert.equal(bad.descriptor('llamacpp')?.baseUrl, 'http://localhost:8080/v1');
  });

  it('reads credentials only from the variables each provider documents', () => {
    const env = {
      GROQ_API_KEY: 'gsk_test_value',
      AWS_SECRET_ACCESS_KEY: 'should-not-be-touched',
      GITHUB_TOKEN: 'ghp_should-not-be-touched',
      OPENAI_SESSION_TOKEN: 'should-not-be-touched',
    } as NodeJS.ProcessEnv;
    const found = discoverEnvCredentials(providers, env);
    assert.deepEqual(
      found.map((f) => `${f.providerId}:${f.envKey}`),
      ['groq:GROQ_API_KEY'],
      'discovery must read the documented variables and nothing else',
    );
  });

  it('keeps provider ids stable and unique', () => {
    const seen = new Set<string>();
    for (const descriptor of PROVIDER_CATALOG as ProviderDescriptor[]) {
      assert.ok(/^[a-z0-9-]+$/.test(descriptor.id), `"${descriptor.id}" is not a stable slug`);
      assert.ok(!seen.has(descriptor.id), `duplicate provider id "${descriptor.id}"`);
      seen.add(descriptor.id);
      assert.ok(descriptor.name.trim().length > 0, `${descriptor.id} has no display name`);
    }
  });
});
