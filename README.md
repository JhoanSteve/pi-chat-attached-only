# pi-chat-attached-only

A [Pi](https://pi.dev) extension that adds a **Continue-style chat mode**: the
model only sees the files you attach, never follows imports into other files,
and answers with code blocks in the chat instead of editing files on disk.

Perfect for Pi Desktop (or plain `pi`) when you want a review/ask chat with a
hard context boundary.

## What it does

- **Attached files only.** Pi / Pi Desktop inlines the contents of attached
  files into your message. This mode removes every tool, so the model cannot
  read, search or list anything else — even when the attached code imports,
  requires or includes other files.
- **No writes, no shell.** `read`, `grep`, `find`, `ls`, `bash`, `edit` and
  `write` are disabled (and blocked by a `tool_call` guard as defense in depth).
- **Code in the chat.** The model replies with fenced code blocks labeled with
  their target file, e.g.:

  ```
  File: app/Models/User.php
  ```php
  ...
  ```
  ```

- **Apply / Create / Copy.** Copy is built into Pi Desktop (right-click a code
  block → *Copy Code Block*, or `Ctrl+Shift+C`). Apply and Create are provided by
  the `/chat-apply` command.

## Install

```bash
# From a local checkout
pi install /absolute/path/to/pi-chat-attached-only

# From git
pi install git:github.com/<user>/pi-chat-attached-only

# From npm (once published)
pi install npm:pi-chat-attached-only
```

Restart Pi, or run `/reload` in an active session.

## Usage

| Command | Description |
| --- | --- |
| `/chat-mode` | Toggle the mode on/off. |
| `/chat-allow <path>` | Allow reading one specific path (for `@`-mentioned files). Adds the `read` tool. |
| `/chat-apply [path]` | Apply/Create: write the last code block of the last reply to `path` (or the block's own `File:` hint). Asks for confirmation first. |

### Start enabled

Add the flag to Pi's `defaultArgs` (Pi Desktop: `~/.config/pi-desktop/settings.json`):

```json
{
  "defaultArgs": ["--chat-attached-only"]
}
```

Or launch directly:

```bash
pi --chat-attached-only
```

## Notes

- Attach files with the paperclip / drag-and-drop so their content is inlined.
  Plain `@file` mentions only insert a path; use `/chat-allow <path>` if you want
  the model to be able to read them.
- While enabled, the footer shows `💬 chat-only`.
- Disabling the mode restores the exact tool set that was active before.

## Safety

This extension is a **model tool-permission control, not an OS sandbox**. Pi
extensions run with the same permissions as the Pi process; audit third-party
extensions separately.

## License

MIT
# pi-chat-attached-only
