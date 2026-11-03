// What `relaykit init` WOULD add to a file that already exists. init never
// overwrites, so instead of replacing a file it shows the parts of the wanted
// content that the existing one lacks, and the owner merges what is useful.

const eol = text => text.replace(/\r\n/g, '\n');
const comparable = text => eol(text).trimEnd();

/** Markdown sections (level 2+) as `{ title, level, lines }`; lines inside code fences are never headings. */
export function sections(text) {
  const result = [];
  let fence = false;
  let current;
  for (const line of eol(text).split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = !fence && line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      current = { title: heading[2], level: heading[1].length, lines: [line] };
      result.push(current);
    } else if (current) current.lines.push(line);
  }
  return result;
}

const normalizeTitle = title => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Sections of `wanted` (below the document title) whose heading `existing` does not have. */
export function missingSections(existing, wanted) {
  const have = new Set(sections(existing).map(s => normalizeTitle(s.title)));
  return sections(wanted)
    .filter(s => s.level >= 2 && !have.has(normalizeTitle(s.title)))
    .map(s => ({ title: s.title, level: s.level, lines: trimBlank(s.lines) }));
}

function trimBlank(lines) {
  const copy = [...lines];
  while (copy.length && !copy.at(-1).trim()) copy.pop();
  return copy;
}

/** Lines of `wanted` that `existing` does not contain (for tiny pointer files). */
export function missingLines(existing, wanted) {
  const have = new Set(eol(existing).split('\n').map(l => l.trim()));
  return eol(wanted).split('\n').filter(l => l.trim() && !have.has(l.trim()));
}

/** Paths in `wanted` (an object tree) that `existing` lacks, as `a.b["c"]: value` strings. */
export function missingKeys(existing, wanted, prefix = '', depth = 0) {
  const found = [];
  for (const [key, value] of Object.entries(wanted)) {
    const label = prefix ? `${prefix}[${JSON.stringify(key)}]` : key;
    if (existing === null || typeof existing !== 'object' || !(key in existing)) {
      found.push(`${label}: ${JSON.stringify(value)}`);
    } else if (value && typeof value === 'object' && !Array.isArray(value) && depth < 3) {
      found.push(...missingKeys(existing[key], value, label, depth + 1));
    }
  }
  return found;
}

/**
 * Compare an existing file with what init wanted to write.
 * Returns { status: 'identical' } or { status: 'additions', sections?, lines? }
 * or { status: 'differs' } for files we cannot compare meaningfully (scripts).
 */
export function describeAdditions(path, existing, wanted) {
  if (comparable(existing) === comparable(wanted)) return { status: 'identical' };
  if (/\.json$/i.test(path)) {
    try {
      const lines = missingKeys(JSON.parse(existing), JSON.parse(wanted));
      return lines.length ? { status: 'additions', lines } : { status: 'identical' };
    } catch {
      return { status: 'differs' };
    }
  }
  if (/\.md$/i.test(path)) {
    const found = missingSections(existing, wanted);
    if (found.length) return { status: 'additions', sections: found };
    if (!sections(wanted).some(s => s.level >= 2)) {
      const lines = missingLines(existing, wanted);
      return lines.length ? { status: 'additions', lines } : { status: 'identical' };
    }
    return { status: 'identical' };
  }
  return { status: 'differs' };
}

/** Printable `+` lines for a description, capped unless `verbose`. */
export function renderAdditions(description, { verbose = false, cap = 40 } = {}) {
  const out = [];
  for (const section of description.sections ?? []) {
    out.push(...section.lines.map(l => `+ ${l}`.trimEnd()), '+');
  }
  for (const line of description.lines ?? []) out.push(`+ ${line}`);
  while (out.length && out.at(-1) === '+') out.pop();
  if (!verbose && out.length > cap) {
    return [...out.slice(0, cap), `  … ${out.length - cap} more lines (rerun with --verbose to see them all)`];
  }
  return out;
}
