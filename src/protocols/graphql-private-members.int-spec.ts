import { ApolloDriver, ApolloDriverConfig } from "@nestjs/apollo";
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  Module,
  SetMetadata,
  UseGuards,
} from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import {
  Args,
  Field,
  GraphQLModule,
  Int,
  Mutation,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  Resolver,
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
import { nestAtLeast } from "../testing/nest-version.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

@ObjectType()
class Account {
  @Field(() => Int)
  id: number;

  @Field()
  owner: string;

  @Field(() => Int)
  balance: number;
}

@Injectable()
class AuditService {
  record(entry: string): string {
    return entry;
  }
}

/** Lets a handler through unless it is marked for the admin role. */
@Injectable()
class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    return this.reflector.get("role", context.getHandler()) !== "admin";
  }
}

@Resolver(() => Account)
class AccountsResolver {
  readonly #accounts = new Map<number, Account>([
    [1, { id: 1, owner: "alice", balance: 100 }],
  ]);
  readonly #limits = new Map<number, number>([[1, 500]]);
  readonly #currency = "EUR";

  constructor(private readonly audit: AuditService) {}

  @Query(() => Account, { nullable: true })
  account(@Args("id", { type: () => Int }) id: number): Account | null {
    return this.#accounts.get(id) ?? null;
  }

  @Mutation(() => Account)
  deposit(
    @Args("id", { type: () => Int }) id: number,
    @Args("amount", { type: () => Int }) amount: number,
  ): Account {
    const account = this.#find(id);
    account.balance += amount;
    this.audit.record(`deposit:${id}`);
    return account;
  }

  @UseGuards(RolesGuard)
  @SetMetadata("role", "admin")
  @Mutation(() => Boolean)
  closeAccount(@Args("id", { type: () => Int }) id: number): boolean {
    return this.#accounts.delete(id);
  }

  /** Takes a parameter, so Nest builds it the whole resolver context. */
  @ResolveField(() => Int)
  limit(@Parent() account: Account): number {
    return this.#limits.get(account.id) ?? 0;
  }

  /** Takes none: Nest binds it to the instance and calls it directly. */
  @ResolveField(() => String)
  currency(): string {
    return this.#currency;
  }

  #find(id: number): Account {
    return this.#accounts.get(id)!;
  }
}

@Resolver()
class LedgerResolver {
  readonly #entries = [100, 5];

  @UseGuards(RolesGuard)
  @SetMetadata("role", "admin")
  @Query(() => Int)
  ledgerSize(): number {
    return this.#entries.length;
  }
}

@Module({
  imports: [
    ObserveModule.forRoot(testObserveOptions()),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      playground: false,
      includeStacktraceInErrorResponses: false,
    }),
  ],
  providers: [
    AccountsResolver,
    AuditService,
    RolesGuard,
    // Under a token of its own: Nest finds this one's module, and the guard
    // the module provides, by the instance the container holds.
    { provide: "LEDGER_RESOLVER", useClass: LedgerResolver },
  ],
})
class PrivateMembersTestModule {}

/** Every span of a tree, depth first, as `Class.method`. */
function spanNames(
  nodes: ReadonlyArray<Pick<CompleteTraceEventNode, "className" | "methodKey">>,
): string[] {
  const names: string[] = [];
  for (const node of nodes) {
    names.push(`${node.className}.${node.methodKey}`);
    const { children } = node as { children?: CompleteTraceEventNode[] };
    names.push(...spanNames(children ?? []));
  }
  return names;
}

/**
 * Resolvers with native private members.
 *
 * `@nestjs/graphql` reads a resolver's methods off the class prototype and
 * applies them to the instance the container holds. With the agent that was
 * the instrumentation proxy, which no `this.#x` accepts as its receiver: every
 * operation of such a resolver answered `INTERNAL_SERVER_ERROR`.
 */
describe("ObserveModule: GraphQL resolvers with private members", () => {
  let app: INestApplication;
  let collected: CollectedSnapshots;

  const gql = (query: string) =>
    request(app.getHttpServer()).post("/graphql").send({ query });

  beforeAll(async () => {
    app = await NestFactory.create(PrivateMembersTestModule, {
      instrument: ObserveInstrument,
      logger: false,
    });
    collected = collectSnapshots(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => collected.clear());

  it("answers a query that reads a private field", async () => {
    const response = await gql("{ account(id: 1) { owner balance } }");

    expect(response.body).toEqual({
      data: { account: { owner: "alice", balance: 100 } },
    });
  });

  it("answers a mutation that calls a private method", async () => {
    const response = await gql(
      "mutation { deposit(id: 1, amount: 5) { balance } }",
    );

    expect(response.body).toEqual({ data: { deposit: { balance: 105 } } });
    // The operation's span is the resolver's, as for any other resolver, and
    // what the method reaches still hangs under it.
    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "Mutation.deposit",
    );
    expect(spanNames(snapshot.traces)).toEqual([
      "AccountsResolver.deposit",
      "AuditService.record",
    ]);
  });

  it("resolves fields that read private fields, on either path", async () => {
    const response = await gql("{ account(id: 1) { limit currency } }");

    expect(response.body).toEqual({
      data: { account: { limit: 500, currency: "EUR" } },
    });
  });

  it("still runs the guards of a resolver method", async () => {
    const response = await gql("mutation { closeAccount(id: 1) }");

    expect(response.body.data).toBeNull();
    expect(response.body.errors[0].extensions.code).toBe("FORBIDDEN");
  });

  // Nest finds the module of a resolver registered under another token, and
  // so its guards, only from 12.2.0 (nestjs/nest d1a5e0dd31); before that it
  // ran such a resolver without them, with the agent or without it.
  it.runIf(nestAtLeast("12.2.0"))(
    "keeps the guards of a resolver registered under another token",
    async () => {
      // Handed the instance behind the proxy, Nest found no module for this
      // resolver and ran the query with its guard left out.
      const response = await gql("{ ledgerSize }");

      expect(response.body.data).toBeNull();
      expect(response.body.errors[0].extensions.code).toBe("FORBIDDEN");
    },
  );
});
