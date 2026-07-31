import { test } from "node:test";
import assert from "node:assert/strict";

import { simulate } from "./live-sync.sim.mjs";

test("pipeline LL stale (age 5) no genera seeks hacia atras", () => {
  const { frames } = simulate({
    ticks: 20,
    edge: 100,
    age: 5,
    partTarget: 1,
    currentTime: 100.5,
  });
  const backward = frames.filter((f) => f.action === "seek-backward");
  assert.deepEqual(backward, []);
});

test("pipeline LL sano converge a delay bajo y se estabiliza sin ping-pong", () => {
  const { frames } = simulate({
    ticks: 20,
    edge: 100,
    age: 0.6,
    partTarget: 1,
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

test("pipeline LL stale no queda en bucle de seeks ni de ping-pong", () => {
  const { frames } = simulate({
    ticks: 20,
    edge: 100,
    age: 5,
    partTarget: 1,
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
    partTarget: 1,
    currentTime: 93,
    isAuto: false,
  });
  const seeks = frames.filter((f) => f.action !== "idle");
  assert.deepEqual(seeks, []);
});

test("pipeline no-LL real: sincroniza cerca del edge y converge", () => {
  const { frames } = simulate({
    ticks: 20,
    edge: 100,
    age: 0.6,
    targetduration: 6,
    currentTime: 93,
  });
  const backward = frames.filter((f) => f.action === "seek-backward");
  assert.deepEqual(backward, []);
  const converged = frames.filter((f) => f.t >= 10);
  const maxRealDelay = Math.max(...converged.map((f) => f.edge - f.currentTime));
  assert.ok(maxRealDelay <= 3, `no sincronizo cerca del edge: realDelay=${maxRealDelay}`);
  const lateSeeks = converged.filter((f) => f.action !== "idle");
  assert.deepEqual(lateSeeks, [], "deberia estabilizarse sin seeks posteriores");
});

test("pipeline no-LL real stale (age alto): sin seeks atras ni bucle", () => {
  const { frames } = simulate({
    ticks: 20,
    edge: 100,
    age: 5,
    targetduration: 6,
    currentTime: 100.5,
  });
  const backward = frames.filter((f) => f.action === "seek-backward");
  assert.deepEqual(backward, []);
  const maxRealDelay = Math.max(...frames.map((f) => f.edge - f.currentTime));
  assert.ok(maxRealDelay <= 3.5, `se alejo del edge: realDelay=${maxRealDelay}`);
});
