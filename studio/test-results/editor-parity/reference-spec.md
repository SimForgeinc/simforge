# SimCloud editor reference — simple timed routes

Observed before implementation on 2026-08-26 at `http://localhost:3000/dashboard/scenarios?dataset=usds_ed44e6332dd74dd78950c79b&document=uscn_5a38c2ffb66a4e1c83187da1`.

## First entry and persistence

- With the editor-experience storage value absent, SimCloud opens a blocking chooser headed **“How do you want to build this scenario?”** and subcopy **“You can switch views later without changing the simulation format.”**
- The emphasized first choice is **Simple**: **“Every movable actor gets one custom timed route. After its final authored point, the actor brakes under physics; the timeline stays visible but locked.”**
- The other choice is **Advanced**: **“Use the current multi-track timeline, triggers, actions, signals, and detailed controls.”**
- After choosing Simple and reopening the same document, SimCloud enters Simple directly: the choice is sticky in local storage.
- Reference screenshot: [`simcloud-01-first-entry.webp`](./simcloud-01-first-entry.webp).

## Car placement and the unconfigured state

1. Open **Car**, select **Place Sedan**, then click the world once.
2. Placement completes and closes the catalog. It does **not** automatically open route drawing.
3. A `Sedan 2` timeline row appears immediately. Its route band spans the timeline, pulses red, and says **“Click to configure route”**. Its accessible label is **“Configure route; setup required”**, its title includes **“Route setup required”**, and its `data-route-status` is `needs-setup`.
4. The new route is a two-point timed-route placeholder at the actor's starting pose. It remains unconfigured while every point is within 0.05 m of the first point.
5. Reference screenshot: [`simcloud-02-placed-needs-route.webp`](./simcloud-02-placed-needs-route.webp).

## Inspector immediately after placement

- Placement leaves the actor available for selection; selecting the timeline identity opens the normal actor inspector.
- The inspector does not add a separate route form. It shows the normal color swatches, **NAME**, and **SENSORS**, with **“Add a camera or a full perception rig to record the scenario.”**, **“Add sensors”**, and **“Camera”**.
- Route setup remains in the timeline rather than being duplicated in the inspector.
- Reference screenshot: [`simcloud-03-actor-inspector.webp`](./simcloud-03-actor-inspector.webp).

## Configuring motion

1. Click the red **“Click to configure route”** band.
2. The map route toolbar opens. Initial copy was **“2 route points · drag a 3D point to move · Delete removes selected · Esc closes”** with **Add points**, **Move points**, **Delete point**, and **Close**.
3. Choose **Add points** and click a meaningfully different world position. Each appended point is one additional second; clicking the highlighted last point again adds a one-second wait. Pressing Enter returns to point movement; **Close** or Esc closes the route tool.
4. As soon as a point differs by more than 0.05 m from the start, the timeline copy changes to **“Edit route”**, the red setup warning clears, and `data-route-status` becomes `configured`.
5. The configured timed route owns the actor's complete motion timeline from 0 seconds. It replaces competing `speed`, `gap`, `changeLane`, `laneOffset`, and other `route` interactions; it does not supplement the compiler's default 13.4112 m/s lane-following route. In Simple mode the placeholder is intentionally stationary, so the newly placed actor does not move until the user adds a displaced timed point. After its last authored point/time the actor brakes under physics.
6. Reference screenshot: [`simcloud-04-configured-route.webp`](./simcloud-04-configured-route.webp).

## Source cross-reference (read-only SimCloud repository)

- `apps/web/app/dashboard/scenarios/editor/EditorExperienceChooser.tsx`: exact chooser and Simple/Advanced copy.
- `apps/web/app/dashboard/scenarios/editor/ScenarioEditorSurface.tsx`: stored experience selection, Simple conversion, placement completion, and route-selection handoff to the canvas tool.
- `apps/web/app/dashboard/scenarios/editor/simple-timed-routes.ts`: local-storage persistence, conversion to one exclusive full-timeline `customTimedRoute`, one-second point timing, and post-route braking contract.
- `apps/web/app/dashboard/scenarios/editor/simple-route-status.ts`: two-point placeholder and 0.05 m setup threshold.
- `apps/web/app/dashboard/scenarios/editor/simple-placement-completion.ts`: single-shot placement/catalog completion.
- `apps/web/app/dashboard/scenarios/editor/ScenarioTimelineDock.tsx`: Simple-mode interaction creation and timing lock gates.
- `apps/web/app/dashboard/scenarios/editor/timeline/V1TimelineRail.tsx`: red setup band, exact **“Click to configure route”** / **“Edit route”** copy and accessibility labels.
- `apps/web/app/dashboard/scenarios/editor/inspector/ActorDetailsPanel.tsx` and `ActorSensorsSection.tsx`: actor inspector content.
- `apps/web/app/dashboard/scenarios/editor/tutorial/EditorTutorialGuide.tsx` and `interactive-tutorial-programs.ts`: exact user workflow, one point per second, waits, Enter, and post-route braking.
