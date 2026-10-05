# Project status — reproducible checkpoint

_Last updated: 2026-10-04. This is a checkpoint summary; the byte-level protocol
details live in `docs/PROTOCOL.md`. Tags: `[verified]` (our own captures/code),
`[source evidence]` (NOOP / my-whoop), `[hypothesis]` (unconfirmed)._

## 1. What is verified and working

**[verified]**

- BLE connection (Fedora/BlueZ + `node-ble`), bonding, GATT discovery.
- WHOOP 4.0 frame format: `[0xAA][len u16 LE][crc8(len)][type][seq][cmd][payload][crc32 LE]`.
- CRC-8 (poly 0x07) and CRC-32 (zlib) — validated against the strap and fixtures.
- Command/response on `61080002`/`61080003` (`GET_BATTERY_LEVEL`, `TOGGLE_REALTIME_HR`,
  `GET_HELLO_HARVARD`, `SEND_HISTORICAL_DATA`, `HISTORICAL_DATA_RESULT`, `REBOOT_STRAP`).
- Events on `61080004` (battery, `BLE_REALTIME_HR_ON/OFF` 33/34, `ERROR` 1, …).
- **Realtime heart rate** via `TOGGLE_REALTIME_HR` (3) → `REALTIME_DATA` (type 40):
  HR at byte 12, R-R intervals (already ms) from byte 14. Works live (~1 Hz).
- **Historical offload + ACK**: `SEND_HISTORICAL_DATA`(22,`[0x00]`) → `HISTORY_START` →
  frames → `HISTORY_END` → ack `HISTORICAL_DATA_RESULT`(23,`[0x01]+end_data[8]`) →
  trim cursor advances. End-to-end working.

## 2. What we achieved

BLE connection · command responses · events · realtime HR/RR · historical offload
+ ACK. All the transport/protocol layers are in place (`src/framing.ts`,
`src/commands.ts`, `src/decoders.ts`, `src/whoop-client.ts`) and covered by 20
passing tests built from real captured frames.

## 3. What we tried to get `type 47`, and the result

| Attempt | Result |
|---|---|
| plain `SEND_HISTORICAL_DATA` + ACK | 0 type 47 — only EVENT + CONSOLE_LOGS |
| `ENTER_HIGH_FREQ_SYNC`(96) + offload | `EVENT 97`, still 0 type 47 |
| `GET_HELLO_HARVARD`(35) + offload | still 0 type 47 |
| wear 30–60 min, then offload | still 0 type 47 (more events/logs, no biometric) |
| console-log inspection | `MFLT enabled : 0`, `Phone connected: 0`, `MFLT_DATA_SEND_SIG retry… 0 total chunks sent` |
| static research (my-whoop) | "frozen/lost RTC suppresses biometric logging" → fix is `SET_CLOCK` + `REBOOT` |
| `SET_CLOCK`(10, 8-byte) | **rejected** — `EVENT 1` (`ERROR`), no `COMMAND_RESPONSE` |
| `REBOOT_STRAP`(29) + re-verify | acked, but RTC unchanged (no `SET_RTC` 16) |

## 4. Current RTC block and evidence

**[verified]** The RTC is frozen at `newest_unix ≈ 2025-12-02` (from
`GET_DATA_RANGE`). `SET_CLOCK` (correct 8-byte payload) and `GET_CLOCK` (empty) are
both rejected with the same `EVENT 1` (`ERROR`) and a fixed payload
`01 00 05 02 0e 00 00 00 00 00 00 00`. No `SET_RTC`(16) event. Firmware is Harvard
`41.17.6.0` (my-whoop's was `41.16.6.0`). See `docs/PROTOCOL.md` §9.

## 5. Hypotheses discarded

- Not a `node-ble`/BlueZ problem (confirmed independently with `bluetoothctl`).
- Not an empty-store-only problem (still 0 type 47 after a wear period).
- `SET_FF_VALUE`/feature flags do **not** gate basic biometric logging
  (`enable_write_r24_packets` tunes research/raw products) — **[source evidence]**.
- `ENTER_HIGH_FREQ_SYNC` and `GET_HELLO_HARVARD` are **not** required for offload.
- The standard HR profile `0x2A37` emits nothing on this strap.

## 6. Still `[hypothesis]`

- The `SET_CLOCK` rejection is caused by the newer Harvard `41.17.6.0` firmware
  **or** by this unit's specific frozen/faulted RTC state — we cannot tell which.
- The `u32 = 0x0e` (14) inside `EVENT 1` is an error code — unconfirmed, no decode exists.
- `MFLT` (from console logs) is the strap's biometric-data transfer mechanism — unconfirmed.

## 7. Most important open problem

**Unlock the RTC (or otherwise make the strap write `HISTORICAL_DATA` type 47).**
There is currently no evidence-backed way to set the clock over BLE on this unit.
Until the strap starts writing type-47 records, we cannot decode real historical
biometric data — that is the next milestone.
