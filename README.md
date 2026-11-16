# swamp-holmesgpt

The `@sntxrr/holmesgpt` [swamp](https://swamp-club.com) extension: ask a
[HolmesGPT](https://holmesgpt.dev) SRE agent server to investigate a question
and keep its answer as versioned data.

Source lives in [`extensions/models/`](extensions/models/); its
[README](extensions/models/README.md) covers the methods, arguments and
limits, and is what ships with the extension.

## Install

```bash
swamp extension pull @sntxrr/holmesgpt
```

## Development

```bash
cd extensions/models
deno fmt --check holmesgpt.ts holmesgpt_test.ts
deno lint holmesgpt.ts holmesgpt_test.ts
deno check holmesgpt.ts holmesgpt_test.ts
deno test holmesgpt_test.ts
```

CI runs the same on every pull request.
