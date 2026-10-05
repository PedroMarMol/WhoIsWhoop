/**
 * HISTORICAL / NOT USED — standard Bluetooth SIG Heart Rate Service (0x180D).
 *
 * This was our first attempt at live heart rate. We subscribed to the Heart
 * Rate Measurement characteristic (0x2A37), but the WHOOP 4.0 never emitted a
 * single notification on it (verified with both bluetoothctl and node-ble).
 *
 * The WHOOP exposes 0x180D/0x2A37 in its GATT tree, but that standard profile
 * is silent; real live heart rate has to come from the vendor service instead
 * (see `whoop-client.ts` / `decoders.ts`). Keep this file as a documented,
 * tested-and-failed reference — it is no longer imported by the program.
 *
 * (The format below is correct per the Bluetooth SIG HRS spec, in case the
 * strap ever starts broadcasting standard HR.)
 *
 * Heart Rate Measurement value layout (Bluetooth SIG HRS / CSS v1.1):
 *
 *   byte 0: flags
 *     bit 0 (0x01): Heart Rate Value Format  0 = uint8, 1 = uint16 (LE)
 *     bits 1-2 (0x06): Sensor Contact Status
 *       00 = feature not supported, 10 = supported + not detected,
 *       11 = supported + detected, 01 = reserved
 *     bit 3 (0x08): Energy Expended present (uint16 LE, kilojoules)
 *     bit 4 (0x10): RR-Interval present (one or more uint16 LE)
 *   then: heart rate value (1 or 2 bytes)
 *   then (optional): energy expended (2 bytes)
 *   then (optional): RR-intervals, 2 bytes each, 1/1024 s per unit
 *
 * We subscribe to notifications: the strap pushes a new measurement roughly
 * once per second while it is worn, without us polling. node-ble exposes this
 * as the `valuechanged` event on the characteristic.
 */
import nodeBle from "node-ble";
import {
  HEART_RATE_MEASUREMENT_UUID,
  HEART_RATE_SERVICE_UUID,
  normalizeUuid,
} from "./whoop-ids.js";

type GattServer = nodeBle.GattServer;

export type SensorContact = "unsupported" | "not detected" | "detected";

export type HeartRateMeasurement = {
  heartRate: number;
  sensorContact: SensorContact;
  energyExpendedKJ?: number;
  rrIntervalsMs?: number[];
};

function findUuid(uuids: string[], expected: string): string | undefined {
  const wanted = normalizeUuid(expected);
  return uuids.find((uuid) => normalizeUuid(uuid) === wanted);
}

export function parseHeartRateMeasurement(
  value: Buffer,
): HeartRateMeasurement | undefined {
  if (value.length < 2) {
    return undefined;
  }

  const flags = value[0];
  let offset = 1;

  let heartRate: number;
  if ((flags & 0x01) !== 0) {
    if (value.length < offset + 2) {
      return undefined;
    }
    heartRate = value.readUInt16LE(offset);
    offset += 2;
  } else {
    heartRate = value.readUInt8(offset);
    offset += 1;
  }

  const contactBits = (flags >> 1) & 0x03;
  let sensorContact: SensorContact;
  if (contactBits === 3) {
    sensorContact = "detected";
  } else if (contactBits === 2) {
    sensorContact = "not detected";
  } else {
    sensorContact = "unsupported";
  }

  const measurement: HeartRateMeasurement = { heartRate, sensorContact };

  if ((flags & 0x08) !== 0 && value.length >= offset + 2) {
    measurement.energyExpendedKJ = value.readUInt16LE(offset);
    offset += 2;
  }

  if ((flags & 0x10) !== 0) {
    const rrIntervalsMs: number[] = [];
    while (value.length >= offset + 2) {
      const rrRaw = value.readUInt16LE(offset);
      offset += 2;
      rrIntervalsMs.push((rrRaw / 1024) * 1000);
    }
    if (rrIntervalsMs.length > 0) {
      measurement.rrIntervalsMs = rrIntervalsMs;
    }
  }

  return measurement;
}

/**
 * Locate the Heart Rate Measurement characteristic and enable notifications.
 * Returns a teardown function that stops notifications and removes the
 * listener, so callers keep this lifecycle in one place.
 */
export async function subscribeHeartRate(
  gatt: GattServer,
  onMeasurement: (m: HeartRateMeasurement) => void,
): Promise<() => Promise<void>> {
  const serviceUuid = findUuid(await gatt.services(), HEART_RATE_SERVICE_UUID);
  if (serviceUuid === undefined) {
    throw new Error("Heart Rate Service (0x180D) is not present on this device.");
  }

  const service = await gatt.getPrimaryService(serviceUuid);
  const charUuid = findUuid(
    await service.characteristics(),
    HEART_RATE_MEASUREMENT_UUID,
  );
  if (charUuid === undefined) {
    throw new Error(
      "Heart Rate Measurement (0x2A37) is not present on this device.",
    );
  }

  const characteristic = await service.getCharacteristic(charUuid);

  const listener = (buffer: Buffer) => {
    const measurement = parseHeartRateMeasurement(buffer);
    if (measurement !== undefined) {
      onMeasurement(measurement);
    }
  };

  characteristic.on("valuechanged", listener);
  await characteristic.startNotifications();

  return async () => {
    await characteristic.stopNotifications();
    characteristic.removeListener("valuechanged", listener);
  };
}
