# Local assets & the CARLA contract

SimForge's containerization rule, in one line: **the only container anywhere is
the user's CARLA base image; everything we develop runs outside containers, and
no large asset is ever baked into an image or committed to git.**

## Asset root

Pulled maps share one cache outside every repo and image:

```
${SIMFORGE_MAPS_CACHE_ROOT:-${XDG_DATA_HOME:-~/.local/share}/simforge/maps}/
  dev-assets/<mapId>/       # semantic sidecars
  map-bundles/<mapId>/      # browser closure and external resources
  .corpus/<mapId>/          # native master closure
  .blobs/                   # content-addressed shared blobs
```


### Installed map profiles

`simforge maps pull <map>@<version>` materializes all three runtime profiles.
Each profile is activated only with a `.map-release.json` receipt that identifies
the same immutable registry release. The compiler and Studio discover complete
installations from the common cache; Studio publishes the browser closure and
registers the matching native master closure during normal boot.

`SIMFORGE_MAPS_CACHE_ROOT=/elsewhere` relocates the entire cache consistently.
Without that variable, `XDG_DATA_HOME` is honored and the fallback is
`~/.local/share/simforge/maps`. Do not point Studio at an individual profile.
When the cache has no complete installation, Studio uses its independently
generated Starter Road.

Rules:

- **Never** commit an asset from this tree into git (see `.gitignore` /
  `.gitattributes` guards) and **never** `COPY`/`ADD` one into a Dockerfile.
- New asset classes get a manifest entry with a real digest *before* code
  starts depending on them. Entries whose bytes are not yet published carry
  `"url": null` and are reported honestly as missing/pending by `status` —
  they are never silently faked.

## CARLA: user-provided, never ours to ship

CARLA is **user-provided**. Users run CARLA themselves as their own container,
a normal upstream-style distribution **with maps baked inside** (e.g.
`ghcr.io/simforgeinc/carla-rr-maps:0.10.0`). SimForge does **not** package,
rebuild, redistribute, or manage CARLA or its map content in any way:

- We build **no** image `FROM` a CARLA image (this is the *only* container in
  the whole system, and it is not ours).
- We bake **no** SimForge code into it — `adapters/carla-exec` installs on the
  host (`pip install`) and **connects** to the already-running server.
- We bind-mount nothing into it and own no part of its content lifecycle.

The connection contract is:

| Variable | Default | Meaning |
|---|---|---|
| `SIMFORGE_CARLA_HOST` | `localhost` | RPC host of the user's running CARLA server |
| `SIMFORGE_CARLA_PORT` | `2000` | RPC port (`PORT..PORT+2` in use) |

If nothing answers there, the adapter fails preflight with a clear message —
*start your CARLA container first* — instead of attempting any container
lifecycle management.

### Optional developer convenience

`scripts/assets/carla-up.sh` exists purely to save local-dev keystrokes:
it attaches when a server already answers on `SIMFORGE_CARLA_HOST:PORT`,
starts a stopped container, or `docker run`s the pinned user-provided image
with `-RenderOffscreen`. It **refuses to build images** (exit 3 on any
`build` argument) and errors out when the image is absent rather than
pulling content on your behalf. It is not part of the product contract.

## Developer loop (CARLA path)

```
scripts/assets/carla-up.sh        # once per boot; the container is long-lived
# edit python in adapters/carla-exec/ ...
python -m pytest adapters/carla-exec/tests -q        # pure-python, no server needed
simforge-oss-carla-api <cmd> --host localhost --port 2000  # rerun against the live server
```

No image build, no container restart, no asset copy is ever part of the
edit-run loop.
