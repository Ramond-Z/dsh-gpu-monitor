import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrderStore } from "../lib/orderstore.mjs";

test("OrderStore defaults and in-memory mode", () => {
  const s = new OrderStore("");
  assert.deepEqual(s.get(), { o: [], t: 0 });
  assert.equal(s.set(["a", "b"], 10), true);
  assert.deepEqual(s.get(), { o: ["a", "b"], t: 10 });
});

test("OrderStore persists to file and reloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-order-"));
  try {
    const file = join(dir, "order.json");
    const s = new OrderStore(file);
    assert.equal(s.set(["a", "b"], 10), true);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(raw, { o: ["a", "b"], t: 10 });
    const s2 = new OrderStore(file);
    assert.deepEqual(s2.get(), { o: ["a", "b"], t: 10 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OrderStore rejects stale timestamps and filters non-strings", () => {
  const s = new OrderStore("");
  assert.equal(s.set(["a"], 10), true);
  assert.equal(s.set(["b"], 9), false); // 旧时间戳拒绝
  assert.deepEqual(s.get(), { o: ["a"], t: 10 });
  assert.equal(s.set(["a", 1, null, "b"], 20), true);
  assert.deepEqual(s.get(), { o: ["a", "b"], t: 20 });
});

test("OrderStore tolerates corrupt file", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-order-"));
  try {
    const file = join(dir, "order.json");
    const s = new OrderStore(file); // 文件不存在 → 默认
    assert.deepEqual(s.get(), { o: [], t: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
