# Search Logo Navigation Design

## Goal

Make the “⚡ Parts ID” logo in the Search screen header an accessible button that returns the user to the main Search route while preserving the current search query and results.

## Behavior

- The existing logo text and visual layout remain unchanged.
- Pressing the logo navigates to the main Search tab with `router.navigate("/(tabs)")`.
- The action does not clear, replace, or reinitialize Search screen state.
- Navigation does not add an unnecessary duplicate Search screen to the history stack.

## Accessibility

- The interactive logo uses a React Native `Pressable`.
- It exposes `accessibilityRole="button"`.
- It exposes the label “Go to Search.”
- Its touch target is at least 44 points high.

## Error Handling

The action is local navigation and requires no asynchronous work or user-visible error state.

## Regression Hardening

Add a focused Search header test that:

- locates the logo by its accessibility label;
- confirms it has button semantics;
- presses it and verifies navigation targets `"/(tabs)"`;
- confirms the handler does not invoke Search reset or clear behavior.

## Scope

No other header controls, Search state behavior, routes, or visual styling will change.