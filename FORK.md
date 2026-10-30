# Fork notes — dsh-plugin-appshot 0.4.3

This repository is a patched fork of [TaurusWood/dsh-plugin-appshot](https://github.com/TaurusWood/dsh-plugin-appshot) at the published `0.4.2` artifact. Only packaging metadata is changed; `dist/` and the native agents are byte-identical to the npm `0.4.2` build.

## Problem

`dist/index.js` (the Host bundle) contains the browser Settings component and therefore a static ESM import:

```js
import React, { useState, useEffect } from "react";
```

The build uses `--packages=external`, so that import is left in the Host entry, but `react` is only listed under `devDependencies`. When DSH loads the bundle from a profile's `node_modules`, Node cannot resolve `react` and the whole entry fails:

```text
dsh: warning: 1 entry did not activate dsh-plugin-appshot(dsh-plugin-appshot):
failed to import: Error[ERR_MODULE_NOT_FOUND]: Cannot find package 'react'
```

## Decision

Declare the real runtime dependency instead of relying on the host profile to provide it:

```json
"dependencies": { "react": "^18.2.0" }
```

`dist/` is unchanged; the Host bundle now always resolves `react` from the package's own dependency graph (pnpm hoisted and isolated layouts both work). `react-dom` is not needed: only the browser client bundle (`dist/client.js`, served through `__ModuleLoader__`) uses it, and that comes from the DSH web app.

## Alternatives considered

- Bundling `react` into `dist/index.js` (drop `--packages=external` for it): duplicates a React copy into the Host for a component that never renders there, and risks a second React instance.
- Removing the component export from the Host entry (rebuild from source): the cleaner upstream fix, but it changes the package's public exports and needs a full source + native rebuild; not required to make the plugin load.

## Consequences

- Version is bumped to `0.4.3` so a profile can pin this fork independently of the npm release.
- `dist/` and Native Agent binaries are committed so `github:` installs need no consumer-side build.
- Install:

```sh
dsh plugin --profile desktop add "github:xuemingze/dsh-plugin-appshot#v0.4.3"
```

Restart DSH afterwards; the Bundle is composed at boot.
