import {
  INestApplication,
  Injectable,
  Module,
  PipeTransform,
} from "@nestjs/common";
import { APP_PIPE, NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { ApolloDriver, ApolloDriverConfig } from "@nestjs/apollo";
import {
  Args,
  Field,
  GraphQLModule,
  Int,
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
  DEFAULT_SPAN_COLLAPSE,
  SPAN_COLLAPSED_TAG,
} from "../services/collapse-repeated-spans.util.js";
import { createNodeAdapter, onPlatforms } from "../testing/nest-version.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

const ORDER_COUNT = 60;

@ObjectType()
class Order {
  @Field(() => Int)
  id: number;
}

/**
 * Stands in for `ValidationPipe` registered through `APP_PIPE` - the idiomatic
 * registration when the pipe needs injection, and the one that runs it once
 * per argument of every field resolver. Named differently so a failure here
 * cannot be mistaken for one in Nest's own pipe.
 */
@Injectable()
class ArgsValidationPipe implements PipeTransform {
  transform(value: unknown): unknown {
    return value;
  }
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
    return Array.from({ length: ORDER_COUNT }, (_, i) => ({ id: i + 1 }));
  }

  @ResolveField(() => Int)
  total(
    @Parent() order: Order,
    @Args("factor", { type: () => Int, nullable: true }) factor?: number,
  ): number {
    return this.pricing.quote(order.id) * (factor ?? 1);
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
    OrdersResolver,
    PricingService,
    { provide: APP_PIPE, useClass: ArgsValidationPipe },
  ],
})
class GraphqlCollapseTestModule {}

type Platform = "express" | "node";

/**
 * The production shape of the span flood this guards against: one list query,
 * a global pipe, and a pipe call for every argument of every field resolver.
 * Uncollapsed, a sixty-row list produced well over a hundred identical
 * siblings under the operation span; the assertion is that what ships is
 * bounded by the defaults, with the slowest calls still present individually.
 */
describe.each<Platform>(onPlatforms(["express", "node"]))(
  "ObserveModule: GraphQL span collapsing (%s)",
  (platform) => {
    let app: INestApplication;
    let collected: CollectedSnapshots;

    const gql = (query: string) =>
      request(app.getHttpServer()).post("/graphql").send({ query });

    const ofClass = (nodes: CompleteTraceEventNode[], className: string) =>
      nodes.filter((node) => node.className === className);

    const countOf = (node: CompleteTraceEventNode) =>
      node.tags?.[SPAN_COLLAPSED_TAG] as number | undefined;

    const countNodes = (nodes: CompleteTraceEventNode[]): number =>
      nodes.reduce((sum, node) => sum + 1 + countNodes(node.children ?? []), 0);

    beforeAll(async () => {
      app = await NestFactory.create(
        GraphqlCollapseTestModule,
        platform === "node" ? await createNodeAdapter() : new ExpressAdapter(),
        { instrument: ObserveInstrument, logger: false },
      );
      await app.init();
      collected = collectSnapshots(app);
    });

    afterAll(async () => {
      await app?.close();
    });

    beforeEach(() => collected.clear());

    it("ships a bounded number of pipe spans for a list query", async () => {
      const response = await gql("{ orders { id total(factor: 2) } }").expect(
        200,
      );
      expect(response.body.data.orders).toHaveLength(ORDER_COUNT);
      expect(response.body.data.orders[0].total).toBe(20);

      const snapshot = await waitForSnapshot(
        collected,
        (item) => item.operationId === "Query.orders",
      );

      expect(snapshot.traces).toHaveLength(1);
      const [operation] = snapshot.traces as CompleteTraceEventNode[];
      const children = operation.children ?? [];

      // The pipe ran at least once per row, and what is left of that is the
      // kept slowest plus one aggregate.
      const pipes = ofClass(children, "ArgsValidationPipe");
      expect(pipes).toHaveLength(DEFAULT_SPAN_COLLAPSE.keepSlowest + 1);

      const collapsed = pipes.filter((node) => countOf(node) !== undefined);
      expect(collapsed).toHaveLength(1);
      const count = countOf(collapsed[0])!;
      expect(count).toBeGreaterThanOrEqual(
        ORDER_COUNT - DEFAULT_SPAN_COLLAPSE.keepSlowest,
      );
      expect(collapsed[0]).toMatchObject({
        origin: "auto",
        methodKey: "transform",
        name: `ArgsValidationPipe.transform ×${count}`,
        startOffset: expect.any(Number),
      });
      expect(collapsed[0].error).toBeUndefined();

      // The kept instances are the slowest: each outlasts the mean of the rest.
      const mean = collapsed[0].duration / count;
      for (const kept of pipes.filter((node) => countOf(node) === undefined)) {
        expect(kept.duration).toBeGreaterThanOrEqual(mean);
      }

      // The pricing call ran once per row and collapsed on its own terms.
      const quotes = ofClass(children, "PricingService");
      expect(quotes).toHaveLength(DEFAULT_SPAN_COLLAPSE.keepSlowest + 1);

      // The whole tree, not just one frame, is bounded.
      expect(
        countNodes(snapshot.traces as CompleteTraceEventNode[]),
      ).toBeLessThan(2 * (DEFAULT_SPAN_COLLAPSE.keepSlowest + 1) + 2);
    });

    it("does not collapse a query that stays under the threshold", async () => {
      await gql("{ orders { id } }").expect(200);

      const snapshot = await waitForSnapshot(
        collected,
        (item) => item.operationId === "Query.orders",
      );

      const [operation] = snapshot.traces as CompleteTraceEventNode[];
      // No field resolver ran, so no pipe ran, so nothing was there to collapse.
      for (const child of operation.children ?? []) {
        expect(countOf(child)).toBeUndefined();
      }
    });
  },
);
