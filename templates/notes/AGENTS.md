# AGENTS.md — {{name}}

Rules for any agent working in this notes folder. The owner's global contract
(language, models, git, security) applies on top of this file.

## What this folder is

TODO: what these notes are for and how they are organised (folders, index notes).

## Conventions

- Keep existing content, frontmatter, tags, `[[links]]` and folder layout. Add
  or reorganize; never delete a note or a section unless asked.
- New notes get frontmatter like their siblings and are linked from the index
  note of their folder.
- Write in the language of the surrounding notes.
- **Never store secrets** (passwords, tokens, keys, private conversations).
  Agents may read the whole folder.

## Working

There are no tests or CI here, so the flow is plan, write, and have another
model review. Use the `writer` agent for writing tasks. Commit only when asked.

## Before delivery

Report which files changed and anything you could not verify (broken links,
missing frontmatter). A significant reorganisation is reviewed by a different
provider, read-only.
