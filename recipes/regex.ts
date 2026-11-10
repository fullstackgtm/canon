/**
 * Phrase checks are regex sources that people and agents write (issue #415), and a draft check runs each one on every
 * read. `unsafePattern` refuses the shapes behind catastrophic backtracking before a pattern is saved or proposed.
 * It is structural and conservative, so it also refuses some patterns that would run fine. `slowPattern` is the
 * backstop for what the structure misses: it times the compiled pattern on worst-case probes. It needs a clock that
 * moves, so it runs in actions only; a Convex query or mutation sees one frozen Date.now().
 */

type Quant = { min: number; max: number };
/** `look` marks a lookaround: it matches no characters, but backtracking inside it costs the same. */
type Atom = { kind: "chars"; source: string; quant: Quant } | { kind: "group"; alt: Alt; quant: Quant; look?: true } | { kind: "assert"; quant: Quant };
type Seq = Atom[];
type Alt = Seq[];

const ONE: Quant = { min: 1, max: 1 };

/** The characters overlap is judged on: printable ASCII, whitespace and the typographic marks drafts contain. */
const SAMPLE = [..."\t\n", ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), ..."é–—‘’“”…"];

class Unsupported extends Error {}

function parse(source: string): Alt {
  let i = 0;
  const peek = () => source[i];
  function quant(): Quant {
    const c = peek();
    let q: Quant | null = null;
    if (c === "*") q = { min: 0, max: Infinity };
    else if (c === "+") q = { min: 1, max: Infinity };
    else if (c === "?") q = { min: 0, max: 1 };
    else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
      if (m) {
        i += m[0].length - 1;
        q = { min: Number(m[1]), max: m[2] === undefined ? Number(m[1]) : m[3] ? Number(m[3]) : Infinity };
      }
    }
    if (!q) return ONE;
    i++;
    if (peek() === "?") i++;
    return q;
  }
  function escape(): Atom {
    const c = source[i + 1];
    if (c === undefined) throw new Unsupported("a trailing backslash");
    if (/[1-9]/.test(c) || c === "k") throw new Unsupported("a backreference");
    i += 2;
    if (c === "b" || c === "B") return { kind: "assert", quant: ONE };
    const start = i - 2;
    if (c === "x") i += 2;
    else if (c === "u") i += 4;
    else if (c === "c") i += 1;
    return { kind: "chars", source: source.slice(start, i), quant: ONE };
  }
  function cls(): Atom {
    const start = i++;
    if (peek() === "^") i++;
    if (peek() === "]") i++;
    while (i < source.length && peek() !== "]") i += peek() === "\\" ? 2 : 1;
    i++;
    return { kind: "chars", source: source.slice(start, i), quant: ONE };
  }
  function alt(): Alt {
    const branches: Alt = [[]];
    while (i < source.length && peek() !== ")") {
      const c = peek();
      if (c === "|") { i++; branches.push([]); continue; }
      let atom: Atom;
      if (c === "(") {
        i++;
        const lookaround = /^\?(<?[=!])/.exec(source.slice(i));
        if (lookaround) i += lookaround[0].length;
        else if (source.startsWith("?:", i)) i += 2;
        else if (source.startsWith("?<", i)) i = source.indexOf(">", i) + 1;
        const inner = alt();
        i++;
        atom = { kind: "group", alt: inner, quant: ONE, ...(lookaround ? { look: true as const } : {}) };
      } else if (c === "[") atom = cls();
      else if (c === "\\") atom = escape();
      else if (c === "^" || c === "$") { i++; atom = { kind: "assert", quant: ONE }; }
      else { i++; atom = { kind: "chars", source: c, quant: ONE }; }
      atom.quant = quant();
      branches[branches.length - 1].push(atom);
    }
    return branches;
  }
  const tree = alt();
  if (i < source.length) throw new Unsupported("an unmatched parenthesis");
  return tree;
}

const repeats = (q: Quant) => q.max > 1;
const varies = (q: Quant) => q.min !== q.max;

const nullable = (atom: Atom): boolean =>
  atom.quant.min === 0 || atom.kind === "assert" || (atom.kind === "group" && (atom.look === true || atom.alt.some((s) => s.every(nullable))));

const charsOf = new Map<string, Set<string>>();
function chars(source: string): Set<string> {
  let set = charsOf.get(source);
  if (!set) {
    const re = new RegExp(`^(?:${source})$`, "i");
    charsOf.set(source, (set = new Set(SAMPLE.filter((c) => re.test(c)))));
  }
  return set;
}

/** The sample characters a sequence's first character can be. */
function first(seq: Seq): Set<string> {
  const out = new Set<string>();
  for (const atom of seq) {
    if (atom.kind === "chars") for (const c of chars(atom.source)) out.add(c);
    if (atom.kind === "group" && !atom.look) for (const branch of atom.alt) for (const c of first(branch)) out.add(c);
    if (!nullable(atom)) break;
  }
  return out;
}

const overlap = (a: Set<string>, b: Set<string>) => [...a].some((c) => b.has(c));
const atomFirst = (atom: Atom) => first([{ ...atom, quant: ONE }]);

function* atoms(alt: Alt): Generator<Atom> {
  for (const seq of alt) for (const atom of seq) {
    yield atom;
    if (atom.kind === "group") yield* atoms(atom.alt);
  }
}

function* alternations(alt: Alt): Generator<Alt> {
  if (alt.length > 1) yield alt;
  for (const atom of atoms(alt)) if (atom.kind === "group" && atom.alt.length > 1) yield atom.alt;
}

function check(alt: Alt): string | null {
  for (const atom of atoms(alt)) {
    if (atom.kind !== "group" || !repeats(atom.quant)) continue;
    if ([...atoms(atom.alt)].some((inner) => varies(inner.quant))) return "a repeat inside a repeat, like (a+)+";
    for (const branches of alternations(atom.alt)) {
      if (branches.some((s) => s.every(nullable))) return "a repeated group with an empty choice, like (a|)+";
      const firsts = branches.map(first);
      if (firsts.some((f, x) => firsts.some((g, y) => y > x && overlap(f, g)))) return "a repeated choice whose options can start alike, like (a|ab)+";
    }
  }
  for (const seq of [...alt, ...[...atoms(alt)].flatMap((a) => (a.kind === "group" ? a.alt : []))]) {
    for (let x = 0; x < seq.length; x++) {
      if (!varies(seq[x].quant)) continue;
      for (let y = x + 1; y < seq.length; y++) {
        const next = seq[y];
        if (varies(next.quant) && (seq[x].quant.max === Infinity || next.quant.max === Infinity) && overlap(atomFirst(seq[x]), atomFirst(next))) {
          return "two open-ended repeats in a row that match the same characters, like .*.*";
        }
        if (!nullable(next)) break;
      }
    }
  }
  return null;
}

/** Why `source` could backtrack catastrophically, or null when its shape is safe. Assumes it compiles. */
export function unsafePattern(source: string): string | null {
  try {
    return check(parse(source));
  } catch (e) {
    if (e instanceof Unsupported) return e.message;
    throw e;
  }
}

/**
 * Whether one match attempt of `source` takes longer than `budgetMs` on a probe built to make it backtrack: a run
 * of one character it mentions, then a character that ends the match. Lengths grow slowly at first, so an
 * exponential pattern trips the budget long before a probe gets big enough to hang.
 */
export function slowPattern(source: string, budgetMs = 50): boolean {
  const re = new RegExp(source, "i");
  const letters = new Set([..."a \n", ...source.replace(/\\./g, "").replace(/[^\p{L}\p{N} ]/gu, "")]);
  const lengths = [10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 64, 128, 256, 512, 1024, 2048, 4096];
  for (const c of letters) {
    for (const n of lengths) {
      const probe = `${c.repeat(n)}\u0001`;
      // A busy machine can stall one run past the budget; backtracking that is truly catastrophic is slow every time.
      const slowRun = () => { const start = Date.now(); re.test(probe); return Date.now() - start > budgetMs; };
      if (slowRun() && slowRun() && slowRun()) return true;
    }
  }
  return false;
}
