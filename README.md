# growth

Agent-native growth experimentation control plane.

## Install

```sh
npm install
npm run build
```

## Use

```sh
npm run dev -- init --json
npm run dev -- status --json
npm run dev -- schema --json
npm run dev -- experiments create --json
```

## Commands

- `init`: create repo-local `.growth/` state and agent guidance
- `status`: inspect configured experiments, connectors, and next steps
- `schema`, `catalog`, `templates`: inspect contracts and defaults
- `experiments`: create and manage experiment configs
- `instrumentation`: plan and verify event instrumentation
- `connectors`, `env`, `pull`: configure sources and import events
- `simulate`, `preflight`: generate synthetic validation traffic
- `analyze`, `power-calc`: evaluate results

## Test

```sh
npm test
```
