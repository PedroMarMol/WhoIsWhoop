/**
 * Identifiers we use to recognize a WHOOP 4.0.
 *
 * Documented by the NOOP project (community reverse-engineering):
 * the strap exposes a vendor GATT service with this UUID.
 * https://github.com/muftiarfan/noop/blob/main/docs/PROTOCOL.md
 *
 * Assumption: many straps also advertise a local name starting with "WHOOP".
 * BLE privacy can hide the name, so we treat the custom service UUID
 * (seen after connect, in GATT) as the real confirmation.
 */
export const WHOOP4_CUSTOM_SERVICE_UUID =
  "61080001-8d6d-82b8-614a-1c8cb0f8dcc6";

/**
 * The WHOOP 4.0 custom-service characteristics (documented by NOOP):
 *   - 0002: write command frames to the strap.
 *   - 0003: command responses (notify).
 *   - 0004: events (notify) — wrist on/off, battery, "realtime HR on", …
 *   - 0005: data frames (notify) — REALTIME_DATA (type 40) carries heart rate.
 */
export const WHOOP4_CMD_WRITE_UUID = "61080002-8d6d-82b8-614a-1c8cb0f8dcc6";
export const WHOOP4_CMD_NOTIFY_UUID = "61080003-8d6d-82b8-614a-1c8cb0f8dcc6";
export const WHOOP4_EVENT_NOTIFY_UUID = "61080004-8d6d-82b8-614a-1c8cb0f8dcc6";
export const WHOOP4_DATA_NOTIFY_UUID = "61080005-8d6d-82b8-614a-1c8cb0f8dcc6";

export const WHOOP_NAME_PREFIX = "WHOOP";

/**
 * Bluetooth SIG 16-bit UUIDs are expanded to this 128-bit form:
 * 0000XXXX-0000-1000-8000-00805f9b34fb
 *
 * Battery Service (0x180F) and Battery Level (0x2A19) are public SIG
 * assigned numbers, not WHOOP-specific. NOOP notes they work unbonded.
 */
export const BATTERY_SERVICE_UUID = "0000180f-0000-1000-8000-00805f9b34fb";
export const BATTERY_LEVEL_UUID = "00002a19-0000-1000-8000-00805f9b34fb";

/**
 * Heart Rate Service (HRS) and Heart Rate Measurement are Bluetooth SIG
 * assigned numbers, the same public BLE feature every fitness band exposes.
 * They are independent of the custom WHOOP service: we read live heart rate
 * here without touching the WHOOP-specific framing or CRC at all.
 */
export const HEART_RATE_SERVICE_UUID = "0000180d-0000-1000-8000-00805f9b34fb";
export const HEART_RATE_MEASUREMENT_UUID = "00002a37-0000-1000-8000-00805f9b34fb";

/** Standard Bluetooth SIG services we expect alongside the custom one. */
export const STANDARD_SERVICE_NAMES: Record<string, string> = {
  [HEART_RATE_SERVICE_UUID]: "Heart Rate",
  [BATTERY_SERVICE_UUID]: "Battery",
  "0000180a-0000-1000-8000-00805f9b34fb": "Device Information",
};

/** Custom WHOOP 4.0 characteristics documented by NOOP. */
export const WHOOP4_CHARACTERISTIC_NAMES: Record<string, string> = {
  [WHOOP4_CMD_WRITE_UUID]: "Command write",
  [WHOOP4_CMD_NOTIFY_UUID]: "Command-response notify",
  [WHOOP4_EVENT_NOTIFY_UUID]: "Event notify",
  [WHOOP4_DATA_NOTIFY_UUID]: "Data notify",
};

export function normalizeUuid(uuid: string): string {
  return uuid.toLowerCase();
}

export function describeService(uuid: string): string {
  const key = normalizeUuid(uuid);
  if (key === WHOOP4_CUSTOM_SERVICE_UUID) {
    return "WHOOP 4.0 custom service";
  }
  return STANDARD_SERVICE_NAMES[key] ?? "unknown service";
}

export function describeCharacteristic(uuid: string): string {
  const key = normalizeUuid(uuid);
  if (key === BATTERY_LEVEL_UUID) {
    return "Battery Level";
  }
  if (key === HEART_RATE_MEASUREMENT_UUID) {
    return "Heart Rate Measurement";
  }
  return WHOOP4_CHARACTERISTIC_NAMES[key] ?? "characteristic";
}

export function looksLikeWhoopName(name: string | undefined): boolean {
  if (!name) {
    return false;
  }
  return name.toUpperCase().startsWith(WHOOP_NAME_PREFIX);
}
