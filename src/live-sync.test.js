import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeResync,
  computeInitialCorrection,
  runResyncTick,
  RESYNC_COOLDOWN_MS,
  RESYNC_THRESHOLD_OFFSET_S,
  INITIAL_CORRECT_MARGIN_S,
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
