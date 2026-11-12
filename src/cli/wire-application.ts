import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import type * as TS from "typescript";
import { isProjectFile } from "./project-files.js";
import { SDK_PACKAGE, TypeScript } from "./project-setup.js";

/** One file the wiring changed, and what it changed there. */
export interface WiredFile {
  /** Relative to the project, with forward slashes. */
  path: string;
  change: string;
}

export type WireResult =
  | { kind: "wired"; files: WiredFile[] }
  | { kind: "manual"; reason: string };

interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** What a step could not do, as the reason the CLI prints. */
class ManualStep {
  constructor(readonly reason: string) {}
}

/**
 * Wires `@nestjs/observe` into one application the way `nest new` generates
 * it: `createObserveModule()` and `ObserveModule.forRoot()` in the root
 * module, `ObserveInstrument` passed to `NestFactory.create()`.
 *
 * The root module is the one `main.ts` hands to `NestFactory.create()`, found
 * by following its import - not assumed to be `app.module.ts`. The key pair is
 * read from `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET`, which link has just
 * written into `.env`.
 *
 * Both files change or neither does: every edit is worked out first, and
 * each edited file has to parse before anything is written. Whatever cannot
 * be done safely comes back as a reason, for the person to finish by hand.
 */
export function wireApplication(
  ts: TypeScript,
  cwd: string,
  mainPath: string,
  serviceId: string,
): WireResult {
  try {
    const files = planWiring(ts, cwd, mainPath, serviceId);
    for (const file of files) {
      // A link out of the tree, or a `../` path: some other application's
      // file, which nobody asked to have rewritten.
      if (!isProjectFile(cwd, file.path)) {
        return manual(`${file.path} leads out of the project`);
      }
      if (
        syntaxErrors(ts, file.path, file.text) >
        syntaxErrors(ts, file.path, file.original)
      ) {
        return manual(
          `editing ${file.path} would not have left it valid TypeScript`,
        );
      }
    }
    for (const file of files) {
      writeFileSync(join(cwd, file.path), file.text);
    }
    return {
      kind: "wired",
      files: files.map(({ path, change }) => ({ path, change })),
    };
  } catch (err) {
    if (err instanceof ManualStep) {
      return manual(err.reason);
    }
    throw err;
  }
}

function manual(reason: string): WireResult {
  return { kind: "manual", reason };
}

function planWiring(
  ts: TypeScript,
  cwd: string,
  mainPath: string,
  serviceId: string,
): Array<WiredFile & { text: string; original: string }> {
  const mainText = readFileSync(join(cwd, mainPath), "utf8");
  const main = parse(ts, mainPath, mainText);

  const create = findNestFactoryCreate(ts, main);
  if (!create) {
    throw new ManualStep(`${mainPath} has no NestFactory.create() call`);
  }
  const [rootArgument] = create.arguments;
  if (!rootArgument || !ts.isIdentifier(rootArgument)) {
    throw new ManualStep(
      `the module NestFactory.create() starts in ${mainPath} is not a plain class name`,
    );
  }
  const rootModule = rootArgument.text;
  const moduleImport = findImportOf(ts, main, rootModule);
  const specifier =
    moduleImport && ts.isStringLiteral(moduleImport.moduleSpecifier)
      ? moduleImport.moduleSpecifier.text
      : undefined;
  if (!moduleImport || !specifier?.startsWith(".")) {
    throw new ManualStep(
      `${mainPath} does not import ${rootModule} from a file of this project`,
    );
  }
  const modulePath = resolveImport(cwd, mainPath, specifier);
  if (!modulePath) {
    throw new ManualStep(
      `could not find ${specifier}, which ${mainPath} imports ${rootModule} from`,
    );
  }

  const moduleText = readFileSync(join(cwd, modulePath), "utf8");
  if (moduleText.includes("createObserveModule")) {
    throw new ManualStep(
      `${modulePath} already calls createObserveModule(), so it was left alone`,
    );
  }

  return [
    {
      path: modulePath,
      original: moduleText,
      text: wireRootModule(ts, modulePath, moduleText, rootModule, serviceId),
      change: `registers ObserveModule first in ${rootModule}'s imports, serviceId "${serviceId}"`,
    },
    {
      path: mainPath,
      original: mainText,
      text: wireMain(ts, mainPath, mainText, main, create, moduleImport),
      change: "passes ObserveInstrument to NestFactory.create()",
    },
  ];
}

/**
 * The root module: the import and the `createObserveModule()` call after the
 * last import, and `ObserveModule.forRoot()` as the first of `@Module()`'s
 * imports - ahead of `BullModule` and anything else that registers a queue,
 * so the jobs still running when the app stops are reported.
 */
function wireRootModule(
  ts: TypeScript,
  path: string,
  text: string,
  className: string,
  serviceId: string,
): string {
  const source = parse(ts, path, text);
  const declaration = source.statements.find(
    (statement): statement is TS.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === className,
  );
  const decorator = declaration
    ? decoratorsOf(ts, declaration).find(
        (candidate) =>
          ts.isCallExpression(candidate.expression) &&
          ts.isIdentifier(candidate.expression.expression) &&
          candidate.expression.expression.text === "Module",
      )
    : undefined;
  const metadata = decorator
    ? (decorator.expression as TS.CallExpression).arguments[0]
    : undefined;
  if (!decorator || !metadata || !ts.isObjectLiteralExpression(metadata)) {
    throw new ManualStep(
      `could not find @Module({ ... }) on ${className} in ${path}`,
    );
  }

  const style = styleOf(ts, source, text);
  const edits: TextEdit[] = [];

  const imports = metadata.properties.find(
    (property) => propertyName(ts, property) === "imports",
  );
  if (imports) {
    if (
      !ts.isPropertyAssignment(imports) ||
      !ts.isArrayLiteralExpression(imports.initializer)
    ) {
      throw new ManualStep(
        `the imports of ${className} in ${path} are not a plain array`,
      );
    }
    edits.push(
      prependElement(
        text,
        source,
        imports.initializer,
        lineIndent(text, imports.getStart(source)),
        style,
        serviceId,
      ),
    );
  } else {
    edits.push(
      prependImportsProperty(
        text,
        source,
        metadata,
        lineIndent(text, decorator.getStart(source)),
        style,
        serviceId,
      ),
    );
  }

  const { quote, semicolon, eol } = style;
  const declarations =
    `import { createObserveModule } from ${quote}${SDK_PACKAGE}${quote}${semicolon}${eol}${eol}` +
    `export const { ObserveModule, ObserveInstrument } = createObserveModule()${semicolon}`;
  const lastImport = source.statements.findLast(ts.isImportDeclaration);
  edits.push(
    lastImport
      ? {
          start: lastImport.getEnd(),
          end: lastImport.getEnd(),
          text: `${eol}${declarations}`,
        }
      : { start: 0, end: 0, text: `${declarations}${eol}${eol}` },
  );
  return applyEdits(text, edits);
}

/** `ObserveModule.forRoot({ ... })`, its first line at `indent`. */
function forRootCall(serviceId: string, indent: string, style: Style): string {
  const { quote, unit, eol } = style;
  const inner = indent + unit;
  return [
    "ObserveModule.forRoot({",
    `${inner}appKey: process.env.OBSERVE_APP_KEY,`,
    `${inner}appSecret: process.env.OBSERVE_APP_SECRET,`,
    `${inner}serviceId: ${quote}${serviceId}${quote},`,
    `${indent}})`,
  ].join(eol);
}

/** `ObserveModule.forRoot()` as the first element of an `imports` array. */
function prependElement(
  text: string,
  source: TS.SourceFile,
  array: TS.ArrayLiteralExpression,
  propertyIndent: string,
  style: Style,
  serviceId: string,
): TextEdit {
  const { eol } = style;
  const open = array.getStart(source);
  const inner = text.slice(open + 1, array.getEnd() - 1);

  // One element a line already: in at the top, at the elements' own
  // indentation, the rest as it was.
  if (array.elements.length > 0 && startsLine(text, open + 1)) {
    const indent = lineIndent(text, array.elements[0].getStart(source));
    const call = forRootCall(serviceId, indent, style);
    return { start: open + 1, end: open + 1, text: `${eol}${indent}${call},` };
  }
  const indent = propertyIndent + style.unit;
  const call = forRootCall(serviceId, indent, style);
  // Empty, or all on one line: laid out a line each, keeping what was there
  // - comments included - on the line after.
  const rest = inner.trim();
  const comma =
    array.elements.length > 0 && !array.elements.hasTrailingComma ? "," : "";
  return {
    start: open,
    end: array.getEnd(),
    text:
      `[${eol}${indent}${call},` +
      (rest ? `${eol}${indent}${rest}${comma}` : "") +
      `${eol}${propertyIndent}]`,
  };
}

/** `imports: [ObserveModule.forRoot()]` as the first property of `@Module()`. */
function prependImportsProperty(
  text: string,
  source: TS.SourceFile,
  metadata: TS.ObjectLiteralExpression,
  decoratorIndent: string,
  style: Style,
  serviceId: string,
): TextEdit {
  const { eol, unit } = style;
  const open = metadata.getStart(source);
  const multiline =
    metadata.properties.length > 0 && startsLine(text, open + 1);
  const propertyIndent = multiline
    ? lineIndent(text, metadata.properties[0].getStart(source))
    : decoratorIndent + unit;
  const indent = propertyIndent + unit;
  const property =
    `imports: [${eol}${indent}${forRootCall(serviceId, indent, style)},` +
    `${eol}${propertyIndent}],`;

  if (multiline) {
    return {
      start: open + 1,
      end: open + 1,
      text: `${eol}${propertyIndent}${property}`,
    };
  }
  const rest = text.slice(open + 1, metadata.getEnd() - 1).trim();
  const comma =
    metadata.properties.length > 0 && !metadata.properties.hasTrailingComma
      ? ","
      : "";
  return {
    start: open,
    end: metadata.getEnd(),
    text:
      `{${eol}${propertyIndent}${property}` +
      (rest ? `${eol}${propertyIndent}${rest}${comma}` : "") +
      `${eol}${decoratorIndent}}`,
  };
}

/**
 * `main.ts`: `ObserveInstrument` imported alongside the root module, and
 * passed as `instrument` in `NestFactory.create()`'s options - added to the
 * options object when there is one, as a new argument when there is not.
 */
function wireMain(
  ts: TypeScript,
  path: string,
  text: string,
  source: TS.SourceFile,
  create: TS.CallExpression,
  moduleImport: TS.ImportDeclaration,
): string {
  const style = styleOf(ts, source, text);
  const { eol, unit } = style;
  const edits: TextEdit[] = [];

  const args = create.arguments;
  const last = args[args.length - 1];
  if (args.length >= 2 && ts.isObjectLiteralExpression(last)) {
    if (
      last.properties.some(
        (property) => propertyName(ts, property) === "instrument",
      )
    ) {
      throw new ManualStep(
        `NestFactory.create() in ${path} already has an instrument option`,
      );
    }
    if (last.properties.length === 0) {
      edits.push({
        start: last.getStart(source),
        end: last.getEnd(),
        text: "{ instrument: ObserveInstrument }",
      });
    } else {
      const lastProperty = last.properties[last.properties.length - 1];
      const separator = startsLine(text, last.getStart(source) + 1)
        ? `${eol}${lineIndent(text, lastProperty.getStart(source))}`
        : " ";
      edits.push({
        start: lastProperty.getEnd(),
        end: lastProperty.getEnd(),
        text: `,${separator}instrument: ObserveInstrument`,
      });
    }
  } else if (startsLine(text, args.pos)) {
    // Arguments a line each: the options as one more line.
    edits.push({
      start: last.getEnd(),
      end: last.getEnd(),
      text: `,${eol}${lineIndent(text, last.getStart(source))}{ instrument: ObserveInstrument }`,
    });
  } else {
    const indent = lineIndent(text, create.getStart(source));
    edits.push({
      start: last.getEnd(),
      end: last.getEnd(),
      text: `, {${eol}${indent}${unit}instrument: ObserveInstrument,${eol}${indent}}`,
    });
  }

  const bindings = moduleImport.importClause?.namedBindings;
  if (bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0) {
    const lastBinding = bindings.elements[bindings.elements.length - 1];
    edits.push({
      start: lastBinding.getEnd(),
      end: lastBinding.getEnd(),
      text: ", ObserveInstrument",
    });
  } else {
    const specifier = moduleImport.moduleSpecifier.getText(source);
    edits.push({
      start: moduleImport.getEnd(),
      end: moduleImport.getEnd(),
      text: `${eol}import { ObserveInstrument } from ${specifier}${style.semicolon}`,
    });
  }
  return applyEdits(text, edits);
}

/** How the file is written, so what is added reads like the rest of it. */
interface Style {
  quote: string;
  semicolon: string;
  /** One level of indentation. */
  unit: string;
  eol: string;
}

function styleOf(ts: TypeScript, source: TS.SourceFile, text: string): Style {
  const firstImport = source.statements.find(ts.isImportDeclaration);
  return {
    quote: firstImport
      ? text[firstImport.moduleSpecifier.getStart(source)]
      : "'",
    semicolon:
      firstImport && !firstImport.getText(source).endsWith(";") ? "" : ";",
    unit: indentUnit(text),
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

/**
 * One level of indentation: a tab if lines are indented with tabs, otherwise
 * the shallowest indentation in the file. Doc comments' ` * ` lines do not
 * count; they are indented by one space whatever the file uses.
 */
function indentUnit(text: string): string {
  let unit: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^([ \t]+)[^\s*]/.exec(line);
    if (!match) {
      continue;
    }
    if (match[1].startsWith("\t")) {
      return "\t";
    }
    if (unit === undefined || match[1].length < unit.length) {
      unit = match[1];
    }
  }
  return unit ?? "  ";
}

/** The whitespace the line holding `position` starts with. */
function lineIndent(text: string, position: number): string {
  const start = text.lastIndexOf("\n", position - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start))?.[0] ?? "";
}

/** Whether nothing but a line break follows `position` on its line. */
function startsLine(text: string, position: number): boolean {
  return /^[ \t]*(\/\/[^\n]*)?\r?\n/.test(text.slice(position));
}

function parse(ts: TypeScript, path: string, text: string): TS.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

/**
 * Syntax errors only - a file can be valid TypeScript and still not type-check
 * against packages that are not installed yet. Compared with the file as it
 * was, so a project that already trips the parser somewhere is not refused.
 */
function syntaxErrors(ts: TypeScript, path: string, text: string): number {
  const { diagnostics } = ts.transpileModule(text, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: { experimentalDecorators: true },
  });
  return (diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  ).length;
}

function findNestFactoryCreate(
  ts: TypeScript,
  source: TS.SourceFile,
): TS.CallExpression | undefined {
  let found: TS.CallExpression | undefined;
  const visit = (node: TS.Node) => {
    if (found) {
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "NestFactory" &&
      node.expression.name.text === "create"
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function findImportOf(
  ts: TypeScript,
  source: TS.SourceFile,
  identifier: string,
): TS.ImportDeclaration | undefined {
  return source.statements.find(
    (statement): statement is TS.ImportDeclaration => {
      if (!ts.isImportDeclaration(statement) || !statement.importClause) {
        return false;
      }
      const { name, namedBindings } = statement.importClause;
      return (
        name?.text === identifier ||
        (!!namedBindings &&
          ts.isNamedImports(namedBindings) &&
          namedBindings.elements.some(
            (element) => element.name.text === identifier,
          ))
      );
    },
  );
}

/** `./app.module` or `./app.module.js` from `src/main.ts`, as `src/app.module.ts`. */
function resolveImport(
  cwd: string,
  fromPath: string,
  specifier: string,
): string | undefined {
  const base = posix.join(
    posix.dirname(fromPath),
    specifier.replace(/\.(js|mjs|cjs|ts|mts|cts)$/, ""),
  );
  return [`${base}.ts`, `${base}.mts`, `${base}/index.ts`].find((candidate) =>
    existsSync(join(cwd, candidate)),
  );
}

/**
 * A class's decorators - through `getDecorators()` from TypeScript 4.8, which
 * moved them off the node, and off the node before that.
 */
function decoratorsOf(
  ts: TypeScript,
  node: TS.ClassDeclaration,
): readonly TS.Decorator[] {
  if (typeof ts.getDecorators === "function") {
    return ts.getDecorators(node) ?? [];
  }
  return (node as unknown as { decorators?: TS.Decorator[] }).decorators ?? [];
}

function propertyName(
  ts: TypeScript,
  property: TS.ObjectLiteralElementLike,
): string | undefined {
  const name = property.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name))
    ? name.text
    : undefined;
}

function applyEdits(text: string, edits: TextEdit[]): string {
  return [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce(
      (result, edit) =>
        result.slice(0, edit.start) + edit.text + result.slice(edit.end),
      text,
    );
}
