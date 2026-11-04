import {
  Controller,
  Get,
  INestApplication,
  Injectable,
  Module,
  NotFoundException,
  Param,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import request from "supertest";
import { RequestSnapshotEncoder } from "../encoders/request-snapshot.encoder.js";
import { createObserveModule } from "../observe.module.js";
import { createNodeAdapter, onPlatforms } from "../testing/nest-version.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

@Injectable()
class ContactsService {
  findOne(id: string) {
    if (id === "missing") {
      throw new NotFoundException("Contact not found");
    }
    return { id };
  }
}

@Controller()
class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get("contacts/:id")
  findOne(@Param("id") id: string) {
    return this.contacts.findOne(id);
  }

  @Get("crash")
  crash() {
    throw new Error("deliberate");
  }
}

@Module({
  imports: [
    ObserveModule.forRoot(
      testObserveOptions({ skipSpans: [400, 401, 403, 404] }),
    ),
  ],
  controllers: [ContactsController],
  providers: [ContactsService],
})
class SkipSpansTestModule {}

type Platform = "express" | "node";

/**
 * `skipSpans` end to end: an application that answers "not found" by throwing
 * `NotFoundException` - the idiomatic Nest way - ships those requests without
 * the span tree it would otherwise pay for, and keeps everything else as it
 * was.
 */
describe.each<Platform>(onPlatforms(["express", "node"]))(
  "ObserveModule: skipped spans (%s)",
  (platform) => {
    let app: INestApplication;
    let collected: CollectedSnapshots;

    beforeAll(async () => {
      app = await NestFactory.create(
        SkipSpansTestModule,
        platform === "node" ? await createNodeAdapter() : new ExpressAdapter(),
        { instrument: ObserveInstrument, logger: false },
      );
      collected = collectSnapshots(app);
      await app.init();
    });

    afterAll(async () => {
      await app?.close();
    });

    beforeEach(() => collected.clear());

    it("reports a listed 4xx with its status and error, and without its spans", async () => {
      await request(app.getHttpServer()).get("/contacts/missing").expect(404);

      const snapshot = await waitForSnapshot(
        collected,
        (item) => item.operationId === "/contacts/:id",
      );

      expect(snapshot.traces).toEqual([]);
      expect(snapshot.attributes).toMatchObject({
        method: "GET",
        statusCode: 404,
      });
      expect(snapshot.error).toMatchObject({
        cls: "NotFoundException",
        message: "Contact not found",
      });
      // Present and empty on the wire, not absent: the collector requires the
      // field, and a batch holding a snapshot without it is refused whole.
      expect(RequestSnapshotEncoder.encode(snapshot).t).toEqual([]);
    });

    it("keeps the spans of the same route when it succeeds", async () => {
      await request(app.getHttpServer()).get("/contacts/42").expect(200);

      const snapshot = await waitForSnapshot(
        collected,
        (item) => item.operationId === "/contacts/:id",
      );

      expect(snapshot.attributes?.statusCode).toBe(200);
      const [handler] = snapshot.traces as Array<{
        className: string;
        children?: Array<{ className: string }>;
      }>;
      expect(handler.className).toBe("ContactsController");
      expect(handler.children?.[0].className).toBe("ContactsService");
    });

    it("keeps the spans of a status the list does not name", async () => {
      await request(app.getHttpServer()).get("/crash").expect(500);

      const snapshot = await waitForSnapshot(
        collected,
        (item) => item.operationId === "/crash",
      );

      expect(snapshot.traces).toHaveLength(1);
      expect(snapshot.error).toMatchObject({ message: "deliberate" });
    });
  },
);
