/**
 * Decoder tests using real frames captured from our WHOOP 4.0.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFrame } from "../src/framing.js";
import {
  decodeCommandResponse,
  decodeEvent,
  decodeRealtimeData,
} from "../src/decoders.js";

const fromHex = (h: string) => Buffer.from(h, "hex");

describe("decodeRealtimeData", () => {
  it("decodes HR with a single R-R interval (already in ms)", () => {
    const sample = decodeRealtimeData(
      fromHex("aa1800ff2802e3cae101682745014e030000000000000105b3bee130"),
    );
    assert.deepEqual(sample, {
      heartRate: 69,
      rrCount: 1,
      rrIntervalsMs: [846],
      deviceTimestamp: 31574755,
    });
  });

  it("decodes HR with no R-R intervals", () => {
    const sample = decodeRealtimeData(
      fromHex("aa1800ff2802e0cae10138364400000000000000000001056a4f2877"),
    );
    assert.deepEqual(sample, {
      heartRate: 68,
      rrCount: 0,
      rrIntervalsMs: [],
      deviceTimestamp: 31574752,
    });
  });

  it("decodes a frame whose R-R ≈ 60000/HR (confirms ms units)", () => {
    const sample = decodeRealtimeData(
      fromHex("aa1800ff2802e5cae101801d450165030000000000000105e50ff188"),
    );
    assert.equal(sample?.heartRate, 69);
    assert.equal(sample?.rrIntervalsMs[0], 869);
    // 869 ms ≈ 60000/69 ≈ 870 ms — the value is milliseconds, not 1/1024 s.
    const expected = 60000 / 69;
    assert.ok(Math.abs(sample!.rrIntervalsMs[0] - expected) < 20);
  });

  it("exposes a device-epoch timestamp (NOT unix)", () => {
    const sample = decodeRealtimeData(
      fromHex("aa1800ff2802e3cae101682745014e030000000000000105b3bee130"),
    );
    // ~31.5 million seconds ≈ 365 days since reset — clearly not Unix epoch.
    assert.ok(sample!.deviceTimestamp > 30_000_000);
    assert.ok(sample!.deviceTimestamp < 100_000_000);
  });
});

describe("decodeCommandResponse", () => {
  it("labels the GET_BATTERY_LEVEL response", () => {
    const r = decodeCommandResponse(
      parseFrame(fromHex("aa10005724091a0101020100000000001ddf31ac")),
    );
    assert.equal(r.cmd, 26);
    assert.equal(r.cmdName, "GET_BATTERY_LEVEL");
    assert.equal(r.payload.toString("hex"), "010102010000000000");
  });

  it("labels the TOGGLE_REALTIME_HR response", () => {
    const r = decodeCommandResponse(
      parseFrame(fromHex("aa0c00fc24100301020000009ebc3d6e")),
    );
    assert.equal(r.cmd, 3);
    assert.equal(r.cmdName, "TOGGLE_REALTIME_HR");
  });
});

describe("decodeEvent", () => {
  it("names BLE_REALTIME_HR_ON (33)", () => {
    const e = decodeEvent(
      parseFrame(fromHex("aa100057308e21007acbe10180280000c1800122")),
    );
    assert.equal(e.event, 33);
    assert.equal(e.eventName, "BLE_REALTIME_HR_ON");
  });

  it("names BLE_REALTIME_HR_OFF (34)", () => {
    const e = decodeEvent(
      parseFrame(fromHex("aa100057308f22007dcbe101c03b00000fa80987")),
    );
    assert.equal(e.event, 34);
    assert.equal(e.eventName, "BLE_REALTIME_HR_OFF");
  });
});
