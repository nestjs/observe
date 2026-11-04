import {
  Controller,
  Get,
  Inject,
  INestApplication,
  Module,
  Param,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ClientKafka,
  ClientMqtt,
  ClientNats,
  ClientRMQ,
  ClientsModule,
  Transport,
} from "@nestjs/microservices";
import { createObserveModule } from "../observe.module.js";
import {
  collectSnapshots,
  CollectedSnapshots,
  listenOnLoopback,
  markIngesting,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";
import { readTraceContext, w3cTraceIdOf } from "../utils/trace-context.util.js";

/** Packet metadata, as the dispatch hook leaves it. */
type Metadata = Record<string, string> | undefined;

/**
 * The parts of a client this suite reaches into: `createPacket`, which
 * `send()`, `emit()` and Kafka's `emitBatch()` build every packet with and
 * which runs the dispatch hook, and the helpers each transport turns the
 * packet's metadata into its own headers with as it sends - all protected,
 * none of them needing a connection or the broker's client library.
 */
interface PacketFactory {
  createPacket(pattern: string, data: unknown): { metadata?: Metadata };
}
interface KafkaInternals extends PacketFactory {
  serializer: {
    serialize(data: unknown, options: { pattern: string }): unknown;
  };
  mergeMetadata(
    message: { headers?: Record<string, unknown> },
    metadata: Metadata,
  ): { headers: Record<string, unknown> };
}
interface RmqInternals extends PacketFactory {
  mergeHeaders(requestHeaders: undefined, metadata: Metadata): Metadata;
}
interface MqttInternals extends PacketFactory {
  mergePacketOptions(
    requestOptions: undefined,
    metadata: Metadata,
  ): { properties?: { userProperties?: Record<string, string> } } | undefined;
}

const PATTERN = "order.confirmed";

@Controller()
class OrdersController {
  constructor(
    @Inject("NATS") private readonly nats: ClientNats,
    @Inject("KAFKA") private readonly kafka: ClientKafka,
    @Inject("RMQ") private readonly rmq: ClientRMQ,
    @Inject("MQTT") private readonly mqtt: ClientMqtt,
  ) {}

  /**
   * Builds the packet each client would send for an event, and what its
   * transport would carry the packet's metadata as - in the request's trace,
   * and without connecting to anything.
   */
  @Get("orders/:id/packets")
  async packets(@Param("id") id: string) {
    const data = { id };
    const nats = (this.nats as unknown as PacketFactory).createPacket(
      PATTERN,
      data,
    );

    const kafkaClient = this.kafka as unknown as KafkaInternals;
    const kafka = kafkaClient.createPacket(PATTERN, data);
    // As `ClientKafka#dispatchEvent` builds the record it hands the producer.
    const kafkaRecord = kafkaClient.mergeMetadata(
      (await kafkaClient.serializer.serialize(data, {
        pattern: PATTERN,
      })) as { headers?: Record<string, unknown> },
      kafka.metadata,
    );

    const rmqClient = this.rmq as unknown as RmqInternals;
    const rmq = rmqClient.createPacket(PATTERN, data);

    const mqttClient = this.mqtt as unknown as MqttInternals;
    const mqtt = mqttClient.createPacket(PATTERN, data);

    return {
      nats: { metadata: nats.metadata },
      kafka: { metadata: kafka.metadata, headers: kafkaRecord.headers },
      rmq: {
        metadata: rmq.metadata,
        headers: rmqClient.mergeHeaders(undefined, rmq.metadata),
      },
      mqtt: {
        metadata: mqtt.metadata,
        headers: mqttClient.mergePacketOptions(undefined, mqtt.metadata)
          ?.properties?.userProperties,
      },
    };
  }
}

interface Packets {
  [transport: string]: {
    metadata: Metadata;
    headers?: Record<string, unknown>;
  };
}

/**
 * The broker transports' half of opentelemetry-e2e-grpc-to-non-nest-server:
 * with `openTelemetry` on, the NATS, Kafka, RabbitMQ and MQTT clients a Nest
 * service registers with `ClientsModule` get the agent's dispatch hook too,
 * and the packet each builds carries a W3C `traceparent` beside
 * `x-request-id` in its metadata. `@nestjs/microservices` 12.3.3 sends that
 * metadata as the transport's own headers - NATS headers, Kafka record
 * headers, AMQP message headers, MQTT 5 user properties (nestjs/nest#18386)
 * - which is where a consumer in another language finds a `traceparent`.
 *
 * Unit level, without a broker: real clients, built by `ClientsModule` and
 * decorated by the agent, asked for their packets in a request. Kafka,
 * RabbitMQ and MQTT then turn the metadata into headers with the helpers
 * their `dispatchEvent` uses, which need no connection. NATS cannot: its
 * `mergeHeaders` builds the headers with the `nats` package, which it loads
 * on connect and this repository does not install, so it stops at the
 * packet.
 */
describe("OpenTelemetry interop on the NATS, Kafka, RabbitMQ and MQTT clients", () => {
  let app: INestApplication;
  let url = "";
  let snapshots: CollectedSnapshots;

  beforeAll(async () => {
    const { ObserveModule, ObserveInstrument } = createObserveModule();

    @Module({
      imports: [
        ObserveModule.forRoot(testObserveOptions({ openTelemetry: true })),
        ClientsModule.register([
          { name: "NATS", transport: Transport.NATS },
          { name: "KAFKA", transport: Transport.KAFKA },
          {
            name: "RMQ",
            transport: Transport.RMQ,
            options: { queue: "orders" },
          },
          {
            name: "MQTT",
            transport: Transport.MQTT,
            // User properties, and so packet metadata, are MQTT 5's.
            options: { protocolVersion: 5 },
          },
        ]),
      ],
      controllers: [OrdersController],
    })
    class OrdersModule {}

    app = await NestFactory.create(OrdersModule, {
      instrument: ObserveInstrument,
      logger: false,
    });
    snapshots = collectSnapshots(app);
    markIngesting(app);
    url = await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("puts a traceparent in the trace Observe reports the request under in every client's packet, beside x-request-id, and Kafka, RabbitMQ and MQTT carry both as headers", async () => {
    const response = await fetch(`${url}/orders/1/packets`);
    expect(response.status).toBe(200);
    const packets = (await response.json()) as Packets;
    const { traceId } = await waitForSnapshot(
      snapshots,
      (snapshot) => snapshot.protocol === "http",
    );

    expect(Object.keys(packets).sort()).toEqual([
      "kafka",
      "mqtt",
      "nats",
      "rmq",
    ]);
    for (const [transport, { metadata, headers }] of Object.entries(packets)) {
      // The packet: Observe's id for the trace, and a traceparent the spec
      // accepts, for the same trace in its W3C form.
      expect(metadata?.["x-request-id"], transport).toBe(traceId);
      expect(
        readTraceContext({ traceparent: metadata?.["traceparent"] })?.traceId,
        transport,
      ).toBe(w3cTraceIdOf(traceId));
      // What the transport sends: both, as they are.
      if (transport !== "nats") {
        expect(headers?.["x-request-id"], transport).toBe(traceId);
        expect(headers?.["traceparent"], transport).toBe(
          metadata?.["traceparent"],
        );
      }
    }
  });
});
