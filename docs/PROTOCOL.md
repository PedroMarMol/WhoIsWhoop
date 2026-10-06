# WHOOP 4.0 BLE protocol (confirmed subset)

This documents what we have **actually verified** against a WHOOP 4.0
(device identifiers redacted) from Fedora, using
`node-ble` + BlueZ. Anything not verified is explicitly marked.

The reference implementation is the NOOP project:
`https://github.com/muftiarfan/noop` (`docs/PROTOCOL.md`, `docs/BLE_REVERSE_ENGINEERING.md`,
`Packages/WhoopProtocol/…`, `Strand/BLE/BLEManager.swift`).

Every fact below is tagged:

- **[verified]** — we produced it ourselves with real captures / working code.
- **[NOOP]** — stated by the NOOP source/docs, not re-verified here.
- **[hypothesis]** — an observation we cannot yet fully explain.

---

## 1. Connection

BLE LE-only link to the strap (advertises name `WHOOP …`). Bonding is not
required for the pieces below **[verified]**; we got responses with `Bonded: yes`
and the characteristics advertise no `encrypt-*` permissions **[verified]**.

`[NOOP]` On Apple platforms one "write-with-response" command (`GET_BATTERY_LEVEL`)
triggers just-works bonding. On BlueZ we paired manually once; it is not clear
this pairing was actually needed for the command channel.

## 2. GATT layout

Custom service `61080001-8d6d-82b8-614a-1c8cb0f8dcc6` **[verified]**:

| Characteristic | Role | Properties |
|---|---|---|
| `61080002` | command write (client → strap) | write, write-without-response |
| `61080003` | command responses (notify) | notify |
| `61080004` | events (notify) | notify |
| `61080005` | data (notify, fragmented) | notify |
| `61080007` | console/version logs (notify) | notify |

`61080007` is **not** in NOOP's WHOOP-4.0 list. It streams a separate
non-`0xAA` (protobuf-like) format containing firmware version strings
(`hboylston h17.2.2.0 kharvard_r06`, `gharvard i41.17.6.0`, …) **[verified]**.
We do not decode it.

Standard services also exist: `180D/2A37` (Heart Rate), `180F/2A19` (Battery).
The standard Heart Rate characteristic emits **nothing** on this strap
**[verified]**; the standard Battery reports `100%` while the custom
`GET_BATTERY_LEVEL` reports ~`26%` **[verified, discrepancy unexplained]**.

## 3. Frame format (0xAA framing)

Every message on the custom service is one frame **[verified] [NOOP]**:

```
┌──────┬───────────┬──────┬──────┬──────┬──────┬───────────┬────────────┐
│ 0xAA │ len u16 LE │ crc8 │ type │ seq  │ cmd  │ payload…  │ crc32 LE   │
│ [0]  │ [1..3]     │ [3]  │ [4]  │ [5]  │ [6]  │ [7..len]  │ [len..+4]  │
└──────┴───────────┴──────┴──────┴──────┴──────┴───────────┴────────────┘
```

- `len` = number of bytes from `type` (offset 4) through the end of the payload,
  **plus 4**. Total frame length = `len + 4`.
- `crc8` (poly `0x07`, init `0x00`) over **only the two length bytes**.
- `crc32` = standard zlib CRC-32 over `[type][seq][cmd][payload…]`.

### Reassembly / fragmentation

Notifications arrive in MTU-sized fragments **[verified]**. The reassembler
buffers bytes, finds `0xAA`, reads `len`, and only emits a frame once `len + 4`
bytes are buffered. Our `Reassembler` (in `src/framing.ts`) is a direct port of
NOOP's.

## 4. CRC values

- CRC-8 poly `0x07` (bitwise, init 0) **[verified]**: `crc8([08 00])=a8`,
  `crc8([0c 00])=fc`, `crc8([10 00])=57`, `crc8([18 00])=ff`.
- CRC-32 = zlib (`zlib.crc32`) **[verified]**.

## 5. Command frames (type 35)

`[0xAA][len][crc8][35][seq][cmd][payload…][crc32]`. `cmd` is the command number,
`payload` its arguments **[verified]**.

Commands we have exercised **[verified]**:

| cmd | name | payload | confirmed response |
|---|---|---|---|
| 3 | `TOGGLE_REALTIME_HR` | `[0x01]` on / `[0x00]` off | `COMMAND_RESPONSE` + `EVENT 33/34` + type-40 stream |
| 11 | `GET_CLOCK` | **empty** (`[]`) | none observed on this firmware |
| 26 | `GET_BATTERY_LEVEL` | `[0x00]` | `COMMAND_RESPONSE` |

Example (exact bytes we sent) **[verified]**:

```
GET_BATTERY_LEVEL seq=1        aa0800a823011a00204f2c22
TOGGLE_REALTIME_HR(on) seq=1   aa0800a823010301aed62bce
GET_CLOCK seq=1 (empty)        aa07006b23010b62c9834b
```

## 6. Command responses (type 36)

`[0xAA][len][crc8][36][seq][cmd][payload…][crc32]`, where `cmd` (offset 6) echoes
the command being answered **[verified]**.

Example (exact capture) **[verified]**:

```
GET_BATTERY_LEVEL resp        aa10005724091a0101020100000000001ddf31ac   (seq=9)
TOGGLE_REALTIME_HR resp       aa0c00fc24100301020000009ebc3d6e           (seq=16)
```

`[NOOP]` `GET_BATTERY_LEVEL` payload decodes as `battery_pct = u16@payload[2..4] / 10`.
Our capture gives `259/10 = 25.9%`.

## 7. Event frames (type 48)

`[0xAA][len][crc8][48][seq][event][payload…][crc32]`, event number at offset 6
**[verified]**.

Events we have observed **[verified]**:

| event | name | meaning |
|---|---|---|
| 33 | `BLE_REALTIME_HR_ON` | realtime HR stream enabled |
| 34 | `BLE_REALTIME_HR_OFF` | realtime HR stream disabled |

Example capture **[verified]**: `aa100057308e21007acbe10180280000c1800122` (event 33).

`[NOOP]` the full `EventNumber` enum is in NOOP's `whoop_protocol.json`.

## 8. Realtime data (type 40)

`[0xAA][len][crc8][40][seq][payload…][crc32]`, with the payload laid out as
**[verified] [NOOP]**:

| offset | field | type |
|---|---|---|
| 6 | timestamp | u32 LE (device epoch) |
| 10 | subseconds | u16 LE |
| 12 | **heart_rate** | u8 (bpm) |
| 13 | rr_count | u8 |
| 14… | R-R intervals | rr_count × u16 LE |

**R-R intervals are already in milliseconds** **[verified]** — a capture with
`HR=69` carried `RR=869` (≈ `60000/69`). They are **not** in the standard
`0x2A37` unit of 1/1024 s. (`[NOOP]` PostHooks also stores them as `ms`.)

Example capture (HR=69, one R-R = 846 ms) **[verified]**:

```
aa1800ff2802e3cae101682745014e030000000000000105b3bee130
```

## 9. Device clock (GET_CLOCK / SET_CLOCK)

`GET_CLOCK` (command 11) is sent with an **empty** payload **[NOOP] [verified — our
frame]**:

```
GET_CLOCK seq=1 (empty)   aa07006b23010b62c9834b
```

**Result on our firmware: no `COMMAND_RESPONSE`.** We sent it (with and without a
preceding `SET_CLOCK`) and got no clock value back; instead the strap emitted
`EVENT 1` (`ERROR`) frames **[verified]**. This matches NOOP: *"the strap rarely
serves GET_CLOCK on this firmware"*, which is why NOOP falls back to an identity
clock for live data.

**What the strap's clock actually looks like** (observed from the `timestamp` field
of `REALTIME_DATA` and `EVENT`) **[verified]**:

- `u32` little-endian, **seconds** (increments by ~1 per sample).
- A **device monotonic epoch**, not Unix time. On our unit it reads
  ~`31,574,000` seconds (~365 days), while the system Unix clock reads
  ~`1,791,000,000` (Oct 2026). Ratio ≈ 0.018.

So the device clock is *not* Unix epoch and *not* milliseconds; it is seconds from
the strap's own epoch. Converting it to wall-clock Unix time requires a
(device, wall) reference pair — normally obtained from `GET_CLOCK` + local time,
which does not work on this unit.

### SET_CLOCK is rejected on this unit (known limitation)

`SET_CLOCK` (10) is sent with the documented **8-byte** payload
`[unix_seconds u32 LE][subseconds u32 LE]` (subseconds = 0) **[source evidence:
NOOP `setClockPayload` + my-whoop debug-handoff §4.4]**.

**Result: the strap rejects it.** We sent the correct 8-byte frame and got **no
`COMMAND_RESPONSE`** — instead `EVENT 1` (`ERROR`) **[verified]**. `GET_CLOCK` (11)
produces the *same* `EVENT 1` with an identical fixed payload **[verified]**, so
the rejection is a generic response of the clock/RTC subsystem, not
command-specific.

Observed facts **[verified]**:

- `SET_CLOCK` (correct 8-byte payload) → `EVENT 1` (`ERROR`), no `COMMAND_RESPONSE`.
- `GET_CLOCK` (empty payload) → the same `EVENT 1`.
- No `SET_RTC` (16) event after `SET_CLOCK` (the event my-whoop uses to confirm a
  clock latch).
- `GET_DATA_RANGE` (34) still reports `newest_unix ≈ 2025-12-02` — the RTC is
  frozen ~10 months in the past, unchanged after `SET_CLOCK` + `REBOOT_STRAP`.
- The `EVENT 1` payload carries a fixed 12-byte block
  `01 00 05 02 0e 00 00 00 00 00 00 00` containing a `u32 = 0x0e` (14). We do
  **not** know whether that is an error code: no decode of this payload exists in
  NOOP or my-whoop **[verified payload] [source evidence: no decode found]**.

Firmware difference **[verified]**:

- Ours: Harvard `41.17.6.0`, Boylston `17.2.2.0`.
- my-whoop's (where `SET_CLOCK` was accepted, though marked "partial"/flaky):
  Harvard `41.16.6.0`, Boylston `17.2.2.0`.

Conclusion **[hypothesis]**:

- We cannot determine whether the rejection is due to the newer Harvard
  `41.17.6.0` firmware or to the specific frozen/faulted RTC state of this unit.
  `SET_CLOCK` was already "partial" on `41.16.6.0`, so there is no fully reliable
  reference to compare against.
- There is currently **no evidence-backed way to unlock the RTC over BLE** on this
  unit.

## 10. Sequence counters

- **Client → strap**: we maintain a rolling `seq` (increment per command,
  wrapping at 255) **[verified]**.
- **Strap → client (COMMAND_RESPONSE)**: the strap uses its own counter that
  advances per command processed; observed `6,7,8,9,…` then `16,17` across
  sessions **[verified]**. We correlate responses on `cmd`, not `seq`.
- **EVENT**: another rolling counter (observed `142,143`) **[verified]**.
- **REALTIME_DATA**: observed **constant `seq=2`** **[hypothesis]** — likely a
  stream identifier, not a rolling counter.

## 11. What we deliberately have NOT implemented

The raw stream (type 43), the connect handshake
(`GET_HELLO_HARVARD`/`SET_CLOCK`/`GET_DATA_RANGE`), and any other commands.
`[NOOP]` documents them; we have not exercised them.

A conservative **offline** decoder for type-47 V24 records (`src/historical.ts`,
§12) and a minimal **historical offload state machine**
(`WhoopSession.downloadHistoricalData()`, §13) now exist.

## 12. HISTORICAL_DATA (type 47) — conservative V24 decoder

Implemented in `src/historical.ts` (`decodeHistoricalDataV24`). Pure and offline:
it decodes records that were already captured and does **not** talk to the strap.

Confidence tags below: **[verified]**, **[strongly supported]**, **[unknown]**.

Evidence base: `captures/type47_raw_hex.txt` — **2877 V24 records** (exactly 104
bytes) and **120 V25 records** (84 bytes), all passing zlib CRC-32. Fields are
frame-absolute offsets.

### 12.1 V24 layout (104-byte record)

| offset | len | field | confidence | evidence |
|---|---|---|---|---|
| 0 | 1 | SOF `0xAA` | **[verified]** | every frame |
| 1–2 | 2 | frame length (`= 100`) | **[verified]** | u16 LE; total = len + 4 |
| 3 | 1 | CRC-8 over the two length bytes | **[verified]** | all 2877 |
| 4 | 1 | packet type `47` | **[verified]** | all 2877 |
| 5 | 1 | version `24` | **[verified]** | all 2877 |
| 6 | 1 | marker `0x05` | **[verified]** | constant |
| 7–10 | 4 | sequence | **[verified]** | u32 LE; strictly +1, no gaps |
| 11–14 | 4 | Unix seconds | **[verified]** | u32 LE; +1/s (111 duplicate seconds) |
| 15–16 | 2 | sub-second timing | **[strongly supported]** | u16 LE; splits same-second pairs; encoding not established |
| 17–20 | 4 | unknown header | **[unknown]** | exposed raw as `header17_20` |
| 21 | 1 | heart rate (bpm) | **[verified]** | 58–124 in capture |
| 22 | 1 | rr_count | **[verified]** | 0–4 in capture |
| 23–30 | 8 | RR intervals (ms) | **[verified]** | up to 4 × u16 LE; first `rr_count` valid; ≈ `60000/HR` |
| 31–39 | 9 | unknown | **[unknown]** | exposed raw as `bytes31_39` |
| 40–51 | 12 | gravity/accelerometer vector | **[strongly supported]** | 3 × f32 LE; \|g\| median 1.011, range 0.52–1.22 |
| 52–55 | 4 | unknown | **[unknown]** | exposed raw as `bytes52_55` |
| 55 | — | *see 52–55* | **[unknown]** | NOOP calls this `skin_contact`; **not accepted** (see 12.2) |
| 56–67 | 12 | duplicate of the gravity/accelerometer vector | **[verified]** | byte-identical to 40–51 in all 2877 records |
| 68–79 | 12 | six unknown u16 | **[unknown]** | exposed raw as `uint16_68_79` (NOOP labels them SpO2/temp/ambient/LED — unproven) |
| 80–83 | 4 | unknown | **[unknown]** | exposed raw as `bytes80_83`; constant `0x0C01` / `0x0C02` |
| 84–99 | 16 | unknown tail | **[unknown]** | exposed raw as `tail84_99` |
| 100–103 | 4 | CRC-32 (zlib) over `frame[4..100]` | **[verified]** | all 2877 |

The decoder intentionally does **not** name or convert offsets 31–39, 52–55,
68–79, 80–83, or the tail. Those ranges are preserved verbatim in `raw`.

### 12.2 NOOP interpretations explicitly NOT accepted

Our full capture contradicts these NOOP `whoop_protocol.json` V24 labels, so we
do **not** adopt them (they remain `[unknown]` here):

- **offset 55 `skin_contact`** — NOOP documents it as `0 = off-wrist`. In our
  corpus it takes 15 distinct values (`0`, `63–70`, `194–199`, i.e. signed
  `-62…-57 / 0 / +63…+70`) and toggles ~2030 times across 2877 records, with no
  correlation to HR (`r = -0.066`) or `\|g\|` (`r = 0.026`). It is not a
  `0`/non-zero contact flag.
- **offset 80 `resp_rate_raw`** — constant `0x0C01` in every record; a per-sample
  respiratory rate cannot be constant.
- **offset 82 `signal_quality`** — constant `0x0C02` in every record.

NOOP's `unix`@11, `heart_rate`@21, `rr_count`@22, RR@23, `gravity_*`@40/44/48 and
`gravity2_*`@56/60/64 labels **are** confirmed by our data.

### 12.3 Version 25 — observed but intentionally unsupported

The capture also contains **120 records of type 47, version 25, exactly 84
bytes** (header length field `80`, marker `0x00`). They overlap the V24 stream in
time. V25 is **not** a truncated V24: the float32 gravity block is absent, offset
21 is a small value (`1–4`, not HR), and its CRC-32 lives at offsets 80–83 (which
is why bytes 80/82 "vary" there). Its payload layout is not understood.

`decodeHistoricalDataV24` therefore returns an explicit `unsupported-version`
error for V25. No V25 decoder is provided.

## 13. Historical offload lifecycle

Implemented in `WhoopSession.downloadHistoricalData()` (`src/whoop-client.ts`).

Evidence base: `captures/historical_offload_ack_raw_hex.txt` — one complete,
ack-driven offload (2929 frames) captured from our own WHOOP 4.0.

### 13.1 Verified by real WHOOP 4.0 capture

- **`SEND_HISTORICAL_DATA` = command `22`, payload `[0x00]`** — starts the
  historical stream on the data channel `61080005`.
- **`HISTORICAL_DATA_RESULT` = command `23`, payload `[0x01, ...frame[17:25]]`**
  — sent once per chunk end.
- **METADATA frames are packet type `49`.** Three `frame[6]` markers were
  observed:

  | `frame[6]` | total length | role observed |
  |---|---|---|
  | `0x01` | 48 | chunk start; precedes the type-47 records of a chunk |
  | `0x02` | 32 | chunk end; `frame[17:25]` is an 8-byte field wholly inside the payload (CRC-32 begins at offset 28) |
  | `0x03` | 20 | final completion; observed exactly once at the end |

- Acking each `[6]===0x02` frame with command 23 `[0x01, ...frame[17:25]]`
  **advances the strap to the next chunk** (a new `[6]===0x01`, then type-47
  records, then a new `[6]===0x02`).
- The capture completed **55 chunks**; **all 55 ACKs were accepted**, after which
  the strap sent the single `[6]===0x03` frame and stopped.

### 13.2 State machine

`downloadHistoricalData()`:

1. reject if another offload is already in flight;
2. send command `22` with `[0x00]`;
3. for every type-49 frame with `frame[6]===0x02`, send command `23` with
   `[0x01, ...frame[17:25]]`;
4. resolve when a type-49 frame with `frame[6]===0x03` arrives.

Type-47 records are delivered through the existing `onHistoricalData()` callback
while the offload runs. `[6]===0x01` is observed and ignored. No retry,
reconnect, cancellation or persistence is implemented.

### 13.3 Explicitly still unknown / not interpreted

- The meaning of every METADATA field other than the `frame[6]` markers — in
  particular **`frame[17:25]`**: its role as the ACK bytes is verified, its
  semantics are **unknown**.
- The meaning of the `[6]===0x01` payload.
- V25 (type-47 version 25) semantics — still unsupported.

No semantic names are assigned to any of these fields.
