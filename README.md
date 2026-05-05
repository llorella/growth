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

## Local Dogfood

Run the low-cost fixture loop without external providers:

```sh
npm run dogfood:local
```

The harness copies small apps from `examples/fixtures/`, drives the CLI from inspection through experiment spec, instrumentation verification, preflight pull, and audit, then writes evidence under `outerloop/runs/local-dogfood-*`.
