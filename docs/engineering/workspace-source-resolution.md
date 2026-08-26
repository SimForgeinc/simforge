# Workspace source resolution

Development and tests must resolve every `@simforge-oss/*` workspace import from TypeScript source. A package's `dist/` directory may be absent or stale and must not affect typechecking, Vitest, `tsx`, or Studio development.

## Standard mechanism

All 13 published packages use the same package-export shape:

```json
{
  "exports": {
    ".": {
      "development": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "publishConfig": {
    "exports": {
      ".": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      }
    }
  }
}
```

Every public JavaScript subpath follows the same rule. Static JSON and schema exports remain direct source-tree files because they are already publishable artifacts rather than compiled JavaScript.

`tsconfig.base.json` selects the `development` condition and maps public workspace specifiers to their source entry points. The paths make `tsx` and TypeScript independent of package build order. Studio repeats those paths because its app-local `paths` object overrides the inherited object. Vitest selects the `development` export condition. Studio development runs Next with webpack, lists every workspace dependency in `transpilePackages`, and maps explicit `.js` relative imports to `.ts`/`.tsx`; that lets Next compile the packages' Node-compatible TypeScript source without rewriting its import specifiers.

Do not add a package-specific alias to fix a stale-build failure. Add its public entry point to the package's `development` exports and both path maps, then keep the published `publishConfig.exports` dist-only.

## Packing is intentionally different

`pnpm pack` applies `publishConfig.exports`, so packed manifests contain only compiled `dist/` entry points. Package `files` lists continue to ship `dist` (plus declared static assets), not `src`. Release artifact verification and packed-package smoke tests therefore exercise the same compiled files consumers install from npm.

Runtime tools that deliberately launch a compiled executable are exceptions. The Gym, CARLA API, policy-runner, and ROS 2 adapters launch `packages/training-env/dist/env-server.js` when no installed `simforge-env-server` is available. They check for that artifact and instruct the operator to run `pnpm --filter @simforge-oss/training-env build`; this is process execution, not workspace module resolution.

## Regression proof

From the repository root, the stale-build failure mode is checked without rebuilding:

```sh
rm -rf packages/engine/dist
pnpm --filter @simforge-oss/training-env test

rm -rf packages/engine/dist packages/viewer/dist
pnpm --filter @simforge-oss/studio test:eval
```

Both commands must pass with the listed `dist/` directories absent.
