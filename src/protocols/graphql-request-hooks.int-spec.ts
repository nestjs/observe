import {
  INestApplication,
  Injectable,
  Module,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ApolloDriver, ApolloDriverConfig } from "@nestjs/apollo";
import {
  GqlRequestEndHookContext,
  GqlRequestStartHookContext,
  GraphQLModule,
  Query,
  Resolver,
  ResolverDecoratorHost,
} from "@nestjs/graphql";
import request from "supertest";
import { CompleteTraceEventNode } from "../interfaces/trace-events.interfaces.js";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

const TRUSTED_DOCUMENTS = new Set(["query Titles { titles }"]);

/** What the application's own hooks saw, for the assertions below. */
const seen = {
  started: [] as (string | undefined)[],
  ended: [] as unknown[],
};

/**
 * The application's use of the same two hooks: only the documents its own
 * client ships are run, and each one that ran is written down with the state
 * its start hook returned. Chained onto "the previous hook", as a careful
 * application would.
 */
function registerTrustedDocuments(host: ResolverDecoratorHost): void {
  const previousStart = host.getOnRequestStartHook();
  const previousEnd = host.getOnRequestEndHook();
  host.setOnRequestStartHook((ctx: GqlRequestStartHookContext) => {
    previousStart?.(ctx);
    seen.started.push(ctx.query);
    if (!TRUSTED_DOCUMENTS.has(ctx.query ?? "")) {
      throw new Error(`Not a trusted document: ${ctx.query}`);
    }
    return { audited: ctx.query };
  });
  host.setOnRequestEndHook((ctx: GqlRequestEndHookContext) => {
    previousEnd?.(ctx);
    seen.ended.push(ctx.state);
  });
}

@Resolver()
class NotesResolver {
  @Query(() => [String])
  titles(): string[] {
    return ["groceries"];
  }

  @Query(() => [String])
  drafts(): string[] {
    return ["unpublished"];
  }
}

/** Before the agent registers: Nest constructs this ahead of either attempt. */
@Injectable()
class TrustedDocumentsFromConstructor {
  constructor(host: ResolverDecoratorHost) {
    registerTrustedDocuments(host);
  }
}

/** After the agent registered, from its `onModuleInit` at the latest. */
@Injectable()
class TrustedDocumentsFromBootstrap implements OnApplicationBootstrap {
  constructor(private readonly host: ResolverDecoratorHost) {}

  onApplicationBootstrap(): void {
    registerTrustedDocuments(this.host);
  }
}

/** An asynchronous start hook, which a driver may or may not wait for. */
@Injectable()
class AsyncAudit {
  constructor(host: ResolverDecoratorHost) {
    host.setOnRequestStartHook(async (ctx: GqlRequestStartHookContext) => {
      await new Promise((resolve) => setImmediate(resolve));
      seen.started.push(ctx.query);
      return { audited: ctx.query };
    });
    host.setOnRequestEndHook((ctx: GqlRequestEndHookContext) => {
      seen.ended.push(ctx.state);
    });
  }
}

const imports = [
  ObserveModule.forRoot(testObserveOptions()),
  GraphQLModule.forRoot<ApolloDriverConfig>({
    driver: ApolloDriver,
    autoSchemaFile: true,
    playground: false,
    includeStacktraceInErrorResponses: false,
  }),
];

@Module({
  imports,
  providers: [NotesResolver, TrustedDocumentsFromConstructor],
})
class HooksFromConstructorModule {}

@Module({
  imports,
  providers: [NotesResolver, TrustedDocumentsFromBootstrap],
})
class HooksFromBootstrapModule {}

@Module({
  imports,
  // Both: the second chains onto the first, through the getter.
  providers: [
    NotesResolver,
    TrustedDocumentsFromConstructor,
    TrustedDocumentsFromBootstrap,
  ],
})
class ChainedHooksModule {}

@Module({ imports, providers: [NotesResolver, AsyncAudit] })
class AsyncHooksModule {}

async function start(rootModule: unknown) {
  const app = await NestFactory.create(rootModule as never, {
    instrument: ObserveInstrument,
    logger: false,
  });
  await app.init();
  return { app, collected: collectSnapshots(app) };
}

/**
 * `ResolverDecoratorHost` keeps one request-start hook and one request-end
 * hook, and they are public API: the application's to use as much as the
 * agent's. Whichever of the two registered second used to be the only one
 * left, so installing the agent switched off a check the application ran
 * there - or the application's hook switched off the agent - without a word
 * from either.
 */
describe.each([
  ["a provider's constructor", HooksFromConstructorModule],
  ["onApplicationBootstrap", HooksFromBootstrapModule],
  ["both, the second chaining the first", ChainedHooksModule],
])(
  "ObserveModule: GraphQL request hooks the application set from %s",
  (name, rootModule) => {
    let app: INestApplication;
    let collected: CollectedSnapshots;
    const runs = name.startsWith("both") ? 2 : 1;

    const gql = (query: string) =>
      request(app.getHttpServer()).post("/graphql").send({ query });

    beforeAll(async () => {
      ({ app, collected } = await start(rootModule));
    });

    afterAll(async () => {
      await app?.close();
    });

    beforeEach(() => {
      collected.clear();
      seen.started.length = 0;
      seen.ended.length = 0;
    });

    it("runs the application's hooks and still records the operation", async () => {
      const response = await gql("query Titles { titles }").expect(200);
      expect(response.body.data).toEqual({ titles: ["groceries"] });

      expect(seen.started).toEqual(Array(runs).fill("query Titles { titles }"));
      // Each end hook is handed what its own start hook returned.
      expect(seen.ended).toEqual(
        Array.from({ length: runs }, () => ({
          audited: "query Titles { titles }",
        })),
      );

      const snapshot = await waitForSnapshot(
        collected,
        (item) => item.operationId === "Query.titles",
      );
      const traces = snapshot.traces as CompleteTraceEventNode[];
      expect(traces).toHaveLength(1);
      expect(traces[0]).toMatchObject({
        className: "NotesResolver",
        methodKey: "titles",
      });
      expect(traces[0].error).toBeUndefined();
    });

    it("does not run a document the application's start hook refuses, and records it failed", async () => {
      const response = await gql("{ drafts }");
      expect(response.status).toBe(500);
      expect(response.body.data).toBeUndefined();
      expect(JSON.stringify(response.body)).not.toContain("unpublished");

      // The span the agent opened ahead of the refusal is closed with it.
      const snapshot = await waitForSnapshot(
        collected,
        (item) => item.operationId === "Query.drafts",
      );
      expect(snapshot.error?.message).toBe(
        "Not a trusted document: { drafts }",
      );
    });
  },
);

describe("ObserveModule: an asynchronous GraphQL start hook of the application's", () => {
  let app: INestApplication;
  let collected: CollectedSnapshots;

  beforeAll(async () => {
    ({ app, collected } = await start(AsyncHooksModule));
  });

  afterAll(async () => {
    await app?.close();
  });

  it("is handed to its end hook as the driver hands it, and the operation is recorded", async () => {
    seen.ended.length = 0;
    await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: "query Titles { titles }" })
      .expect(200);

    // The promise itself where the driver does not await the start hook
    // (Apollo before 14.2), what it resolved to where it does.
    expect(seen.ended).toHaveLength(1);
    expect(await seen.ended[0]).toEqual({
      audited: "query Titles { titles }",
    });
    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "Query.titles",
    );
    expect(snapshot.traces).toHaveLength(1);
  });
});
