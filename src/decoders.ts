/**
 * Pure decoders: turn a parsed frame into a small, typed domain object.
 *
 * These functions have no BLE or node-ble dependency — they only take buffers /
 * parsed frames and return plain data. Everything here is backed by NOOP's
 * `whoop_protocol.json` + `PostHooks.swift`, and by real captures from our strap.
 */
import type { ParsedFrame } from "./framing.js";
import { commandName } from "./commands.js";

/** A single heart-rate sample from a REALTIME_DATA (type 40) frame. */
export type RealtimeHeartRateSample = {
  heartRate: number;
  rrCount: number;
  rrIntervalsMs: number[];
  /**
   * Device clock at sample time, in seconds, little-endian u32 (frame offset 6).
   * This is the strap's own monotonic epoch (~31.5 million ≈ 365 days since
   * reset on our unit), NOT Unix time. It increments by ~1 per second.
   */
  deviceTimestamp: number;
};

/**
 * Decode a complete REALTIME_DATA (type 40) frame.
 *
 * Field offsets (NOOP `whoop_protocol.json`, frame-absolute):
 *   timestamp u32 LE @6, subseconds u16 LE @10, heart_rate u8 @12,
 *   rr_count u8 @13, then rr_count × u16 LE R-R intervals @14…
 *
 * IMPORTANT: the WHOOP R-R intervals are ALREADY in milliseconds (NOOP stores
 * them as "ms" with no conversion, and our capture matches 60000/HR). They are
 * NOT in the 1/1024 s unit that the standard 0x2A37 profile uses.
 */
export function decodeRealtimeData(frame: Buffer): RealtimeHeartRateSample | undefined {
  if (frame.length < 14) {
    return undefined;
  }
  const deviceTimestamp = frame.readUInt32LE(6);
  const heartRate = frame[12];
  const rrCount = frame[13];
  const rrIntervalsMs: number[] = [];
  let offset = 14;
  for (let i = 0; i < rrCount && offset + 2 <= frame.length; i++) {
    rrIntervalsMs.push(frame.readUInt16LE(offset));
    offset += 2;
  }
  return { heartRate, rrCount, rrIntervalsMs, deviceTimestamp };
}

/** A decoded COMMAND_RESPONSE (type 36) frame. */
export type CommandResponse = {
  /** The command number the strap is answering (echo of our command). */
  cmd: number;
  cmdName: string;
  payload: Buffer;
};

export function decodeCommandResponse(parsed: ParsedFrame): CommandResponse {
  return {
    cmd: parsed.cmd,
    cmdName: commandName(parsed.cmd),
    payload: parsed.payload,
  };
}

/**
 * EVENT (type 48) numbers we have observed. NOOP `whoop_protocol.json`
 * `EventNumber` documents the full list; we only name the ones we have seen.
 */
export const EVENT_NAMES: Record<number, string> = {
  33: "BLE_REALTIME_HR_ON",
  34: "BLE_REALTIME_HR_OFF",
};

export function eventName(event: number): string {
  return EVENT_NAMES[event] ?? `EVENT_${event}`;
}

/** A decoded EVENT (type 48) frame: the event number is at frame offset 6. */
export type WhoopEvent = {
  event: number;
  eventName: string;
};

export function decodeEvent(parsed: ParsedFrame): WhoopEvent {
  return {
    event: parsed.cmd,
    eventName: eventName(parsed.cmd),
  };
}
