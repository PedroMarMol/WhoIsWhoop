/**
 * Conservative decoder for HISTORICAL_DATA (type 47) version 24 frames.
 *
 * Scope: ONLY the fields the full real capture supports as VERIFIED or
 * STRONGLY SUPPORTED. Evidence base is `captures/type47_raw_hex.txt`
 * (2877 V24 records of exactly 104 bytes). Every byte range whose meaning is
 * not established is preserved verbatim under `raw` — no semantic names are
 * invented for it.
 *
 * See `docs/PROTOCOL.md` §12 for the evidence table and confidence levels.
 *
 * Version 25 (type 47, 84 bytes) is observed in the capture but is
 * deliberately NOT decoded: `decodeHistoricalDataV24` returns an explicit
 * `unsupported-version` error for it.
 *
 * This module is pure: it performs no BLE I/O and does not drive the
 * historical offload (see `src/whoop-client.ts` / §11 of the protocol doc).
 */
import { PACKET_TYPE, parseFrame } from "./framing.js";

/** A complete V24 record is always 104 bytes on the wire. */
export const HISTORICAL_DATA_V24_LENGTH = 104;

/** The version byte (frame offset 5) this decoder accepts. */
export const HISTORICAL_DATA_V24_VERSION = 24;

/** Three IEEE-754 little-endian float32 values (x, y, z). */
export type Vector3 = {
  x: number;
  y: number;
  z: number;
};

/**
 * A decoded HISTORICAL_DATA V24 record.
 *
 * Field confidence (see §12):
 *   VERIFIED          — sequence, unixSeconds, heartRate, rrIntervalsMs,
 *                       gravityDuplicate
 *   STRONGLY SUPPORTED — subsecond (timing field), gravity (|g| ≈ 1 g)
 *   UNKNOWN / RAW      — everything under `raw`
 */
export type HistoricalDataV24 = {
  version: 24;
  /** u32 LE @7; strictly +1 per V24 record in the capture. */
  sequence: number;
  /** u32 LE @11 interpreted as Unix seconds. */
  timestamp: Date;
  /** The raw Unix seconds (frame offset 11). */
  unixSeconds: number;
  /** u16 LE @15; a sub-second timing field (encoding not established). */
  subsecond: number;
  /** u8 @21, beats per minute. */
  heartRate: number;
  /** u16 LE @23…, already milliseconds; length = rr_count (≤ 4). */
  rrIntervalsMs: number[];
  /**
   * f32 LE @40/44/48. A gravity/accelerometer-like vector (|g| ≈ 1 g across
   * the capture). The semantic label is STRONGLY SUPPORTED, not proven.
   */
  gravity: Vector3;
  /** f32 LE @56/60/64; byte-identical to `gravity` in every captured record. */
  gravityDuplicate: Vector3;
  /** Unknown bytes, preserved verbatim (no meaning assigned). */
  raw: {
    header17_20: Buffer;
    bytes31_39: Buffer;
    bytes52_55: Buffer;
    uint16_68_79: number[];
    bytes80_83: Buffer;
    tail84_99: Buffer;
  };
};

/** Why a type-47 frame could not be decoded as V24. */
export type HistoricalDataError =
  | "wrong-length"
  | "not-historical-data"
  | "unsupported-version"
  | "bad-crc";

/** Discriminated result so callers get an explicit error instead of `undefined`. */
export type HistoricalDataResult =
  | { ok: true; data: HistoricalDataV24 }
  | { ok: false; error: HistoricalDataError; detail: string };

function fail(error: HistoricalDataError, detail: string): HistoricalDataResult {
  return { ok: false, error, detail };
}

function readVector3(frame: Buffer, offset: number): Vector3 {
  return {
    x: frame.readFloatLE(offset),
    y: frame.readFloatLE(offset + 4),
    z: frame.readFloatLE(offset + 8),
  };
}

/**
 * Decode a complete HISTORICAL_DATA (type 47) V24 frame.
 *
 * Validation order: type → version → length → CRC-32. Checking the version
 * before the length lets V25 frames return a precise `unsupported-version`.
 */
export function decodeHistoricalDataV24(frame: Buffer): HistoricalDataResult {
  if (frame.length < 6) {
    return fail("wrong-length", `frame is ${frame.length} bytes; too short to read type/version`);
  }
  const type = frame[4];
  if (type !== PACKET_TYPE.HISTORICAL_DATA) {
    return fail(
      "not-historical-data",
      `packet type ${type} is not HISTORICAL_DATA (${PACKET_TYPE.HISTORICAL_DATA})`,
    );
  }
  const version = frame[5];
  if (version !== HISTORICAL_DATA_V24_VERSION) {
    return fail("unsupported-version", `HISTORICAL_DATA version ${version} is not decoded (only V24)`);
  }
  if (frame.length !== HISTORICAL_DATA_V24_LENGTH) {
    return fail(
      "wrong-length",
      `V24 frame is ${frame.length} bytes; expected ${HISTORICAL_DATA_V24_LENGTH}`,
    );
  }
  if (!parseFrame(frame).crcOK) {
    return fail("bad-crc", "frame failed CRC-8/CRC-32 validation");
  }

  const unixSeconds = frame.readUInt32LE(11);

  // The record reserves exactly four RR slots (offsets 23..30). Only the first
  // `rr_count` are valid; the rest are ignored.
  const rrCount = Math.min(frame[22], 4);
  const rrIntervalsMs: number[] = [];
  for (let i = 0; i < rrCount; i++) {
    rrIntervalsMs.push(frame.readUInt16LE(23 + i * 2));
  }

  return {
    ok: true,
    data: {
      version: HISTORICAL_DATA_V24_VERSION,
      sequence: frame.readUInt32LE(7),
      timestamp: new Date(unixSeconds * 1000),
      unixSeconds,
      subsecond: frame.readUInt16LE(15),
      heartRate: frame[21],
      rrIntervalsMs,
      gravity: readVector3(frame, 40),
      gravityDuplicate: readVector3(frame, 56),
      raw: {
        header17_20: Buffer.from(frame.subarray(17, 21)),
        bytes31_39: Buffer.from(frame.subarray(31, 40)),
        bytes52_55: Buffer.from(frame.subarray(52, 56)),
        uint16_68_79: [68, 70, 72, 74, 76, 78].map((o) => frame.readUInt16LE(o)),
        bytes80_83: Buffer.from(frame.subarray(80, 84)),
        tail84_99: Buffer.from(frame.subarray(84, 100)),
      },
    },
  };
}
