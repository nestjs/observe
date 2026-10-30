import {
  CallHandler,
  CanActivate,
  Controller,
  DynamicModule,
  ExecutionContext,
  Get,
  Injectable,
  Module,
  NestInterceptor,
  NotFoundException,
  Param,
  ParseIntPipe,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { map, Observable } from "rxjs";
import { API_KEY, API_KEY_HEADER } from "./protocol.js";

/**
 * Stands in for a driver round trip: the continuation runs on a later turn of
 * the event loop, as a query's would, without a timer's jitter in the result.
 */
const io = () => new Promise<void>((resolve) => setImmediate(resolve));

interface OrderLine {
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

interface OrderRecord {
  id: number;
  customerId: number;
  status: string;
  createdAt: string;
  lines: OrderLine[];
}

interface CustomerRecord {
  id: number;
  name: string;
  email: string;
  tier: string;
}

const ORDERS = new Map<number, OrderRecord>(
  Array.from({ length: 100 }, (_, id) => [
    id,
    {
      id,
      customerId: id % 10,
      status: "paid",
      createdAt: new Date(Date.UTC(2026, 9, 1, 12, id % 60)).toISOString(),
      lines: Array.from({ length: 8 }, (__, line) => ({
        sku: `SKU-${1000 + line}`,
        name: `Catalog item number ${line}`,
        quantity: 1 + (line % 3),
        unitPrice: 9.99 + line,
      })),
    },
  ]),
);

const CUSTOMERS = new Map<number, CustomerRecord>(
  Array.from({ length: 10 }, (_, id) => [
    id,
    {
      id,
      name: `Customer ${id}`,
      email: `customer${id}@example.com`,
      tier: id % 2 ? "gold" : "standard",
    },
  ]),
);

@Controller()
class HelloController {
  @Get("hello")
  hello(): string {
    return "Hello World!";
  }
}

@Injectable()
class OrdersRepository {
  async findById(id: number): Promise<OrderRecord | undefined> {
    await io();
    return ORDERS.get(id);
  }
}

@Injectable()
class CustomersRepository {
  async findById(id: number): Promise<CustomerRecord | undefined> {
    await io();
    return CUSTOMERS.get(id);
  }
}

@Injectable()
class OrdersService {
  constructor(
    private readonly orders: OrdersRepository,
    private readonly customers: CustomersRepository,
  ) {}

  async findOne(id: number) {
    const order = await this.orders.findById(id);
    if (!order) {
      throw new NotFoundException();
    }
    const customer = await this.customers.findById(order.customerId);
    return this.toResponse(order, customer);
  }

  toResponse(order: OrderRecord, customer: CustomerRecord | undefined) {
    const total = order.lines.reduce(
      (sum, line) => sum + line.quantity * line.unitPrice,
      0,
    );
    return { ...order, customer, total: Math.round(total * 100) / 100 };
  }
}

@Injectable()
class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    return request.headers[API_KEY_HEADER] === API_KEY;
  }
}

@Injectable()
class EnvelopeInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(map((data) => ({ data })));
  }
}

@Controller("orders")
@UseGuards(ApiKeyGuard)
@UseInterceptors(EnvelopeInterceptor)
class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.ordersService.findOne(id);
  }
}

interface ReportRow {
  sku: string;
  quantity: number;
  amount: number;
}

const REPORT_ROWS: ReportRow[] = Array.from({ length: 100 }, (_, i) => ({
  sku: `SKU-${2000 + i}`,
  quantity: 1 + (i % 7),
  amount: ((i * 37) % 1000) / 3,
}));

@Injectable()
class LineFormatter {
  format(row: ReportRow): string {
    return `${row.sku.padEnd(10)}${String(row.quantity).padStart(4)}${row.amount.toFixed(2).padStart(10)}`;
  }
}

@Injectable()
class ReportService {
  constructor(private readonly formatter: LineFormatter) {}

  build(): string[] {
    return REPORT_ROWS.map((row) => this.formatter.format(row));
  }
}

@Controller()
class ReportController {
  constructor(private readonly reports: ReportService) {}

  @Get("report")
  report() {
    return { lines: this.reports.build() };
  }
}

interface CartLine {
  sku: string;
  quantity: number;
  unitPrice: number;
}

const CART: CartLine[] = Array.from({ length: 1000 }, (_, i) => ({
  sku: `SKU-${i % 50}`,
  quantity: 1 + (i % 4),
  unitPrice: 4.99 + (i % 25),
}));

@Injectable()
class PricingService {
  private readonly taxRate = 0.23;
  private readonly discounts = new Map<string, number>(
    Array.from({ length: 50 }, (_, i) => [`SKU-${i}`, (i % 5) / 100]),
  );

  quote(lines: CartLine[]) {
    let net = 0;
    let tax = 0;
    for (const line of lines) {
      const discount = this.discounts.get(line.sku) ?? 0;
      const amount = line.quantity * line.unitPrice * (1 - discount);
      net += amount;
      tax += amount * this.taxRate;
    }
    return {
      lines: lines.length,
      net: Math.round(net * 100) / 100,
      tax: Math.round(tax * 100) / 100,
    };
  }
}

@Controller()
class PricingController {
  constructor(private readonly pricing: PricingService) {}

  @Get("quote")
  quote() {
    return this.pricing.quote(CART);
  }
}

/** Serves every scenario in `SCENARIO_PATHS`. */
@Module({})
export class BenchModule {
  /**
   * `observe` holds `ObserveModule.forRoot()` when the agent is installed -
   * first among the imports, as the README tells applications to put it.
   */
  static register(observe: DynamicModule[]): DynamicModule {
    return {
      module: BenchModule,
      imports: [...observe],
      controllers: [
        HelloController,
        OrdersController,
        ReportController,
        PricingController,
      ],
      providers: [
        OrdersRepository,
        CustomersRepository,
        OrdersService,
        ApiKeyGuard,
        EnvelopeInterceptor,
        LineFormatter,
        ReportService,
        PricingService,
      ],
    };
  }
}
