# Goal Pulse AI Doctor

The first version is a **read-only diagnostic CLI**. It is intentionally kept separate from the live server so a broken server cannot prevent the checks from starting.

## Run it

From the repository root, with Node.js installed:

```sh
npm run doctor
```

To also test the deployed site's HTTP response, set `GOAL_PULSE_HEALTH_URL` to the exact public URL you want checked:

```sh
GOAL_PULSE_HEALTH_URL="https://your-confirmed-goal-pulse-host.example/" npm run doctor
```

Replace the example with the actual deployed URL. The doctor does not guess a host or call an unconfirmed URL.

## What it checks

- `package.json` validity and the start command
- presence of the server entry point and Node syntax
- required dependencies declared in the package
- port configuration
- presence (without revealing values) of common database and PitchAPI environment variables
- optional HTTP response from a configured health URL

Exit code is non-zero when a check fails; warnings are reported separately. Secrets are never printed.

## Safety boundary

This version does **not** restart or deploy the service, edit source files, change environment variables, clear history, or claim that a healthy HTTP response proves live matches and alerts are correct. It is a foundation for later health endpoints, freshness checks, alert/history integrity tests, and notifications diagnostics. Any future repair automation must be allow-listed, logged, and reversible; risky code/configuration changes should require human approval.
