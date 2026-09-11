/**
 * Minimal TOML read/modify helpers shared by the Codex takeover path
 * (clientConfig / clientConfigWriter) and the user-settings path (codexConfigManager).
 *
 * Full TOML syntax is intentionally out of scope: these helpers only update the
 * simple string, boolean, and integer assignments that XwX Deck owns.
 */

import { escapeRegExp } from '../shared/str';

/** Read a string key from the supplied TOML fragment. */
export function readTomlStringKey(text: string, key: string): string | undefined {
  const re = new RegExp(String.raw`^\s*${escapeRegExp(key)}\s*=\s*("([^"]*)"|'([^']*)')`, 'm');
  const match = re.exec(text);
  return match?.[2] ?? match?.[3];
}

/** Read a root-level string key, never a key nested under `[section]`. */
export function readTomlTopLevelString(text: string, key: string): string | undefined {
  return readTomlStringKey(rootToml(text), key);
}

/** Read a boolean key from the supplied TOML fragment. */
export function readTomlBooleanKey(text: string, key: string): boolean | undefined {
  const re = new RegExp(String.raw`^\s*${escapeRegExp(key)}\s*=\s*(true|false)`, 'mi');
  const match = re.exec(text);
  return match ? match[1].toLowerCase() === 'true' : undefined;
}

/** Read a finite integer key from the supplied TOML fragment. */
export function readTomlIntegerKey(text: string, key: string): number | undefined {
  const re = new RegExp(String.raw`^\s*${escapeRegExp(key)}\s*=\s*([+-]?\d+)`, 'm');
  const match = re.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** Read a root-level integer key, never a key nested under `[section]`. */
export function readTomlTopLevelInteger(text: string, key: string): number | undefined {
  return readTomlIntegerKey(rootToml(text), key);
}

export function findTomlSection(text: string, header: string): { start: number; end: number } | undefined {
  const re = new RegExp(String.raw`^\s*${escapeRegExp(header)}\s*$`, 'm');
  const match = re.exec(text);
  if (!match || match.index === undefined) return undefined;
  const start = match.index;
  const afterHeader = start + match[0].length;
  const nextSection = /^\s*\[/m.exec(text.slice(afterHeader));
  return { start, end: nextSection ? afterHeader + nextSection.index : text.length };
}

/** Rewrite a string key. Without `sectionHeader`, the assignment is always root-level. */
export function setTomlStringKey(
  text: string,
  key: string,
  value: string,
  options: { sectionHeader?: string } = {}
): { text: string; changed: boolean } {
  const newLine = `${key} = ${JSON.stringify(value)}`;
  return setTomlKey(text, newLine, stringAssignmentPattern(key), options.sectionHeader);
}

/** Rewrite a boolean key. Without `sectionHeader`, the assignment is always root-level. */
export function setTomlBooleanKey(
  text: string,
  key: string,
  value: boolean,
  options: { sectionHeader?: string } = {}
): { text: string; changed: boolean } {
  const newLine = `${key} = ${value ? 'true' : 'false'}`;
  return setTomlKey(text, newLine, booleanAssignmentPattern(key), options.sectionHeader);
}

/** Rewrite an integer key. Without `sectionHeader`, the assignment is root-level. */
export function setTomlIntegerKey(
  text: string,
  key: string,
  value: number,
  options: { sectionHeader?: string } = {}
): { text: string; changed: boolean } {
  if (!Number.isSafeInteger(value)) throw new Error(`TOML integer ${key} must be a safe integer.`);
  return setTomlKey(text, `${key} = ${value}`, integerAssignmentPattern(key), options.sectionHeader);
}

/** Remove a string assignment, optionally scoped to a section. */
export function removeTomlStringKey(
  text: string,
  key: string,
  sectionHeader?: string
): { text: string; changed: boolean } {
  const re = new RegExp(String.raw`^\s*${escapeRegExp(key)}\s*=\s*("[^"]*"|'[^']*')\s*(?:\r?\n|$)`, 'm');
  if (sectionHeader) {
    const section = findTomlSection(text, sectionHeader);
    if (!section) return { text, changed: false };
    const sectionText = text.slice(section.start, section.end);
    if (!re.test(sectionText)) return { text, changed: false };
    return {
      text: text.slice(0, section.start) + sectionText.replace(re, '') + text.slice(section.end),
      changed: true
    };
  }

  const root = rootToml(text);
  if (!re.test(root)) return { text, changed: false };
  return { text: root.replace(re, '') + text.slice(root.length), changed: true };
}

/** Remove a boolean assignment, optionally scoped to a section. */
export function removeTomlBooleanKey(
  text: string,
  key: string,
  sectionHeader?: string
): { text: string; changed: boolean } {
  const re = new RegExp(
    String.raw`^\s*${escapeRegExp(key)}\s*=\s*(?:true|false|"[^"]*"|'[^']*')\s*(?:#.*)?(?:\r?\n|$)`,
    'mi'
  );
  if (sectionHeader) {
    const section = findTomlSection(text, sectionHeader);
    if (!section) return { text, changed: false };
    const sectionText = text.slice(section.start, section.end);
    if (!re.test(sectionText)) return { text, changed: false };
    return {
      text: text.slice(0, section.start) + sectionText.replace(re, '') + text.slice(section.end),
      changed: true
    };
  }

  const root = rootToml(text);
  if (!re.test(root)) return { text, changed: false };
  return { text: root.replace(re, '') + text.slice(root.length), changed: true };
}

/** Remove an integer assignment, optionally scoped to a section. */
export function removeTomlIntegerKey(
  text: string,
  key: string,
  sectionHeader?: string
): { text: string; changed: boolean } {
  const re = new RegExp(
    String.raw`^\s*${escapeRegExp(key)}\s*=\s*[+-]?\d+\s*(?:#.*)?(?:\r?\n|$)`,
    'm'
  );
  if (sectionHeader) {
    const section = findTomlSection(text, sectionHeader);
    if (!section) return { text, changed: false };
    const sectionText = text.slice(section.start, section.end);
    if (!re.test(sectionText)) return { text, changed: false };
    return {
      text: text.slice(0, section.start) + sectionText.replace(re, '') + text.slice(section.end),
      changed: true
    };
  }

  const root = rootToml(text);
  if (!re.test(root)) return { text, changed: false };
  return { text: root.replace(re, '') + text.slice(root.length), changed: true };
}

/** Append an empty `[section]` header if it does not already exist. */
export function ensureTomlSection(text: string, header: string): string {
  if (findTomlSection(text, header)) return text;
  const eol = detectEol(text);
  const prefix = text && !endsWithEol(text) ? eol : '';
  const gap = text.trim() ? eol : '';
  return `${text}${prefix}${gap}${header}${eol}`;
}

/** The text before the first `[section]` header (the only valid root-level region). */
export function rootToml(text: string): string {
  const firstSection = /^\s*\[/m.exec(text);
  return firstSection?.index === undefined ? text : text.slice(0, firstSection.index);
}

function setTomlKey(
  text: string,
  newLine: string,
  assignment: RegExp,
  sectionHeader?: string
): { text: string; changed: boolean } {
  if (sectionHeader) {
    const section = findTomlSection(text, sectionHeader);
    if (section) {
      const sectionText = text.slice(section.start, section.end);
      if (assignment.test(sectionText)) {
        const updated = sectionText.replace(assignment, newLine);
        return { text: text.slice(0, section.start) + updated + text.slice(section.end), changed: updated !== sectionText };
      }
      const eol = detectEol(text);
      const updated = `${sectionText.replace(/\s+$/, '')}${eol}${newLine}${eol}`;
      return { text: text.slice(0, section.start) + updated + text.slice(section.end), changed: true };
    }
  }

  // Never append a root-level key after `[windows]` or another section: TOML
  // would scope it to that section and Codex would ignore it.
  const root = rootToml(text);
  if (assignment.test(root)) {
    return { text: root.replace(assignment, newLine) + text.slice(root.length), changed: true };
  }
  const eol = detectEol(text);
  const prefix = root && !endsWithEol(root) ? eol : '';
  return { text: `${root}${prefix}${newLine}${eol}${text.slice(root.length)}`, changed: true };
}

function stringAssignmentPattern(key: string): RegExp {
  return new RegExp(String.raw`^\s*${escapeRegExp(key)}\s*=\s*("[^"]*"|'[^']*')`, 'm');
}

function booleanAssignmentPattern(key: string): RegExp {
  return new RegExp(String.raw`^\s*${escapeRegExp(key)}\s*=\s*(?:true|false|"[^"]*"|'[^']*')`, 'mi');
}

function integerAssignmentPattern(key: string): RegExp {
  return new RegExp(String.raw`^\s*${escapeRegExp(key)}\s*=\s*[+-]?\d+`, 'm');
}

function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function endsWithEol(text: string): boolean {
  return text.endsWith('\n') || text.endsWith('\r');
}
