# Upstream Chat2Scenic research adapter

This is a noncommercial evaluation path for the pinned TUM-AVS Chat2Scenic
repository. It is a third Scenario Copilot approach named **Upstream
Chat2Scenic (Research)**. It is not imported into the Vite/browser bundle.

## Setup

Create a local Python environment outside the repository:

```sh
python3 -m venv /private/tmp/simforge-chat2scenic-venv
/private/tmp/simforge-chat2scenic-venv/bin/pip install -r research/chat2scenic_adapter/requirements.txt
```

Start the development server with the OpenAI credential injected by 1Password;
the value is never placed in source, arguments, logs, or browser storage:

```sh
OPENAI_API_KEY='op://MichaelAgents/openai key/notesPlain' \
SIMFORGE_SCENIC_PYTHON=/private/tmp/simforge-chat2scenic-venv/bin/python \
SIMFORGE_COPILOT_MODEL=gpt-5.6-luna \
OPENAI_SCENARIO_MODEL=gpt-5.6-luna \
$HOME/bin/op-michaelagents run -- pnpm dev
```

The adapter probes the exact model id before generation. Model substitution is
not silent. The Scenic child process gets a minimal environment without the API
key, has a CPU/file-size bound, is denied network access on macOS, and is killed
after 45 seconds.

## Fidelity and caveats

The original interpreter, settings detector, header generator, and component
prompts execute in the published dependency order. Raw generated components are
retained only in server memory and passed to the lowering stage. They are not
executed: Scenic is Python-capable, so executing arbitrary model text would be
an unacceptable local-code-execution boundary.

Instead, actors selected by the lowering stage are placed at trusted map slots
in a restricted Scenic program. Scenic 3.1.0 loads the current raw OpenDRIVE,
compiles the program, and samples the initial scene. Sampled positions are
checked against the same slots before creating an editable native ScenarioDoc.
The ordinary canonical 20-second SimForge simulation remains the final gate.

Some trusted lane-center slots occupy lanes narrower than Scenic's default
CARLA vehicle footprint. The adapter disables Scenic's footprint-containment
rejection for these fixed points while still loading the OpenDRIVE and sampling
its road direction. This is not a Scenic road-fit guarantee; native lane binding
and the canonical simulation are authoritative and the deviation is recorded.

The pinned repository contains Milvus client code but not the referenced vector
database snapshot. This adapter therefore uses the examples embedded in the
original prompts and reports `prompt-examples-substitute` in provenance.

Only native speed, lane-change, and lane-offset actions are currently lowered.
Other Scenic monitors, behaviors, distributions, CARLA-specific blueprints,
traffic-light utilities, and dynamic termination semantics are reported as
unsupported rather than approximated silently.

CC BY-NC 4.0 limits this path to noncommercial research. Remove or disable the
provider before any commercial distribution unless separate permission is
obtained from the rightsholders.
