import { setFlagsFromString } from "v8";
import { runInNewContext } from "vm";
import {
  clearGraphQLOperationCache,
  graphQLOperationCacheSize,
  ParsedGraphQLOperation,
  parseGraphQLOperation,
  toResolveInfoLike,
} from "./graphql-operation-parser.js";

/**
 * The operation id every GraphQL trace is labelled with comes out of here, so
 * these cases are really about one thing: a document that used to be labelled
 * `Query.orders` from a resolver's info is still labelled `Query.orders` now
 * that only the query text is available.
 */
describe("parseGraphQLOperation", () => {
  beforeEach(() => clearGraphQLOperationCache());

  it("reads a shorthand query", () => {
    expect(parseGraphQLOperation("{ orders { id name } }")).toEqual({
      rootTypeName: "Query",
      fieldName: "orders",
      operationName: undefined,
      sanitizedDocument: "{ orders { id name } }",
    });
  });

  it("reads an explicit query keyword", () => {
    expect(parseGraphQLOperation("query { orders { id } }")).toMatchObject({
      rootTypeName: "Query",
      fieldName: "orders",
    });
  });

  it("reads a named operation", () => {
    expect(parseGraphQLOperation("query GetOrders { orders { id } }")).toEqual({
      rootTypeName: "Query",
      fieldName: "orders",
      operationName: "GetOrders",
      sanitizedDocument: "query GetOrders { orders { id } }",
    });
  });

  it("reads a mutation", () => {
    expect(
      parseGraphQLOperation('mutation { createOrder(name: "new") { id } }'),
    ).toMatchObject({
      rootTypeName: "Mutation",
      fieldName: "createOrder",
    });
  });

  it("reads a subscription", () => {
    expect(
      parseGraphQLOperation("subscription { orderAdded { id } }"),
    ).toMatchObject({
      rootTypeName: "Subscription",
      fieldName: "orderAdded",
    });
  });

  it("skips variable definitions, including brace-shaped defaults", () => {
    expect(
      parseGraphQLOperation(
        "query Search($filter: Filter = { paid: true }, $limit: Int = 10) { orders { id } }",
      ),
    ).toEqual({
      rootTypeName: "Query",
      fieldName: "orders",
      operationName: "Search",
      sanitizedDocument:
        "query Search($filter: Filter = { paid: true }, $limit: Int = _) { orders { id } }",
    });
  });

  it("resolves an alias to the field behind it", () => {
    // A resolver's info reports `orders`, never the alias, and an operation id
    // that changed with the alias would scatter one endpoint across many rows.
    expect(parseGraphQLOperation("{ latest: orders { id } }")).toMatchObject({
      fieldName: "orders",
    });
  });

  it("takes the first root field of a multi-field document", () => {
    expect(
      parseGraphQLOperation("{ orders { id } customers { id } }"),
    ).toMatchObject({ fieldName: "orders" });
  });

  it("skips fragment definitions preceding the operation", () => {
    expect(
      parseGraphQLOperation(`
        fragment OrderFields on Order { id name }
        query { orders { ...OrderFields } }
      `),
    ).toMatchObject({ rootTypeName: "Query", fieldName: "orders" });
  });

  it("ignores comments", () => {
    expect(
      parseGraphQLOperation(`
        # query Decoy { decoy { id } }
        { orders { id } }
      `),
    ).toMatchObject({ fieldName: "orders" });
  });

  it("ignores braces and keywords inside string arguments", () => {
    expect(
      parseGraphQLOperation('{ search(term: "mutation { evil }") { id } }'),
    ).toMatchObject({ rootTypeName: "Query", fieldName: "search" });
  });

  it("ignores block strings", () => {
    expect(
      parseGraphQLOperation('{ search(term: """{ evil }""") { id } }'),
    ).toMatchObject({ fieldName: "search" });
  });

  it("does not mistake a directive for the operation name", () => {
    expect(
      parseGraphQLOperation("query @live { orders { id } }"),
    ).toMatchObject({ fieldName: "orders", operationName: undefined });
  });

  it("gives up on a document whose first selection is a fragment spread", () => {
    // The field is defined elsewhere, and chasing it is not worth an AST.
    expect(
      parseGraphQLOperation(
        "fragment Roots on Query { orders { id } } query { ...Roots }",
      ),
    ).toBeUndefined();
  });

  it("leaves a document opening with an inherited key unlabelled", () => {
    // Looked up in an object literal, `constructor` found Object's own, and
    // labelling the operation threw inside the request hook: a 500.
    for (const document of [
      "constructor { health }",
      "Constructor { health }",
      "__proto__ { health }",
      "toString { health }",
    ]) {
      expect(parseGraphQLOperation(document)).toBeUndefined();
    }
  });

  it("gives up on an unparseable document rather than guessing", () => {
    expect(parseGraphQLOperation("this is not graphql")).toBeUndefined();
    expect(parseGraphQLOperation("{")).toBeUndefined();
    expect(parseGraphQLOperation("")).toBeUndefined();
    expect(parseGraphQLOperation(undefined)).toBeUndefined();
  });

  it("caches by document text", () => {
    const document = "{ orders { id } }";
    expect(parseGraphQLOperation(document)).toBe(
      parseGraphQLOperation(document),
    );
  });

  describe("sanitizedDocument", () => {
    it("collapses formatting, so equivalent documents share one signature", () => {
      const pretty = parseGraphQLOperation(
        "query GetOrders {\n  orders {\n    id\n    name\n  }\n}",
      );
      const dense = parseGraphQLOperation(
        "query GetOrders { orders { id name } }",
      );
      expect(pretty?.sanitizedDocument).toBe(dense?.sanitizedDocument);
    });

    it("keeps different selections apart", () => {
      expect(
        parseGraphQLOperation("{ orders { id } }")?.sanitizedDocument,
      ).not.toBe(
        parseGraphQLOperation("{ orders { id name } }")?.sanitizedDocument,
      );
    });

    it("blanks string literals rather than recording them", () => {
      expect(
        parseGraphQLOperation(
          'mutation { login(email: "user@example.com") { token } }',
        )?.sanitizedDocument,
      ).toBe("mutation { login(email: _) { token } }");
    });

    it("blanks number literals, and leaves digits that belong to a name", () => {
      expect(
        parseGraphQLOperation(
          "mutation { verifyOtp(code: 489213, ratio: -1.5e+3) { field2 } }",
        )?.sanitizedDocument,
      ).toBe("mutation { verifyOtp(code: _, ratio: _) { field2 } }");
      expect(
        parseGraphQLOperation(
          "query($v1: Int = 5) { orders(first: $v1) { id } }",
        )?.sanitizedDocument,
      ).toBe("query($v1: Int = _) { orders(first: $v1) { id } }");
    });

    it("blanks a number written straight after another literal", () => {
      // Commas are optional, and the `_` a string leaves is a name character
      // itself: the number after it is not a name's tail.
      expect(
        parseGraphQLOperation('{ notes(ids: ["draft"489213"""x"""7]) { id } }')
          ?.sanitizedDocument,
      ).toBe("{ notes(ids: [____]) { id } }");
      expect(
        parseGraphQLOperation('{ notes(ids: ["draft"1.5e3]) { field2 } }')
          ?.sanitizedDocument,
      ).toBe("{ notes(ids: [__]) { field2 } }");
    });

    it.each([
      ["a run of literals", "1 ".repeat(100_000)],
      ["a sign before each literal", "-1".repeat(100_000)],
      ["digits that continue a name", `a${"1".repeat(200_000)}`],
    ])("scans a document of digits in linear time: %s", (_, digits) => {
      // The euro sign is not GraphQL, but it is copied through like any other
      // character and makes the output a two-byte string.
      const document = `{ health(ids: [€ ${digits}]) }`;
      const startedAt = performance.now();

      const parsed = parseGraphQLOperation(document);

      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(parsed?.fieldName).toBe("health");
    });

    it('reads an escaped \\""" as part of its block string', () => {
      // graphql-js reads `\"""` inside a block string as three quotes of
      // content; ended there, the rest of the literal was recorded as syntax.
      expect(
        parseGraphQLOperation(
          'mutation { saveNote(text: """a \\""" password=hunter2 \\""" b""", tag: """x""") { id } }',
        )?.sanitizedDocument,
      ).toBe("mutation { saveNote(text: _, tag: _) { id } }");
      expect(
        parseGraphQLOperation(
          'query Q($a: String = """\\""" fieldName: """) { real }',
        ),
      ).toMatchObject({
        fieldName: "real",
        sanitizedDocument: "query Q($a: String = _) { real }",
      });
    });

    it("drops comments", () => {
      expect(
        parseGraphQLOperation("# top secret\n{ orders { id } }")
          ?.sanitizedDocument,
      ).toBe("{ orders { id } }");
    });

    it("ends a comment at a carriage return, as the server does", () => {
      // Read on to the next `\n`, the comment swallowed the opening quotes
      // of the block string after it, whose text was then recorded.
      expect(
        parseGraphQLOperation(
          'mutation { # note\rsaveNote(text: """\npassword=hunter2\n""") { id } }',
        ),
      ).toMatchObject({
        fieldName: "saveNote",
        sanitizedDocument: "mutation { saveNote(text: _) { id } }",
      });
      expect(parseGraphQLOperation("# note\r{ orders { id } }")).toMatchObject({
        fieldName: "orders",
        sanitizedDocument: "{ orders { id } }",
      });
    });

    it("caps what it records of an oversized document", () => {
      // The document is a request body, chosen by the client; the shape it
      // leaves in the trace must not be able to overflow the batch.
      const fields = Array.from({ length: 4000 }, (_, i) => `f${i}`).join(" ");
      const document = `{ orders { ${fields} } }`;

      const recorded = parseGraphQLOperation(document)!.sanitizedDocument;

      expect(recorded.length).toBe(8 * 1024);
      expect(recorded.endsWith("... [truncated by observe]")).toBe(true);
      expect(recorded.startsWith("{ orders { f0 f1")).toBe(true);
    });
  });

  describe("what a parsed document keeps alive", () => {
    /** Live heap after a full collection, in bytes. */
    const liveHeap = () => {
      setFlagsFromString("--expose-gc");
      const gc = runInNewContext("gc") as () => void;
      gc();
      gc();
      return process.memoryUsage().heapUsed;
    };

    /** Parses distinct documents, none of them kept but by what is returned. */
    const parseLargeDocuments = (count: number, size: number) => {
      const results: Array<ParsedGraphQLOperation | undefined> = [];
      for (let i = 0; i < count; i++) {
        const fields = `f${i} `.repeat(size / (`${i}`.length + 2));
        results.push(
          parseGraphQLOperation(
            `query Operation${i}WithALongName { ordersWithALongName${i} { ${fields} } }`,
          ),
        );
      }
      return results;
    };

    it("keeps no more of a document past the cache's size than it records", () => {
      // A buffered trace holds what is returned until its batch is flushed.
      // A slice of a string is a view that keeps all of it in memory: an
      // 8 kB slice of a 100 kB document kept the 100 kB.
      const before = liveHeap();

      const results = parseLargeDocuments(40, 100_000);
      const held = liveHeap() - before;

      expect(results.every((result) => result?.sanitizedDocument)).toBe(true);
      expect(results[39]?.fieldName).toBe("ordersWithALongName39");
      expect(results[39]?.operationName).toBe("Operation39WithALongName");
      // 40 recorded documents of 8 kB each, and change; not 40 of 100 kB.
      expect(held).toBeLessThan(1_500_000);
    });
  });

  describe("cache", () => {
    it("remembers an ordinary document", () => {
      parseGraphQLOperation("{ orders { id } }");

      expect(graphQLOperationCacheSize()).toBe(1);
    });

    it("does not remember a document past the size cap", () => {
      // Entries are counted but not sized; a client could otherwise fill the
      // cache with 512 multi-megabyte keys.
      const fields = Array.from({ length: 8000 }, (_, i) => `f${i}`).join(" ");
      const parsed = parseGraphQLOperation(`{ orders { ${fields} } }`);

      expect(parsed?.fieldName).toBe("orders");
      expect(graphQLOperationCacheSize()).toBe(0);
    });
  });
});

describe("toResolveInfoLike", () => {
  it("carries the values a root field's real info carried", () => {
    expect(
      toResolveInfoLike({
        rootTypeName: "Mutation",
        fieldName: "createOrder",
        operationName: "Create",
      }),
    ).toEqual({
      fieldName: "createOrder",
      parentType: { name: "Mutation" },
      operation: { operation: "mutation", name: { value: "Create" } },
    });
  });

  it("leaves the operation unnamed when the document did", () => {
    expect(
      toResolveInfoLike({ rootTypeName: "Query", fieldName: "orders" })
        .operation,
    ).toEqual({ operation: "query", name: undefined });
  });
});
