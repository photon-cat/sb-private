# SparkBench Stabilization Plan

This plan treats `sb-private` as the deploy-capable source of truth and keeps the
public filesystem prototype as a downstream concern until the core tool is stable.

## Phase 1: Make Verification Useful

Status: implemented.

- Keep generated trees out of lint (`node_modules`, vendored modules, emulator build
  output, Playwright scratch data).
- Make lint a signal for application code instead of a wall of migration noise.
- Keep `tsc --noEmit`, unit tests, and production build as the required gates.
- Align API tests with the deploy API shape.

Current gates:

- `npm test`
- `npm run lint`
- `npx tsc --noEmit`
- `npm run build`

## Phase 2: Normalize Diagram Data

Status: implemented for the main crash path and active editor flow.

- Use object-shaped connections internally: `{ from, to, color, hints }`.
- Keep Wokwi tuple connections only at import/export boundaries.
- Centralize diagram edits in `lib/diagram-ops.ts`.
- Preserve compatibility with legacy tuple test fixtures through parser/runtime
  normalization instead of letting mixed shapes crash downstream code.

Remaining cleanup:

- Remove stale tuple assumptions from old tests and scripts over time.
- Clean unused imports and disabled lint comments after the migration settles.

## Phase 3: Reduce Diagram Editor Coupling

Status: partially implemented before this pass, preserved and verified.

- Simulation wiring is extracted into `hooks/useSimulationWiring.ts`.
- `DiagramCanvas` now delegates runner/component binding to that hook.

Next extractions:

- `useDiagramElements` for custom/Wokwi element lifecycle.
- `useDiagramViewport` for pan, zoom, fit, and ruler math.
- `useWireEditing` for selected wire segment handles.
- `usePinGeometry` for pin collection and wire rendering inputs.

## Phase 4: Stabilize PCB Generation

Status: implemented.

- `lib/pcb-pipeline.ts` owns diagram-to-PCB generation.
- The pipeline preserves existing footprint positions.
- The pipeline preserves existing Edge.Cuts outline unless `diagram.boardSize` is
  explicitly set.
- The project page now calls the pipeline instead of owning KiCad mutation details.
- Tests cover placement preservation, outline preservation, explicit board sizing,
  and autoroute input validation.

Next PCB work:

- Add fixtures for larger real projects (`demo-guide`, `simon-game`, `74hc165-input`).
- Add a golden-board smoke test that parses generated `.kicad_pcb` back through
  KiCanvas.
- Move route/zone merge behavior into the same pipeline once desired semantics are
  clear.

## Phase 5: Harden DeepPCB Routing

Status: implemented for local/deploy routing boundary and early validation.

- The DeepPCB route now supports local filesystem projects without importing MinIO
  at module load.
- Deployed routing still requires auth and project write access.
- Boards are validated before routing and after retrieving DeepPCB output.
- Routed boards refresh storage and DB project metadata.
- The DeepPCB client now requires core MCP tools, carries discovered job ids into
  status/result calls when possible, and errors with available tool names when the
  remote MCP contract does not match expectations.

Remaining DeepPCB work:

- Replace fuzzy tool discovery with fixed tool names after confirming the production
  MCP schema.
- Persist route attempts and logs as project artifacts.
- Add a retry/debug endpoint that can rerun against the exact board sent to DeepPCB.

## Phase 6: Project Storage Boundary

Status: existing direction is sound; more consolidation remains.

- `sb-private` already has local-dev and DB/MinIO paths.
- Continue moving API routes toward storage/service helpers so UI, agent tools, and
  routes do not care whether a project is local or deployed.

Next target:

- Introduce a `ProjectRepository` interface with filesystem and DB/MinIO adapters.
- Migrate chat, build, copy, PCB, sketch, libraries, and settings routes onto that
  interface one route at a time.

## Phase 7: Product Smoke Tests

Status: not implemented in this pass.

Add Playwright coverage for:

- Open dashboard and load a project.
- Diagram renders parts and wires.
- Add/move/delete a part.
- Update PCB from diagram.
- PCB tab loads generated board.
- Build flow returns either firmware or a clear compile error.

These should run after unit tests and before deployment.
