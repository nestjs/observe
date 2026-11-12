import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wireApplication } from "./wire-application.js";

/** What `nest new` generates without Observe. */
const NEST_NEW_MODULE = `import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
`;

const NEST_NEW_MAIN = `import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
`;

describe("wireApplication", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "observe-wire-"));
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  const read = (path: string) => readFileSync(join(cwd, path), "utf8");
  const wire = (main = "src/main.ts") =>
    wireApplication(ts, cwd, main, "orders-api");

  // A link out of the tree, or a `../` import: the file is some other
  // application's, which the person never asked to have rewritten.
  it.each([["src/main.ts"], ["src/app.module.ts"]])(
    "leaves the wiring to the person when %s leads out of the project",
    (linked) => {
      const outside = mkdtempSync(join(tmpdir(), "observe-outside-"));
      try {
        write("src/app.module.ts", NEST_NEW_MODULE);
        write("src/main.ts", NEST_NEW_MAIN);
        const original = read(linked);
        writeFileSync(join(outside, "theirs.ts"), original);
        rmSync(join(cwd, linked));
        symlinkSync(join(outside, "theirs.ts"), join(cwd, linked));

        expect(wire()).toMatchObject({ kind: "manual" });
        expect(readFileSync(join(outside, "theirs.ts"), "utf8")).toBe(original);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it("wires a nest new project the way nest new --observe generates it", () => {
    write("src/app.module.ts", NEST_NEW_MODULE);
    write("src/main.ts", NEST_NEW_MAIN);

    expect(wire()).toEqual({
      kind: "wired",
      files: [
        {
          path: "src/app.module.ts",
          change: `registers ObserveModule first in AppModule's imports, serviceId "orders-api"`,
        },
        {
          path: "src/main.ts",
          change: "passes ObserveInstrument to NestFactory.create()",
        },
      ],
    });
    expect(read("src/app.module.ts"))
      .toBe(`import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { createObserveModule } from '@nestjs/observe';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY,
      appSecret: process.env.OBSERVE_APP_SECRET,
      serviceId: 'orders-api',
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
`);
    expect(read("src/main.ts"))
      .toBe(`import { NestFactory } from '@nestjs/core';
import { AppModule, ObserveInstrument } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
  });
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
`);
  });

  it("keeps an ES module project's .js specifiers", () => {
    write("src/app.module.ts", NEST_NEW_MODULE);
    write(
      "src/main.ts",
      NEST_NEW_MAIN.replace("'./app.module'", "'./app.module.js'"),
    );

    expect(wire().kind).toBe("wired");
    expect(read("src/main.ts")).toContain(
      "import { AppModule, ObserveInstrument } from './app.module.js';",
    );
  });

  it("goes first in a real app's imports, keeping the rest as they were", () => {
    write(
      "src/app/app.module.ts",
      `import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    // Loads .env for everything below.
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRoot({ connection: { host: 'localhost' } }),
    UsersModule,
  ],
})
export class AppModule {}
`,
    );
    write(
      "src/main.ts",
      NEST_NEW_MAIN.replace("'./app.module'", "'./app/app.module'"),
    );

    expect(wire().kind).toBe("wired");
    expect(read("src/app/app.module.ts"))
      .toBe(`import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { UsersModule } from '../users/users.module';
import { createObserveModule } from '@nestjs/observe';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY,
      appSecret: process.env.OBSERVE_APP_SECRET,
      serviceId: 'orders-api',
    }),
    // Loads .env for everything below.
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRoot({ connection: { host: 'localhost' } }),
    UsersModule,
  ],
})
export class AppModule {}
`);
  });

  it("adds imports to a module that has none, and lays out a one-line array", () => {
    write(
      "src/app.module.ts",
      `import { Module } from '@nestjs/common';
import { AppController } from './app.controller';

@Module({
  controllers: [AppController],
})
export class AppModule {}
`,
    );
    write("src/main.ts", NEST_NEW_MAIN);
    expect(wire().kind).toBe("wired");
    expect(read("src/app.module.ts")).toContain(`@Module({
  imports: [
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY,
      appSecret: process.env.OBSERVE_APP_SECRET,
      serviceId: 'orders-api',
    }),
  ],
  controllers: [AppController],
})`);

    write(
      "src/app.module.ts",
      `import { Module } from '@nestjs/common';

@Module({ imports: [ConfigModule.forRoot(), UsersModule] })
export class AppModule {}
`,
    );
    write("src/main.ts", NEST_NEW_MAIN);
    expect(wire().kind).toBe("wired");
    // The array is laid out a line an element from its own line's
    // indentation; the decorator around it stays as it was written.
    expect(read("src/app.module.ts")).toContain(`@Module({ imports: [
  ObserveModule.forRoot({
    appKey: process.env.OBSERVE_APP_KEY,
    appSecret: process.env.OBSERVE_APP_SECRET,
    serviceId: 'orders-api',
  }),
  ConfigModule.forRoot(), UsersModule,
] })`);
  });

  it("writes in the file's own style: double quotes, no semicolons, four spaces", () => {
    write(
      "src/app.module.ts",
      `import { Module } from "@nestjs/common"

@Module({
    imports: [],
})
export class AppModule {}
`,
    );
    write(
      "src/main.ts",
      `import { NestFactory } from "@nestjs/core"
import { AppModule } from "./app.module"

async function bootstrap() {
    const app = await NestFactory.create(AppModule)
    await app.listen(3000)
}
bootstrap()
`,
    );

    expect(wire().kind).toBe("wired");
    expect(read("src/app.module.ts"))
      .toBe(`import { Module } from "@nestjs/common"
import { createObserveModule } from "@nestjs/observe"

export const { ObserveModule, ObserveInstrument } = createObserveModule()

@Module({
    imports: [
        ObserveModule.forRoot({
            appKey: process.env.OBSERVE_APP_KEY,
            appSecret: process.env.OBSERVE_APP_SECRET,
            serviceId: "orders-api",
        }),
    ],
})
export class AppModule {}
`);
    expect(read("src/main.ts"))
      .toContain(`import { AppModule, ObserveInstrument } from "./app.module"

async function bootstrap() {
    const app = await NestFactory.create(AppModule, {
        instrument: ObserveInstrument,
    })`);
  });

  it.each([
    [
      "an options object on one line",
      "NestFactory.create(AppModule, { bufferLogs: true })",
      "NestFactory.create(AppModule, { bufferLogs: true, instrument: ObserveInstrument })",
    ],
    [
      "an options object a property a line",
      "NestFactory.create(AppModule, {\n    bufferLogs: true,\n  })",
      "NestFactory.create(AppModule, {\n    bufferLogs: true,\n    instrument: ObserveInstrument,\n  })",
    ],
    [
      "an empty options object",
      "NestFactory.create(AppModule, {})",
      "NestFactory.create(AppModule, { instrument: ObserveInstrument })",
    ],
    [
      "an adapter and no options",
      "NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())",
      "NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {\n    instrument: ObserveInstrument,\n  })",
    ],
    [
      "an argument a line",
      "NestFactory.create(\n    AppModule,\n    new FastifyAdapter(),\n  )",
      "NestFactory.create(\n    AppModule,\n    new FastifyAdapter(),\n    { instrument: ObserveInstrument },\n  )",
    ],
  ])("passes the instrument alongside %s", (_, call, expected) => {
    write("src/app.module.ts", NEST_NEW_MODULE);
    write(
      "src/main.ts",
      NEST_NEW_MAIN.replace("NestFactory.create(AppModule)", call),
    );

    expect(wire().kind).toBe("wired");
    expect(read("src/main.ts")).toContain(expected);
  });

  it("imports the instrument on a line of its own beside a default import", () => {
    write(
      "src/app.module.ts",
      NEST_NEW_MODULE.replace("export class", "export default class"),
    );
    write(
      "src/main.ts",
      NEST_NEW_MAIN.replace(
        "import { AppModule } from './app.module';",
        "import AppModule from './app.module';",
      ),
    );

    expect(wire().kind).toBe("wired");
    expect(read("src/main.ts")).toContain(
      "import AppModule from './app.module';\nimport { ObserveInstrument } from './app.module';",
    );
  });

  it.each([
    [
      "there is no NestFactory.create()",
      NEST_NEW_MODULE,
      "export const app = 1;\n",
      /src\/main\.ts has no NestFactory\.create\(\) call/,
    ],
    [
      "the root module comes from a package",
      NEST_NEW_MODULE,
      NEST_NEW_MAIN.replace("'./app.module'", "'@acme/app'"),
      /does not import AppModule from a file of this project/,
    ],
    [
      "the options already set an instrument",
      NEST_NEW_MODULE,
      NEST_NEW_MAIN.replace(
        "NestFactory.create(AppModule)",
        "NestFactory.create(AppModule, { instrument })",
      ),
      /already has an instrument option/,
    ],
    [
      "the imports are not a plain array",
      NEST_NEW_MODULE.replace("imports: [],", "imports: modules,"),
      NEST_NEW_MAIN,
      /imports of AppModule in src\/app\.module\.ts are not a plain array/,
    ],
    [
      "the root module has no @Module()",
      "export class AppModule {}\n",
      NEST_NEW_MAIN,
      /could not find @Module\(\{ \.\.\. \}\) on AppModule/,
    ],
  ])("leaves both files alone when %s", (_, module, main, reason) => {
    write("src/app.module.ts", module);
    write("src/main.ts", main);

    const result = wire();

    expect(result.kind).toBe("manual");
    expect(result.kind === "manual" && result.reason).toMatch(reason);
    expect(read("src/app.module.ts")).toBe(module);
    expect(read("src/main.ts")).toBe(main);
  });
});
