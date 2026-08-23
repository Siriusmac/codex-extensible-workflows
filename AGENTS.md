# Repository guidance

## Scope

This repository contains the Codex Extensible Workflows plugin, an independent
adaptation of https://github.com/vekexasia/pi-extensible-workflows. Preserve
clear upstream attribution. Keep Pi-specific concepts at the compatibility
boundary and implement Codex execution through the local MCP server and
`codex exec --json`.

## Validation

- Use Node.js 22.19 or newer.
- Run `npm test` before handing off changes.
- Validate every edited `SKILL.md`.
- Validate `.codex-plugin/plugin.json` before publishing a plugin build.
- Keep README, NOTICE, CHANGELOG, and HANDOFF documentation in English.

## Safety

- Preserve persisted-run compatibility when changing operation keys or state.
- Keep progress reporting opt-in; background execution alone is not consent.
- Keep quiet waits below the MCP host timeout.
- Do not commit generated workflow runs, local marketplace archives, secrets,
  or machine-specific configuration.
- Do not commit, push, publish, or deploy without explicit user authorization.
