# Project Guidelines

## Goal

Build a TypeScript implementation for communicating with a WHOOP 4.0
over Bluetooth Low Energy, without relying on a WHOOP membership or
the official WHOOP API.

The project is also a learning project. The developer is learning
software development, TypeScript, BLE and reverse engineering.

## Important rules

- Do not implement large features without explaining the approach first.
- Prefer simple, understandable code over clever abstractions.
- Explain unfamiliar concepts when they appear.
- Do not hide important logic behind libraries without explaining what
  the library is doing.
- Do not add dependencies unless they are actually necessary.
- When modifying existing code, explain what changed and why.
- If there are multiple reasonable approaches, explain the trade-offs
  before choosing one.
- Never invent undocumented WHOOP protocol details.
- Use the NOOP project and its documentation as a reference when
  investigating the WHOOP 4.0 protocol.
- Clearly distinguish between documented facts, assumptions and
  reverse-engineered findings.

## Learning style

The developer wants to understand the underlying concepts rather than
just obtain working code.

When introducing something new, explain:
1. What it is.
2. Why we need it.
3. How it works at a high level.
4. Then show the implementation.

Avoid unnecessary theory unrelated to the current task.