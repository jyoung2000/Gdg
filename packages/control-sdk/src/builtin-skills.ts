import type { SkillInput } from './skills.js';

/**
 * Skills Meridian ships with.
 *
 * They exist so a fresh install has something real to assign, compare and
 * exclude — an empty Skills screen teaches nobody how precedence works. They
 * are seeded once, marked `builtin`, and are editable and deletable like any
 * other: shipped defaults should not be undeletable furniture.
 */
export const BUILTIN_SKILLS: SkillInput[] = [
  {
    slug: 'concise-answers',
    name: 'Concise answers',
    description: 'Prefer short, direct replies with the conclusion first.',
    tags: ['style'],
    source: 'builtin',
    content: `Lead with the answer, then the reasoning if it is needed.
Prefer complete sentences over fragments, but do not pad.
When you are unsure, say what you are unsure about rather than hedging every sentence.`,
  },
  {
    slug: 'code-review',
    name: 'Code review',
    description: 'Review changes for correctness first, then clarity.',
    tags: ['engineering'],
    source: 'builtin',
    content: `When reviewing code, rank findings by whether they can produce wrong behaviour.
For each finding give the concrete input or state that breaks, not a general principle.
Separate correctness problems from style preferences and label which is which.
Do not restate what the code does; the reviewer can read it.`,
  },
  {
    slug: 'cite-sources',
    name: 'Cite sources',
    description: 'Attribute factual claims to where they came from.',
    tags: ['research'],
    requiresCapabilities: ['tools'],
    source: 'builtin',
    content: `When you state a fact you learned from a page or a tool result, say which source it came from.
If a claim comes from your own prior knowledge rather than a retrieved source, say so.
Never present an inference as something a source stated.`,
  },
  {
    slug: 'describe-images',
    name: 'Describe images carefully',
    description: 'Read images precisely and separate what is visible from what is inferred.',
    tags: ['multimodal'],
    requiresCapabilities: ['vision'],
    source: 'builtin',
    content: `When an image is supplied, describe what is actually visible before interpreting it.
Distinguish text you can read verbatim from text you are guessing at.
If part of the image is unclear or cut off, say which part rather than filling it in.`,
  },
  {
    slug: 'tool-discipline',
    name: 'Tool discipline',
    description: 'Use tools deliberately and report failures honestly.',
    tags: ['agent'],
    requiresCapabilities: ['tools'],
    source: 'builtin',
    content: `Call a tool when it will give you information you do not have; do not call one to look busy.
Read the whole tool result before acting on it.
If a tool fails, report what failed and why rather than retrying the same call unchanged.
Never claim you performed an action that a tool result does not show succeeding.`,
  },
];
