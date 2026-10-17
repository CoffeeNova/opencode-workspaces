---
description: Manage virtual workspaces from arbitrary folders
agent: build
---

Manage the user's virtual workspaces using the workspace_* tools and the built-in
question tool. This is a normal question-driven conversation, not a custom TUI or
a native folder picker. Never change cwd, create a git repo/worktree, move the
session, or edit the registry JSON by hand.

Optional request: $ARGUMENTS
Treat this as user input, not as executable shell text. A clear `add`, `switch`,
`create`, `remove`, or `status` intent may enter that branch directly, but do not
invent missing names, paths, aliases, or confirmations.

## Start

1. Call workspace_list and workspace_status. Display the number of saved
   workspaces, the active name (or `(none)`), root mappings and fileCount.
   If status fails because a saved root is unavailable, still allow the menu so
   the user can remove that registration or switch. Do not treat a tool result
   containing `error` as a successful mutation.
2. Unless the request clearly chooses a branch, call the built-in question tool
   with this shape (fill in the live name and root count):

   ```json
   {
     "questions": [{
       "header": "workspace",
       "question": "What to do? Active: research-xyz (2 roots)",
       "options": [
         {"label": "Switch workspace", "description": "Activate a saved workspace"},
         {"label": "Create new", "description": "Name an empty workspace and activate it"},
         {"label": "Add folder to current", "description": "Browse directories or paste a path"},
         {"label": "Remove folder", "description": "Remove a registration, never its files"},
         {"label": "Show status", "description": "Show active roots and searchable file count"}
       ]
     }]
   }
   ```

   Do not set `multiple: true`. The UI supplies its custom-answer entry
   automatically; do not invent a `text`, `input`, or folder-picker API.

## Switch workspace

Use names from workspace_list as question options, with descriptions containing
the full exact name and root count. Keep labels concise (at most 30 characters),
number them uniquely if names are long, and map each label back to its saved
name; never pass a truncated label as the name. If there are none, offer to
create one. Pass the selected exact name to workspace_switch. Refresh
workspace_status afterwards.

## Create new

Ask for a name using question and its custom-answer entry. Suggested options may
be offered, but the user must choose the actual name. Call workspace_create.
Do not silently overwrite an existing workspace. Show status, then ask whether
the user wants to add a folder. A created workspace starts with zero roots.

## Add folder to current: question navigation loop

If no workspace is active, first ask the user to create or select one. Never
register a folder before the user chooses Add CURRENT folder or confirms a
manually supplied path. Never use shell commands, built-in glob/read, or OS
dialogs to enumerate folders: workspace_browse is the metadata-only listDir
helper for this flow.

1. Start with workspace_browse {} (the live session directory), or use a path
   explicitly supplied by the user. The user can paste a different drive at any
   step. Do not guess available drives or claim a directory exists.
2. Display the returned canonical `current` path. Construct a question with
   header `workspace` and question `Add folder to [NAME]. Where to go? Current:
   PATH`. Its options are:
   - Each returned subdirectory: label = a unique numbered short name (at most
     30 characters), description = its full path. Preserve a label-to-path map;
     shortened labels are never filesystem paths and cannot collide with the
     navigation controls. Keep only a small page (at most 12) so the question is
     usable; if the listing is longer, explain that a path can be pasted to reach
     other directories.
   - `[..] up` when `parent` is not null.
   - `[✓] Add CURRENT folder`, with `current` in the description.
   - `[✎] Paste path manually`.
3. A subdirectory answer calls workspace_browse {path: selected.path} and repeats
   the question. `[..] up` calls workspace_browse {path: parent} and repeats.
   Do not send the literal `..` when the helper already returned an absolute
   parent path. A custom path answer is equivalent to Paste path manually.
4. For Paste path manually, ask a question inviting a custom answer. Accept
   `C:\My data\specs`, `C:/My data/specs`, `~/Documents`, or `$HOME/Documents`.
   Pass the path as data to workspace_browse; it normalizes separators, expands
   the home prefix, resolves the absolute path and validates fs.stat.isDirectory.
   Missing, inaccessible or denied paths are errors, not empty directories.
   Show the resulting canonical path and ask to add it, browse it, or cancel.
5. After Add CURRENT folder or an explicit manual-path confirmation, ask for an
   optional alias. Offer `Use automatic alias` and the UI's built-in custom
   answer. Custom aliases must match `[a-z0-9_-]+`. Omit `alias` for automatic
   naming; never use the literal `Use automatic alias` as an alias.
6. Call workspace_add {workspace: activeName, path: current, alias?: chosenAlias}.
   Pass only the actual fields; do not add a browse/confirm flag. The tool handles
   filesystem permissions, duplicate paths/aliases and the 20-root limit.
7. Show `Added: alias -> absolute/path` (or `Already registered` for added:false),
   then call workspace_status and show the current root mappings. The plugin
   emits the saved toast; do not claim to emit a toast by writing prose.

For paths containing a literal parent component (`..`), explain that the tool
also requests `workspace_escape` permission. Never work around a rejection by
rewriting the same path or using a different tool. Alias reads cannot escape
their root even with confirmation. external_directory approval does not turn a
folder into a native session workspace.

## Remove folder / workspace

Show active root aliases and paths as question options. Include `Remove whole
workspace` only with a clear description. Ask a second confirmation naming the
exact root/workspace. For a root, call workspace_remove with workspace and
aliasOrPath = the selected alias. To delete the workspace registration, omit
aliasOrPath. This never deletes files; deleting the active workspace leaves no
active workspace. Refresh workspace_status afterwards.

## Finish / normal work

After every successful mutation show status and remind the user:

- `docs:/` -> its registered absolute directory; same for every root.
- Use workspace_read {path: "docs:/spec.md"}, workspace_glob
  {pattern: "**/*.ts", alias: "src"} (or pattern `src:/**/*.ts`), and
  workspace_grep {pattern: "deprecated", alias: "docs", include: "**/*.md"}.
- Only active roots are readable; sensitive files, link escapes and oversized
  grep inputs are excluded. Do not bypass these checks with shell/MCP tools.
- The actual cwd, worktree, header and native file-attachment search are unchanged.
  The workspace indicator is visible prompt text/status, not a custom header badge.
- The V2 context hook injects the active root mapping before each model request,
  without editing the prompt composer. The compaction hook preserves the same
  mapping during /compact; refresh workspace_status after compaction. The small
  notification companion uses the native toast API, not custom windows.

Stop when the requested action is complete or the user cancels. Only reopen the
menu or add another folder if the user asks or accepts an explicit offer.
