# Zone Editor — Global Save Indicator Design Spec

**Date:** 2026-08-03  
**Status:** Approved  
**Scope:** `artifacts/mockup-sandbox/src/pages/ZoneEditor.tsx`

---

## Problem

Users in Zone Editor (Pan/Select, Draw Zone, Fill modes) have no persistent visual
feedback that their changes are being saved and no way to force-flush on demand.  The
only save UI is:

* The Calibrate-mode toolbar's "Save ●" button (only visible in Calibrate mode).
* A sidebar Sonner toast ("Saved") — easy to miss, disappears after a few seconds.

---

## Solution

Add a **slim second row** to the sticky banner (below the mode buttons) that shows the
current save state and a Save button.  The row is hidden when Calibrate mode is active
because Calibrate already has its own dedicated save controls.

---

## State Machine

```
        mount
          │
          ▼
       ┌─────┐   form change (valid, selected)   ┌───────┐
       │clean│ ─────────────────────────────────► │ dirty │
       └─────┘ ◄──────────────────────────────── └───────┘
          ▲       save success (flush/timer)           │
          │                                            │ timer fires or
          │   save success                             │ Save clicked
       ┌──────┐ ◄──────────────────────────── ┌────────┤
       │ clean│                                │ saving │
       └──────┘                                └────────┘
          │                                        │
          │ selection changed (new zone)       save failed
          │                                        │
          └──────────────────────────────── ┌───────┐
                                            │ error │
                                            └───────┘
                                                │
                                           Save clicked (retry)
                                                │
                                           ┌────────┐
                                           │ saving │
                                           └────────┘
```

**Transitions:**

| Event | From | To |
|---|---|---|
| Component mount | — | `clean` |
| Form changes & conditions met (selectedId set, aisleId valid, differs from last saved) | any | `dirty` |
| Auto-save timer fires / `flushSave` starts PATCH | dirty | `saving` |
| PATCH succeeds | saving | `clean` |
| PATCH fails | saving | `error` |
| Zone selection changes (new selectedId) | any | `clean` |
| Save button clicked (retries) | error | `saving` |

---

## Layout

```
┌────────────────────────────────────────────────────────┐
│ ← Internal Tools  ⚠ DEV TOOL — …   [Pan] [Draw] […]   │  ← row 1 (unchanged)
├────────────────────────────────────────────────────────┤
│              All changes saved   [Save]                 │  ← row 2 (new, hidden in Calibrate)
└────────────────────────────────────────────────────────┘
```

Row 2 is a flex row, centered horizontally, with `padding: "3px 16px"` and a subtle
top separator (`borderTop: "1px solid rgba(255,255,255,0.15)"`).

---

## Label Copy & Colour

| `saveStatus` | Label | Colour | Font style |
|---|---|---|---|
| `clean` | `All changes saved` | `rgba(255,255,255,0.55)` | normal |
| `dirty` | `Unsaved changes ●` | `#fbbf24` (amber-400) | normal |
| `saving` | `Saving…` | `rgba(255,255,255,0.55)` | italic |
| `error` | `Save failed — retry` | `#f87171` (red-400) | normal |

---

## Save Button

| `saveStatus` | Enabled? | Background | Label |
|---|---|---|---|
| `clean` | no (dimmed) | transparent | Save |
| `dirty` | yes | `#16a34a` (green-600) | Save |
| `saving` | no (dimmed) | transparent | Saving… |
| `error` | yes | `#dc2626` (red-600) | Retry |

`onClick` → calls `flushSave(formRef.current, selectedId)` when `selectedId` is set.
When `selectedId` is null (no single zone selected), the button is disabled regardless
of `saveStatus`.

---

## Wiring

* **`saveStatus` state**: `useState<"clean" | "dirty" | "saving" | "error">("clean")`
* **Auto-save effect** (debounce 600 ms): set `dirty` after conditions pass and before
  scheduling the timer; set `saving` at the top of the timer callback async body; set
  `clean` after `toast.success`; set `error` in the `catch` block.
* **`flushSave` callback**: set `saving` before `patchZone` awaits; set `clean` after
  success; set `error` in `catch`.
* **Selection-change reset**: `useEffect(() => { setSaveStatus("clean"); }, [selectedId])`.

---

## Regression Hardening

* Unit tests verify all four state transitions:
  * `clean → dirty` on form change.
  * `dirty → saving → clean` on successful flush.
  * `dirty → saving → error` on failed PATCH, Save button re-enabled.
* Render tests confirm:
  * Second row is **absent** in Calibrate mode.
  * Second row is **present** in Pan mode.
* Existing ZoneEditor tests must remain green (no regression).

---

## Out of Scope

* Calibrate-mode save toolbar (unchanged).
* Sidebar "Saved" Sonner toast (unchanged).
* Draft/crash-recovery UI (unchanged).
* Any changes to `flushSave()` or the debounce persistence logic.
