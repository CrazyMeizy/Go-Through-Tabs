---
version: alpha
name: Go Through Tabs
description: Compact macOS browser utility for navigating linked tabs.
colors:
  background: "#f7f8fa"
  surface: "#ffffff"
  text: "#1f2530"
  muted: "#5f6875"
  accent: "#3568d4"
  accent-hover: "#2958bd"
  border: "#dce1e8"
  key-shadow: "#cbd2dc"
  switch-off: "#7a8493"
  switch-knob: "#ffffff"
  warning-background: "#fff5e3"
  warning-text: "#805719"
  warning-border: "#e6c58c"
  dark-background: "#202328"
  dark-surface: "#2c3037"
  dark-text: "#eef1f6"
  dark-muted: "#aab3c1"
  dark-accent: "#90b0ff"
  dark-accent-hover: "#b1c7ff"
  dark-border: "#454c59"
  dark-key-shadow: "#171a20"
  dark-switch-off: "#717b8b"
  dark-switch-knob: "#202328"
  dark-warning-background: "#393125"
  dark-warning-text: "#f2d19b"
  dark-warning-border: "#665338"
typography:
  sans:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "13px"
    lineHeight: "1.5"
  key:
    fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, monospace'
    fontSize: "15px"
    lineHeight: "1"
rounded:
  panel: "14px"
  key: "7px"
  feedback: "10px"
spacing:
  page: "20px"
  popup-width: "340px"
components:
  switch: {}
  shortcut: {}
  feedback: {}
  help: {}
---

# Go Through Tabs Design System

## Overview

**North Star:** a small macOS settings panel opened from Chrome's toolbar. It answers whether linked navigation is enabled and reminds the user of the two shortcuts.

The audience is a macOS Chrome user; this is a product utility, not a promotional screen. The approved brief supplies the English name, Russian instructions, 340 px width and system-following theme. No Japan-market or Japanese-language scope is present.

The signature is a pair of outlined browser tabs joined by an arrow, repeated as the local toolbar icon. Everything around it stays quiet: one switch, two shortcut rows, one disclosure. There are no promotional headings, decorative gradients or animated entrances.

The existing product has one popup, so no sibling screen or UI library exists. The maintained business sources are the accepted implementation plan, README's usage/limitations and the `status`/`toggle` handlers in `extension/background.js`. This UI does not introduce navigation commands or change history semantics.

**Token ownership:** Model B. `extension/popup.css` is the canonical runtime source; this file mirrors accepted values and rationale. No token generator, theme provider or parallel CSS system is required. Colors map by name to CSS custom properties (`colors.background` → `--background`); `dark-*` entries map to the same variable inside `prefers-color-scheme: dark`. The switch knob becomes dark in dark mode to maintain contrast against the soft blue track. Scrollbar thumb/hover/active alias switch-off/muted/accent. `typography.sans` maps to `--font`, `typography.key` to `--font-key`; rounded panel/key/feedback map to `--radius-*`; page spacing maps to `--space-page`. Width is applied to `body`. Browser checks verify computed theme colors, contrast and geometry.

## Colors

Light uses a cool near-white document, white controls and slate text. Blue identifies the enabled switch and keyboard focus. Dark uses a charcoal document, slightly lighter controls and a softer blue; hierarchy and meaning stay identical. Muted text retains readable contrast.

Warnings use amber background, border, icon and text. Meaning is always written, not conveyed solely by color. The app icon uses the stable light accent and white outlines in every theme; generated PNGs come from one SVG. Forced colors preserve system colors, control outlines and operable scrollbars.

## Typography

Use the native macOS system face for brand, controls and Russian copy, with Latin/Cyrillic fallbacks. The name is 20 px / 650, controls and direction labels 14 px / 600, secondary copy 12 px with 1.5–1.6 line height. Command uses the system face; bracket keys use the system monospace face. No external font or font swap is allowed.

## Layout

The document is 340 px wide with 20 px outer padding and natural vertical scrolling. At narrower test widths it contracts to the viewport. The icon/name header precedes the status row, two direction rows, feedback and footer. Native disclosure content wraps; important instructions and notices are never ellipsized.

The switch's hit area is 48 × 44 px. Its row reserves 78 px across loading, ready and error states. Feedback is below the main controls, so its appearance does not move them. Long notices are bounded to 108 px with keyboard-operable scrolling. All scrollable regions inherit the document scrollbar theme.

## Elevation & Depth

Panels use a border and tonal surface, without shadows. Keycaps alone have a 2 px lower edge to suggest physical keys. No blur, large shadow or floating card stack.

## Shapes

The status panel has 14 px corners; keycaps 7 px; notices 10 px. The switch is a pill. The app icon has rounded corners intrinsic to the SVG. Shape differences communicate function rather than treating all content as identical cards.

## Components

### Behavior and ownership

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Scrollbar | Global baseline in extension/popup.css | DESIGN.md Layout and Colors | document / bounded notice | tests/popup.mjs computed styles and keyboard |
| Toast | Existing notice state, popup feedback renderer | background.js status/toggle API | notice / connection error | tests/popup.mjs failure and long-notice scenarios |

The switch is a native button with `role="switch"`, a stable localized accessible name and `aria-checked`. Enter and Space use native behavior. Pending requests disable activation and expose `aria-busy`; state changes are announced politely. Focus returns to the initiating control after completion, or to recovery after a failure. Initial loading never steals focus.

Only confirmed responses set enabled/disabled state. A 5-second timeout leaves the state unknown and disables the switch. Recovery sends `status`, not `toggle`, because a timed-out toggle may still finish. Late responses cannot overwrite a later check. No optimistic flip or automatic mutation retry is allowed.

Feedback is persistent while applicable, uses safe text content and a localized status region. Error recovery is an outlined button labeled «Повторить проверку». Help uses native `details`/`summary`, preserving standard keyboard behavior and focus. The document title is the stable product name.

### Visual states, iconography and motion

Controls define hover, active, focus-visible, busy and disabled treatments. Blue outline marks focus; text labels identify enabled and disabled states. Keycaps are explanatory, not clickable controls.

Icons are local SVGs with rounded strokes, decorative when accompanying text. The switch and help chevron transition for 160 ms solely to communicate state; reduced motion removes transitions. There are no continuous animations or skeletons.

### Content

Russian copy uses direct verbs and familiar browser terminology. English appears only in the product name and Command key accessibility label. The popup describes native history first and linked-tab behavior at its boundary. No data visualization, forms or authentication flow is part of this surface.

## Do's and Don'ts

- Keep the two directions equally prominent and readable.
- Keep status factual during slow or failed requests; provide safe rechecking.
- Keep help available with keyboard and all resources local.
- Do not turn shortcut labels into buttons that pretend to navigate.
- Do not retry a toggle automatically or guess that an uncertain operation failed.
- Do not add dashboard cards, external fonts or marketing copy to this utility.
