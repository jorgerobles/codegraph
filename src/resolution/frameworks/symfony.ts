import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

function lastFqcnSegment(fqcn: string): string {
  const clean = fqcn.replace(/^\\+/, '').trim();
  const parts = clean.split('\\');
  return parts[parts.length - 1] ?? clean;
}

function extractMethods(args: string): string[] {
  const methodsMatch = args.match(/methods:\s*\[([^\]]*)\]/);
  if (methodsMatch) {
    return methodsMatch[1]!.split(',').map(m => m.trim().replace(/['"]/g, '').toUpperCase()).filter(Boolean);
  }
  return [];
}

function extractName(args: string): string | null {
  const nameMatch = args.match(/\bname:\s*['"]([^'"]+)['"]/);
  return nameMatch ? nameMatch[1]! : null;
}

function extractPath(args: string): string | null {
  const named = args.match(/\bpath:\s*['"]([^'"]+?)['"]/);
  if (named) return named[1]!;
  const pos = args.match(/^['"]([^'"]+?)['"]/);
  return pos ? pos[1]! : null;
}

function parseControllerServiceRef(expr: string): { class: string; method: string } | null {
  const clean = expr.trim().replace(/^['"]|['"]$/g, '');
  const match = clean.match(/^([A-Za-z_\\][\w\\]*):{1,2}(\w+)$/);
  if (match) {
    return { class: match[1]!, method: match[2]! };
  }
  // Bare FQCN — single-action controller (__invoke)
  if (clean.includes('\\') && /[A-Z]/.test(clean)) {
    return { class: clean, method: '__invoke' };
  }
  return null;
}

function resolveControllerMethod(
  controller: string,
  method: string,
  context: ResolutionContext
): string | null {
  const shortName = lastFqcnSegment(controller);

  // Search all class nodes — no path assumptions for hexagonal/modular layouts
  const allClasses = context.getNodesByKind('class');
  for (const cls of allClasses) {
    if (cls.name === shortName) {
      const nodesInFile = context.getNodesInFile(cls.filePath);
      const methodNode = nodesInFile.find(n => n.kind === 'method' && n.name === method);
      if (methodNode) return methodNode.id;
    }
  }

  return null;
}

export const symfonyResolver: FrameworkResolver = {
  name: 'symfony',
  languages: ['php', 'yaml'],

  detect(context: ResolutionContext): boolean {
    const composer = context.readFile('composer.json');
    if (composer) {
      try {
        const json = JSON.parse(composer) as {
          require?: Record<string, string>;
          'require-dev'?: Record<string, string>;
        };
        const deps = { ...json.require, ...(json['require-dev'] ?? {}) };
        if (Object.keys(deps).some(k => k === 'symfony/framework-bundle' || k === 'symfony/symfony')) {
          return true;
        }
        if (Object.keys(deps).some(k => k.startsWith('symfony/') && k !== 'symfony/polyfill-*')) {
          const hasConsole = context.fileExists('bin/console');
          const hasConfig = context.fileExists('config/');
          if (hasConsole && hasConfig) return true;
        }
      } catch {
      }
    }
    return context.fileExists('bin/console') && context.fileExists('config/');
  },

  claimsReference(name: string): boolean {
    return name.includes('::') || name.includes('\\') || name.endsWith('Controller');
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const parsed = parseControllerServiceRef(ref.referenceName);
    if (parsed) {
      const result = resolveControllerMethod(parsed.class, parsed.method, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.9,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();

    // ── PHP ──────────────────────────────────────────────────────────────────
    if (filePath.endsWith('.php')) {
      const safe = stripCommentsForRegex(content, 'php');

      // Class-level #[Route] prefix
      let classPrefix = '';
      const classAttrMatch = safe.match(
        /#\[\s*Route\s*\(([^)]*)\)\s*\](?:\s*\n\s*)*\b(?:final\s+)?(?:readonly\s+)?class\b/
      );
      if (classAttrMatch) {
        const path = extractPath(classAttrMatch[1]!);
        if (path) classPrefix = path;
      }

      // Method-level #[Route] — `[^)]*` stops at first `)`, can't bleed into next attribute
      const methodRouteRegex =
        /#\[\s*Route\s*\(([^)]*)\)\s*\](?:\s*\n\s*(?:#\[(?!\s*Route\s*\()[\s\S]*?\]\s*\n\s*)*)?(?:public|private|protected)\s+function\s+(\w+)\s*\(/g;
      let match: RegExpExecArray | null;
      while ((match = methodRouteRegex.exec(safe)) !== null) {
        const args = match[1]!.trim();
        const methodName = match[2]!;
        const line = safe.slice(0, match.index).split('\n').length;
        const path = extractPath(args);
        const routeMethods = extractMethods(args);
        const routeName = extractName(args);

        if (!path) continue;

        const fullPath = classPrefix ? classPrefix + path : path;
        const httpMethods = routeMethods.length > 0 ? routeMethods : ['ANY'];

        for (const httpMethod of httpMethods) {
          const routeNode: Node = {
            id: `route:${filePath}:${line}:${httpMethod}:${fullPath}`,
            kind: 'route',
            name: `${httpMethod} ${fullPath}`,
            qualifiedName: routeName ? `${filePath}::${routeName}` : `${filePath}::route:${fullPath}`,
            filePath,
            startLine: line,
            endLine: line,
            startColumn: 0,
            endColumn: match[0].length,
            language: 'php',
            updatedAt: now,
          };
          nodes.push(routeNode);

          references.push({
            fromNodeId: routeNode.id,
            referenceName: methodName,
            referenceKind: 'references',
            line,
            column: 0,
            filePath,
            language: 'php',
          });
        }
      }

      // ── Compiled DI container ─────────────────────────────────────────
      if (/var\/cache\/.*\.php$/.test(filePath) && /Container/i.test(content.slice(0, 500))) {
        const svcRegex = /protected\s+function\s+get(\w+)Service\s*\(\s*\)\s*:\s*(\\?[\w\\]+)/g;
        let svcMatch: RegExpExecArray | null;
        while ((svcMatch = svcRegex.exec(content)) !== null) {
          const svcName = svcMatch[1]!;
          const fqcn = svcMatch[2]!;
          const svcLine = content.slice(0, svcMatch.index).split('\n').length;

          const svcNode: Node = {
            id: `service:${filePath}:${svcLine}:${svcName}`,
            kind: 'variable',
            name: svcName,
            qualifiedName: fqcn,
            filePath,
            startLine: svcLine,
            endLine: svcLine,
            startColumn: 0,
            endColumn: svcMatch[0].length,
            language: 'php',
            updatedAt: now,
          };
          nodes.push(svcNode);

          references.push({
            fromNodeId: svcNode.id,
            referenceName: fqcn,
            referenceKind: 'references',
            line: svcLine,
            column: 0,
            filePath,
            language: 'php',
          });
        }
      }
    }

    // ── YAML ──────────────────────────────────────────────────────────────────
    if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
      const lines = content.split('\n');
      let currentRoute: { name: string; lineNum: number } | null = null;
      let currentPathVal: string | null = null;
      let currentController: string | null = null;
      let currentMethods: string[] = [];
      const flushRoute = () => {
        if (!currentRoute || !currentPathVal) return;
        const httpMethods = currentMethods.length > 0 ? currentMethods : ['ANY'];
        for (const httpMethod of httpMethods) {
          nodes.push({
            id: `route:${filePath}:${currentRoute.lineNum}:${httpMethod}:${currentPathVal}`,
            kind: 'route',
            name: `${httpMethod} ${currentPathVal}`,
            qualifiedName: `${filePath}::${currentRoute.name}`,
            filePath,
            startLine: currentRoute.lineNum,
            endLine: currentRoute.lineNum,
            startColumn: 0,
            endColumn: 0,
            language: 'yaml',
            updatedAt: now,
          });
          if (currentController) {
            references.push({
              fromNodeId: `route:${filePath}:${currentRoute.lineNum}:${httpMethod}:${currentPathVal}`,
              referenceName: currentController,
              referenceKind: 'references',
              line: currentRoute.lineNum,
              column: 0,
              filePath,
              language: 'yaml',
            });
          }
        }
      };

      let inServicesBlock = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const indent = line.length - line.trimStart().length;
        const keyValMatch = trimmed.match(/^([\w\-_.\\]+):\s*(.*)/);
        if (!keyValMatch) continue;

        const key = keyValMatch[1]!;
        const val = keyValMatch[2]!.trim();

        // Top-level key (column 0)
        if (indent === 0) {
          flushRoute();
          currentRoute = null;
          currentPathVal = null;
          currentController = null;
          currentMethods = [];
          inServicesBlock = key === 'services';

          // Start a new route definition (key has no inline value or an inline comment)
          if (!val || val.startsWith('#')) {
            currentRoute = { name: key, lineNum: i + 1 };
          } else if (!inServicesBlock && key !== 'services') {
            // Inline shorthand: route_name: /path
            currentRoute = { name: key, lineNum: i + 1 };
            currentPathVal = val.replace(/^['"]|['"]$/g, '');
          }
          continue;
        }

        // Sub-key of current route
        if (currentRoute && !inServicesBlock) {
          if (key === 'path') {
            const subVal = val.replace(/^['"]|['"]$/g, '').replace(/\s+#.*$/, '');
            if (subVal) currentPathVal = subVal;
          } else if (key === 'controller') {
            const subVal = val.replace(/^['"]|['"]$/g, '').replace(/\s+#.*$/, '');
            if (subVal) currentController = subVal;
          } else if (key === 'methods') {
            const m = val.match(/\[([^\]]*)\]/);
            if (m) {
              currentMethods = m[1]!.split(',').map(s => s.trim().replace(/['"]/g, '').toUpperCase()).filter(Boolean);
            }
          }
        }

        // Service definitions under `services:`
        if (inServicesBlock && indent > 0) {
          const svcMatch = trimmed.match(/^([\w\\_.]+):\s*/);
          if (svcMatch && svcMatch[1]!.includes('\\') && indent >= 2) {
            const svcId = svcMatch[1]!;
            references.push({
              fromNodeId: `file:${filePath}`,
              referenceName: svcId,
              referenceKind: 'references',
              line: i + 1,
              column: 0,
              filePath,
              language: 'yaml',
            });
          }
        }
      }
      flushRoute();
    }

    return { nodes, references };
  },
};
