import { readFileSync } from 'fs';

const contractDirUrl = new URL('./contracts/', import.meta.url);

export function loadContractSource(fileName: string) {
  return readFileSync(new URL(fileName, contractDirUrl), 'utf8').trim();
}

export function loadContractTemplate(fileName: string, replacements: Record<string, string>) {
  let source = loadContractSource(fileName);
  for (const [key, value] of Object.entries(replacements)) {
    source = source.replaceAll(`{{${key}}}`, value);
  }
  const unresolved = source.match(/{{[A-Z0-9_]+}}/);
  if (unresolved) {
    throw new Error(`Contract template ${fileName} has unresolved placeholder ${unresolved[0]}`);
  }
  return source;
}

export function clarityHexLiteral(hex: string, label: string) {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`${label} must be an even-length hex string`);
  }
  return `0x${hex.toLowerCase()}`;
}
