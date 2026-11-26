import {
  Controller,
  Get,
  Inject,
  INestApplication,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Scope,
  Type,
} from "@nestjs/common";
import { NestFactory, REQUEST } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import request from "supertest";
import { createObserveModule } from "../observe.module.js";
import { createNodeAdapter, onPlatforms } from "../testing/nest-version.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

/** Built per request, and refuses one for an organization it cannot serve. */
@Injectable({ scope: Scope.REQUEST })
class ProjectsService {
  constructor(@Inject(REQUEST) req: { params: { orgId: string } }) {
    if (req.params.orgId === "not-an-org") {
      throw new NotFoundException("Organization not found");
    }
  }

  findAll() {
    return [{ id: 1 }];
  }
}

@Controller("orgs/:orgId/projects")
class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  findAll() {
    return this.projects.findAll();
  }
}

const MISSING_INSTRUMENT = /"instrument" option/;

type Platform = "express" | "node";

async function bootApp({
  platform,
  instrument,
}: {
  platform: Platform;
  instrument: boolean;
}): Promise<{ app: INestApplication; collected: CollectedSnapshots }> {
  const { ObserveModule, ObserveInstrument } = createObserveModule();

  @Module({
    imports: [ObserveModule.forRoot(testObserveOptions())],
    controllers: [ProjectsController],
    providers: [ProjectsService],
  })
  class ProjectsModule {}

  const app = await NestFactory.create(
    ProjectsModule as Type<unknown>,
    platform === "node" ? await createNodeAdapter() : new ExpressAdapter(),
    instrument
      ? { instrument: ObserveInstrument, logger: false }
      : { logger: false },
  );
  const collected = collectSnapshots(app);
  await app.init();
  return { app, collected };
}

/** What the agent logged as an error since the spy was set. */
function loggedErrors(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map(([message]) => String(message));
}

/**
 * A request can fail before anything that records a span runs: Nest builds a
 * request-scoped controller's instance - and every request-scoped provider it
 * injects - ahead of the guards, the interceptors and the handler, and a
 * constructor that throws ends the request there. The operation is routed and
 * named, and has no spans, which used to be read as `instrument` missing from
 * NestFactory, however the application was started.
 */
describe.each<Platform>(onPlatforms(["express", "node"]))(
  "ObserveModule: HTTP requests that fail before any span (%s)",
  (platform) => {
    let errors: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      errors = vi.spyOn(Logger.prototype, "error");
    });

    afterEach(() => {
      errors.mockRestore();
    });

    describe("with instrument", () => {
      let app: INestApplication;
      let collected: CollectedSnapshots;

      beforeAll(async () => {
        ({ app, collected } = await bootApp({ platform, instrument: true }));
      });

      afterAll(async () => {
        await app?.close();
      });

      beforeEach(() => collected.clear());

      it("reports a request whose provider threw while being built as failed, with no spans", async () => {
        await request(app.getHttpServer())
          .get("/orgs/not-an-org/projects")
          .expect(404);

        const snapshot = await waitForSnapshot(
          collected,
          (item) => item.operationId === "/orgs/:orgId/projects",
        );
        expect(snapshot.attributes?.statusCode).toBe(404);
        expect(snapshot.traces).toEqual([]);
        expect(loggedErrors(errors)).not.toContainEqual(
          expect.stringMatching(MISSING_INSTRUMENT),
        );
      });

      it("still records the spans of a request that gets past the constructor", async () => {
        await request(app.getHttpServer())
          .get("/orgs/acme/projects")
          .expect(200);

        const snapshot = await waitForSnapshot(
          collected,
          (item) => item.attributes?.originalUrl === "/orgs/acme/projects",
        );
        expect(snapshot.traces.length).toBeGreaterThan(0);
      });
    });

    describe("without instrument", () => {
      let app: INestApplication;

      beforeAll(async () => {
        ({ app } = await bootApp({ platform, instrument: false }));
      });

      afterAll(async () => {
        await app?.close();
      });

      it("still says the instrument is missing", async () => {
        await request(app.getHttpServer())
          .get("/orgs/acme/projects")
          .expect(200);

        await vi.waitFor(() => {
          expect(loggedErrors(errors)).toContainEqual(
            expect.stringMatching(MISSING_INSTRUMENT),
          );
        });
      });
    });
  },
);
