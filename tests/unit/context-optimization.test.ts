import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoMode,
  checkSafety,
  computeBudget,
  deduplicate,
  elideStaleToolResults,
  MIN_TOKENS_TO_OPTIMIZE,
  optimizeContext,
  overlapScore,
  select,
  terms,
  windowHistory,
} from '@meridian/context-sdk';
import { breakdownTokens, estimateMessagesTokens, type ChatMessage, type ToolDefinition } from '@meridian/shared';

/**
 * The optimiser's job is to remove what does not matter and keep what does.
 * These tests are mostly about the second half, because the first half is easy
 * and the second half is where an optimiser silently ruins a system.
 */

/** Enough distinct prose to be worth optimising, without being noise. */
function prose(topic: string, paragraphs: number): string {
  const out: string[] = [];
  for (let i = 0; i < paragraphs; i += 1) {
    out.push(
      `Section ${i} about ${topic}. The ${topic} subsystem maintains invariants across restarts and reports its own state. ` +
        `Operators reading this need to understand how ${topic} interacts with retries, budgets and the persistence layer, ` +
        `including the failure modes that only appear under concurrent load.`,
    );
  }
  return out.join('\n\n');
}

function userMsg(text: string): ChatMessage {
  return { role: 'user', content: text };
}
function toolMsg(text: string, id = 'call_1'): ChatMessage {
  return { role: 'tool', content: text, toolCallId: id };
}

describe('Token accounting', () => {
  it('counts an image as real tokens rather than as nothing', () => {
    const withImage: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image', url: 'data:image/png;base64,AAAA' }] },
    ];
    const textOnly: ChatMessage[] = [{ role: 'user', content: 'what is this' }];
    assert.ok(
      estimateMessagesTokens(withImage) > estimateMessagesTokens(textOnly) + 500,
      'an image must cost substantially more than the text beside it',
    );
  });

  it('counts a tool schema, which is often the largest part of a request', () => {
    const tool: ToolDefinition = {
      name: 'search_repository',
      description: 'Search the repository for a pattern and return matching lines with their file and line number.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'A regular expression to match against file contents.' },
          glob: { type: 'string', description: 'Restrict the search to files matching this glob.' },
        },
        required: ['pattern'],
      },
    };
    const b = breakdownTokens({ messages: [userMsg('hi')], tools: [tool] });
    assert.ok(b.tools > 30, `a real tool schema should cost real tokens, got ${b.tools}`);
    assert.equal(b.total, b.system + b.conversation + b.tools);
  });

  it('attributes tokens to where they came from', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: prose('routing', 3) },
      { role: 'user', content: 'fix the bug' },
      { role: 'user', content: [{ type: 'image', url: 'data:image/png;base64,AA' }] },
    ];
    const b = breakdownTokens({ messages });

    assert.ok(b.system > 100, 'a three-paragraph system prompt is not free');
    assert.equal(b.imageCount, 1);
    // One screenshot outweighs three paragraphs of prose, which is exactly why
    // the old estimator counting images as zero was not a rounding error.
    assert.ok(b.images > b.system, `one image (${b.images}) should outweigh the prose (${b.system})`);
    assert.equal(b.total, b.system + b.conversation + b.tools);
  });
});

describe('Context budget', () => {
  it('reserves room for the answer rather than filling the window', () => {
    const budget = computeBudget({ model: { contextLength: 10_000, maxOutputTokens: 2000 }, usedTokens: 1000 });
    assert.ok(budget.available != null && budget.available < 10_000 - 2000 + 1);
    assert.equal(budget.over, false);
  });

  it('reports an unpublished window as unknown rather than as full', () => {
    const budget = computeBudget({ model: { contextLength: null, maxOutputTokens: null }, usedTokens: 500_000 });
    assert.equal(budget.available, null);
    assert.equal(budget.pressure, null);
    assert.equal(budget.over, false, 'missing metadata must not become a failed request');
  });

  it('says when a prompt does not fit', () => {
    const budget = computeBudget({ model: { contextLength: 4000, maxOutputTokens: 1000 }, usedTokens: 3900 });
    assert.equal(budget.over, true);
  });
});

describe('Automatic mode selection', () => {
  it('leaves a small prompt in a large window alone', () => {
    assert.equal(autoMode(2000, 128_000), 'OFF');
  });

  it('escalates as the window fills', () => {
    assert.equal(autoMode(40_000, 128_000), 'CONSERVATIVE');
    assert.equal(autoMode(70_000, 128_000), 'BALANCED');
    assert.equal(autoMode(110_000, 128_000), 'AGGRESSIVE');
  });

  it('still deduplicates when the window is unknown', () => {
    assert.equal(autoMode(50_000, null), 'CONSERVATIVE');
  });
});

describe('Deduplication', () => {
  it('removes a repeated block and keeps the later copy', () => {
    const body = prose('persistence', 6);
    const messages: ChatMessage[] = [userMsg('read the file twice'), toolMsg(body), { role: 'assistant', content: 'ok' }, toolMsg(body)];

    const { messages: out, notes } = deduplicate(messages);
    assert.equal(out.length, messages.length, 'nothing is deleted; the earlier copy is replaced by a marker');
    assert.match(String(out[1].content), /omitted/);
    assert.equal(out[3].content, body, 'the most recent copy is the one that survives');
    assert.ok(notes[0].tokensSaved > 0);
  });

  it('never touches a user message, even a repeated one', () => {
    const body = prose('routing', 6);
    const messages: ChatMessage[] = [userMsg(body), userMsg(body)];
    const { messages: out } = deduplicate(messages);
    assert.deepEqual(out, messages, 'what the user said is the request, however often they said it');
  });
});

describe('Tool-result elision', () => {
  it('keeps recent results whole and shortens older ones', () => {
    const messages: ChatMessage[] = [
      userMsg('build the thing'),
      toolMsg(prose('step one', 8), 'c1'),
      toolMsg(prose('step two', 8), 'c2'),
      toolMsg(prose('step three', 8), 'c3'),
    ];
    const { messages: out, notes } = elideStaleToolResults(messages, 1);
    assert.match(String(out[1].content), /omitted/);
    assert.match(String(out[2].content), /omitted/);
    assert.equal(out[3].content, messages[3].content, 'the newest result is what the model is working on');
    assert.ok(notes[0].tokensSaved > 0);
  });

  it('leaves a short result alone, because there is nothing to gain', () => {
    const messages: ChatMessage[] = [userMsg('go'), toolMsg('ok', 'c1'), toolMsg('done', 'c2')];
    const { messages: out } = elideStaleToolResults(messages, 1);
    assert.deepEqual(out, messages);
  });
});

describe('History windowing', () => {
  it('keeps the system prompt, the original request and the recent turns', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a coding agent.' },
      userMsg('Implement retry with backoff in `src/net/retry.ts`.'),
      ...Array.from({ length: 20 }, (_, i): ChatMessage => ({ role: 'assistant', content: `step ${i}: ${prose('work', 2)}` })),
      userMsg('now add a test'),
    ];

    const { messages: out, notes } = windowHistory(messages, 4);

    assert.equal(out[0].content, 'You are a coding agent.', 'instructions survive');
    assert.ok(
      out.some((m) => m.role === 'user' && String(m.content).includes('src/net/retry.ts')),
      'the original task survives — losing it is how an agent forgets what it was asked',
    );
    assert.equal(out[out.length - 1].content, 'now add a test', 'the newest turn survives');
    assert.ok(out.some((m) => String(m.content).includes('omitted')), 'the gap is declared rather than hidden');
    assert.ok(notes[0].tokensSaved > 0);
    assert.ok(out.length < messages.length);
  });

  it('carries the references a dropped turn named into the marker it leaves', () => {
    // This is what makes windowing a long conversation permissible at all. The
    // prose of turn three may go; the fact that turn three said "in
    // `src/db/users.ts`" may not, because that is what the request is about.
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      userMsg('start the migration work'),
      userMsg('the schema lives in `src/db/users.ts` and the fixture is "seed-users"'),
      ...Array.from({ length: 12 }, (_, i): ChatMessage => ({ role: 'assistant', content: `${prose('work', 2)} ${i}` })),
      userMsg('now finish it'),
    ];

    const { messages: out } = windowHistory(messages, 3);
    const whole = out.map((m) => String(m.content)).join('\n');

    assert.ok(!out.some((m) => String(m.content).includes('the schema lives in')), 'the prose of the old turn is gone');
    assert.ok(whole.includes('`src/db/users.ts`'), 'but the file it named survives');
    assert.ok(whole.includes('"seed-users"'), 'and so does the quoted identifier');
  });

  it('does not orphan a tool result from the call that produced it', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      userMsg('do it'),
      ...Array.from({ length: 10 }, (_, i): ChatMessage => ({ role: 'assistant', content: `filler ${i} ${prose('x', 1)}` })),
      { role: 'assistant', content: '', toolCalls: [{ id: 'c9', name: 'read_file', arguments: {} }] },
      toolMsg(prose('file body', 3), 'c9'),
      userMsg('thanks'),
    ];

    const { messages: out } = windowHistory(messages, 3);
    const hasCall = out.some((m) => m.toolCalls?.some((c) => c.id === 'c9'));
    const hasResult = out.some((m) => m.role === 'tool' && m.toolCallId === 'c9');
    assert.equal(hasCall, hasResult, 'a tool call and its answer are kept or dropped together, never split');
  });
});

describe('Relevance selection', () => {
  it('strips words that say nothing about what a request is about', () => {
    const t = terms('Please can you update the database migration for me');
    assert.ok(t.has('database'));
    assert.ok(t.has('migration'));
    assert.ok(!t.has('please'));
    assert.ok(!t.has('the'));
  });

  it('scores a matching document above an unrelated one', () => {
    const request = terms('add a database migration for the users table');
    assert.ok(
      overlapScore(request, 'How to write database migrations and alter a users table safely') >
        overlapScore(request, 'A guide to choosing typography and colour palettes'),
    );
  });

  it('never drops something the operator enabled explicitly', () => {
    const result = select('write a poem', [
      { id: 'sql-style', text: 'database migration conventions', estimatedTokens: 5000, pinned: true },
    ]);
    assert.deepEqual(result.included, ['sql-style']);
    assert.match(result.verdicts[0].reason, /explicit/);
  });

  it('keeps a cheap candidate rather than risking a wrong exclusion', () => {
    const result = select('write a poem', [{ id: 'tiny', text: 'database migrations', estimatedTokens: 50 }]);
    assert.deepEqual(result.included, ['tiny']);
    assert.match(result.verdicts[0].reason, /small enough/);
  });

  it('excludes an expensive, unrelated skill and says why', () => {
    const result = select('write a haiku about the sea', [
      { id: 'sql', text: 'database migration postgres index tuning vacuum analyze', estimatedTokens: 4000 },
    ]);
    assert.deepEqual(result.excluded, ['sql']);
    assert.equal(result.tokensSaved, 4000);
    assert.ok(result.verdicts[0].reason.length > 10);
  });
});

describe('Safety check', () => {
  it('rejects an optimisation that lost a user message', () => {
    const original: ChatMessage[] = [userMsg('rename getUserById in `src/db/users.ts`')];
    const verdict = checkSafety(original, [{ role: 'system', content: 'a summary of what the user wanted' }]);
    assert.equal(verdict.safe, false);
    assert.equal(verdict.issues[0].kind, 'no-user-message');
  });

  it('rejects an optimisation that dropped a filename the request named', () => {
    const original: ChatMessage[] = [
      { role: 'system', content: 'contents of `src/db/users.ts` follow' },
      userMsg('fix the bug in `src/db/users.ts`'),
    ];
    // The user message survives verbatim but is truncated — the requirement goes.
    const broken: ChatMessage[] = [userMsg('fix the bug in')];
    const verdict = checkSafety(original, broken);
    assert.equal(verdict.safe, false);
    assert.ok(verdict.issues.some((i) => i.kind === 'user-text-missing' || i.kind === 'requirement-missing'));
  });

  it('accepts an optimisation that only removed assistant chatter', () => {
    const original: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      userMsg('fix `a.ts`'),
      { role: 'assistant', content: 'thinking out loud' },
    ];
    const verdict = checkSafety(original, [{ role: 'system', content: 'sys' }, userMsg('fix `a.ts`')]);
    assert.equal(verdict.safe, true, verdict.issues.map((i) => i.detail).join('; '));
  });
});

describe('The optimiser end to end', () => {
  /** A long agent conversation with a repeated file read — the realistic case. */
  function agentConversation(): ChatMessage[] {
    const fileBody = prose('the retry module', 20);
    return [
      { role: 'system', content: 'You are a coding agent. Work carefully.' },
      userMsg('Add exponential backoff to `src/net/retry.ts` and cover it with a test.'),
      ...Array.from({ length: 12 }, (_, i): ChatMessage[] => [
        { role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'read_file', arguments: { path: 'src/net/retry.ts' } }] },
        toolMsg(fileBody, `c${i}`),
      ]).flat(),
      userMsg('now run the tests'),
    ];
  }

  it('does nothing to a prompt too small to be worth the risk', () => {
    const result = optimizeContext({ messages: [userMsg('hello')], mode: 'AGGRESSIVE' });
    assert.equal(result.report.skipped, true);
    assert.equal(result.report.tokensSaved, 0);
    assert.match(result.report.reason, new RegExp(String(MIN_TOKENS_TO_OPTIMIZE)));
    assert.deepEqual(result.messages, [userMsg('hello')]);
  });

  it('measurably reduces a long conversation', () => {
    const messages = agentConversation();
    const result = optimizeContext({ messages, mode: 'BALANCED', model: { contextLength: 32_000, maxOutputTokens: 4000 } });

    assert.equal(result.report.skipped, false);
    assert.ok(result.report.tokensSaved > 0, 'a conversation that reads one file twelve times has slack in it');
    assert.equal(result.report.after, estimateMessagesTokens(result.messages), 'the reported after-count is a real measurement');
    assert.equal(result.report.tokensSaved, result.report.before - result.report.after);
    assert.ok(result.report.savedFraction > 0.5, `expected a large saving, got ${Math.round(result.report.savedFraction * 100)}%`);
  });

  it('preserves the request through the most aggressive pass', () => {
    const messages = agentConversation();
    const result = optimizeContext({ messages, mode: 'AGGRESSIVE', model: { contextLength: 8000, maxOutputTokens: 1000 } });

    const whole = result.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    assert.ok(whole.includes('src/net/retry.ts'), 'the file the task names must survive');
    assert.ok(
      result.messages.some((m) => m.role === 'user' && String(m.content).includes('exponential backoff')),
      'the task itself must survive',
    );
    assert.ok(result.messages.some((m) => m.role === 'user' && String(m.content) === 'now run the tests'));
    // Whatever it did, it has to be able to prove it was safe.
    assert.equal(checkSafety(messages, result.messages).safe, true);
  });

  it('saves more as the mode gets more aggressive, and never less', () => {
    const messages = agentConversation();
    const model = { contextLength: 32_000, maxOutputTokens: 2000 };
    const off = optimizeContext({ messages, mode: 'OFF', model });
    const conservative = optimizeContext({ messages, mode: 'CONSERVATIVE', model });
    const balanced = optimizeContext({ messages, mode: 'BALANCED', model });
    const aggressive = optimizeContext({ messages, mode: 'AGGRESSIVE', model });

    assert.equal(off.report.tokensSaved, 0);
    assert.ok(conservative.report.tokensSaved > 0);
    assert.ok(balanced.report.tokensSaved >= conservative.report.tokensSaved);
    assert.ok(aggressive.report.tokensSaved >= balanced.report.tokensSaved);

    // And every one of them still asks the same question.
    for (const [name, r] of [['conservative', conservative], ['balanced', balanced], ['aggressive', aggressive]] as const) {
      assert.equal(checkSafety(messages, r.messages).safe, true, `${name} broke the request`);
    }
  });

  it('reports what it did in terms an operator can check', () => {
    const result = optimizeContext({
      messages: agentConversation(),
      mode: 'BALANCED',
      model: { contextLength: 32_000, maxOutputTokens: 2000 },
    });
    assert.ok(result.report.notes.length > 0);
    for (const note of result.report.notes) {
      assert.ok(note.stage.length > 0);
      assert.ok(note.detail.length > 10, `a note should be readable, got ${JSON.stringify(note.detail)}`);
      assert.ok(note.tokensSaved >= 0);
    }
    // Optimising has to be cheap relative to what it saves.
    assert.ok(result.report.elapsedMs < 1000, `optimisation took ${result.report.elapsedMs}ms`);
  });

  it('excludes an irrelevant skill and keeps a relevant one', () => {
    const messages = agentConversation();
    const result = optimizeContext({
      messages,
      mode: 'BALANCED',
      model: { contextLength: 32_000, maxOutputTokens: 2000 },
      request: 'Add exponential backoff to src/net/retry.ts and cover it with a test',
      skills: [
        { id: 'retry-conventions', text: 'retry backoff jitter exponential network resilience', estimatedTokens: 3000 },
        { id: 'brand-voice', text: 'tone of voice marketing copy headline capitalisation', estimatedTokens: 3000 },
      ],
    });
    assert.ok(result.skills.includes('retry-conventions'));
    assert.ok(!result.skills.includes('brand-voice'));
    const excluded = result.report.skillVerdicts.find((v) => v.id === 'brand-voice');
    assert.equal(excluded?.included, false);
    assert.ok(excluded && excluded.reason.length > 10);
  });

  it('filters tools only in the most aggressive mode', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'run_command',
        description: 'Run a shell command in the workspace and return its output, exit code and duration.',
        parameters: { type: 'object', properties: { command: { type: 'string', description: 'The command line to run.' } } },
      },
      {
        name: 'generate_image',
        description: 'Generate a picture from a text prompt using a diffusion model with configurable steps and guidance.',
        parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'What to draw.' } } },
      },
    ];
    const messages = agentConversation();
    const opts = { messages, tools, model: { contextLength: 32_000, maxOutputTokens: 2000 }, request: 'run the test command' };

    const balanced = optimizeContext({ ...opts, mode: 'BALANCED' });
    assert.equal(balanced.tools.length, 2, 'a missing tool changes what the model can do, so BALANCED leaves them alone');

    const aggressive = optimizeContext({ ...opts, mode: 'AGGRESSIVE' });
    assert.ok(aggressive.tools.length <= 2);
  });
});
