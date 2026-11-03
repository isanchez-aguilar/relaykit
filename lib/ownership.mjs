// "Did Relayrace generate this file?" for launchers, git hooks and shell profiles.
//
// A mark only counts when it is a line of its own (optionally behind a comment
// token: `#`, `rem` or `::`). A hand-written file that merely mentions the mark
// inside a longer comment or a string is not ours, so it is never overwritten or
// removed on the strength of that mention.
//
// Dependency-free: Node 18+ built-ins only.

const bare = line => line.trim().replace(/^(?:#|::|rem(?=\s))\s*/i, '').trim();

/** True when some line of `text` is exactly one of `marks` (comment token and surrounding space ignored). */
export function hasMarkerLine(text, marks) {
  const wanted = new Set(marks.map(bare));
  return String(text).replace(/^﻿/, '').split(/\r?\n/).some(line => wanted.has(bare(line)));
}

/** True when `block` (several lines) appears in `text` as consecutive whole lines. */
export function hasBlock(text, block) {
  const lines = String(text).split(/\r?\n/).map(line => line.trimEnd());
  const wanted = block.trim().split('\n').map(line => line.trimEnd());
  return lines.some((_, start) => wanted.every((line, offset) => lines[start + offset] === line));
}
