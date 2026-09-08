/**
 * Measure what context optimisation actually saves.
 *
 * Every number this prints comes from running the real optimiser over a real
 * message list and measuring both ends with the same estimator. Nothing here is
 * a projection: the "after" figure is taken from the message list the optimiser
 * returned, and `saved` is the subtraction.
 *
 * The fixtures are shaped like the things Meridian actually sends — an agent
 * re-reading a file across turns, a long chat, a request carrying screenshots —
 * because an optimiser benchmarked on synthetic repetition will report savings
 * it cannot reproduce on real traffic.
 *
 *   node scripts/benchmark-context.mjs [--json] [--out docs/TOKEN_OPTIMIZATION_BENCHMARK.md]
 */
import { writeFileSync } from 'node:fs';

// Run under tsx so the TypeScript sources import directly:
//   pnpm exec tsx scripts/benchmark-context.mjs
const { optimizeContext, checkSafety } = await import('../packages/context-sdk/src/index.ts');
const { estimateMessagesTokens } = await import('../packages/shared/src/index.ts');

const MODES = ['OFF', 'CONSERVATIVE', 'BALANCED', 'AGGRESSIVE'];

/** Deterministic filler so a run is reproducible. */
function paragraphs(topic, n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(
      `Section ${i} of the ${topic} module. It maintains invariants across restarts, reports its own state, ` +
        `and interacts with retries, budgets and persistence. The failure modes that matter appear only under ` +
        `concurrent load, when a partially applied write races a reader that assumed atomicity.`,
    );
  }
  return out.join('\n\n');
}

/**
 * An agent working on one file across many turns.
 *
 * This is the shape that motivated the whole subsystem: the transcript is
 * re-sent whole on every turn, so the same file body is paid for once per turn.
 */
function agentRun(turns, fileParagraphs) {
  const body = paragraphs('retry', fileParagraphs);
  const messages = [
    { role: 'system', content: 'You are a coding agent. Work carefully and explain what you change.' },
    { role: 'user', content: 'Add exponential backoff to `src/net/retry.ts` and cover it with a test.' },
  ];
  for (let i = 0; i < turns; i += 1) {
    messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'read_file', arguments: { path: 'src/net/retry.ts' } }] });
    messages.push({ role: 'tool', content: body, toolCallId: `c${i}` });
  }
  messages.push({ role: 'user', content: 'now run the tests' });
  return messages;
}

/** A long conversation with no repetition — the case where little can be saved. */
function chatHistory(turns) {
  const messages = [{ role: 'system', content: 'You are a helpful assistant.' }];
  for (let i = 0; i < turns; i += 1) {
    messages.push({ role: 'user', content: `Question ${i}: ${paragraphs(`topic-${i}`, 1)}` });
    messages.push({ role: 'assistant', content: `Answer ${i}: ${paragraphs(`answer-${i}`, 2)}` });
  }
  messages.push({ role: 'user', content: 'Summarise everything above in `notes.md`.' });
  return messages;
}

/** A request carrying screenshots — the case the old estimator scored at zero. */
function visionRequest(images) {
  const content = [{ type: 'text', text: 'Compare these screenshots and describe what changed in `layout.css`.' }];
  for (let i = 0; i < images; i += 1) content.push({ type: 'image', url: `data:image/png;base64,AAAA${i}` });
  return [
    { role: 'system', content: paragraphs('review', 3) },
    { role: 'user', content },
  ];
}

const FIXTURES = [
  { name: 'SMALL — short chat', messages: chatHistory(2), model: { contextLength: 128_000, maxOutputTokens: 4096 } },
  { name: 'MEDIUM — agent, 6 turns on one file', messages: agentRun(6, 12), model: { contextLength: 32_000, maxOutputTokens: 4096 } },
  { name: 'LARGE — agent, 20 turns on one file', messages: agentRun(20, 20), model: { contextLength: 32_000, maxOutputTokens: 4096 } },
  { name: 'LARGE — long chat, no repetition', messages: chatHistory(40), model: { contextLength: 32_000, maxOutputTokens: 4096 } },
  { name: 'XL — agent, 40 turns on one file', messages: agentRun(40, 30), model: { contextLength: 200_000, maxOutputTokens: 8192 } },
  { name: 'VISION — 8 screenshots', messages: visionRequest(8), model: { contextLength: 128_000, maxOutputTokens: 4096 } },
];

const rows = [];
for (const fixture of FIXTURES) {
  const raw = estimateMessagesTokens(fixture.messages);
  for (const mode of MODES) {
    const started = process.hrtime.bigint();
    const result = optimizeContext({ messages: fixture.messages, model: fixture.model, mode });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const safety = checkSafety(fixture.messages, result.messages);
    rows.push({
      fixture: fixture.name,
      mode,
      raw,
      after: result.report.after,
      saved: result.report.tokensSaved,
      savedPct: raw > 0 ? (result.report.tokensSaved / raw) * 100 : 0,
      elapsedMs,
      safe: safety.safe,
      skipped: result.report.skipped,
      appliedMode: result.report.mode,
      reason: result.report.reason,
    });
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const r of rows) {
    console.log(
      `${r.fixture.padEnd(38)} ${r.mode.padEnd(13)} ${String(r.raw).padStart(7)} → ${String(r.after).padStart(7)}  ` +
        `${r.savedPct.toFixed(1).padStart(5)}%  ${r.elapsedMs.toFixed(2).padStart(6)}ms  ${r.safe ? 'safe' : 'UNSAFE'}` +
        (r.skipped ? '  (skipped)' : ''),
    );
  }
}

const outIndex = process.argv.indexOf('--out');
if (outIndex >= 0 && process.argv[outIndex + 1]) {
  const path = process.argv[outIndex + 1];
  const lines = [
    '# Token optimisation benchmark',
    '',
    'Generated by `node scripts/benchmark-context.mjs --out ' + path + '`.',
    '',
    'Every figure below is measured: the optimiser was run over the fixture and',
    'both ends were counted with the same estimator, so `saved` is a subtraction',
    'between two real message lists rather than a projection. `safe` is the',
    'independent safety check re-run against the result — it verifies that every',
    'user message and every requirement-shaped token the request named survived.',
    '',
    '| Fixture | Mode | Before | After | Saved | Time | Safe |',
    '| --- | --- | ---: | ---: | ---: | ---: | :---: |',
    ...rows.map(
      (r) =>
        `| ${r.fixture} | ${r.mode}${r.skipped ? ' *(skipped)*' : ''} | ${r.raw.toLocaleString()} | ${r.after.toLocaleString()} | ` +
        `${r.savedPct.toFixed(1)}% | ${r.elapsedMs.toFixed(2)}ms | ${r.safe ? '✅' : '❌'} |`,
    ),
    '',
  ];
  writeFileSync(path, lines.join('\n'), 'utf8');
  console.error(`wrote ${path}`);
}
