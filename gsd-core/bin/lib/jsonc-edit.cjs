"use strict";
/**
 * Comment-preserving JSONC editing (issue #5334; epic #5331, Phase 2 #5338).
 *
 * OpenCode (1.x and 2.x) and Kilo read `opencode.jsonc`/`kilo.jsonc`, so users annotate them. The
 * installer used to parse such a file and write it back with `JSON.stringify`, which dropped every
 * comment, trailing comma and the user's layout. This module edits the TEXT instead: it locates the
 * property GSD owns and splices only that, leaving every other byte as the user wrote it.
 *
 * Scope is deliberately small — set a value at a key path, remove a key path (pruning objects the
 * removal emptied). It is not a general JSONC formatter. A document it cannot parse or whose root is
 * not an object is reported as `null` so the caller can keep its existing behavior.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasJsoncFeatures = hasJsoncFeatures;
exports.setJsoncValue = setJsoncValue;
exports.removeJsoncValue = removeJsoncValue;
exports.isEditableJsonc = isEditableJsonc;
exports.parseJsonc = parseJsonc;
class JsoncSyntaxError extends Error {
}
function skipTrivia(text, from) {
    let i = from;
    while (i < text.length) {
        const c = text[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
            i++;
        }
        else if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n')
                i++;
        }
        else if (c === '/' && text[i + 1] === '*') {
            const close = text.indexOf('*/', i + 2);
            if (close === -1)
                throw new JsoncSyntaxError('unterminated block comment');
            i = close + 2;
        }
        else {
            break;
        }
    }
    return i;
}
function scanString(text, from) {
    let i = from + 1;
    while (i < text.length) {
        const c = text[i];
        if (c === '\\') {
            i += 2;
        }
        else if (c === '"') {
            const raw = text.slice(from, i + 1);
            return { value: JSON.parse(raw), end: i + 1 };
        }
        else if (c === '\n') {
            throw new JsoncSyntaxError('unterminated string');
        }
        else {
            i++;
        }
    }
    throw new JsoncSyntaxError('unterminated string');
}
function parseValue(text, from) {
    const i = skipTrivia(text, from);
    const c = text[i];
    if (c === '{')
        return parseObject(text, i);
    if (c === '[')
        return parseArray(text, i);
    if (c === '"') {
        const s = scanString(text, i);
        return { kind: 'string', start: i, end: s.end, props: [] };
    }
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m)
        throw new JsoncSyntaxError(`unexpected token at ${i}`);
    return { kind: m[0] === 'true' || m[0] === 'false' || m[0] === 'null' ? 'literal' : 'number', start: i, end: i + m[0].length, props: [] };
}
function parseArray(text, from) {
    let i = from + 1;
    for (;;) {
        i = skipTrivia(text, i);
        if (text[i] === ']')
            return { kind: 'array', start: from, end: i + 1, props: [] };
        const v = parseValue(text, i);
        i = skipTrivia(text, v.end);
        if (text[i] === ',')
            i++;
        else if (text[i] !== ']')
            throw new JsoncSyntaxError(`expected , or ] at ${i}`);
    }
}
function parseObject(text, from) {
    const props = [];
    let i = from + 1;
    for (;;) {
        i = skipTrivia(text, i);
        if (text[i] === '}')
            return { kind: 'object', start: from, end: i + 1, props };
        if (text[i] !== '"')
            throw new JsoncSyntaxError(`expected key at ${i}`);
        const k = scanString(text, i);
        let j = skipTrivia(text, k.end);
        if (text[j] !== ':')
            throw new JsoncSyntaxError(`expected : at ${j}`);
        const value = parseValue(text, j + 1);
        const prop = { key: k.value, start: i, end: value.end, value, commaAfter: -1 };
        props.push(prop);
        j = skipTrivia(text, value.end);
        if (text[j] === ',') {
            prop.commaAfter = j;
            i = j + 1;
        }
        else if (text[j] === '}') {
            i = j;
        }
        else {
            throw new JsoncSyntaxError(`expected , or } at ${j}`);
        }
    }
}
function parseRoot(text) {
    try {
        const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
        const i = skipTrivia(text, bom);
        if (text[i] !== '{')
            return null;
        const root = parseObject(text, i);
        if (skipTrivia(text, root.end) !== text.length)
            return null;
        return root;
    }
    catch (e) {
        if (e instanceof JsoncSyntaxError || e instanceof SyntaxError)
            return null;
        throw e;
    }
}
/** True when `text` carries JSONC-only syntax (comments or a trailing comma) that a rewrite would lose. */
function hasJsoncFeatures(text) {
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '"') {
            try {
                i = scanString(text, i).end;
            }
            catch {
                return false;
            }
        }
        else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
            return true;
        }
        else if (c === ',') {
            const j = skipTrivia(text, i + 1);
            if (text[j] === '}' || text[j] === ']')
                return true;
            i++;
        }
        else {
            i++;
        }
    }
    return false;
}
// ─── Layout helpers ──────────────────────────────────────────────────────────
function lineStart(text, pos) {
    const nl = text.lastIndexOf('\n', pos - 1);
    return nl === -1 ? 0 : nl + 1;
}
function indentOf(text, pos) {
    const ls = lineStart(text, pos);
    const lead = text.slice(ls, pos);
    return /^[ \t]*$/.test(lead) ? lead : null;
}
function detectUnit(text, root) {
    const first = root.props[0];
    const lead = first ? indentOf(text, first.start) : null;
    if (lead && lead.length > 0)
        return lead;
    return '  ';
}
/** Indentation for children of `node`, given the indentation of the line that opens it. */
function childIndent(text, node, openerIndent, unit) {
    const first = node.props[0];
    const lead = first ? indentOf(text, first.start) : null;
    return lead !== null && lead.length > 0 ? lead : openerIndent + unit;
}
function serialize(value, baseIndent, unit) {
    // A short array of primitives stays on one line, the way people write command arrays by hand.
    if (Array.isArray(value) && value.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))) {
        const inline = `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
        if (inline.length <= 100)
            return inline;
    }
    return JSON.stringify(value, null, unit).split('\n').join('\n' + baseIndent);
}
function nest(path, value) {
    let v = value;
    for (let i = path.length - 1; i >= 0; i--)
        v = { [path[i]]: v };
    return v;
}
function endOfSameLineTrivia(text, from) {
    let i = from;
    for (;;) {
        while (text[i] === ' ' || text[i] === '\t')
            i++;
        if (text[i] === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n')
                i++;
            return i;
        }
        if (text[i] === '/' && text[i + 1] === '*') {
            const close = text.indexOf('*/', i + 2);
            if (close === -1)
                return i;
            if (text.slice(i, close).includes('\n'))
                return i;
            i = close + 2;
            continue;
        }
        return i;
    }
}
function splice(text, start, end, insert) {
    return text.slice(0, start) + insert + text.slice(end);
}
// ─── Operations ──────────────────────────────────────────────────────────────
function insertProperty(text, node, openerIndent, unit, key, value) {
    const indent = childIndent(text, node, openerIndent, unit);
    const rendered = `${JSON.stringify(key)}: ${serialize(value, indent, unit)}`;
    if (node.props.length === 0) {
        const interior = text.slice(node.start + 1, node.end - 1);
        if (interior.trim() === '') {
            return splice(text, node.start + 1, node.end - 1, `\n${indent}${rendered}\n${openerIndent}`);
        }
        // Only comments inside: keep them, add the property after the last one.
        let at = node.end - 1;
        while (at > node.start + 1 && /\s/.test(text[at - 1]))
            at--;
        return splice(text, at, at, `\n${indent}${rendered}`);
    }
    const last = node.props[node.props.length - 1];
    if (last.commaAfter >= 0) {
        // Trailing-comma style: keep it for the new property.
        const at = endOfSameLineTrivia(text, last.commaAfter + 1);
        return splice(text, at, at, `\n${indent}${rendered},`);
    }
    const at = endOfSameLineTrivia(text, last.end);
    const withProp = splice(text, at, at, `\n${indent}${rendered}`);
    return splice(withProp, last.end, last.end, ',');
}
function removeProperty(text, node, index) {
    const prop = node.props[index];
    let end = prop.commaAfter >= 0 ? prop.commaAfter + 1 : prop.end;
    end = endOfSameLineTrivia(text, end);
    if (text[end] === '\r')
        end++;
    if (text[end] === '\n')
        end++;
    const lead = indentOf(text, prop.start);
    const start = lead !== null ? lineStart(text, prop.start) : prop.start;
    if (lead === null) {
        // Sharing a line with other content: do not swallow the line break.
        end = prop.commaAfter >= 0 ? prop.commaAfter + 1 : prop.end;
        while (text[end] === ' ')
            end++;
    }
    let out = splice(text, start, end, '');
    // The removed property was last with no trailing comma: drop the comma that preceded it.
    if (prop.commaAfter < 0 && index > 0) {
        const prev = node.props[index - 1];
        if (prev.commaAfter >= 0 && prev.commaAfter < start) {
            out = splice(out, prev.commaAfter, prev.commaAfter + 1, '');
        }
    }
    return out;
}
function descend(root, path) {
    const chain = [root];
    let node = root;
    for (let i = 0; i < path.length; i++) {
        const prop = node.props.find((p) => p.key === path[i]);
        if (!prop)
            return { chain, hit: null, depth: i };
        if (i === path.length - 1)
            return { chain, hit: prop, depth: i };
        if (prop.value.kind !== 'object')
            return { chain, hit: prop, depth: i };
        node = prop.value;
        chain.push(node);
    }
    return { chain, hit: null, depth: path.length };
}
function openerIndentFor(text, chain, depth, unit) {
    // Indentation of the line holding the opener of chain[depth]; the root opens at column 0.
    if (depth === 0)
        return '';
    const node = chain[depth];
    const lead = indentOf(text, node.start);
    if (lead !== null)
        return lead;
    // `"key": {` on a line of its own: use the key's line indentation.
    const parentProps = (chain[depth - 1]).props;
    const owner = parentProps.find((p) => p.value === node);
    const keyLead = owner ? indentOf(text, owner.start) : null;
    return keyLead ?? unit.repeat(depth);
}
/**
 * Set `path` to `value`, creating missing objects. Returns the edited text, or `null` when the
 * document is not an object-rooted JSONC document.
 */
function setJsoncValue(text, path, value) {
    const root = parseRoot(text);
    if (!root || path.length === 0)
        return null;
    const unit = detectUnit(text, root);
    const { chain, hit, depth } = descend(root, path);
    const atLeaf = hit !== null && depth === path.length - 1;
    if (atLeaf && (hit).value.kind !== undefined) {
        const prop = hit;
        const base = indentOf(text, prop.start) ?? '';
        return splice(text, prop.value.start, prop.value.end, serialize(value, base, unit));
    }
    if (hit !== null) {
        // A non-object sits where an object is needed: replace it with the nested structure.
        const base = indentOf(text, hit.start) ?? '';
        return splice(text, hit.value.start, hit.value.end, serialize(nest(path.slice(depth + 1), value), base, unit));
    }
    const node = chain[chain.length - 1];
    const parentDepth = chain.length - 1;
    const opener = openerIndentFor(text, chain, parentDepth, unit);
    const key = path[parentDepth];
    return insertProperty(text, node, opener, unit, key, nest(path.slice(parentDepth + 1), value));
}
/**
 * Remove the key at `path`, then remove any ancestor object (never the root) the removal emptied.
 * Returns the edited text, or `null` when the document is not an object-rooted JSONC document.
 * A path that does not exist leaves the text unchanged.
 */
function removeJsoncValue(text, path) {
    let root = parseRoot(text);
    if (!root || path.length === 0)
        return null;
    let current = text;
    let target = path;
    for (;;) {
        const { chain, hit, depth } = descend(root, target);
        if (hit === null || depth !== target.length - 1)
            return current;
        const parent = chain[chain.length - 1];
        current = removeProperty(current, parent, parent.props.indexOf(hit));
        root = parseRoot(current);
        if (!root || target.length === 1)
            return current;
        target = target.slice(0, -1);
        const again = descend(root, target);
        const holder = again.hit;
        if (holder === null || again.depth !== target.length - 1 || holder.value.kind !== 'object' || holder.value.props.length > 0) {
            return current;
        }
    }
}
/** Parse tolerantly for callers that only need to know whether the text is edit-able. */
function isEditableJsonc(text) {
    return parseRoot(text) !== null;
}
/**
 * Parse JSONC (JSON with comments and trailing commas) into a value. Throws a `SyntaxError` (from
 * `JSON.parse`) on malformed input, like `JSON.parse` itself — callers keep their existing
 * "could not parse, do not touch the file" handling.
 */
function parseJsonc(content) {
    let text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    let stripped = '';
    let inString = false;
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        const next = text[i + 1];
        if (inString) {
            stripped += c;
            if (c === '\\' && i + 1 < text.length) {
                stripped += next;
                i += 2;
                continue;
            }
            if (c === '"')
                inString = false;
            i++;
        }
        else if (c === '"') {
            inString = true;
            stripped += c;
            i++;
        }
        else if (c === '/' && next === '/') {
            while (i < text.length && text[i] !== '\n')
                i++;
        }
        else if (c === '/' && next === '*') {
            i += 2;
            while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/'))
                i++;
            i += 2;
        }
        else {
            stripped += c;
            i++;
        }
    }
    text = stripped.replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(text);
}
