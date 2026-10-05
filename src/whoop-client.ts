/**
 * BLE transport + session layer for the WHOOP 4.0.
 *
 * This is the only file (besides `main.ts`) that touches node-ble. It owns the
 * custom-service characteristics, the rolling command sequence, and the
 * notification listeners, and it routes parsed frames to the right decoder.
 *
 * Layering:
 *   whoop-client.ts (transport/session)  →  framing.ts + decoders.ts (pure)
 *   framing.ts (CRC, frame build/parse)  →  nothing
 *   decoders.ts (frame → domain objects) →  framing.ts + commands.ts
 */
import nodeBle from "node-ble";
import { WHOOP_COMMAND, toggleRealtimeHrPayload } from "./commands.js";
import {
  decodeCommandResponse,
  decodeEvent,
  decodeRealtimeData,
  type CommandResponse,
  type RealtimeHeartRateSample,
  type WhoopEvent,
} from "./decoders.js";
import { buildCommandFrame, parseFrame, Reassembler, PACKET_TYPE } from "./framing.js";
import {
  WHOOP4_CMD_NOTIFY_UUID,
  WHOOP4_CMD_WRITE_UUID,
  WHOOP4_CUSTOM_SERVICE_UUID,
  WHOOP4_DATA_NOTIFY_UUID,
  WHOOP4_EVENT_NOTIFY_UUID,
  normalizeUuid,
} from "./whoop-ids.js";

type GattServer = nodeBle.GattServer;
type GattCharacteristic = nodeBle.GattCharacteristic;

function findUuid(uuids: string[], expected: string): string | undefined {
  const wanted = normalizeUuid(expected);
  return uuids.find((uuid) => normalizeUuid(uuid) === wanted);
}

export type { CommandResponse, RealtimeHeartRateSample, WhoopEvent };

/**
 * An open session with the WHOOP custom service. Create it with
 * `WhoopSession.open(gatt)` (the device must already be connected), use it to
 * send commands and observe responses/events/heart-rate, then call `close()`.
 */
export class WhoopSession {
  private seq = 0;

  private readonly commandResponseCallbacks: Array<(r: CommandResponse) => void> = [];
  private readonly eventCallbacks: Array<(e: WhoopEvent) => void> = [];
  private readonly realtimeCallbacks: Array<(s: RealtimeHeartRateSample) => void> = [];

  // One reassembler per notify channel: notifications arrive MTU-fragmented
  // (especially the data channel), so each stream buffers until whole frames.
  private readonly cmdReassembler = new Reassembler();
  private readonly eventReassembler = new Reassembler();
  private readonly dataReassembler = new Reassembler();

  private constructor(
    private readonly cmdWrite: GattCharacteristic,
    private readonly cmdNotify: GattCharacteristic,
    private readonly eventNotify: GattCharacteristic,
    private readonly dataNotify: GattCharacteristic,
  ) {}

  /** Discover the custom-service characteristics and subscribe to its notifications. */
  static async open(gatt: GattServer): Promise<WhoopSession> {
    const serviceUuid = findUuid(await gatt.services(), WHOOP4_CUSTOM_SERVICE_UUID);
    if (serviceUuid === undefined) {
      throw new Error("WHOOP custom service (61080001) is not present on this device.");
    }
    const service = await gatt.getPrimaryService(serviceUuid);
    const charUuids = await service.characteristics();

    const getChar = async (uuid: string): Promise<GattCharacteristic | undefined> => {
      const found = findUuid(charUuids, uuid);
      return found === undefined ? undefined : service.getCharacteristic(found);
    };

    const cmdWrite = await getChar(WHOOP4_CMD_WRITE_UUID);
    const cmdNotify = await getChar(WHOOP4_CMD_NOTIFY_UUID);
    const eventNotify = await getChar(WHOOP4_EVENT_NOTIFY_UUID);
    const dataNotify = await getChar(WHOOP4_DATA_NOTIFY_UUID);
    if (!cmdWrite || !cmdNotify || !eventNotify || !dataNotify) {
      throw new Error("WHOOP custom characteristics are incomplete on this device.");
    }

    const session = new WhoopSession(cmdWrite, cmdNotify, eventNotify, dataNotify);
    await session.subscribe();
    return session;
  }

  private async subscribe(): Promise<void> {
    this.cmdNotify.on("valuechanged", this.onCmdNotify);
    this.eventNotify.on("valuechanged", this.onEventNotify);
    this.dataNotify.on("valuechanged", this.onDataNotify);

    await this.cmdNotify.startNotifications();
    await this.eventNotify.startNotifications();
    await this.dataNotify.startNotifications();
  }

  private readonly onCmdNotify = (buffer: Buffer): void => {
    for (const frame of this.cmdReassembler.feed(buffer)) {
      const parsed = parseFrame(frame);
      if (!parsed.ok || parsed.type !== PACKET_TYPE.COMMAND_RESPONSE) {
        continue;
      }
      const response = decodeCommandResponse(parsed);
      for (const cb of this.commandResponseCallbacks) {
        cb(response);
      }
    }
  };

  private readonly onEventNotify = (buffer: Buffer): void => {
    for (const frame of this.eventReassembler.feed(buffer)) {
      const parsed = parseFrame(frame);
      if (!parsed.ok || parsed.type !== PACKET_TYPE.EVENT) {
        continue;
      }
      const event = decodeEvent(parsed);
      for (const cb of this.eventCallbacks) {
        cb(event);
      }
    }
  };

  private readonly onDataNotify = (buffer: Buffer): void => {
    for (const frame of this.dataReassembler.feed(buffer)) {
      const parsed = parseFrame(frame);
      if (!parsed.ok || parsed.type !== PACKET_TYPE.REALTIME_DATA) {
        continue;
      }
      const sample = decodeRealtimeData(parsed.raw);
      if (sample !== undefined) {
        for (const cb of this.realtimeCallbacks) {
          cb(sample);
        }
      }
    }
  };

  /** Send a command frame to the strap (write-with-response). */
  sendCommand(cmd: number, payload: number[] = [0x00]): Promise<void> {
    this.seq = (this.seq + 1) & 0xff;
    return this.cmdWrite.writeValue(buildCommandFrame(cmd, this.seq, payload), {
      type: "request",
    });
  }

  /** Enable the realtime heart-rate stream (REALTIME_DATA, type 40). */
  startRealtimeHr(): Promise<void> {
    return this.sendCommand(WHOOP_COMMAND.TOGGLE_REALTIME_HR, toggleRealtimeHrPayload(true));
  }

  /** Disable the realtime heart-rate stream. */
  stopRealtimeHr(): Promise<void> {
    return this.sendCommand(WHOOP_COMMAND.TOGGLE_REALTIME_HR, toggleRealtimeHrPayload(false));
  }

  /**
   * Ask for the strap's clock (GET_CLOCK, empty payload).
   *
   * NOTE: on our firmware the strap does NOT answer this command — we observed
   * no COMMAND_RESPONSE (NOOP: "the strap rarely serves GET_CLOCK on this
   * firmware"). The device clock is instead observable via the `deviceTimestamp`
   * field on realtime samples (u32 LE seconds, strap's own monotonic epoch).
   */
  getClock(): Promise<void> {
    return this.sendCommand(WHOOP_COMMAND.GET_CLOCK, []);
  }

  /** Register a callback for COMMAND_RESPONSE frames. */
  onCommandResponse(cb: (r: CommandResponse) => void): void {
    this.commandResponseCallbacks.push(cb);
  }

  /** Register a callback for EVENT frames. */
  onEvent(cb: (e: WhoopEvent) => void): void {
    this.eventCallbacks.push(cb);
  }

  /** Register a callback for decoded realtime heart-rate samples. */
  onRealtimeData(cb: (s: RealtimeHeartRateSample) => void): void {
    this.realtimeCallbacks.push(cb);
  }

  /** Stop notifications and detach listeners. The BLE link is left up. */
  async close(): Promise<void> {
    this.cmdNotify.removeListener("valuechanged", this.onCmdNotify);
    this.eventNotify.removeListener("valuechanged", this.onEventNotify);
    this.dataNotify.removeListener("valuechanged", this.onDataNotify);
    try {
      await this.cmdNotify.stopNotifications();
      await this.eventNotify.stopNotifications();
      await this.dataNotify.stopNotifications();
    } catch {
      // Link may already be gone.
    }
  }
}
