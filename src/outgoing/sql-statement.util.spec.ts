import { describeSqlStatement, SqlDialect } from "./sql-statement.util.js";

const DIALECTS: SqlDialect[] = ["postgresql", "mysql"];

describe.each(DIALECTS)("describeSqlStatement (%s)", (dialect) => {
  it.each([
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
    [
      "SELECT * FROM ONLY users WHERE id = 1",
      "SELECT users",
      "SELECT * FROM ONLY users WHERE id = ?",
    ],
    [
      "DELETE FROM ONLY sessions WHERE id = 1",
      "DELETE sessions",
      "DELETE FROM ONLY sessions WHERE id = ?",
    ],
    ["BEGIN", "BEGIN", "BEGIN"],
    ["  ", "QUERY", ""],
  ])("%s", (sql, operation, statement) => {
    expect(describeSqlStatement(sql, dialect)).toEqual({
      operation,
      statement,
    });
  });

  it("drops comments, which is where taggers put request and user ids", () => {
    const { statement } = describeSqlStatement(
      "/* user:42 trace:abc */ SELECT 1 -- by kamil\nFROM dual",
      dialect,
    );
    expect(statement).toBe("SELECT ? FROM dual");
  });

  it("keeps digits that belong to identifiers", () => {
    expect(
      describeSqlStatement("SELECT col1 FROM table2 t0 WHERE t0.x = 5", dialect)
        .statement,
    ).toBe("SELECT col1 FROM table2 t0 WHERE t0.x = ?");
  });

  it("replaces hex and binary numbers", () => {
    expect(
      describeSqlStatement(
        "SELECT * FROM t WHERE hash = 0x5f4dcc3b5aa765d61d8327deb882cf99 AND flags = 0B1011 AND x = X'ff'",
        dialect,
      ).statement,
    ).toBe("SELECT * FROM t WHERE hash = ? AND flags = ? AND x = X?");
  });

  it("bounds what it ships", () => {
    const { statement } = describeSqlStatement(
      `SELECT ${"a, ".repeat(5000)} b FROM t`,
      dialect,
    );
    expect(statement.length).toBeLessThanOrEqual(2048);
  });

  // Only the first 8 KB is read, and a long comment or literal shrinks to
  // almost nothing: what the bound cut in two lands inside what is shipped.
  const comment = (length: number) => `/*${"x".repeat(length)}*/`;
  it.each([
    [`SELECT ${comment(8170)} 'secret-value' FROM t`, "SELECT ?"],
    [`SELECT ${comment(8172)} 'secret\\'s' FROM t`, "SELECT ?"],
    [`SELECT ${comment(8170)} $tag$secret body$tag$`, "SELECT ?"],
    [`SELECT ${comment(8170)} /* user:secret-value */`, "SELECT"],
    [`SELECT ${comment(8173)} 987654e2`, "SELECT ?"],
    [`SELECT ${comment(8172)} 987654e+2`, "SELECT ?"],
    [`SELECT ${comment(8172)} 987654e-2`, "SELECT ?"],
    [`SELECT ${comment(8170)} 98765.43e+2`, "SELECT ?.?"],
    [
      `INSERT INTO t (a, b) VALUES ('${"z".repeat(8150)}', 'secret-value')`,
      "INSERT INTO t (a, b) VALUES (?, ?",
    ],
  ])("ships no part of a value the input bound cuts: %#", (sql, statement) => {
    expect(describeSqlStatement(sql, dialect).statement).toBe(statement);
  });

  it.each([
    [
      "SELECT * FROM users WHERE pw = 'hunter2--x'\nAND id = 1",
      "SELECT * FROM users WHERE pw = ? AND id = ?",
    ],
    [
      "SELECT `it's` FROM t WHERE name = 'secret-value'",
      "SELECT `it's` FROM t WHERE name = ?",
    ],
    [
      "SELECT * FROM t WHERE name = 'secret-value",
      "SELECT * FROM t WHERE name = ?",
    ],
  ])(
    "reads a quote or comment marker inside another token as part of it: %s",
    (sql, statement) => {
      expect(describeSqlStatement(sql, dialect).statement).toBe(statement);
    },
  );

  it("redacts a token cut by the input bound in linear time", () => {
    const sql = `SELECT ${"a".repeat(8180)} , secret_column FROM t`;
    const timings: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const startedAt = performance.now();
      describeSqlStatement(sql, dialect);
      timings.push(performance.now() - startedAt);
    }
    expect(Math.min(...timings)).toBeLessThan(50);
    expect(describeSqlStatement(sql, dialect).statement).toBe(
      `SELECT ${"a".repeat(2041)}`,
    );
  });
});

describe("describeSqlStatement for Postgres", () => {
  it.each([
    [
      `SELECT "u"."id" FROM "users" "u" WHERE "u"."email" = 'a@b.co' AND age > 21`,
      `SELECT "u"."id" FROM "users" "u" WHERE "u"."email" = ? AND age > ?`,
    ],
    ["SELECT $tag$secret 'text'$tag$, $$other$$", "SELECT ?, ?"],
    [
      "SELECT * FROM t WHERE a = 'secret-a$$b' AND b = $$secret-c$$",
      "SELECT * FROM t WHERE a = ? AND b = ?",
    ],
    [
      `SELECT "it's" FROM t WHERE name = 'secret-value'`,
      `SELECT "it's" FROM t WHERE name = ?`,
    ],
    [
      `SELECT "a--b" FROM t WHERE name = 'secret-value'`,
      `SELECT "a--b" FROM t WHERE name = ?`,
    ],
    // A plain string takes a backslash as it is. Whether `\'` ends one turns
    // on a session setting, so what follows such a string is not shipped.
    [
      "SELECT * FROM t WHERE path = 'C:\\' AND token = 'secret-value'",
      "SELECT * FROM t WHERE path = ?",
    ],
    [
      "SELECT * FROM t WHERE a = 'it\\'s' AND b = 'secret-value'",
      "SELECT * FROM t WHERE a = ?",
    ],
    [
      "SELECT 'C:\\path\\file' AS p, 'a\\\\' AS q FROM t",
      "SELECT ? AS p, ? AS q FROM t",
    ],
    [
      "SELECT E'it\\'s', e'\\\\', 'x' FROM t WHERE b = 'secret-value'",
      "SELECT E?, e?, ? FROM t WHERE b = ?",
    ],
    ["SELECT /* outer /* inner */ secret-value */ 1", "SELECT ?"],
    ["SELECT /* outer /* inner */ 1", "SELECT"],
    ["SELECT 5 # 3, 1_000_000, 0o17", "SELECT ? # ?, ?, ?"],
    ["SELECT a$b$c, $1 FROM t", "SELECT a$b$c, $1 FROM t"],
  ])("%s", (sql, statement) => {
    expect(describeSqlStatement(sql, "postgresql").statement).toBe(statement);
  });
});

describe("describeSqlStatement for MySQL", () => {
  it.each([
    [
      `SELECT * FROM users WHERE email = "secret@example.com"`,
      "SELECT * FROM users WHERE email = ?",
    ],
    [`SELECT "it\\"s", "a""b", "c'd" FROM t`, "SELECT ?, ?, ? FROM t"],
    [
      "SELECT * FROM t WHERE a = 'it\\'s' AND b = 'secret-value'",
      "SELECT * FROM t WHERE a = ? AND b = ?",
    ],
    [
      "SELECT * FROM t WHERE id = 1 # user=secret@example.com",
      "SELECT * FROM t WHERE id = ?",
    ],
    [
      "SELECT * FROM t WHERE id = 1 # it's\nAND b = 'secret-value'",
      "SELECT * FROM t WHERE id = ? AND b = ?",
    ],
    ["SELECT /* outer /* inner */ 1", "SELECT ?"],
    ["SELECT a$$b$$, $$c FROM t", "SELECT a$$b$$, $$c FROM t"],
  ])("%s", (sql, statement) => {
    expect(describeSqlStatement(sql, "mysql").statement).toBe(statement);
  });
});
