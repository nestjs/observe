/*
 * Swaps the dev tree onto an older Nest, so the repository's own suites can
 * run against it: `node scripts/use-nest.cjs 11.2.8`, then `npm test` and
 * `npm run test:int`. CI runs it in the older-Nest job (see ci.yml); run
 * locally, it is that job's exact install.
 *
 * It rewrites package.json and package-lock.json in place. To go back:
 * `git checkout -- package.json package-lock.json && npm ci --legacy-peer-deps`.
 *
 * The framework packages move as one set, at one version. Nest publishes them
 * together, and they are not interchangeable across minors whatever their peer
 * ranges say: @nestjs/microservices 12.1.3 and later call core's
 * `flushLogsIfAutoFlushEnabled`, which only core 12.1.3 and later has, so
 * microservices 12.3.3 beside core 12.0.1 boots and then crashes. The install
 * reads peers the legacy way (as the lockfile was written) and would let such
 * a set through without a word - so after it, every copy of every framework
 * package in node_modules, nested ones included, is checked against the
 * version asked for, and the swap fails if one is not.
 *
 * The versions are written into package.json, exact, rather than installed
 * with `--no-save`: the `overrides` entry for nestjs-cls follows the root's
 * spec (`$@nestjs/core`), and should name the core that is installed, not the
 * newest one package.json would otherwise still declare.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/** Published together, at one version - moved together. */
const FRAMEWORK = [
  "@nestjs/common",
  "@nestjs/core",
  "@nestjs/microservices",
  "@nestjs/platform-express",
  "@nestjs/platform-fastify",
  "@nestjs/platform-socket.io",
  "@nestjs/platform-ws",
  "@nestjs/testing",
  "@nestjs/websockets",
];

/**
 * Per Nest major, the line of each package versioned apart from the framework
 * that a Nest app of that major would have - the lines the SDK's own peer
 * ranges name - and the packages that major has no version of. The SDK
 * patches internals of several (the schedule explorer, the bullmq processor
 * decorator, the graphql resolver host), so their older lines are worth
 * running, not only the framework's. A major missing here keeps the dev tree's
 * versions.
 */
const COMPANIONS = {
  11: {
    install: {
      "@nestjs/apollo": "13.4.5",
      "@nestjs/bull": "11.0.5",
      "@nestjs/bullmq": "11.0.5",
      "@nestjs/graphql": "13.4.5",
      "@nestjs/schedule": "6.1.3",
    },
    // Nest 12 only: the suites gate their `node` platform cases on the major.
    remove: ["@nestjs/platform-node"],
  },
};

/**
 * Versioned apart from the framework, and kept at the dev tree's version
 * unless a COMPANIONS entry says otherwise. @nestjs/platform-node is here
 * because it has no line before 12.3, and 12.3.3 runs on core 12.0.1.
 */
const INDEPENDENT = [
  "@nestjs/apollo",
  "@nestjs/bull",
  "@nestjs/bullmq",
  "@nestjs/graphql",
  "@nestjs/platform-node",
  "@nestjs/schedule",
];

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error(
    "usage: node scripts/use-nest.cjs <exact version, e.g. 11.2.8>",
  );
  process.exit(2);
}
const major = Number(version.split(".")[0]);
const root = path.join(__dirname, "..");
const manifestPath = path.join(root, "package.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const dev = manifest.devDependencies;

// A @nestjs package added to the dev tree has to be sorted into one of the
// lists above, or it would stay on the newest Nest unnoticed.
const unsorted = Object.keys(dev).filter(
  (name) =>
    name.startsWith("@nestjs/") &&
    !FRAMEWORK.includes(name) &&
    !INDEPENDENT.includes(name),
);
if (unsorted.length > 0) {
  console.error(
    `use-nest: sort ${unsorted.join(", ")} into FRAMEWORK or INDEPENDENT in scripts/use-nest.cjs`,
  );
  process.exit(1);
}

const companions = COMPANIONS[major] ?? { install: {}, remove: [] };
for (const name of FRAMEWORK) {
  dev[name] = version;
}
Object.assign(dev, companions.install);
for (const name of companions.remove) {
  delete dev[name];
}
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

execFileSync(
  "npm",
  ["install", "--legacy-peer-deps", "--no-audit", "--no-fund"],
  { cwd: root, stdio: "inherit" },
);

/** Every installed copy of a package, nested ones included, by path. */
function findCopies(dir, found = new Map()) {
  const modules = path.join(dir, "node_modules");
  if (!fs.existsSync(modules)) {
    return found;
  }
  for (const entry of fs.readdirSync(modules)) {
    const names = entry.startsWith("@")
      ? fs.readdirSync(path.join(modules, entry)).map((n) => `${entry}/${n}`)
      : [entry];
    for (const name of names) {
      const pkgDir = path.join(modules, name);
      const pkgJson = path.join(pkgDir, "package.json");
      if (fs.existsSync(pkgJson)) {
        const copies = found.get(name) ?? [];
        copies.push({
          at: path.relative(root, pkgDir),
          version: JSON.parse(fs.readFileSync(pkgJson, "utf8")).version,
        });
        found.set(name, copies);
      }
      findCopies(pkgDir, found);
    }
  }
  return found;
}

const copies = findCopies(root);
const wrong = [];
for (const name of FRAMEWORK) {
  for (const copy of copies.get(name) ?? [{ at: name, version: "missing" }]) {
    if (copy.version !== version) {
      wrong.push(`${copy.at}@${copy.version}`);
    }
  }
}
for (const [name, want] of Object.entries(companions.install)) {
  for (const copy of copies.get(name) ?? [{ at: name, version: "missing" }]) {
    if (copy.version !== want) {
      wrong.push(`${copy.at}@${copy.version} (wanted ${want})`);
    }
  }
}
for (const name of companions.remove) {
  for (const copy of copies.get(name) ?? []) {
    wrong.push(`${copy.at}@${copy.version} (wanted none)`);
  }
}

for (const [name, list] of [...copies].sort(([a], [b]) => a.localeCompare(b))) {
  if (name.startsWith("@nestjs/")) {
    for (const copy of list) {
      console.log(`  ${copy.at}  ${copy.version}`);
    }
  }
}
if (wrong.length > 0) {
  console.error(
    `use-nest: not a Nest ${version} set:\n  ${wrong.join("\n  ")}`,
  );
  process.exit(1);
}
console.log(`use-nest: Nest ${version}, as one set`);
