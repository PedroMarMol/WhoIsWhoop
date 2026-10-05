/**
 * WHOOP 4.0 frame encoding/decoding (pure functions, no BLE dependency).
 *
 * Every message on the custom service is a length-prefixed, double-checksummed
 * frame. This layout is documented by NOOP (Framing.swift / Commands.swift) and
 * was verified byte-for-byte against the strap in this project:
 *
 *   ┌──────┬───────────┬──────┬──────┬──────┬──────┬───────────┬────────────┐
 *   │ 0xAA │ len u16 LE │ crc8 │ type │ seq  │ cmd  │ payload…  │ crc32 LE   │
 *   └──────┴───────────┴──────┴──────┴──────┴──────┴───────────┴────────────┘
 *            \_______ crc8 over these 2 length bytes _______/
 *                     \____ crc32 (zlib) over [type][seq][cmd][payload] ____/
 *
 * - `len` = the number of bytes from `type` through the end of the payload,
 *   plus 4. The total frame on the wire is `len + 4`.
 * - `crc8` (poly 0x07) only guards the two length bytes.
 * - `crc32` is standard zlib CRC-32 over the inner bytes.
 * - `seq` is a rolling client counter (we keep it simple; the strap answers
 *   with its own counter and we correlate on `cmd`, not `seq`).
 */
import zlib from "node:zlib";

/** CRC-8, polynomial 0x07, initial value 0x00 (matches NOOP `crc8`). */
export function crc8(bytes: number[]): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc & 0xff;
}

/** zlib CRC-32 (matches NOOP `crc32`). */
export function crc32(bytes: number[]): number {
  return zlib.crc32(Buffer.from(bytes)) >>> 0;
}

/**
 * Build a COMMAND frame (type 35) to write to the 61080002 characteristic.
 * `cmd` is the command number, `payload` its argument bytes.
 */
export function buildCommandFrame(
  cmd: number,
  seq: number,
  payload: number[],
): Buffer {
  const inner = [35, seq, cmd, ...payload];
  const len = inner.length + 4;
  const lenBytes = [len & 0xff, (len >> 8) & 0xff];
  const headerCrc = crc8(lenBytes);
  const trailer = crc32(inner);
  return Buffer.from([
    0xaa,
    ...lenBytes,
    headerCrc,
    ...inner,
    trailer & 0xff,
    (trailer >>> 8) & 0xff,
    (trailer >>> 16) & 0xff,
    (trailer >>> 24) & 0xff,
  ]);
}

/** Packet type numbers we care about (from NOOP `whoop_protocol.json`). */
export const PACKET_TYPE = {
  COMMAND: 35,
  COMMAND_RESPONSE: 36,
  REALTIME_DATA: 40,
  REALTIME_RAW_DATA: 43,
  HISTORICAL_DATA: 47,
  EVENT: 48,
  METADATA: 49,
  CONSOLE_LOGS: 50,
} as const;

const TYPE_NAMES: Record<number, string> = {
  35: "COMMAND",
  36: "COMMAND_RESPONSE",
  40: "REALTIME_DATA",
  43: "REALTIME_RAW_DATA",
  47: "HISTORICAL_DATA",
  48: "EVENT",
  49: "METADATA",
  50: "CONSOLE_LOGS",
};

export function packetTypeName(type: number): string {
  return TYPE_NAMES[type] ?? `TYPE_${type}`;
}

/**
 * BLE delivers frames in MTU-sized fragments. The reassembler accumulates
 * bytes, finds the 0xAA start-of-frame, reads the declared length, and only
 * emits a frame once `len + 4` bytes are present (NOOP `Reassembler`).
 */
export class Reassembler {
  private buf: number[] = [];

  feed(fragment: Buffer): Buffer[] {
    this.buf.push(...fragment);
    const out: Buffer[] = [];
    for (;;) {
      const sof = this.buf.indexOf(0xaa);
      if (sof < 0) {
        this.buf = [];
        break;
      }
      if (sof > 0) {
        this.buf.splice(0, sof);
      }
      if (this.buf.length < 4) {
        break;
      }
      const len = this.buf[1] | (this.buf[2] << 8);
      const total = len + 4;
      if (this.buf.length < total) {
        break;
      }
      out.push(Buffer.from(this.buf.slice(0, total)));
      this.buf.splice(0, total);
    }
    return out;
  }
}

export type ParsedFrame = {
  ok: boolean;
  crcOK: boolean;
  type: number;
  typeName: string;
  seq: number;
  cmd: number;
  payload: Buffer;
  raw: Buffer;
};

/** Validate and split a complete frame into its fields (NOOP `parseFrame`). */
export function parseFrame(frame: Buffer): ParsedFrame {
  if (frame.length < 8 || frame[0] !== 0xaa) {
    return {
      ok: false,
      crcOK: false,
      type: 0,
      typeName: "INVALID",
      seq: 0,
      cmd: 0,
      payload: Buffer.alloc(0),
      raw: frame,
    };
  }

  const len = frame.readUInt16LE(1);
  const crc8OK = crc8([frame[1], frame[2]]) === frame[3];

  let crc32OK = false;
  if (len >= 7 && len + 4 <= frame.length) {
    const inner = [...frame.subarray(4, len)];
    crc32OK = crc32(inner) === frame.readUInt32LE(len);
  }

  const type = frame[4];
  return {
    ok: crc8OK && crc32OK,
    crcOK: crc8OK && crc32OK,
    type,
    typeName: packetTypeName(type),
    seq: frame[5],
    cmd: frame.length > 6 ? frame[6] : 0,
    payload: frame.subarray(7, len),
    raw: frame,
  };
}
