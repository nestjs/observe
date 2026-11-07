import {
  Body,
  CanActivate,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  UseGuards,
  ValidationPipe,
} from "@nestjs/common";
import { APP_PIPE, NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

class CreateOrderDto {
  total?: number;
}

@Injectable()
class SessionGuard implements CanActivate {
  canActivate() {
    return this.hasSession();
  }

  hasSession() {
    return true;
  }
}

@Controller()
@UseGuards(SessionGuard)
class OrdersController {
  @Get("orders/:id")
  find(@Param("id") id: string) {
    return { id };
  }

  @Post("orders")
  create(@Body() dto: CreateOrderDto) {
    return { total: dto.total ?? null };
  }
}

@Module({
  imports: [ObserveModule.forRoot(testObserveOptions())],
  controllers: [OrdersController],
  providers: [
    {
      provide: APP_PIPE,
      useFactory: () =>
        new ValidationPipe({
          validatorPackage: { validate: () => [] } as never,
          transformerPackage: {
            plainToInstance: (_type: unknown, value: unknown) => value,
            classToPlain: (value: unknown) => value,
          } as never,
        }),
    },
  ],
})
class ValidatingPipeTestModule {}

/** Every span of a tree, depth first, as `Class.method`. */
function spanNames(nodes: unknown): string[] {
  return ((nodes ?? []) as Array<Record<string, any>>).flatMap((node) => [
    `${node.className}.${node.methodKey}`,
    ...spanNames(node.children),
  ]);
}

/**
 * What a real application ships for a global `ValidationPipe` resolved by the
 * real injector, beside a guard that is the control: the pipe makes a span only
 * when it validates, and the guard keeps all of its own.
 */
describe("ObserveModule: Nest's validating pipes", () => {
  let app: NestExpressApplication;
  let collected: CollectedSnapshots;

  const namesOf = async (operationId: string) =>
    spanNames(
      (
        await waitForSnapshot(
          collected,
          (item) => item.operationId === operationId,
        )
      ).traces,
    );

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(
      ValidatingPipeTestModule,
      { instrument: ObserveInstrument, logger: false },
    );
    collected = collectSnapshots(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => collected.clear());

  it("ships nothing for an argument it doesn't validate", async () => {
    await request(app.getHttpServer()).get("/orders/7").expect(200, {
      id: "7",
    });

    const names = await namesOf("/orders/:id");
    expect(names.filter((name) => name.startsWith("ValidationPipe."))).toEqual(
      [],
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "SessionGuard.canActivate",
        "SessionGuard.hasSession",
        "OrdersController.find",
      ]),
    );
  });

  it("ships `validate` for an argument it does", async () => {
    await request(app.getHttpServer())
      .post("/orders")
      .send({ total: 3 })
      .expect(201, { total: 3 });

    const names = await namesOf("/orders");
    expect(names.filter((name) => name.startsWith("ValidationPipe."))).toEqual([
      "ValidationPipe.validate",
    ]);
    expect(names).toContain("SessionGuard.hasSession");
  });
});
