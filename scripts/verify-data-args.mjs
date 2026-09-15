// Verification: every data-args value in the dashboard source must be either
// static valid JSON (an array) or a correctly shaped runtime value — wrapped
// in [ … ], every element a fnData(...) piece. Also runs dead-control checks:
//   · every statically referenced data-fn must resolve to a window.<fn>
//     assignment (the delegated dispatcher only finds window[fn]);
//   · every toggle switch (.tg) in index.html must be clickable (data-fn
//     ancestor) and have its state consumed — id'd toggles must be referenced
//     in dashboard JS, data-w toggles must have a hide-w-<key> hook. Catches
//     "renders but does nothing" controls like labelToggle was.
// Exits non-zero on any failure so CI can run it.
import fs from 'node:fs';

const files = [
    ...fs.readdirSync('src/dashboard/parts').filter((f) => f.endsWith('.mjs')).map((f) => 'src/dashboard/parts/' + f),
    'src/dashboard/index.html',
    'src/dashboard/login.html',
];

let ok = 0;
let bad = 0;
const fail = (file, val, why) => { bad++; console.log('BAD  ' + file + ' → ' + val.slice(0, 90) + '  (' + why + ')'); };

// Split an attribute value's inner text on top-level commas. Paren-aware and
// quote-aware: commas inside JSON strings ("…" with \\” escapes in the jsq
// layer) don't split.
function splitTop(inner) {
    const out = [];
    let depth = 0;
    let inStr = false;
    let cur = '';
    for (let i = 0; i < inner.length; i++) {
        const c = inner[i];
        if (c === '\\' && i + 1 < inner.length) { cur += c + inner[i + 1]; i++; continue; }
        if (c === '"') inStr = !inStr;
        if (c === '(' || c === '[') depth++;
        else if (c === ')' || c === ']') depth--;
        else if (c === ',' && depth === 0 && !inStr) { out.push(cur); cur = ''; continue; }
        cur += c;
    }
    out.push(cur);
    return out;
}

function balancedParens(s) {
    let depth = 0;
    for (const c of s) {
        if (c === '(') depth++;
        else if (c === ')') depth--;
        if (depth < 0) return false;
    }
    return depth === 0;
}

// Source JS-string layer unescape: \' \" \\ → ' " \
const unescapeJs = (s) => s.replace(/\\(['"\\])/g, '$1');

for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    // data-args= followed by \'…\' (escaped delimiter — junctions may contain
    // bare ' quotes inside) or '…' (raw delimiter — template context / static
    // HTML). Raw values may legitimately contain ' emitted by fnData (always
    // followed by ']' or ',' in compact JSON); the attribute terminator is a '
    // followed by '>' or whitespace.
    const re = /data-args=\\'((?:(?!\\')[\s\S])*)\\'|data-args='((?:(?!'(?=[>\s]))[\s\S])*)'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const escaped2 = m[1] !== undefined;
        const rawVal = escaped2 ? m[1] : m[2];
        // Whole-value junction template (e.g. tkPill's data-args='+args+'): the
        // entire array JSON comes from a call-site expression at render time.
        if (escaped2 && /^'\+[A-Za-z_$][\w$]*\+'$/.test(rawVal)) { ok++; continue; }
        if (!rawVal.startsWith('[') || !rawVal.endsWith(']')) { fail(file, rawVal, 'not array-wrapped'); continue; }
        const inner = rawVal.slice(1, -1);
        const isRuntime = escaped2 ? inner.includes('fnData(') : inner.includes('${');

        if (!isRuntime) {
            const jsonText = escaped2 ? unescapeJs(rawVal) : rawVal.replace(/&#39;/g, "'");
            try { JSON.parse(jsonText); ok++; } catch { fail(file, rawVal, 'invalid static JSON'); }
            continue;
        }

        const pieces = splitTop(inner);
        let pieceOk = true;
        // One element: either a fnData junction, a nested array (a _seq step
        // whose elements are JSON literals and/or fnData junctions), or a
        // static JSON literal.
        function checkElement(p) {
            if (p.startsWith('[') && p.endsWith(']')) {
                for (const e of splitTop(p.slice(1, -1))) checkElement(e);
                return;
            }
            const body = escaped2
                ? (p.match(/^'\+fnData\(([\s\S]*)\)\+'$/) || [])[1]
                : (p.match(/^\$\{fnData\(([\s\S]*)\)\}$/) || [])[1];
            if (body !== undefined) {
                if (!balancedParens(body)) pieceOk = false;
                return;
            }
            const jsonText = escaped2 ? unescapeJs(p) : p;
            try { JSON.parse(jsonText); } catch { pieceOk = false; }
        }
        for (const p of pieces) {
            checkElement(p);
            if (!pieceOk) break;
        }
        if (pieceOk && pieces.length) ok++;
        else fail(file, rawVal, 'malformed runtime element');
    }
}

// ──────────────────── dead-control checks ────────────────────

const partFiles = fs.readdirSync('src/dashboard/parts').filter((f) => f.endsWith('.mjs')).map((f) => 'src/dashboard/parts/' + f);
const jsSrc = partFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const cssSrc = fs.readFileSync('src/dashboard/dashboard.css', 'utf8');
// Handlers reachable by the dispatcher = explicit window assignments. Names
// starting with "_" are dispatcher built-ins (_seq, _hideSelf).
const windowFns = new Set();
for (const m of jsSrc.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) windowFns.add(m[1]);
const handlerKnown = (fn) => fn.startsWith('_') || windowFns.has(fn);

// 1) Static data-fn references (static HTML + module-generated markup) must
//    resolve. Template-built names (data-fn="'+x+'" / \'+fn+\') don't match
//    the regex and are skipped; line comments are stripped so doc comments
//    like data-fn="windowFn" can't false-positive.
const fnRe = /data-fn="([A-Za-z_$][\w$]*)"/g;
const checkedFns = new Set();
for (const file of ['src/dashboard/index.html', ...partFiles]) {
    const src = fs.readFileSync(file, 'utf8').replace(/^[ \t]*\/\/.*$/gm, '');
    for (const m of src.matchAll(fnRe)) {
        if (checkedFns.has(m[1])) continue;
        checkedFns.add(m[1]);
        if (!handlerKnown(m[1])) { bad++; console.log('DEAD ' + file + ' → data-fn="' + m[1] + '"  (no window.<fn> assignment — control does nothing when clicked)'); }
    }
}

// 2) _seq steps in static HTML: [fnName, ...args] entries must reference
//    known handlers. Static JSON args only; runtime junctions are skipped.
{
    const html = fs.readFileSync('src/dashboard/index.html', 'utf8');
    for (const tm of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
        const tag = tm[0];
        if (!tag.includes('data-fn="_seq"')) continue;
        const am = tag.match(/data-args='([^']*)'/);
        if (!am) continue;
        let steps;
        try { steps = JSON.parse(am[1].replace(/&#39;/g, "'")); } catch { continue; }
        for (const step of steps) {
            if (Array.isArray(step) && step.length > 0 && typeof step[0] === 'string' && !handlerKnown(step[0])) {
                bad++; console.log('DEAD src/dashboard/index.html → _seq step ' + step[0] + '  (no window.<fn> assignment)');
            }
        }
    }
}

// 3) Toggle switches in static HTML must have their state consumed.
{
    const html = fs.readFileSync('src/dashboard/index.html', 'utf8');
    const tagRe = /<(\/)?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
    const voidEls = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'stop', 'use']);
    const stack = [];
    let toggles = 0;
    for (const m of html.matchAll(tagRe)) {
        const [, closing, name, attrStr, selfClose] = m;
        if (closing) {
            const i = stack.map((e) => e.name).lastIndexOf(name);
            if (i >= 0) stack.length = i;
            continue;
        }
        const attrs = {};
        for (const am of attrStr.matchAll(/([a-zA-Z-]+)=(?:"([^"]*)"|'([^']*)')/g)) attrs[am[1]] = am[2] !== undefined ? am[2] : am[3];
        if (!(selfClose === '/' || voidEls.has(name))) stack.push({ name, attrs });
        const cls = (attrs.class || '').split(/\s+/);
        if (!cls.includes('tg')) continue;
        toggles++;
        const label = (attrs.id ? ' #' + attrs.id : '') + (attrs['data-w'] ? ' [data-w=' + attrs['data-w'] + ']' : '');
        if (!stack.some((e) => e.attrs['data-fn'])) { bad++; console.log('DEAD src/dashboard/index.html → toggle' + label + '  (no data-fn on any ancestor — not clickable)'); }
        if (attrs.id && !jsSrc.includes("'" + attrs.id + "'") && !jsSrc.includes('"' + attrs.id + '"')) {
            bad++; console.log('DEAD src/dashboard/index.html → toggle #' + attrs.id + '  (id never referenced in dashboard JS — state read/applied nowhere)');
        }
        if (attrs['data-w'] && !(jsSrc + cssSrc).includes('hide-w-' + attrs['data-w'])) {
            bad++; console.log('DEAD src/dashboard/index.html → toggle [data-w=' + attrs['data-w'] + ']  (no hide-w-<key> consumer in JS or CSS — visibility never applied)');
        }
    }
    console.log('toggles: ' + toggles + ' checked');
}

console.log('\nOK: ' + ok + '  BAD: ' + bad);
process.exit(bad ? 1 : 0);
