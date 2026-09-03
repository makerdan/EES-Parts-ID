---
name: RTLRN custom-host queries
description: Query guidance for the project's React Native test mocks when rendered controls and labels are custom host elements.
---

The project's React Native mocks render `TextInput` as a custom host element, so Testing Library's display-value queries may not recognize its `value` prop. Labels containing nested `<Text>` children may also fail exact text queries.

**Why:** The mock tree preserves native props and nested children for inspection, but it does not expose the same accessibility/value semantics as a real React Native host.

**How to apply:** For these suites, locate inputs with `root.queryAll(node => node.props.value === value)` and locate compound labels by recursively concatenating a text node's children before matching.