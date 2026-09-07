# Projects and attachments

Two ways to give a model more than the words in the box: attach files to a
single message, or work inside a project whose whole folder is shared context.

## Attachments

The composer accepts files by drag-and-drop or the paperclip, and folds them
into the message that is sent:

- **Images** (`image/*`, up to 8 MB) become image parts the gateway forwards to
  a vision model as real images. A model without vision will not see them —
  that is the model's limit, and Meridian does not pretend otherwise.
- **Text-like files** (source, Markdown, JSON, CSV, logs, config, up to 256 KB)
  are inlined as fenced blocks tagged with the filename, which a model can read
  directly.
- **Anything else** (a PDF, a zip, a binary) is not silently swallowed. It is
  reported back in the composer as skipped, with the reason.

Attachments belong to the one message they were sent with; they are cleared
after sending. For files that should persist across a conversation, use a
project.

Verified in a real browser: an attached text file containing a distinctive
marker produced that marker in the reply — proving its content reached the
model — and an oversized or unsupported file was reported as skipped rather
than dropped in silence.

## Projects

A project is a folder of files plus standing instructions that become shared
context for a whole conversation — the same idea as a project in other
assistants. In Meridian a **project is a workspace**: a real folder on disk,
the same object the Workspace screen edits and a task runs against. Nothing new
was invented to store it.

Two things make a project:

- **A folder of files.** Every text file in the project is delivered to the
  model as project knowledge — a manifest of the whole folder, plus the
  contents of its files up to a bounded budget (~24 K characters). Files past
  the budget still appear in the manifest by name, so the model knows they
  exist and can ask to read them.
- **Standing instructions.** A `MERIDIAN.md` file at the project root holds
  instructions that are prepended to every message while the project is active.
  Keeping them in a file in the folder means the knowledge travels with the
  project rather than hiding in a database.

### Using projects

There are two ways in, backed by the **same** manager component so they behave
identically:

- A **Projects** tab in the left sidebar (Workspace section) — a full screen for
  browsing, creating and curating projects, the way other assistants make
  projects a first-class destination.
- A **project selector** in the chat header that opens the same manager in a
  **Manage projects** dialog, so you never have to leave the conversation.

In either place you can:

- **Create** a project (it makes a workspace folder).
- **Write its instructions** — saved as `MERIDIAN.md`.
- **Add text files** to its folder.
- See what the project contains.
- **Use in chat** — activate the project as the conversation's context.

Pick a project and every message in the conversation carries its context. Clear
the active project and nothing is injected. The choice is remembered (in
`localStorage` under `meridian.chat.project`, read by both the tab and the chat),
and falls back to none if that workspace is later deleted. Activating a project
from the Projects tab drops you into the chat with it already applied.

### How it reaches the model

The chat route calls a single injector when a project (workspace) is active. It
reads the instruction file and the folder's files, builds one system message —
instructions first, then a file manifest, then file contents to budget — and
prepends it ahead of the resolved skills and the conversation. An empty or
missing project injects nothing; it is a genuine no-op, not an empty context
block.

Because a project is a workspace, the skills already scoped to that workspace by
the AI control plane apply on the same request, on top of the project's own
instructions.

### How it was verified

`tests/e2e/projects.test.ts`, against a running gateway and a real inference
server, using the sim server's directive mechanism so nothing is taken on
faith — a marker placed in project content can only come back as the reply if
the gateway actually delivered that content to the model:

- A directive placed in a project **file** came back as the reply, and did
  **not** appear for the same question with no project active — so the file's
  contents genuinely reached the model, attributable to the project alone.
- A directive in a project's **`MERIDIAN.md`** came back as the reply — the
  standing instructions were applied.
- An **empty** project left the request unchanged.

And end to end through the real GUI: a project created in the dialog, its
instructions saved, activated from the header, then a plain message whose reply
proved the project's instructions had been delivered to the model.

### Deliberate limits

- Project knowledge is **text**. Images belong as per-message attachments to a
  vision model; the project injector inlines text files, which is what "a folder
  the AI can reference" most needs.
- File contents are delivered **up to a budget**. A very large project is
  represented by its full manifest plus as much file content as the budget
  allows, newest-cheapest first; the rest are named, not inlined.
- A project is a workspace, so its files are also visible to the Workspace
  screen and to agent tasks — by design, since it is the same folder.
