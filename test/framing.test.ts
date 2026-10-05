/**
 * Framing tests using real frames captured from a WHOOP 4.0
 * and the two known-good command frames generated with NOOP's algorithm.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCommandFrame,
  crc8,
  crc32,
  parseFrame,
  Reassembler,
  PACKET_TYPE,
} from "../src/framing.js";

const hex = (b: Buffer) => b.toString("hex");

describe("crc8", () => {
  it("matches known length-byte headers", () => {
    assert.equal(crc8([0x08, 0x00]), 0xa8); // command frame
    assert.equal(crc8([0x0c, 0x00]), 0xfc); // TOGGLE_REALTIME_HR response
    assert.equal(crc8([0x10, 0x00]), 0x57); // GET_BATTERY_LEVEL response / event
    assert.equal(crc8([0x18, 0x00]), 0xff); // REALTIME_DATA frame
  });
});

describe("buildCommandFrame", () => {
  it("produces the exact GET_BATTERY_LEVEL frame we sent to the strap", () => {
    assert.equal(hex(buildCommandFrame(26, 1, [0x00])), "aa0800a823011a00204f2c22");
  });

  it("produces the exact TOGGLE_REALTIME_HR(on) frame", () => {
    assert.equal(hex(buildCommandFrame(3, 1, [0x01])), "aa0800a823010301aed62bce");
  });

  it("produces the exact GET_CLOCK frame (empty payload)", () => {
    // GET_CLOCK uses an EMPTY payload (NOOP), so the frame is only 11 bytes.
    assert.equal(hex(buildCommandFrame(11, 1, [])), "aa07006b23010b62c9834b");
  });

  it("embeds the sequence number in byte 5", () => {
    const seq1 = buildCommandFrame(26, 1, [0x00]);
    const seq2 = buildCommandFrame(26, 2, [0x00]);
    assert.equal(seq1[5], 1);
    assert.equal(seq2[5], 2);
    assert.notEqual(hex(seq1), hex(seq2));
  });
});

describe("parseFrame", () => {
  it("parses a real GET_BATTERY_LEVEL response", () => {
    const p = parseFrame(Buffer.from("aa10005724091a0101020100000000001ddf31ac", "hex"));
    assert.equal(p.ok, true);
    assert.equal(p.type, PACKET_TYPE.COMMAND_RESPONSE);
    assert.equal(p.seq, 9);
    assert.equal(p.cmd, 26);
    assert.equal(p.payload.toString("hex"), "010102010000000000");
  });

  it("parses a real TOGGLE_REALTIME_HR response", () => {
    const p = parseFrame(Buffer.from("aa0c00fc24100301020000009ebc3d6e", "hex"));
    assert.equal(p.ok, true);
    assert.equal(p.type, PACKET_TYPE.COMMAND_RESPONSE);
    assert.equal(p.cmd, 3);
  });

  it("parses a real REALTIME_DATA frame", () => {
    const p = parseFrame(Buffer.from("aa1800ff2802e3cae101682745014e030000000000000105b3bee130", "hex"));
    assert.equal(p.ok, true);
    assert.equal(p.type, PACKET_TYPE.REALTIME_DATA);
    assert.equal(p.seq, 2);
  });

  it("parses a real EVENT frame", () => {
    const p = parseFrame(Buffer.from("aa100057308e21007acbe10180280000c1800122", "hex"));
    assert.equal(p.ok, true);
    assert.equal(p.type, PACKET_TYPE.EVENT);
    assert.equal(p.cmd, 33); // BLE_REALTIME_HR_ON
  });

  it("rejects a corrupted frame", () => {
    const p = parseFrame(Buffer.from("aa10005724091a01010201000000000000000000", "hex"));
    assert.equal(p.ok, false);
  });
});

describe("Reassembler", () => {
  it("reassembles a frame split into fragments", () => {
    const frame = Buffer.from("aa1800ff2802e3cae101682745014e030000000000000105b3bee130", "hex");
    const re = new Reassembler();
    assert.deepEqual(re.feed(frame.subarray(0, 5)), []);
    assert.deepEqual(re.feed(frame.subarray(5, 11)), []);
    const out = re.feed(frame.subarray(11));
    assert.equal(out.length, 1);
    assert.equal(hex(out[0]), hex(frame));
  });
});

describe("crc32", () => {
  it("matches the trailer of a real frame", () => {
    // inner bytes of aa1800ff2802… (type..payload)
    const frame = Buffer.from("aa1800ff2802e3cae101682745014e030000000000000105b3bee130", "hex");
    const inner = [...frame.subarray(4, frame.readUInt16LE(1))];
    assert.equal(crc32(inner), frame.readUInt32LE(frame.readUInt16LE(1)));
  });
});
