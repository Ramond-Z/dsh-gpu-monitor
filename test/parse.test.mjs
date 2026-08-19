import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../lib/query.mjs";

test("parses nvidia-smi csv rows", () => {
  const csv = [
    "0, NVIDIA GeForce RTX 3090, 15808, 24576, 64, 45, 215, 350",
    "1, NVIDIA GeForce RTX 3090, 2048, 24576, 3, 38, 30, 350",
  ].join("\n");
  const gpus = parseCsv(csv);
  assert.equal(gpus.length, 2);
  assert.equal(gpus[0].index, "0");
  assert.equal(gpus[0].name, "NVIDIA GeForce RTX 3090");
  assert.equal(gpus[0].memUsedMB, 15808);
  assert.equal(gpus[0].memTotalMB, 24576);
  assert.equal(gpus[0].utilPct, 64);
  assert.equal(gpus[0].tempC, 45);
  assert.equal(gpus[0].powerW, 215);
  assert.equal(gpus[0].powerLimitW, 350);
});

test("handles N/A and missing values", () => {
  const gpus = parseCsv("0, A100, 1000, 40000, N/A, 40, N/A, N/A");
  assert.equal(gpus.length, 1);
  assert.equal(gpus[0].utilPct, 0);
  assert.ok(Number.isNaN(gpus[0].powerW));
});

test("skips blank lines and short rows", () => {
  const gpus = parseCsv("\n\n0, RTX, 1, 2, 3, 4, 5, 6\nbad,row\n");
  assert.equal(gpus.length, 1);
  assert.equal(gpus[0].index, "0");
});
