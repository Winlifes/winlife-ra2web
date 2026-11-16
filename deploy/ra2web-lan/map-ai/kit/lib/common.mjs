import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const profile = JSON.parse(fs.readFileSync(new URL('./profile.json', import.meta.url)));
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const cellKey = (rx, ry) => ry * 512 + rx;
export function writeJson(file, data) { fs.mkdirSync(path.dirname(path.resolve(file)), {recursive: true}); fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n'); }
export function safeText(text, field) {
  if (typeof text !== 'string' || !text.trim() || text.length > 100 || /[\r\n\x00-\x1f\[\]]/.test(text)) throw new Error('Invalid ' + field);
  return text.trim();
}
export function cliArgs(argv) {
  const positional = [], options = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) positional.push(argv[i]);
    else { const name = argv[i].slice(2); if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Missing value for --' + name); options[name] = argv[++i]; }
  }
  return {positional, options};
}
export function parseIniStrict(text) {
  const sections = new Map(), errors = []; let current;
  for (const [index, line] of text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).entries()) {
    if (!line.trim() || /^\s*[;#]/.test(line)) continue;
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:;.*)?$/);
    if (header) {
      const name = header[1].toUpperCase();
      if (sections.has(name)) errors.push('Duplicate section: ' + name);
      current = new Map(); sections.set(name, current); continue;
    }
    const entry = line.match(/^\s*([^=]+)=(.*)$/);
    if (!entry || !current) {errors.push('Malformed INI line ' + (index + 1)); continue;}
    const key = entry[1].trim().toUpperCase();
    if (current.has(key)) errors.push('Duplicate INI key at line ' + (index + 1) + ': ' + key);
    // Preserve escaped semicolons; the native decoder remains the authority.
    const value = entry[2].replace(/(?<!\\);.*$/, '').trim(); current.set(key, value);
  }
  return {sections, errors};
}
