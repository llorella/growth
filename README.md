# growth

Agent-native growth experimentation control plane.

`growth` gives coding agents a deterministic way to create, instrument, preflight,
pull, and analyze product experiments from inside an existing repository. It owns
the experiment contract, local state, connector config, event windows, synthetic
preflight packets, analysis, and audit trail. The outer coding agent still owns
understanding and editing the product code.

## Install From Source

Until `growth` is published as a package, use a local source checkout.

```sh
git clone <repo-url> growth
cd growth
npm ci
npm run build
node dist/index.js --help
```

To use the CLI from another product repo, link the built package globally:

```sh
cd /path/to/growth
npm link

cd /path/to/product-repo
growth --help
growth init --json
growth status --json
```

If you do not want to install a global link, run the compiled CLI directly and
point it at the product repo:

```sh
node /path/to/growth/dist/index.js --root /path/to/product-repo status --json
```

`growth` requires Node.js 18 or newer.

The npm package name is `@qxp/growth`; the installed binary remains `growth`.

## Develop

```sh
npm ci
npm run build
```

During development, run the CLI through `npm run dev --`:

```sh
npm run dev -- --help
npm run dev -- schema experiment --json
npm run dev -- status --json
```

After `npm run build`, the compiled binaries are:

```sh
node dist/index.js --help
node dist/mcp.js
```

The MCP server exposes typed tools such as `growth_preflight_prepare` and
`growth_analyze`. Each tool accepts named JSON arguments instead of a generic
CLI `args` array.

## Demo

Run the local fixture loop without external providers:

```sh
npm run dogfood:local
```

The harness copies the apps in `examples/fixtures/`, drives the CLI from
inspection through experiment creation, instrumentation verification, local
preflight pull, and audit, then writes evidence under
`outerloop/runs/local-dogfood-*`.

## Basic Workflow

In a product repo, initialize growth and inspect the current state:

```sh
growth init --json
growth status --json
growth llm-context --json
```

Create an experiment from a built-in template:

```sh
growth template list --json
growth experiment create onboarding-flow --template onboarding-activation --json
growth experiment show onboarding-flow --json
```

Or create one from an explicit JSON spec:

```sh
growth schema experiment --json
growth experiment create onboarding-flow --from-file experiment.json --json
```

Plan and verify instrumentation before running a preflight:

```sh
growth instrumentation plan onboarding-flow --json
growth instrumentation verify onboarding-flow --json
growth preflight prepare onboarding-flow --agents 4 --browser --json
```

For local JSONL validation, add a local connector and complete the preflight from
app-emitted events:

```sh
growth connector add local --events-file tmp/events.jsonl --json
growth preflight complete-local <run_id> --events-file tmp/events.jsonl --json
growth preflight pull <run_id> --source local --json
growth preflight audit <run_id> --json
```

`ready_for_provider_preflight` means local synthetic traffic passed. It is not a
ship decision. `provider_preflight_passed` means synthetic events were pulled
through a configured provider; real-user launch and measurement still happen via
`growth analyze --segment real-users`.

For provider-backed analysis, configure a connector, pull events, and analyze:

```sh
growth connector add posthog --json
growth connector auth check posthog --json
growth connector validate posthog --json
growth pull onboarding-flow --source posthog --after <iso> --json
growth analyze onboarding-flow --segment real-users --json
```

## Commands

- `init`: create repo-local `.growth/` state and agent guidance
- `status`: inspect configured experiments, connectors, and next steps
- `schema`, `catalog`, `templates`: inspect contracts and defaults
- `experiment`: create and manage experiment configs
- `instrumentation`: plan and verify event instrumentation
- `connectors`, `env`, `pull`: configure sources and import events
- `simulate`, `preflight`: generate and audit synthetic validation traffic
- `analyze`, `power-calc`: evaluate results

## Verify

```sh
npm test
npm run dogfood:local
```
