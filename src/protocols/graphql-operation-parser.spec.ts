import {
  clearGraphQLOperationCache,
  graphQLOperationCacheSize,
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

    it("drops comments", () => {
      expect(
        parseGraphQLOperation("# top secret\n{ orders { id } }")
          ?.sanitizedDocument,
      ).toBe("{ orders { id } }");
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
