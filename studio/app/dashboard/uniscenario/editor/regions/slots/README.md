# Editor v2 host slots

Each file here is an **empty host slot**: it renders `null` today, and its props
are the data its future contents need. A porting agent fills one file and touches
nothing else — not the surface layout, not the region that hosts it.

| Slot | Hosted by | Manifest | Responsibility |
| --- | --- | --- | --- |
| `ScenarioRailSlot` | `UniScenarioEditorSurface` (left of the actor library) | 43-50 | Product dataset navigation, status, and compile actions |
| `NotificationDockSlot` | `UniScenarioEditorSurface` | 166-168 | Product workspace notices and scenario activity |
| Traffic-light authoring | `UniScenarioTimelineDock` (anchored to the selected light lane) | 6.x | One selected reference light controls the junction cycle; the domain layer lives in `app/lib/uniscenario/signals/**` |
| `TimelineDockSlot` | `EditorDockRegion` (below the timeline, in flow) | 5.x, 7.x | Product playback and timeline extensions |
| `AssistantChatSlot` | `UniScenarioEditorSurface` (right overlay) | 11.x | Cloud assistant/copilot surface |
| `TutorialOverlaySlot` | `UniScenarioEditorSurface` (above everything) | 14.x | Product tutorial overlay and spotlight styling |

## Rules

- **Keep the props contract.** If the contents need data the slot does not
  receive, widen the slot's props and the one host that renders it. Do not reach
  into the surface.
- **Overlay, never replace.** Slots that paint over the canvas are `absolute`
  inside the canvas region or `fixed` at the surface level, so appearing and
  disappearing never reflows the canvas or drops the WebGL context.
- **Status goes through the stream.** Publish with
  `useUniScenarioWorkspaceStatus` / `useUniScenarioNotification` from
  `../../status`. Do not add a second display mechanism.
- **Tokens only.** No hex literals, no `bg-[#…]`, no `text-white/xx`, no
  `rounded-*` (the product forces `border-radius: 0`). See parity plan §5.
