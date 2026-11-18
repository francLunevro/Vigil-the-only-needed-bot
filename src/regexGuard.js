// ──────────────────── Regex Safety Guard ────────────────────
// User-authored regexes (automod filters, autoresponder triggers) run on
// EVERY message in the hot path. A syntactically-valid pattern like
// `(a+)+$` is catastrophic-backtracking bait: one crafted message can
// pin the event loop for hours — a full-bot freeze, not just a slow
// command. This module is the single choke point every regex feature
// validates through BEFORE a pattern is stored, so an unsafe pattern
// never reaches the message pipeline.
//
// Three layers, cheapest first:
//   1. Length cap — a 200-char budget is generous for a filter; huge
//      patterns are a resource-abuse vector on their own.
//   2. Syntax check — already existed; kept here so callers need one API.
//   3. Star-height scanner — a static (no-execution) pass that rejects
//      the classic ReDoS shapes: an unbounded quantifier (`*`, `+`,
//      `{n,}`) applied to a group whose own body contains a quantifier
//      or an alternation. That covers `(a+)+`, `([a-zA-Z]+)*`,
//      `(a|aa)+`, `(.*)*`, `(a?)+` — the patterns that actually freeze
//      bots — while keeping every normal filter form legal
//      (`discord\.gg|bit\.ly/`, `[A-Z]{5,}`, `(ab)+`, `a+`).
//
// The scanner is deliberately conservative: `(foo|bar)+` is rejected even
// though some alternations are harmless, because telling safe alternations
// from exponential ones statically is not reliably possible. A rejected
// user can write the equivalent un-grouped form (`foo|bar`), which has
// identical semantics for .test().
//
// Honest limitation: a static scan cannot prove safety in general. Defense
// in depth lives at the match sites — compiled-pattern caching and an
// input-length cap (see automod.js / customCommands.js) bound the worst
// case for anything that slips past the heuristics.

const MAX_REGEX_LENGTH = 200;

// Is the token at position i an UNBOUNDED quantifier? `*`, `+` and `{n,}`
// are; `?` and `{n,m}` are not (they're ambiguity markers for the group
// scanner instead, since `(a?)+`-style empty-match loops are equally fatal).
function isUnboundedQuant(p, i) {
    const c = p[i];
    if (c === '*' || c === '+') return true;
    if (c === '{') {
        const close = p.indexOf('}', i);
        if (close === -1) return false;
        const body = p.slice(i + 1, close);
        if (!/^\d+(,\d*)?$/.test(body)) return false; // literal `{...}`, not a quantifier
        if (body.includes(',')) return body.split(',')[1] === ''; // {n,} → unbounded
        return false;
    }
    return false;
}

// Any quantifier at all (`*`, `+`, `?`, `{...}`) marks a group body as
// ambiguous — see the empty-match case above.
function isAnyQuant(p, i) {
    const c = p[i];
    if (c === '*' || c === '+' || c === '?') return true;
    if (c === '{') {
        const close = p.indexOf('}', i);
        if (close === -1) return false;
        return /^\d+(,\d*)?$/.test(p.slice(i + 1, close));
    }
    return false;
}

// Static scan. Returns true if the pattern has catastrophic-backtracking
// SHAPE (nested unbounded quantification, or an unbounded quantifier over
// a group containing quantifiers/alternation). Purely lexical — never
// executes the pattern.
function hasBacktrackingShape(pattern) {
    // Per open group: does its body contain a quantifier or alternation?
    const stack = [];
    // Info about the group closed most recently, so a quantifier that
    // immediately follows `)` can be applied to it.
    let lastGroup = null;

    let i = 0;
    while (i < pattern.length) {
        const c = pattern[i];

        if (c === '\\') { i += 2; lastGroup = null; continue; } // escaped char: literal

        if (c === '[') {
            // Char class — skip to the unescaped `]`. A quantifier after the
            // class is handled by the normal loop (lastGroup is null, so it
            // correctly just marks the enclosing group ambiguous).
            i++;
            while (i < pattern.length && pattern[i] !== ']') {
                if (pattern[i] === '\\') i++;
                i++;
            }
            i++; // past `]`
            lastGroup = null;
            continue;
        }

        if (c === '(') {
            stack.push({ ambiguous: false });
            i++;
            // `(?:` `(?=` `(?!` `(?<=` `(?<!` — consume the group-kind marker
            // so it isn't mistaken for a quantifier on the empty group.
            if (pattern[i] === '?') {
                i++;
                if (pattern[i] === '<') i++;
                if (pattern[i] === '=' || pattern[i] === '!' || pattern[i] === ':') i++;
            }
            lastGroup = null;
            continue;
        }

        if (c === ')') {
            const g = stack.pop();
            if (isUnboundedQuant(pattern, i + 1)) {
                // Unbounded quantifier over this group: fatal if the body is
                // ambiguous (nested quantifier or alternation).
                if (g && g.ambiguous) return true;
                if (stack.length) stack[stack.length - 1].ambiguous = true;
                i++; // consume the quantifier here so the loop-top check can't double-apply it
            } else if (g && g.ambiguous && stack.length) {
                // Closed without a quantifier, but the body was ambiguous —
                // e.g. the inner group of `((a+)b)+`. That ambiguity must
                // propagate to the enclosing group, or an outer unbounded
                // loop over it would slip through unnoticed.
                stack[stack.length - 1].ambiguous = true;
            }
            lastGroup = g;
            i++;
            continue;
        }

        if (c === '|') {
            if (stack.length) stack[stack.length - 1].ambiguous = true;
            lastGroup = null;
            i++;
            continue;
        }

        if (isUnboundedQuant(pattern, i)) {
            // Quantifier straight after a closed group (non-`)` paths can't
            // produce this; kept for safety) or over the enclosing group's
            // latest atom — either way the enclosing group becomes ambiguous.
            if (lastGroup && lastGroup.ambiguous) return true;
            if (stack.length) stack[stack.length - 1].ambiguous = true;
            i++;
            continue;
        }

        if (isAnyQuant(pattern, i)) {
            // Bounded/optional quantifier: doesn't make the enclosing group
            // catastrophic on its own, but marks it ambiguous for an outer
            // unbounded quantifier (catches `(a?)+`, `(a{0,2})*`).
            if (stack.length) stack[stack.length - 1].ambiguous = true;
            i++;
            continue;
        }

        // Plain atom.
        lastGroup = null;
        i++;
    }
    return false;
}

// Returns null when the pattern is safe to compile and run, or a
// human-readable reason string when it must be rejected. The reason is
// safe to show to users (no pattern echo needed — callers already have it).
function regexIssue(pattern) {
    if (typeof pattern !== 'string' || pattern.trim() === '') {
        return 'Pattern is empty.';
    }
    if (pattern.length > MAX_REGEX_LENGTH) {
        return 'Pattern is too long (max ' + MAX_REGEX_LENGTH + ' characters).';
    }
    try {
        new RegExp(pattern);
    } catch (err) {
        return 'Not a valid regular expression: ' + (err.message || 'syntax error');
    }
    if (hasBacktrackingShape(pattern)) {
        return 'Pattern has a catastrophic-backtracking shape (nested unbounded quantifiers, or an unbounded quantifier over a group containing quantifiers or alternation). Simplify it — e.g. write `foo|bar` instead of `(foo|bar)+`.';
    }
    return null;
}

// Boolean form kept for existing callers/tests.
function isValidRegex(pattern) {
    return regexIssue(pattern) === null;
}

module.exports = { regexIssue, isValidRegex, hasBacktrackingShape, MAX_REGEX_LENGTH };
