import { test } from "node:test";
import assert from "node:assert/strict";

import { simulate } from "./live-sync.sim.mjs";

test("pipeline stale (age 5) no genera seeks hacia atras", () => {
  const { frames } = simulate({
    ticks: 20,
    edge: 100,
    age: 5,
    currentTime: 100.5,
  });
  const backward = frames.filter((f) => f.action === "seek-backward");
  assert.deepEqual(backward, []);
});

test("pipeline sano converge a delay bajo y se estabiliza sin ping-pong", () => {
  const { frames } = simulate({
    ticks: 20,
    edge: 100,
    age: 0.6,
    currentTime: 93,
  });
  const backward = frames.filter((f) => f.action === "seek-backward");
  assert.deepEqual(backward, []);
  const converged = frames.filter((f) => f.t >= 10);
  const maxLatency = Math.max(...converged.map((f) => f.latency));
  assert.ok(maxLatency <= 4, `delay no convergio: maxLatency=${maxLatency}`);
  const lateSeeks = converged.filter((f) => f.action !== "idle");
  assert.deepEqual(lateSeeks, [], "deberia estabilizarse sin seeks posteriores");
});

test("pipeline stale no queda en bucle de seeks ni de ping-pong", () => {
  const { frames } = simulate({
    ticks: 20,
    edge: 100,
    age: 5,
    currentTime: 100.5,
  });
  const seeks = frames.filter((f) => f.action !== "idle");
  assert.deepEqual(seeks, []);
});

test("velocidad manual no genera ningun seek", () => {
  const { frames } = simulate({
    ticks: 20,
    edge: 100,
    age: 0.6,
    currentTime: 93,
    isAuto: false,
  });
  const seeks = frames.filter((f) => f.action !== "idle");
  assert.deepEqual(seeks, []);
});
