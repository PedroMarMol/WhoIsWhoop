/**
 * Integration tests for `WhoopSession`: HISTORICAL_DATA (type 47) routing and
 * the historical offload state machine (commands 22/23, type-49 metadata).
 *
 * Fake GATT characteristics let the real `open()` → subscribe → reassemble →
 * decode path run without any BLE hardware. Real captured frames are used as
 * fixtures.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  normalizeUuid,
  WHOOP4_CMD_NOTIFY_UUID,
  WHOOP4_CMD_WRITE_UUID,
  WHOOP4_CUSTOM_SERVICE_UUID,
  WHOOP4_DATA_NOTIFY_UUID,
  WHOOP4_EVENT_NOTIFY_UUID,
} from "../src/whoop-ids.js";
import { WhoopSession, type HistoricalDataFrame } from "../src/whoop-client.js";

const hex = (h: string) => Buffer.from(h, "hex");

// Real frames from captures/type47_raw_hex.txt.
const V24_HEX =
  "aa6400a12f1805043a8b06cc01c56a685a8064400144015a030000000000000020de00ff8043313c8593073f0ad7d3ba008c5dbf0000a9c68593073f0ad7d3ba008c5dbfee01df016102e10150015002010c020c00000000001900047b120000000000008d4fa119";
const V25_HEX =
  "aa50000c2f1900133b0000d102c56a301c30004f3c03003dff1efbeef840fb6bf6edfafb0023053e0de60e8502d6fa03fdc1fb4cfbe9fb48fc00fb67fba6fd3afd41fd34fdc3fd6070be3d500200000094cb958d";
// Real REALTIME_DATA (type 40) frame.
const REALTIME_HEX = "aa1800ff2802e3cae101682745014e030000000000000105b3bee130";
// Real EVENT (type 48) frame — not a data-channel type the session routes.
const EVENT_HEX = "aa100057308e21007acbe10180280000c1800122";

// Real METADATA (type 49) frames from captures/historical_offload_ack_raw_hex.txt.
const META_START_1 = "aa2c0052314b014816c56a800906000000060000000000000029000000110000000600000000000000080600c667c331"; // [6]=0x01, len 48
const META_END_1 = "aa1c00ab314c024816c56a601733000000641c010085000000000000a8d52684"; // [6]=0x02, len 32
const META_END_2 = "aa1c00ab314f024816c56a00543b000000681c010085000000000000d3a70343"; // [6]=0x02, len 32
const META_DONE = "aa10005731f0035516c56ab04800000028b8916d"; // [6]=0x03, len 20
// Real captured command-23 frame produced by the device-verified ACK #2 (seq=2).
const REAL_ACK_2 = "aa10005723021701681c0100850000006c20b42c";

class FakeCharacteristic {
  private readonly emitter = new EventEmitter();
  readonly writes: Buffer[] = [];
  /** When set, the next writeValue() rejects with this error, then clears. */
  failNext: Error | undefined;

  on(event: string, listener: (buffer: Buffer) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  removeListener(event: string, listener: (buffer: Buffer) => void): this {
    this.emitter.removeListener(event, listener);
    return this;
  }

  async startNotifications(): Promise<void> {}
  async stopNotifications(): Promise<void> {}
  async writeValue(value: Buffer): Promise<void> {
    if (this.failNext !== undefined) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
    this.writes.push(Buffer.from(value));
  }

  /** Test helper: simulate a notification on this characteristic. */
  notify(buffer: Buffer): void {
    this.emitter.emit("valuechanged", buffer);
  }
}

type Fakes = { gatt: unknown; data: FakeCharacteristic; write: FakeCharacteristic };

function fakeGatt(): Fakes {
  const characteristics = new Map<string, FakeCharacteristic>();
  for (const uuid of [
    WHOOP4_CMD_WRITE_UUID,
    WHOOP4_CMD_NOTIFY_UUID,
    WHOOP4_EVENT_NOTIFY_UUID,
    WHOOP4_DATA_NOTIFY_UUID,
  ]) {
    characteristics.set(normalizeUuid(uuid), new FakeCharacteristic());
  }

  const gatt = {
    services: async () => [WHOOP4_CUSTOM_SERVICE_UUID],
    getPrimaryService: async () => ({
      characteristics: async () => [...characteristics.keys()],
      getCharacteristic: async (uuid: string) => characteristics.get(normalizeUuid(uuid)),
    }),
  };

  return {
    gatt,
    data: characteristics.get(normalizeUuid(WHOOP4_DATA_NOTIFY_UUID))!,
    write: characteristics.get(normalizeUuid(WHOOP4_CMD_WRITE_UUID))!,
  };
}

async function openFakeSession(): Promise<Fakes & { session: WhoopSession }> {
  const fakes = fakeGatt();
  const session = await WhoopSession.open(
    fakes.gatt as unknown as Parameters<typeof WhoopSession.open>[0],
  );
  return { ...fakes, session };
}

// Frames whose frame[6] === 0x17 (command 23) among the recorded writes.
const acksOnly = (writes: Buffer[]) => writes.filter((w) => w[6] === 23);
// The payload of a built command frame: bytes after cmd (offset 6), before CRC-32.
const payloadOf = (frame: Buffer) => frame.subarray(7, frame.length - 4);

describe("WhoopSession data channel — HISTORICAL_DATA routing", () => {
  it("decodes a real V24 frame and delivers HR, timestamp, sequence and RR", async () => {
    const { session, data } = await openFakeSession();
    const received: HistoricalDataFrame[] = [];
    session.onHistoricalData((frame) => received.push(frame));

    data.notify(hex(V24_HEX));

    assert.equal(received.length, 1);
    const result = received[0].result;
    assert.ok(result.ok, "V24 frame should decode");
    if (result.ok) {
      assert.equal(result.data.version, 24);
      assert.equal(result.data.heartRate, 68);
      assert.equal(result.data.sequence, 109787652);
      assert.equal(result.data.unixSeconds, 1791295948);
      assert.equal(result.data.timestamp.toISOString(), "2026-10-06T14:12:28.000Z");
      assert.deepEqual(result.data.rrIntervalsMs, [858]);
    }
    assert.equal(received[0].raw.toString("hex"), V24_HEX);

    await session.close();
  });

  it("reports V25 as unsupported and never decodes it as V24", async () => {
    const { session, data } = await openFakeSession();
    const received: HistoricalDataFrame[] = [];
    session.onHistoricalData((frame) => received.push(frame));

    data.notify(hex(V25_HEX));

    assert.equal(received.length, 1);
    assert.equal(received[0].result.ok, false);
    if (!received[0].result.ok) {
      assert.equal(received[0].result.error, "unsupported-version");
    }

    await session.close();
  });

  it("keeps the existing realtime routing unchanged", async () => {
    const { session, data } = await openFakeSession();
    const realtime: number[] = [];
    const historical: HistoricalDataFrame[] = [];
    session.onRealtimeData((sample) => realtime.push(sample.heartRate));
    session.onHistoricalData((frame) => historical.push(frame));

    data.notify(hex(REALTIME_HEX));
    data.notify(hex(EVENT_HEX));

    assert.deepEqual(realtime, [69]);
    assert.equal(historical.length, 0);

    await session.close();
  });
});

describe("WhoopSession — historical offload state machine", () => {
  it("sends SEND_HISTORICAL_DATA (22, [0x00]) when a download starts", async () => {
    const { session, data, write } = await openFakeSession();
    const done = session.downloadHistoricalData();

    assert.equal(write.writes.length, 1);
    const start = write.writes[0];
    assert.equal(start[4], 35); // COMMAND
    assert.equal(start[6], 22); // SEND_HISTORICAL_DATA
    assert.equal(payloadOf(start).toString("hex"), "00"); // payload [0x00]

    data.notify(hex(META_DONE));
    const result = await done;
    assert.equal(result.historicalRecords, 0);

    await session.close();
  });

  it("recognizes a real [6]===0x01 frame without ACKing, and keeps V24 flowing", async () => {
    const { session, data, write } = await openFakeSession();
    const received: HistoricalDataFrame[] = [];
    session.onHistoricalData((frame) => received.push(frame));
    const done = session.downloadHistoricalData();

    data.notify(hex(META_START_1)); // chunk start: observed, not acked
    assert.equal(acksOnly(write.writes).length, 0);

    data.notify(hex(V24_HEX));
    assert.equal(received.length, 1);

    data.notify(hex(META_DONE));
    const result = await done;
    assert.equal(result.historicalRecords, 1);

    await session.close();
  });

  it("ACKs a real [6]===0x02 frame with the exact command-23 payload", async () => {
    const { session, data, write } = await openFakeSession();
    const done = session.downloadHistoricalData();

    data.notify(hex(META_END_1));
    const acks = acksOnly(write.writes);
    assert.equal(acks.length, 1);
    const ack = acks[0];

    // payload = [0x01, ...frame[17:25]] of the source END frame
    assert.equal(payloadOf(ack).toString("hex"), "01" + "641c010085000000");

    data.notify(hex(META_DONE));
    await done;
    await session.close();
  });

  it("generates the same command-23 frame the device accepted (real capture)", async () => {
    const { session, data, write } = await openFakeSession();
    const done = session.downloadHistoricalData(); // consumes seq 1

    // This END frame was the 2nd chunk in the capture; our ack gets seq 2,
    // matching the real captured command frame ACL2.
    data.notify(hex(META_END_2));
    const ack = acksOnly(write.writes)[0];
    assert.equal(ack.toString("hex"), REAL_ACK_2);

    data.notify(hex(META_DONE));
    await done;
    await session.close();
  });

  it("advances through multiple real chunks, one ACK per chunk end", async () => {
    const { session, data, write } = await openFakeSession();
    const done = session.downloadHistoricalData();

    for (const frame of [META_START_1, META_END_1, V24_HEX, META_START_1, META_END_2, V24_HEX]) {
      data.notify(hex(frame));
    }
    const acks = acksOnly(write.writes);
    assert.equal(acks.length, 2);
    assert.equal(payloadOf(acks[0]).toString("hex"), "01" + "641c010085000000");
    assert.equal(payloadOf(acks[1]).toString("hex"), "01" + "681c010085000000");

    data.notify(hex(META_DONE));
    await done;
    await session.close();
  });

  it("terminates the download on the real [6]===0x03 frame", async () => {
    const { session, data } = await openFakeSession();
    let settled = false;
    const done = session.downloadHistoricalData().then((r) => {
      settled = true;
      return r;
    });

    data.notify(hex(META_START_1));
    data.notify(hex(V24_HEX));
    data.notify(hex(META_END_1));
    assert.equal(settled, false);

    data.notify(hex(META_DONE));
    const result = await done;
    assert.equal(settled, true);
    assert.equal(result.historicalRecords, 1);

    await session.close();
  });

  it("rejects a second concurrent download", async () => {
    const { session, data } = await openFakeSession();
    const done = session.downloadHistoricalData();
    await assert.rejects(session.downloadHistoricalData(), /already in progress/);

    data.notify(hex(META_DONE));
    await done;
    await session.close();
  });

  it("rejects the download when a command-23 ACK write fails, then clears state", async () => {
    const { session, data, write } = await openFakeSession();
    const done = session.downloadHistoricalData(); // command 22 succeeds

    write.failNext = new Error("write failed");
    data.notify(hex(META_END_1)); // triggers the command-23 ACK write, which fails
    await assert.rejects(done, /write failed/);

    // State was cleared: a fresh download can start and complete normally.
    const second = session.downloadHistoricalData();
    data.notify(hex(META_DONE));
    const result = await second;
    assert.equal(result.historicalRecords, 0);

    await session.close();
  });

  it("rejects and clears state when SEND_HISTORICAL_DATA (command 22) fails", async () => {
    const { session, data, write } = await openFakeSession();
    write.failNext = new Error("start failed");
    await assert.rejects(session.downloadHistoricalData(), /start failed/);

    // State was cleared: a fresh download can start and complete normally.
    const done = session.downloadHistoricalData();
    data.notify(hex(META_DONE));
    const result = await done;
    assert.equal(result.historicalRecords, 0);

    await session.close();
  });

  it("rejects a pending download when the session is closed", async () => {
    const { session } = await openFakeSession();
    const done = session.downloadHistoricalData();
    // Attach a handler before closing so the rejection is never unhandled.
    const settled = done.then(
      () => undefined,
      (error: Error) => error,
    );

    await session.close();

    const error = await settled;
    assert.ok(error instanceof Error, "pending download should reject on close");
    assert.match(error.message, /closed/);
  });

  it("drives the full 55-chunk capture through to completion", async (t) => {
    let lines: string[];
    try {
      lines = readFileSync(
        new URL("../captures/historical_offload_ack_raw_hex.txt", import.meta.url),
        "utf8",
      )
        .trim()
        .split("\n");
    } catch {
      t.skip("capture file not present");
      return;
    }

    const { session, data, write } = await openFakeSession();
    let deliveredOk = 0;
    session.onHistoricalData((frame) => {
      if (frame.result.ok) deliveredOk += 1;
    });

    const done = session.downloadHistoricalData();
    for (const line of lines) {
      data.notify(Buffer.from(line, "hex"));
    }
    const result = await done;

    const acks = acksOnly(write.writes);
    assert.equal(acks.length, 55);
    assert.equal(result.historicalRecords, deliveredOk);
    assert.ok(result.historicalRecords > 0);
    // Last captured frame is the [6]===0x03 completion frame.
    assert.equal(lines[lines.length - 1], META_DONE);

    await session.close();
  });
});
