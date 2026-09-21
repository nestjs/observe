import { Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { ApolloDriver, ApolloDriverConfig } from "@nestjs/apollo";
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
import { createObserveModule } from "../observe.module.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

@ObjectType()
class Order {
  @Field(() => Int)
  id: number;

  @Field()
  name: string;
}

@Injectable()
class PricingService {
  quote(id: number): number {
    return id * 10;
  }
}

@Resolver(() => Order)
class OrdersResolver {
  constructor(private readonly pricing: PricingService) {}

  @Query(() => [Order])
  orders(): Order[] {
    return [{ id: 1, name: "first" }];
  }

  @Query(() => Order)
  order(@Args("id", { type: () => Int }) id: number): Order {
    return { id, name: `order-${id}` };
  }

  @Query(() => Order)
  brokenOrder(): Order {
    throw new Error("deliberate");
  }

  @Query(() => Order)
  async slowOrder(): Promise<Order> {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { id: 7, name: "slow" };
  }

  @Mutation(() => Order)
  createOrder(@Args("name") name: string): Order {
    return { id: 99, name };
  }

  /** A schema name that differs from the method name, asserted on below. */
  @Query(() => [Order], { name: "latestOrders" })
  findLatest(): Order[] {
    return [{ id: 2, name: "latest" }];
  }

  /**
   * A field resolver, not a root one - deliberately left uninstrumented, and
   * asserted on below.
   */
  @ResolveField(() => Int)
  total(@Parent() order: Order): number {
    return this.pricing.quote(order.id);
  }
}

@Module({
  imports: [
    ObserveModule.forRoot(testObserveOptions()),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      // Keeps the suite's output about the assertions rather than about
      // Apollo's landing page and deliberate resolver errors.
      playground: false,
      includeStacktraceInErrorResponses: false,
    }),
  ],
  providers: [OrdersResolver, PricingService],
})
class GraphqlTestModule {}

/**
 * GraphQL collection.
 *
 * A Nest GraphQL server is an HTTP endpoint, so the HTTP agent sees every
 * operation the service handles - but it sees all of them as the same
 * `POST /graphql`, with no Nest route handler behind it and therefore no spans.
 * On its own that collects nothing at all: `OperationTraceRegistry.endTrace`
 * discards a trace that recorded no spans, on the reasoning that the request
 * never reached a handler.
 *
 * `GraphQLObserveAgentService` is what closes that gap. It claims the request
 * lifecycle hooks on `@nestjs/graphql`'s `ResolverDecoratorHost` and gives the
 * *operation* a span inside the trace the HTTP agent already opened - one span
 * covering parsing, validation and execution together - which both keeps the
 * trace alive and lets it be labelled with the operation that actually ran.
 *
 * The two consequences worth knowing are asserted below: an operation id is
 * `Query.orders` rather than `/graphql`, and a failing resolver is recorded as
 * an error even though GraphQL answered the request with a 200.
 */
describe("ObserveModule: GraphQL collection", () => {
  let app: NestExpressApplication;
  let collected: CollectedSnapshots;

  const gql = (query: string) =>
    request(app.getHttpServer()).post("/graphql").send({ query });

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(GraphqlTestModule, {
      instrument: ObserveInstrument,
      logger: false,
    });
    await app.init();
    collected = collectSnapshots(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => collected.clear());

  it("collects a snapshot for a GraphQL query", async () => {
    const response = await gql("{ orders { id name } }").expect(200);
    expect(response.body.data.orders).toHaveLength(1);

    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "Query.orders",
    );

    // The request was HTTP and is still reported as such - the GraphQL layer
    // sharpens the operation id and replaces the URL, which would otherwise
    // read `/graphql` on every row, with the document that ran.
    expect(snapshot.protocol).toBe("http");
    expect(snapshot.attributes?.method).toBe("POST");
    expect(snapshot.attributes?.originalUrl).toBe("{ orders { id name } }");
    expect(snapshot.attributes?.statusCode).toBe(200);
    expect(snapshot.traceId).toEqual(expect.any(String));
    expect(snapshot.duration).toBeGreaterThanOrEqual(0);
  });

  it("attributes the root span to the resolver class, not the schema type", async () => {
    // The operation id keeps the schema's vocabulary (`Query.orders`), but the
    // span's class is the class that registered the handler - `Query` on a
    // services page would lump every resolver in the schema into one row.
    await gql("{ orders { id } }").expect(200);

    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "Query.orders",
    );

    const [root] = snapshot.traces;
    expect(root).toMatchObject({
      className: "OrdersResolver",
      methodKey: "orders",
    });
  });

  it("attributes a renamed field to the method that serves it", async () => {
    // `@Query({ name })` decouples the schema field from the method. The
    // operation id speaks the schema's language; the span speaks the code's.
    await gql("{ latestOrders { id } }").expect(200);

    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "Query.latestOrders",
    );

    expect(snapshot.traces[0]).toMatchObject({
      className: "OrdersResolver",
      methodKey: "findLatest",
    });
  });

  it("collects a query taking arguments", async () => {
    const response = await gql("{ order(id: 7) { id name } }").expect(200);
    expect(response.body.data.order).toMatchObject({
      id: 7,
      name: "order-7",
    });

    await waitForSnapshot(
      collected,
      (item) => item.operationId === "Query.order",
    );
  });

  it("collects a mutation under its own operation id", async () => {
    await gql('mutation { createOrder(name: "new") { id name } }').expect(200);

    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "Mutation.createOrder",
    );

    expect(snapshot.traces[0]).toMatchObject({
      className: "OrdersResolver",
      methodKey: "createOrder",
    });
  });

  it("keeps operations apart rather than lumping them under /graphql", async () => {
    // The whole point of instrumenting resolvers: an HTTP-level agent sees one
    // path for the entire schema, so a GraphQL service's throughput and latency
    // would otherwise aggregate into a single "/graphql" row.
    await gql("{ orders { id } }").expect(200);
    await gql("{ order(id: 1) { id } }").expect(200);

    await waitForSnapshot(collected, () => collected.items.length >= 2);

    expect(new Set(collected.operationIds)).toEqual(
      new Set(["Query.orders", "Query.order"]),
    );
  });

  it("labels a multi-field document with its first root field", async () => {
    // One request, two root fields, and an operation id has to be one value.
    // First-in-document wins - arbitrary but stable, and unlike the per-field
    // spans this replaced, the two fields no longer compete for the label.
    await gql("{ orders { id } order(id: 3) { id } }").expect(200);

    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "Query.orders",
    );

    expect(collected.items).toHaveLength(1);
    // One span for the whole document, not one per root field: both fields'
    // execution is inside it, and the first field only lends it its name.
    expect(snapshot.traces).toHaveLength(1);
    expect(snapshot.traces[0]).toMatchObject({
      className: "OrdersResolver",
      methodKey: "orders",
    });
  });

  it("records the document as the originalUrl, telling requests to the same field apart", async () => {
    // Two requests to the same root field share an operation id - that is the
    // aggregation row - but the recorded document says what each one actually
    // selected, which the id alone cannot. It rides in `originalUrl`, which
    // for a GraphQL operation would otherwise say `/graphql` on every row:
    // the field every reader already treats as "what was this request", now
    // carrying the one value that answers it.
    await gql("{ orders { id } }").expect(200);
    await gql("{ orders { id name } }").expect(200);

    await waitForSnapshot(collected, () => collected.items.length >= 2);

    expect(new Set(collected.items.map((item) => item.operationId))).toEqual(
      new Set(["Query.orders"]),
    );
    expect(
      new Set(collected.items.map((item) => item.attributes?.originalUrl)),
    ).toEqual(new Set(["{ orders { id } }", "{ orders { id name } }"]));
  });

  it("keeps the operation name inline and blanks inline string arguments", async () => {
    await gql(
      'mutation CreateOrder { createOrder(name: "confidential") { id } }',
    ).expect(200);

    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "Mutation.createOrder",
    );

    // The document's shape - operation name included - is kept; the literal's
    // value is not.
    expect(snapshot.attributes?.originalUrl).toBe(
      "mutation CreateOrder { createOrder(name: _) { id } }",
    );
    // The rest of the HTTP attributes survive the overwrite.
    expect(snapshot.attributes?.method).toBe("POST");
    expect(snapshot.attributes?.statusCode).toBe(200);
  });

  it("records a failing resolver as an error, despite the 200", async () => {
    // GraphQL reports resolver errors in the body and answers 200 regardless,
    // so a status code taken from the transport would give a broken service a
    // flat zero error rate. The root span that threw is what classifies it.
    const response = await gql("{ brokenOrder { id } }").expect(200);
    expect(response.body.errors).toBeDefined();

    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "Query.brokenOrder",
    );

    expect(snapshot.attributes?.statusCode).toBe(500);
    expect(snapshot.error?.message).toBe("deliberate");
  });

  it("collects field-resolver work under the operation span", async () => {
    // A field resolver gets no span of its own - a list of 500 orders would
    // emit 500 of them - but the providers it calls are instrumented like any
    // other. The operation span covers the whole execution, field resolution
    // included, so that work nests underneath it rather than floating beside
    // it as it did when only root fields were bracketed.
    const response = await gql("{ orders { id total } }").expect(200);
    expect(response.body.data.orders[0].total).toBe(10);

    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "Query.orders",
    );

    expect(snapshot.traces).toHaveLength(1);
    const [operation] = snapshot.traces;
    expect(operation).toMatchObject({
      className: "OrdersResolver",
      methodKey: "orders",
    });
    expect(operation.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          className: "PricingService",
          methodKey: "quote",
        }),
      ]),
    );
  });

  it("collects one snapshot per request", async () => {
    await gql("{ orders { id } }").expect(200);
    await gql("{ orders { id } }").expect(200);
    await gql("{ orders { id } }").expect(200);

    await waitForSnapshot(collected, () => collected.items.length >= 3);
    expect(collected.items).toHaveLength(3);
  });

  it("reports both of two concurrent operations that arrive under one x-request-id", async () => {
    // A caller that fans out sends its trace id twice. The HTTP agent keys the
    // second request apart, and the operation has to find its trace under
    // that key rather than under the id the two share.
    await Promise.all([
      gql("{ slowOrder { id } }").set("x-request-id", "shared-trace-1"),
      gql("{ slowOrder { id } }").set("x-request-id", "shared-trace-1"),
    ]);

    await waitForSnapshot(collected, () => collected.items.length >= 2);
    for (const snapshot of collected.items) {
      expect(snapshot.traceId).toBe("shared-trace-1");
      expect(snapshot.operationId).toBe("Query.slowOrder");
      expect(snapshot.traces).toHaveLength(1);
      expect(snapshot.traces[0]).toMatchObject({
        className: "OrdersResolver",
        methodKey: "slowOrder",
      });
    }
  });
});
