/**
 * WHOOP 4.0 command numbers and the few payload builders we have verified.
 *
 * A command is the byte at frame offset 6 inside a COMMAND (type 35) frame.
 * The numbers here are documented by NOOP (`Commands.swift` / `whoop_protocol.json`)
 * and were exercised against the strap in this project.
 *
 * We intentionally keep this list tiny: only commands whose behaviour we have
 * actually confirmed. Adding a name for a command does NOT mean we understand
 * its payload or response — do not add unverified commands here.
 */
export const WHOOP_COMMAND = {
  /** Ask the strap to start/stop the realtime heart-rate stream (type 40). */
  TOGGLE_REALTIME_HR: 3,
  /**
   * Ask for the strap's current clock. NOOP sends this with an EMPTY payload.
   * On our firmware the strap does NOT answer (NOOP: "rarely serves GET_CLOCK").
   */
  GET_CLOCK: 11,
  /** Ask for the battery level (returns a COMMAND_RESPONSE). */
  GET_BATTERY_LEVEL: 26,
} as const;

/** Names for the command numbers we know, used to label responses. */
export const COMMAND_NAMES: Record<number, string> = {
  [WHOOP_COMMAND.TOGGLE_REALTIME_HR]: "TOGGLE_REALTIME_HR",
  [WHOOP_COMMAND.GET_CLOCK]: "GET_CLOCK",
  [WHOOP_COMMAND.GET_BATTERY_LEVEL]: "GET_BATTERY_LEVEL",
};

export function commandName(cmd: number): string {
  return COMMAND_NAMES[cmd] ?? `CMD_${cmd}`;
}

/** TOGGLE_REALTIME_HR payload: [0x01] on, [0x00] off (NOOP `toggleRealtimeHR`). */
export function toggleRealtimeHrPayload(on: boolean): number[] {
  return [on ? 0x01 : 0x00];
}
