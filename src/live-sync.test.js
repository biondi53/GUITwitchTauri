import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeResync,
  computeInitialCorrection,
  computeTrueLatency,
  runResyncTick,
  updateResyncGate,
  USER_SEEK_BACK_THRESHOLD_S,
  RESYNC_COOLDOWN_MS,
  RESYNC_THRESHOLD_OFFSET_S,
  INITIAL_CORRECT_MARGIN_S,
  LIVE_EDGE_S,
} from "./live-sync.js";

const NOW = 100_000;
const liveSyncPosition = 500;

const covers = () => true;
const notCovers = () => false;

test("computeResync devuelve target con delay alto (bug delay clavado ~7s)", () => {
  const result = computeResync({
    latency: 6,
    targetLatency: 2,
    liveSyncPosition,
    lastResyncAt: 0,
    now: NOW,
    isAuto: true,
    bufferCovers: covers,
  });
  assert.deepEqual(result, { target: liveSyncPosition });
});

test("computeResync no actua con delay dentro del umbral", () => {
  const result = computeResync({
    latency: 3,
    targetLatency: 2,
    liveSyncPosition,
    lastResyncAt: 0,
    now: NOW,
    isAuto: true,
    bufferCovers: covers,
  });
  assert.equal(result, null);
});

test("computeResync usa umbral relativo al target", () => {
  const result = computeResync({
    latency: 3,
    targetLatency: 1,
    liveSyncPosition,
    lastResyncAt: 0,
    now: NOW,
    isAuto: true,
    bufferCovers: covers,
  });
  assert.equal(result, null);
});

test("computeResync respeta el cooldown (evita ping-pong)", () => {
  const result = computeResync({
    latency: 6,
    targetLatency: 2,
    liveSyncPosition,
    lastResyncAt: NOW - 1000,
    now: NOW,
    isAuto: true,
    bufferCovers: covers,
  });
  assert.equal(result, null);
});

test("computeResync actua cuando el cooldown ya expiro", () => {
  const result = computeResync({
    latency: 6,
    targetLatency: 2,
    liveSyncPosition,
    lastResyncAt: NOW - (RESYNC_COOLDOWN_MS + 1),
    now: NOW,
    isAuto: true,
    bufferCovers: covers,
  });
  assert.deepEqual(result, { target: liveSyncPosition });
});

test("computeResync no actua en velocidad manual", () => {
  const result = computeResync({
    latency: 6,
    targetLatency: 2,
    liveSyncPosition,
    lastResyncAt: 0,
    now: NOW,
    isAuto: false,
    bufferCovers: covers,
  });
  assert.equal(result, null);
});

test("computeResync no actua sin liveSyncPosition disponible", () => {
  const result = computeResync({
    latency: 6,
    targetLatency: 2,
    liveSyncPosition: null,
    lastResyncAt: 0,
    now: NOW,
    isAuto: true,
    bufferCovers: covers,
  });
  assert.equal(result, null);
});

test("computeResync no actua si el buffer no cubre el target (evita stall)", () => {
  const result = computeResync({
    latency: 6,
    targetLatency: 2,
    liveSyncPosition,
    lastResyncAt: 0,
    now: NOW,
    isAuto: true,
    bufferCovers: notCovers,
  });
  assert.equal(result, null);
});

test("computeResync no actua sin latency disponible", () => {
  const result = computeResync({
    latency: null,
    targetLatency: 2,
    liveSyncPosition,
    lastResyncAt: 0,
    now: NOW,
    isAuto: true,
    bufferCovers: covers,
  });
  assert.equal(result, null);
});

test("computeResync no busca hacia atras cuando liveSyncPosition quedo detras del playhead", () => {
  const result = computeResync({
    latency: 5.5,
    targetLatency: 2,
    liveSyncPosition: 100,
    currentTime: 100.5,
    lastResyncAt: 0,
    now: NOW,
    isAuto: true,
    bufferCovers: covers,
  });
  assert.equal(result, null);
});

test("computeResync permite seek hacia adelante con margen suficiente", () => {
  const result = computeResync({
    latency: 6,
    targetLatency: 2,
    liveSyncPosition: 500,
    currentTime: 495,
    lastResyncAt: 0,
    now: NOW,
    isAuto: true,
    bufferCovers: covers,
  });
  assert.deepEqual(result, { target: 500 });
});

test("computeResync no busca cuando el target adelanta menos que el margen minimo", () => {
  const result = computeResync({
    latency: 6,
    targetLatency: 2,
    liveSyncPosition: 500,
    currentTime: 499.5,
    lastResyncAt: 0,
    now: NOW,
    isAuto: true,
    bufferCovers: covers,
  });
  assert.equal(result, null);
});

test("computeResync apunta a edge - LIVE_EDGE_S en lugar del clamp conservador", () => {
  const result = computeResync({
    latency: 7,
    targetLatency: 2,
    liveSyncPosition: 494,
    currentTime: 490,
    edge: 500,
    lastResyncAt: 0,
    now: NOW,
    isAuto: true,
    bufferCovers: covers,
  });
  assert.deepEqual(result, { target: 500 - LIVE_EDGE_S });
});

test("computeResync cae a liveSyncPosition si edge - LIVE_EDGE_S no esta buffered", () => {
  const coversOnly494 = (pos) => pos === 494;
  const result = computeResync({
    latency: 7,
    targetLatency: 2,
    liveSyncPosition: 494,
    currentTime: 490,
    edge: 500,
    lastResyncAt: 0,
    now: NOW,
    isAuto: true,
    bufferCovers: coversOnly494,
  });
  assert.deepEqual(result, { target: 494 });
});

test("computeResync no busca si edge - LIVE_EDGE_S no adelanta con margen", () => {
  const result = computeResync({
    latency: 7,
    targetLatency: 2,
    liveSyncPosition: 494,
    currentTime: 497.5,
    edge: 500,
    lastResyncAt: 0,
    now: NOW,
    isAuto: true,
    bufferCovers: covers,
  });
  assert.equal(result, null);
});

test("computeInitialCorrection corrige el landing cuando el target fresco adelanta", () => {
  const result = computeInitialCorrection({
    currentTime: liveSyncPosition - 3,
    liveSyncPosition,
    initialCorrectionDone: false,
    bufferCovers: covers,
  });
  assert.deepEqual(result, { target: liveSyncPosition });
});

test("computeInitialCorrection no actua si ya se corrigio", () => {
  const result = computeInitialCorrection({
    currentTime: liveSyncPosition - 3,
    liveSyncPosition,
    initialCorrectionDone: true,
    bufferCovers: covers,
  });
  assert.equal(result, null);
});

test("computeInitialCorrection no actua sin liveSyncPosition", () => {
  const result = computeInitialCorrection({
    currentTime: 0,
    liveSyncPosition: null,
    initialCorrectionDone: false,
    bufferCovers: covers,
  });
  assert.equal(result, null);
});

test("computeInitialCorrection no actua si el adelanto es menor al margen", () => {
  const result = computeInitialCorrection({
    currentTime: liveSyncPosition - INITIAL_CORRECT_MARGIN_S + 0.5,
    liveSyncPosition,
    initialCorrectionDone: false,
    bufferCovers: covers,
  });
  assert.equal(result, null);
});

test("computeInitialCorrection no actua si el buffer no cubre el target", () => {
  const result = computeInitialCorrection({
    currentTime: liveSyncPosition - 3,
    liveSyncPosition,
    initialCorrectionDone: false,
    bufferCovers: notCovers,
  });
  assert.equal(result, null);
});

test("computeInitialCorrection apunta a edge - LIVE_EDGE_S", () => {
  const result = computeInitialCorrection({
    currentTime: 494 - 3,
    liveSyncPosition: 494,
    edge: 500,
    initialCorrectionDone: false,
    bufferCovers: covers,
  });
  assert.deepEqual(result, { target: 500 - LIVE_EDGE_S });
});

test("runResyncTick devuelve target y lastResyncAt actualizado cuando hay resync", () => {
  const result = runResyncTick({
    latency: 6,
    targetLatency: 2,
    liveSyncPosition,
    currentTime: liveSyncPosition - 5,
    lastResyncAt: 0,
    now: NOW,
    isAuto: true,
    bufferCovers: covers,
  });
  assert.deepEqual(result, { target: liveSyncPosition, lastResyncAt: NOW });
});

test("runResyncTick devuelve target null y conserva lastResyncAt sin resync", () => {
  const result = runResyncTick({
    latency: 3,
    targetLatency: 2,
    liveSyncPosition,
    currentTime: liveSyncPosition - 5,
    lastResyncAt: 0,
    now: NOW,
    isAuto: true,
    bufferCovers: covers,
  });
  assert.deepEqual(result, { target: null, lastResyncAt: 0 });
});

test("computeTrueLatency con ingesta 0 devuelve el realDelay (captura al dia)", () => {
  const nowMs = 100_000;
  const lastDur = 2;
  const result = computeTrueLatency({
    realDelay: 2.3,
    pdtMs: nowMs - lastDur * 1000,
    lastDur,
    now: nowMs,
  });
  assert.equal(result, 2.3);
});

test("computeTrueLatency suma la ingesta del canal (buffer de servidor)", () => {
  const nowMs = 100_000;
  const lastDur = 2;
  const result = computeTrueLatency({
    realDelay: 2.3,
    pdtMs: nowMs - (lastDur + 5) * 1000,
    lastDur,
    now: nowMs,
  });
  assert.equal(result, 2.3 + 5);
});

test("computeTrueLatency devuelve null si no hay pdtMs (fallback)", () => {
  const result = computeTrueLatency({
    realDelay: 2.3,
    pdtMs: null,
    lastDur: 2,
    now: 100_000,
  });
  assert.equal(result, null);
});

test("computeTrueLatency no aplica ingesta negativa si el segmento aun no termino", () => {
  const nowMs = 100_000;
  const lastDur = 2;
  const result = computeTrueLatency({
    realDelay: 2.3,
    pdtMs: nowMs + 3 * 1000,
    lastDur,
    now: nowMs,
  });
  assert.equal(result, 2.3);
});

test("computeResync no busca si el usuario rebobino (manualSeekPending)", () => {
  const result = computeResync({
    latency: 20,
    targetLatency: 2,
    liveSyncPosition,
    currentTime: 480,
    edge: 500,
    lastResyncAt: 0,
    now: NOW,
    isAuto: true,
    bufferCovers: covers,
    manualSeekPending: true,
  });
  assert.equal(result, null);
});

test("updateResyncGate detecta un rewind del usuario (seek hacia atras)", () => {
  const result = updateResyncGate({
    manualSeekPending: false,
    currentTime: 480,
    lastPosition: 500,
    latency: 20,
    targetLatency: 2,
  });
  assert.equal(result, true);
});

test("updateResyncGate ignora micro-drifs menores al umbral", () => {
  const result = updateResyncGate({
    manualSeekPending: false,
    currentTime: 499.6,
    lastPosition: 500,
    latency: 2.4,
    targetLatency: 2,
  });
  assert.equal(result, false);
});

test("updateResyncGate suelta el flag cuando el usuario alcanza el directo", () => {
  const result = updateResyncGate({
    manualSeekPending: true,
    currentTime: 497,
    lastPosition: 500,
    latency: 3,
    targetLatency: 2,
  });
  assert.equal(result, false);
});

test("updateResyncGate mantiene el flag mientras sigue atras", () => {
  const result = updateResyncGate({
    manualSeekPending: true,
    currentTime: 480,
    lastPosition: 500,
    latency: 20,
    targetLatency: 2,
  });
  assert.equal(result, true);
});

test("updateResyncGate no detecta rewind sin lastPosition (inicio)", () => {
  const result = updateResyncGate({
    manualSeekPending: false,
    currentTime: 480,
    lastPosition: null,
    latency: 20,
    targetLatency: 2,
  });
  assert.equal(result, false);
});

test("umbral USER_SEEK_BACK_THRESHOLD_S es 0.5s", () => {
  assert.equal(USER_SEEK_BACK_THRESHOLD_S, 0.5);
});
