export function extractMethods(args: string): string[] {
  const methodsMatch = args.match(/methods:\s*\[([^\]]*)\]/);
  if (methodsMatch) {
    return methodsMatch[1]!.split(',').map(m => m.trim().replace(/['"]/g, '').toUpperCase()).filter(Boolean);
  }
  return [];
}

export function extractName(args: string): string | null {
  const nameMatch = args.match(/\bname:\s*['"]([^'"]+)['"]/);
  return nameMatch ? nameMatch[1]! : null;
}

export function extractPath(args: string): string | null {
  const named = args.match(/\bpath:\s*['"]([^'"]+?)['"]/);
  if (named) return named[1]!;
  const pos = args.match(/^['"]([^'"]+?)['"]/);
  return pos ? pos[1]! : null;
}

export function extractDefaults(args: string): Record<string, string> | undefined {
  const match = args.match(/\bdefaults:\s*\{(.*?)\}/);
  if (!match) return undefined;
  const pairs: Record<string, string> = {};
  const pairRe = /(\w[\w_-]*)\s*:\s*(['"]?)([^,'"}]+)\2/g;
  let m;
  while ((m = pairRe.exec(match[1]!)) !== null) {
    pairs[m[1]!] = m[3]!.trim();
  }
  return Object.keys(pairs).length > 0 ? pairs : undefined;
}

export function extractRequirements(args: string): Record<string, string> | undefined {
  const match = args.match(/\brequirements:\s*\{(.*?)\}/);
  if (!match) return undefined;
  const pairs: Record<string, string> = {};
  const pairRe = /(\w[\w_-]*)\s*:\s*(['"]?)([^,'"}]+)\2/g;
  let m;
  while ((m = pairRe.exec(match[1]!)) !== null) {
    pairs[m[1]!] = m[3]!.trim();
  }
  return Object.keys(pairs).length > 0 ? pairs : undefined;
}

export function extractHost(args: string): string | undefined {
  const match = args.match(/\bhost:\s*['"]([^'"]+)['"]/);
  return match ? match[1]! : undefined;
}

export function extractSchemes(args: string): string[] | undefined {
  const match = args.match(/\bschemes:\s*\[([^\]]*)\]/);
  if (match) {
    const schemes = match[1]!.split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
    return schemes.length > 0 ? schemes : undefined;
  }
  return undefined;
}
