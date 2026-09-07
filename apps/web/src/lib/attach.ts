/**
 * Turn dropped or picked files into chat content the model can actually read.
 *
 * Two honest paths, and a refusal for everything else:
 *
 *  - An image becomes an OpenAI `image_url` part, which the gateway forwards to
 *    a vision model as a real image. A model without vision will not see it —
 *    that is the model's limit, not a fiction here.
 *  - A text-like file is inlined as a fenced block tagged with its name, which
 *    is what a model can use directly.
 *
 * A file that is neither (a PDF, a zip, a binary) is not silently attached and
 * quietly ignored downstream; it is reported back so the composer can tell the
 * user plainly that it was skipped and why.
 */

export interface TextPart {
  type: 'text';
  text: string;
}
export interface ImagePart {
  type: 'image_url';
  image_url: { url: string };
}
export type ContentPart = TextPart | ImagePart;

export interface BuiltContent {
  /** OpenAI-shaped content: a string when there are no images, parts otherwise. */
  content: string | ContentPart[];
  /** Names of files that could not be attached, with the reason. */
  skipped: { name: string; reason: string }[];
}

/** Roughly how much file text to inline before it stops helping and starts costing. */
const MAX_TEXT_BYTES = 256 * 1024;
/** A hard ceiling on a single image, so a huge photo cannot blow the request up. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'log', 'yaml', 'yml', 'toml', 'ini', 'env',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp',
  'cs', 'php', 'swift', 'sh', 'bash', 'zsh', 'sql', 'html', 'css', 'scss', 'xml', 'svg', 'vue', 'svelte',
]);

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

function looksTextual(file: File): boolean {
  if (file.type.startsWith('text/')) return true;
  if (/^application\/(json|xml|x-yaml|x-sh|javascript|typescript)/.test(file.type)) return true;
  return TEXT_EXTENSIONS.has(extension(file.name));
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsText(file);
  });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(file);
  });
}

/**
 * Compose the user's typed prompt and their attachments into one message.
 *
 * Text files are folded into the prompt text so the whole thing reads as one
 * message; images ride alongside as parts. The result is a plain string when
 * nothing but text was involved, which keeps a simple chat simple.
 */
export async function buildUserContent(prompt: string, files: File[]): Promise<BuiltContent> {
  const skipped: { name: string; reason: string }[] = [];
  const images: ImagePart[] = [];
  const textBlocks: string[] = [];

  for (const file of files) {
    if (file.type.startsWith('image/')) {
      if (file.size > MAX_IMAGE_BYTES) {
        skipped.push({ name: file.name, reason: 'image is larger than 8 MB' });
        continue;
      }
      images.push({ type: 'image_url', image_url: { url: await readAsDataUrl(file) } });
    } else if (looksTextual(file)) {
      if (file.size > MAX_TEXT_BYTES) {
        skipped.push({ name: file.name, reason: 'text file is larger than 256 KB' });
        continue;
      }
      const body = await readAsText(file);
      textBlocks.push(`Attached file \`${file.name}\`:\n\n\`\`\`${extension(file.name)}\n${body}\n\`\`\``);
    } else {
      skipped.push({ name: file.name, reason: 'unsupported type — attach images or text files' });
    }
  }

  const text = [prompt, ...textBlocks].filter(Boolean).join('\n\n');
  if (images.length === 0) return { content: text, skipped };
  return { content: [{ type: 'text', text }, ...images], skipped };
}
