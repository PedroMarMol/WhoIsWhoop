# WhoIsWhoop

Reverse engineering of the WHOOP 4.0 BLE protocol.

This project explores direct Bluetooth Low Energy communication with a WHOOP 4.0 device without relying on the official WHOOP API or membership.

## Current status

The project can currently:

* Connect to a WHOOP 4.0 over BLE.
* Discover and subscribe to proprietary WHOOP characteristics.
* Build, parse, and reassemble WHOOP protocol frames.
* Send proprietary commands and decode command responses.
* Read battery information.
* Enable realtime heart-rate streaming.
* Decode realtime heart rate and RR intervals.
* Request and acknowledge historical data transfers.
* Decode historical transfer metadata, events, and firmware console logs.
* Document verified protocol behavior and experimental findings.

## Historical data

Historical data transfer has been successfully triggered and acknowledged.

However, on the currently tested device and firmware, the transfer produces event and console-log records but no biometric `HISTORICAL_DATA` (type 47) records.

The device also reports a stale RTC/data range, and attempts to update the clock using the documented `SET_CLOCK` command are rejected by the tested firmware.

This is currently an open research problem.

## Approach

The project follows an evidence-driven reverse-engineering approach:

* Verified behavior is documented separately from hypotheses.
* Protocol details are only added when supported by captured traffic, source evidence, or reproducible experiments.
* Experiments are kept isolated to minimize assumptions.
* Device-specific identifiers and secrets are not included in the repository.

## Project structure

```text
src/
  commands.ts       Known command definitions
  decoders.ts       Protocol response/data decoders
  framing.ts        Frame construction, CRCs, and reassembly
  heart-rate.ts     Realtime heart-rate decoding
  whoop-client.ts   BLE transport and session handling
  whoop-ids.ts      WHOOP BLE UUIDs

test/
  framing.test.ts
  decoders.test.ts

docs/
  PROTOCOL.md       Detailed protocol findings
  STATUS.md         Current research status
```

## Requirements

* Node.js
* TypeScript
* Linux with Bluetooth LE support
* A WHOOP 4.0 device

## Disclaimer

This is an independent reverse-engineering project and is not affiliated with or endorsed by WHOOP.

Protocol behavior may vary between devices and firmware versions.

## License

Not yet specified.
