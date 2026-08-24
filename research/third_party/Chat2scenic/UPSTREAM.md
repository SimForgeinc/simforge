# TUM-AVS/Chat2scenic pinned research source

- Upstream: <https://github.com/TUM-AVS/Chat2scenic>
- Commit: `54264e4e394ff7bd5a72913abe4e323fa06cd37e`
- License: CC BY-NC 4.0; see `LICENSE`
- Imported: 2026-08-03 for noncommercial research evaluation

The files in this directory are unmodified copies from the pinned commit:
`app.py`, `core/`, `utils/`, `Benchmark/`, `README.md`, `requirements.txt`,
`env.example`, and `LICENSE`.

The 72 MB demonstration `assets/` and 43 MB CARLA `maps/` directories are
not vendored because they are not used by the current-map evaluation and would
duplicate large binary artifacts. They can be reproduced exactly with:

```sh
git clone https://github.com/TUM-AVS/Chat2scenic.git
git -C Chat2scenic checkout 54264e4e394ff7bd5a72913abe4e323fa06cd37e
```

SimForge modifications are deliberately outside this directory under
`research/chat2scenic_adapter/` and `apps/studio/server/copilot/`. The adapter:

1. substitutes OpenAI for the upstream Gemini defaults while retaining the
   original prompt text and interpreter/component ordering;
2. replaces CARLA Town selection with the current SimForge OpenDRIVE map;
3. uses prompt-embedded examples because the upstream Milvus volume snapshot
   is not distributed in the Git repository;
4. compiles and samples a strict trusted-slot Scenic program instead of
   executing raw model-generated Scenic/Python; and
5. lowers only supported actors and actions into the native ScenarioDoc.

These changes are evaluation adaptations, not claims of upstream equivalence.

