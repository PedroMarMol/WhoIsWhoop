/**
 * Tests for the conservative HISTORICAL_DATA V24 decoder, using real frames
 * from `captures/type47_raw_hex.txt`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  decodeHistoricalDataV24,
  type HistoricalDataError,
  type HistoricalDataV24,
} from "../src/historical.js";

const hex = (h: string) => Buffer.from(h, "hex");

function mustDecode(frame: Buffer): HistoricalDataV24 {
  const result = decodeHistoricalDataV24(frame);
  if (!result.ok) {
    throw new Error(`expected a V24 decode, got ${result.error}: ${result.detail}`);
  }
  return result.data;
}

function expectError(frame: Buffer, error: HistoricalDataError): void {
  const result = decodeHistoricalDataV24(frame);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, error);
  }
}

// Three real V24 records from the capture: rr_count = 1, 0 and 2.
const FRAME_RR1 =
  "aa6400a12f1805043a8b06cc01c56a685a8064400144015a030000000000000020de00ff8043313c8593073f0ad7d3ba008c5dbf0000a9c68593073f0ad7d3ba008c5dbfee01df016102e10150015002010c020c00000000001900047b120000000000008d4fa119";
const FRAME_RR0 =
  "aa6400a12f1805223a8b06e901c56ad04580644001470000000000000000000020fa0aff3c5ab53ea470c33ec3e504bec3bd70bf00005845a470c33ec3e504bec3bd70bfee01df015a02de0150015002010c020c00000000007e00047b12000000000000c83cc518";
const FRAME_RR2 =
  "aa6400a12f18050b3a8b06d301c56ac037806440014502700345030000000000004303ff80c6073c3d7e073fec5144bbaea35dbf0000fa463d7e073fec5144bbaea35dbfee01df015f02e10150015002010c020c00000000000400047b1200000000000026641f41";

// A real V25 record (type 47, version 25, 84 bytes) — must not be decoded.
const FRAME_V25 =
  "aa50000c2f1900133b0000d102c56a301c30004f3c03003dff1efbeef840fb6bf6edfafb0023053e0de60e8502d6fa03fdc1fb4cfbe9fb48fc00fb67fba6fd3afd41fd34fdc3fd6070be3d500200000094cb958d";

let corpusHex: string[] | undefined;
try {
  corpusHex = readFileSync(new URL("../captures/type47_raw_hex.txt", import.meta.url), "utf8")
    .trim()
    .split("\n");
} catch {
  corpusHex = undefined;
}

describe("decodeHistoricalDataV24 — single real records", () => {
  it("decodes a full V24 record with sequence, timestamp, HR and one RR", () => {
    const d = mustDecode(hex(FRAME_RR1));
    assert.equal(d.version, 24);
    assert.equal(d.sequence, 109787652);
    assert.equal(d.unixSeconds, 1791295948);
    assert.equal(d.timestamp.toISOString(), "2026-10-06T14:12:28.000Z");
    assert.equal(d.timestamp.getTime(), 1791295948 * 1000);
    assert.equal(d.subsecond, 23144);
    assert.equal(d.heartRate, 68);
    assert.deepEqual(d.rrIntervalsMs, [858]);
  });

  it("treats RR values as milliseconds (≈ 60000 / HR)", () => {
    const d = mustDecode(hex(FRAME_RR1));
    const expected = 60000 / d.heartRate; // 882 ms
    assert.ok(Math.abs(d.rrIntervalsMs[0] - expected) < 60);
  });

  it("decodes rr_count = 0 as an empty interval list", () => {
    const d = mustDecode(hex(FRAME_RR0));
    assert.equal(d.heartRate, 71);
    assert.deepEqual(d.rrIntervalsMs, []);
  });

  it("reads exactly rr_count values and ignores the remaining RR slots", () => {
    const d = mustDecode(hex(FRAME_RR2));
    assert.equal(d.heartRate, 69);
    assert.deepEqual(d.rrIntervalsMs, [880, 837]);
  });

  it("decodes the gravity vector and its byte-identical duplicate", () => {
    const d = mustDecode(hex(FRAME_RR1));
    assert.equal(d.gravity.x, 0.5295947194099426);
    assert.equal(d.gravity.y, -0.0016162109095603228);
    assert.equal(d.gravity.z, -0.86541748046875);
    assert.deepEqual(d.gravity, d.gravityDuplicate);
    const magnitude = Math.hypot(d.gravity.x, d.gravity.y, d.gravity.z);
    assert.ok(magnitude > 0.4 && magnitude < 1.4, `|g| = ${magnitude}`);
  });

  it("preserves every unknown byte range verbatim", () => {
    const d = mustDecode(hex(FRAME_RR1));
    assert.equal(d.raw.header17_20.toString("hex"), "80644001");
    assert.equal(d.raw.bytes31_39.toString("hex"), "0020de00ff8043313c");
    assert.equal(d.raw.bytes52_55.toString("hex"), "0000a9c6");
    assert.deepEqual(d.raw.uint16_68_79, [494, 479, 609, 481, 336, 592]);
    assert.equal(d.raw.bytes80_83.toString("hex"), "010c020c");
    assert.equal(d.raw.tail84_99.toString("hex"), "00000000001900047b12000000000000");
    assert.equal(d.raw.tail84_99.length, 16);
  });
});

describe("decodeHistoricalDataV24 — rejection", () => {
  it("rejects a frame with a corrupted CRC-32", () => {
    const frame = hex(FRAME_RR1);
    frame[50] ^= 0xff; // payload byte; length/type/version unchanged
    expectError(frame, "bad-crc");
  });

  it("rejects a non-HISTORICAL_DATA packet type", () => {
    const frame = hex(FRAME_RR1);
    frame[4] = 40; // REALTIME_DATA
    expectError(frame, "not-historical-data");
  });

  it("rejects an unsupported version", () => {
    const frame = hex(FRAME_RR1);
    frame[5] = 23;
    expectError(frame, "unsupported-version");
  });

  it("rejects a wrong-length V24 frame", () => {
    expectError(hex(FRAME_RR1).subarray(0, 103), "wrong-length");
  });

  it("does not decode a V25 record (explicit unsupported-version)", () => {
    const frame = hex(FRAME_V25);
    assert.equal(frame.length, 84);
    assert.equal(frame[4], 47);
    assert.equal(frame[5], 25);
    expectError(frame, "unsupported-version");
  });
});

describe("decodeHistoricalDataV24 — full real capture corpus", () => {
  it("decodes all 2877 real V24 records consistently", { skip: corpusHex === undefined }, () => {
    const v24 = corpusHex!
      .map((line) => Buffer.from(line, "hex"))
      .filter((frame) => frame.length === 104);

    assert.equal(v24.length, 2877);

    let previousSequence: number | undefined;
    let previousUnix: number | undefined;

    for (const frame of v24) {
      const d = mustDecode(frame);

      assert.equal(d.version, 24);
      assert.ok(d.heartRate >= 0 && d.heartRate <= 255);
      assert.equal(d.rrIntervalsMs.length, Math.min(frame[22], 4));
      for (const rr of d.rrIntervalsMs) {
        assert.ok(rr >= 250 && rr <= 3000, `implausible RR ${rr}`);
      }

      // The duplicate gravity block must always equal the first.
      assert.deepEqual(d.gravity, d.gravityDuplicate);
      const magnitude = Math.hypot(d.gravity.x, d.gravity.y, d.gravity.z);
      assert.ok(magnitude > 0.4 && magnitude < 1.4, `|g| = ${magnitude}`);

      if (previousSequence !== undefined) {
        assert.equal(d.sequence, previousSequence + 1);
      }
      if (previousUnix !== undefined) {
        assert.ok(d.unixSeconds >= previousUnix);
      }
      previousSequence = d.sequence;
      previousUnix = d.unixSeconds;
    }
  });

  it("decodes a sample of 20 real records from the capture", { skip: corpusHex === undefined }, () => {
    const v24 = corpusHex!
      .map((line) => Buffer.from(line, "hex"))
      .filter((frame) => frame.length === 104);

    for (const frame of v24.slice(0, 20)) {
      const d = mustDecode(frame);
      assert.equal(d.version, 24);
      assert.equal(d.timestamp.getTime(), d.unixSeconds * 1000);
    }
  });
});
