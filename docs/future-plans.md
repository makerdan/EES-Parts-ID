# Future Plans

This document parks deferred feature ideas with context on why they were held and when to revisit them. It is not a backlog — items here are intentionally out of scope for the near term.

---

## Help Modal / In-App Guidance

### Why it was deferred

The app has several non-obvious gestures (long-press cycle counting, multi-photo Photo ID, map pinning) and an AI layer that is still evolving. Building help content before those surfaces stabilize would mean rewriting the copy on every significant change. The cost-to-value ratio is poor until the feature set settles and real user confusion signals are available.

### When to revisit

- After Reference AI ships and the full set of AI capabilities is documented in one place
- After at least one cycle of user feedback that surfaces specific confusion points
- When the gesture surface stops changing frequently enough that copy can be written once and trusted

### Recommendations

1. **Prioritize non-obvious gestures first.** Long-press to start a cycle count, multi-photo capture in Photo ID, and map pinning are the interactions users are least likely to discover on their own. Start there rather than documenting obvious flows.

2. **Scope to a lightweight modal, not a step-through onboarding tour.** A "?" button that opens a screen-aware cheat sheet is easier to build, easier to maintain, and less intrusive than a guided tour. Users can consult it on demand rather than sitting through upfront instruction they may not need.

3. **Write copy after Reference AI ships.** The AI feature set spans Photo ID, enrichment, search fallback, and the Reference assistant. Documenting them piecemeal will produce a fragmented help experience. Wait until they are all live and describe them together in one place.

4. **Consider a "What's New" variant instead of full documentation.** A brief changelog surface (e.g., a banner on first launch after an update) is cheaper to maintain than a comprehensive help doc and may address the same problem — users not knowing a feature exists — without requiring an exhaustive content effort.

5. **Measure before building.** Add a simple feedback mechanism (a thumbs-down on a result, a "Was this helpful?" prompt, or just watching support volume) before writing any copy. Real confusion signals should drive the content, not assumptions about what users will find hard.
