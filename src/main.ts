/**
 * Connect to a WHOOP 4.0, print its GATT tree, read standard battery %, then
 * stream live heart rate over the WHOOP custom protocol.
 *
 * What this program does:
 * 1. Ask BlueZ (Fedora's Bluetooth daemon) to scan for BLE advertisements.
 * 2. Pick a device that looks like a WHOOP 4.0 (name prefix).
 * 3. Connect and list GATT services/characteristics.
 * 4. Read the Bluetooth SIG Battery Level characteristic (0x2A19).
 * 5. Subscribe to the custom channels and enable realtime heart rate
 *    (TOGGLE_REALTIME_HR), then decode and print REALTIME_DATA frames.
 *
 * The standard Heart Rate Service (0x180D / 0x2A37) does NOT emit data on the
 * WHOOP, so live HR comes from the vendor service via WHOOP framing + CRC
 * (see realtime-hr.ts and framing.ts).
 *
 * The BLE library (`node-ble`) is only a D-Bus client for BlueZ. It does not
 * understand WHOOP; our framing layer handles that on top of the transport.
 */
import nodeBle from "node-ble";
import { WhoopSession } from "./whoop-client.js";
import {
  BATTERY_LEVEL_UUID,
  BATTERY_SERVICE_UUID,
  describeCharacteristic,
  describeService,
  looksLikeWhoopName,
  normalizeUuid,
  WHOOP4_CUSTOM_SERVICE_UUID,
} from "./whoop-ids.js";

const { createBluetooth } = nodeBle;
type Adapter = nodeBle.Adapter;
type Device = nodeBle.Device;
type GattServer = nodeBle.GattServer;

const SCAN_MS = Number(process.env.WHOOP_SCAN_MS ?? 12_000);
const HR_MS = Number(process.env.WHOOP_HR_MS ?? 30_000);
const POLL_MS = 500;
const CONNECT_MS = 20_000;

async function optional<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    // BlueZ omits properties the device has not advertised (Name, RSSI, …).
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Sighting = {
  address: string;
  name?: string;
  alias?: string;
  rssi?: number;
};

async function readSighting(device: Device, address: string): Promise<Sighting> {
    const rssiRaw = await optional(() => device.getRSSI());
    const rssi = rssiRaw === undefined ? undefined : Number(rssiRaw);
    return {
      address,
      name: await optional(() => device.getName()),
      alias: await optional(() => device.getAlias()),
      rssi: rssi !== undefined && Number.isFinite(rssi) ? rssi : undefined,
    };
}

function displayName(s: Sighting): string {
  return s.name ?? s.alias ?? "(no name)";
}

function isWhoopCandidate(s: Sighting): boolean {
  return looksLikeWhoopName(s.name) || looksLikeWhoopName(s.alias);
}

async function scan(adapter: Adapter): Promise<Sighting[]> {
  // Discovery = listen for BLE advertisements. node-ble already asks BlueZ
  // for LE-only transport, so we do not mix in classic Bluetooth devices.
  if (!(await adapter.isDiscovering())) {
    await adapter.startDiscovery();
  }

  console.log(`Scanning for ${SCAN_MS / 1000}s…`);
  console.log("Keep the strap close. Disconnect the official WHOOP app first.\n");

  const byAddress = new Map<string, Sighting>();
  const deadline = Date.now() + SCAN_MS;

  while (Date.now() < deadline) {
    for (const address of await adapter.devices()) {
      const device = await adapter.getDevice(address);
      const sighting = await readSighting(device, address);
      byAddress.set(address, sighting);
    }
    await sleep(POLL_MS);
  }

  if (await adapter.isDiscovering()) {
    await adapter.stopDiscovery();
  }

  return [...byAddress.values()];
}

function pickWhoop(sightings: Sighting[]): Sighting | undefined {
  const matches = sightings.filter(isWhoopCandidate);
  if (matches.length === 0) {
    return undefined;
  }

  matches.sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
  return matches[0];
}

async function connectWithTimeout(device: Device): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Connect timed out after ${CONNECT_MS}ms`)),
      CONNECT_MS,
    );
  });

  try {
    await Promise.race([device.connect(), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function findUuid(uuids: string[], expected: string): string | undefined {
  const wanted = normalizeUuid(expected);
  return uuids.find((uuid) => normalizeUuid(uuid) === wanted);
}

async function printGatt(gatt: GattServer): Promise<void> {
  // GATT is the tree of services (folders) and characteristics (values).
  // BlueZ fills this in after connect; node-ble waits for ServicesResolved.
  const serviceUuids = await gatt.services();

  console.log("GATT services:\n");

  let sawWhoopService = false;

  for (const serviceUuid of serviceUuids) {
    if (normalizeUuid(serviceUuid) === WHOOP4_CUSTOM_SERVICE_UUID) {
      sawWhoopService = true;
    }

    console.log(`  ${serviceUuid}  (${describeService(serviceUuid)})`);
    const service = await gatt.getPrimaryService(serviceUuid);
    const charUuids = await service.characteristics();

    for (const charUuid of charUuids) {
      const characteristic = await service.getCharacteristic(charUuid);
      const flags = await optional(() => characteristic.getFlags());
      const flagText = flags && flags.length > 0 ? flags.join(", ") : "no flags";
      console.log(
        `    ${charUuid}  ${describeCharacteristic(charUuid)}  [${flagText}]`,
      );
    }
    console.log("");
  }

  if (sawWhoopService) {
    console.log("Confirmed WHOOP 4.0 custom service after connect.");
  } else {
    console.log(
      "Connected, but the WHOOP 4.0 custom service was not in GATT.",
    );
    console.log(
      "This may be a different WHOOP generation, or the strap is not ready.",
    );
  }
}

/**
 * Battery Level is a standard BLE characteristic: one unsigned byte, 0–100.
 * `readValue` asks BlueZ to issue a GATT Read on that characteristic.
 * We only look at the first byte; we do not parse WHOOP frames.
 */
async function printBattery(gatt: GattServer): Promise<void> {
  const serviceUuid = findUuid(await gatt.services(), BATTERY_SERVICE_UUID);
  if (serviceUuid === undefined) {
    console.log("Battery Service (0x180F) is not present on this device.");
    return;
  }

  const service = await gatt.getPrimaryService(serviceUuid);
  const characteristicUuid = findUuid(
    await service.characteristics(),
    BATTERY_LEVEL_UUID,
  );
  if (characteristicUuid === undefined) {
    console.log("Battery Level (0x2A19) is not present on this device.");
    return;
  }

  const characteristic = await service.getCharacteristic(characteristicUuid);
  const value = await characteristic.readValue();
  if (value.length < 1) {
    console.log("Battery Level read returned an empty value.");
    return;
  }

  const percent = value[0];
  console.log(`Battery: ${percent}%`);
}

/**
 * Enable the WHOOP custom realtime-HR stream for a fixed window and print each
 * decoded sample. This uses the vendor service, WHOOP framing and CRC — not the
 * standard Heart Rate Service (which stays silent on this strap).
 */
async function streamHeartRate(gatt: GattServer, durationMs: number): Promise<void> {
  let count = 0;

  let session: WhoopSession;
  try {
    session = await WhoopSession.open(gatt);
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    return;
  }

  session.onRealtimeData((sample) => {
    count += 1;
    const rr =
      sample.rrIntervalsMs.length > 0
        ? `, RR ${sample.rrIntervalsMs.join(", ")} ms`
        : "";
    console.log(
      `  HR: ${sample.heartRate} bpm${rr}  (device clock ${sample.deviceTimestamp}s)`,
    );
  });
  session.onEvent((event) => {
    console.log(`  event: ${event.eventName}`);
  });

  console.log(
    `Listening for custom-protocol heart rate for ${durationMs / 1000}s…`,
  );
  console.log(`  system unix time: ${Math.floor(Date.now() / 1000)}s`);
  await session.startRealtimeHr();
  await sleep(durationMs);
  await session.stopRealtimeHr();
  await session.close();

  console.log(`Received ${count} heart-rate sample(s).`);
}

function printSightings(sightings: Sighting[]): void {
  if (sightings.length === 0) {
    console.log("No BLE devices reported by BlueZ.");
    return;
  }

  console.log("Devices seen during scan:\n");
  for (const s of sightings) {
    const mark = isWhoopCandidate(s) ? "WHOOP?" : "      ";
    const rssi = s.rssi === undefined ? "n/a" : `${s.rssi} dBm`;
    console.log(`  ${mark}  ${s.address}  rssi=${rssi}  ${displayName(s)}`);
  }
  console.log("");
}

function printPermissionHint(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.error(`
If this is a D-Bus / BlueZ permission error:
  - add your user to the bluetooth group, then log out and back in
      sudo usermod -aG bluetooth "$USER"
  - make sure the adapter is on
      bluetoothctl power on
  - node-ble also documents a D-Bus policy file if group membership is not enough
      https://github.com/chrvadala/node-ble#provide-permissions
`);
}

async function main(): Promise<void> {
  const { bluetooth, destroy } = createBluetooth();
  let device: Device | undefined;

  try {
    const adapter = await bluetooth.defaultAdapter();
    const adapterName = await optional(() => adapter.getName());
    const adapterAddress = await optional(() => adapter.getAddress());
    console.log(
      `Adapter: ${adapterName ?? "unknown"} (${adapterAddress ?? "no address"})`,
    );

    if (!Boolean(await adapter.isPowered())) {
      throw new Error(
        "Bluetooth adapter is powered off. Run: bluetoothctl power on",
      );
    }

    const sightings = await scan(adapter);
    printSightings(sightings);

    const chosen = pickWhoop(sightings);
    if (!chosen) {
      console.error("No WHOOP candidate found (name/alias starting with WHOOP).");
      console.error("Assumption: we identify by advertised name at this step.");
      console.error(
        "If the strap is nearby, it may be using a random address with no name,",
      );
      console.error("or the official app still holds the connection.");
      process.exitCode = 1;
      return;
    }

    console.log(
      `Connecting to ${chosen.address} (${displayName(chosen)})…`,
    );
    device = await adapter.getDevice(chosen.address);
    await connectWithTimeout(device);
    console.log("Connected.\n");

    const gatt = await device.gatt();
    await printGatt(gatt);
    await printBattery(gatt);
    await streamHeartRate(gatt, HR_MS);
  } catch (error) {
    printPermissionHint(error);
    process.exitCode = 1;
  } finally {
    if (device !== undefined) {
      try {
        await device.disconnect();
        console.log("Disconnected.");
      } catch {
        // Already gone.
      }
    }
    destroy();
  }
}

await main();
