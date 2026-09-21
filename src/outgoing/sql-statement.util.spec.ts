import { describeSqlStatement } from "./sql-statement.util.js";

describe("describeSqlStatement", () => {
  it.each([
    [
      `SELECT "u"."id" FROM "users" "u" WHERE "u"."email" = 'a@b.co' AND age > 21`,
      "SELECT users",
      `SELECT "u"."id" FROM "users" "u" WHERE "u"."email" = ? AND age > ?`,
    ],
    [
      "select * from orders where id in (1, 2, 3, 4)",
      "SELECT orders",
      "select * from orders where id in (?)",
    ],
    [
      "SELECT * FROM public.orders WHERE id = ANY($1) AND tenant IN ($2, $3, $4)",
      "SELECT public.orders",
      "SELECT * FROM public.orders WHERE id = ANY($1) AND tenant IN ($n)",
    ],
    [
      "INSERT INTO `audit_log` (actor, note) VALUES ('kamil', 'it''s done')",
      "INSERT audit_log",
      "INSERT INTO `audit_log` (actor, note) VALUES (?)",
    ],
    [
      "UPDATE accounts SET balance = balance - 10.50 WHERE id = 7",
      "UPDATE accounts",
      "UPDATE accounts SET balance = balance - ? WHERE id = ?",
    ],
    [
      "DELETE FROM sessions WHERE token = 'abc'",
      "DELETE sessions",
      "DELETE FROM sessions WHERE token = ?",
    ],
    ["BEGIN", "BEGIN", "BEGIN"],
    ["  ", "QUERY", ""],
  ])("%s", (sql, operation, statement) => {
    expect(describeSqlStatement(sql)).toEqual({ operation, statement });
  });

  it("drops comments, which is where taggers put request and user ids", () => {
    const { statement } = describeSqlStatement(
      "/* user:42 trace:abc */ SELECT 1 -- by kamil\nFROM dual",
    );
    expect(statement).toBe("SELECT ? FROM dual");
  });

  it("keeps digits that belong to identifiers", () => {
    expect(
      describeSqlStatement("SELECT col1 FROM table2 t0 WHERE t0.x = 5")
        .statement,
    ).toBe("SELECT col1 FROM table2 t0 WHERE t0.x = ?");
  });

  it("replaces a dollar-quoted body", () => {
    expect(
      describeSqlStatement("SELECT $tag$secret 'text'$tag$, $$other$$")
        .statement,
    ).toBe("SELECT ?, ?");
  });

  it("bounds what it ships", () => {
    const { statement } = describeSqlStatement(
      `SELECT ${"a, ".repeat(5000)} b FROM t`,
    );
    expect(statement.length).toBeLessThanOrEqual(2048);
  });
});
