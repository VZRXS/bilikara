import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { readFileSync } from 'node:fs';
import { root, runNative } from './desktop_construction_support.mjs';

// Large, generated player fixtures exceed Windows' command-line limit. Node
// reads the same CommonJS script from stdin; require still resolves from cwd.
export function runNodeScript(script, timeout = 10_000, cwd = root, environment = process.env) {
  return runNative(process.execPath, ['-'], environment, timeout, cwd, 'utf8', script);
}

// Source contracts inspect semantic UTF-8 text, as the prior universal-newline
// readers did. Artifact inventory/copy checks must keep using raw bytes.
export function readSourceText(file, encoding = 'utf8') {
  assert.ok(encoding === 'utf8' || encoding === 'utf-8', 'Source text requires UTF-8');
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

// Frontend fixtures return strings, JSON collections and booleans. Keep their
// assertions explicit about collection membership and empty results.
export function contains(value, collection) {
  if (typeof collection === 'string') return collection.includes(value);
  if (Array.isArray(collection)) return collection.some(item => isDeepStrictEqual(item, value));
  if (collection instanceof Set) return collection.has(value);
  return Object.hasOwn(collection, value);
}

export function hasContent(value) {
  if (typeof value === 'string' || Array.isArray(value)) return value.length > 0;
  if (value instanceof Set) return value.size > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

export function splitOnce(source, separator) {
  const at = source.indexOf(separator);
  return at < 0 ? [source] : [source.slice(0, at), source.slice(at + separator.length)];
}

export function splitLimited(source, separator, limit) {
  const pieces = source.split(separator);
  return pieces.length <= limit ? pieces : [...pieces.slice(0, limit), pieces.slice(limit).join(separator)];
}

export function paired(left, right) {
  return Array.from({length: Math.min(left.length, right.length)}, (_, i) => [left[i], right[i]]);
}

export function words(source) {
  const trimmed = source.trim();
  return trimmed ? trimmed.split(/\s+/) : [];
}

export function subtract(left, right) {
  return typeof left === 'number' ? left - right : new Set(Array.from(left).filter(value => !contains(value, right)));
}

export function sourceIndex(source, value, from = 0) {
  const index = source.indexOf(value, from);
  assert.ok(index >= 0, `Missing ${value}`);
  return index;
}

export function lastSourceIndex(source, value, from = 0, end = source.length) {
  const index = source.slice(from, end).lastIndexOf(value);
  assert.ok(index >= 0, `Missing ${value}`);
  return from + index;
}

export function iterableValues(value) {
  return Symbol.iterator in Object(value) ? value : Object.keys(value);
}

export function firstMatch(matches) {
  assert.ok(matches.length > 0, 'Expected a matching source section');
  return matches[0];
}

export function countValues(values) {
  const counts = Object.create(null);
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

export function concatenate(left, right) {
  return Array.isArray(left) ? left.concat(right) : left + right;
}

export function countOccurrences(collection, value) {
  return Array.isArray(collection)
    ? collection.filter(item => isDeepStrictEqual(item, value)).length
    : collection.split(value).length - 1;
}

export function markupSummary(source = '') {
  const tags = [], scripts = [], elements = [], ids = new Set(), keys = new Set();
  const markup = source.replace(/<!--[\s\S]*?-->/g, '');
  for (const match of markup.matchAll(/<([a-zA-Z][\w:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const tag = match[1].toLowerCase(); const values = Object.create(null);
    for (const attribute of match[2].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const name = attribute[1].toLowerCase(); const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
      values[name] = value.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      if (name === 'data-i18n' || name.startsWith('data-i18n-')) keys.add(values[name]);
    }
    tags.push(tag); elements.push([tag, values]);
    if (values.id) ids.add(values.id);
    if (tag === 'script' && values.src) scripts.push(values.src);
  }
  return { tags, scripts, elements, ids, keys };
}

export function readUniqueJson(file) {
  const source = readFileSync(file, 'utf8');
  const tokens = [...source.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g)].map(match => match[0]);
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '{' || token === '[') stack.push(token === '{' ? new Set() : null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ':') {
      const key = JSON.parse(token), keys = stack.at(-1);
      assert.ok(keys instanceof Set && !keys.has(key), `Duplicate JSON key: ${key}`);
      keys.add(key);
    }
  }
  return JSON.parse(source);
}

export function lockPackages(source) {
  // Only package identities are inspected here; Cargo itself validates the
  // locked application manifests in frontend_static_contract.test.mjs.
  return { package: source.split('[[package]]').slice(1).map(block => {
    const name = block.match(/^name = (".*")$/m), version = block.match(/^version = (".*")$/m);
    assert.ok(name && version, 'Expected locked package identity');
    return { name: JSON.parse(name[1]), version: JSON.parse(version[1]) };
  }) };
}
