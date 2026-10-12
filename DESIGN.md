---
version: alpha
name: Novaris Desktop Operations
description: A calm, trustworthy desktop operations console for managing the Novaris monitoring agent and its local AI assistant.
colors:
  primary: "#0F6B4F"
  primary-hover: "#0B573F"
  primary-soft: "#E2F3EC"
  primary-container: "#C7EBDD"
  accent: "#18A673"
  sidebar: "#13241E"
  sidebar-hover: "#1C342B"
  sidebar-active: "#244B3D"
  canvas: "#F5F7F6"
  surface: "#FFFFFF"
  surface-subtle: "#F0F4F2"
  border: "#D9E1DD"
  border-strong: "#B8C5BF"
  text: "#17201C"
  text-muted: "#5C6B64"
  text-on-dark: "#F5FAF7"
  text-on-primary: "#FFFFFF"
  success: "#18794E"
  success-soft: "#E4F5EC"
  warning: "#9A6700"
  warning-soft: "#FFF4D6"
  danger: "#B42318"
  danger-hover: "#8F1C13"
  danger-soft: "#FDECEA"
  info: "#1769AA"
  info-soft: "#E8F2FC"
  focus: "#2F80ED"
typography:
  display:
    fontFamily: Inter
    fontSize: 2rem
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  h1:
    fontFamily: Inter
    fontSize: 1.5rem
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  h2:
    fontFamily: Inter
    fontSize: 1.125rem
    fontWeight: 650
    lineHeight: 1.35
    letterSpacing: "-0.01em"
  h3:
    fontFamily: Inter
    fontSize: 0.9375rem
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: "0em"
  body-md:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0em"
  body-sm:
    fontFamily: Inter
    fontSize: 0.8125rem
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "0em"
  label:
    fontFamily: Inter
    fontSize: 0.8125rem
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0em"
  caption:
    fontFamily: Inter
    fontSize: 0.75rem
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.01em"
  mono:
    fontFamily: JetBrains Mono
    fontSize: 0.75rem
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0em"
rounded:
  sm: 4px
  md: 8px
  lg: 12px
  xl: 16px
  pill: 999px
spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 40px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.text-on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 10px
    height: 36px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.text-on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 10px
    height: 36px
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 10px
    height: 36px
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.text-on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 10px
    height: 36px
  button-danger-hover:
    backgroundColor: "{colors.danger-hover}"
    textColor: "{colors.text-on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 10px
    height: 36px
  navigation-item:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.text-on-dark}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 10px
    height: 40px
  navigation-item-active:
    backgroundColor: "{colors.sidebar-active}"
    textColor: "{colors.text-on-dark}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 10px
    height: 40px
  status-success:
    backgroundColor: "{colors.success-soft}"
    textColor: "{colors.success}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: 6px
    height: 24px
  status-warning:
    backgroundColor: "{colors.warning-soft}"
    textColor: "{colors.warning}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: 6px
    height: 24px
  status-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: 6px
    height: 24px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: 20px
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: 10px
    height: 36px
  log-viewer:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.text-on-dark}"
    typography: "{typography.mono}"
    rounded: "{rounded.md}"
    padding: 16px
---

## Overview

Novaris Desktop Operations turns a cramped configuration panel into a focused Windows-style utility. It should feel dependable, quiet, and operational rather than promotional: clear hierarchy, concise labels, honest runtime state, and safe actions.

The visual identity derives from the existing Novaris mark: deep evergreen structure, a brighter emerald accent, charcoal typography, and generous neutral surfaces. The application is primarily light, with a compact dark sidebar that anchors navigation and makes the desktop shell unmistakable.

Design for an administrator or IT operator who may keep the application open while diagnosing a device. The interface must expose status before configuration, separate everyday actions from advanced settings, and keep destructive or security-sensitive actions deliberate.

## Colors

- **Primary (#0F6B4F):** Novaris evergreen for primary actions, selected controls, and healthy operational emphasis.
- **Accent (#18A673):** Brighter emerald used sparingly for active indicators and brand details, never as body text on white.
- **Sidebar (#13241E):** Stable dark navigation rail that visually separates global destinations from page content.
- **Canvas (#F5F7F6):** Low-contrast application workspace behind white surfaces.
- **Surface (#FFFFFF):** Cards, forms, tables, dialogs, and conversation areas.
- **Status colors:** Green, amber, red, and blue always pair an icon or text label with color. Color alone must never communicate state.
- **Focus (#2F80ED):** Visible 2px keyboard focus ring with at least 2px separation from the control edge.

Use semantic colors only for status or consequence. Do not decorate neutral information cards with arbitrary multicolor accents.

## Typography

Inter is the primary UI family because it remains compact and legible in dense desktop controls. Use the system Segoe UI fallback when Inter is unavailable. JetBrains Mono is reserved for logs, IDs, ports, paths, timestamps, and diagnostic payloads.

Page titles are 24px, card titles are 18px, and normal application text is 14px. Avoid oversized dashboard numbers: Novaris is a desktop utility, not a marketing analytics product. Use sentence case throughout.

## Layout

- Target a default desktop viewport of **1180 × 760px**, resizable and maximizable.
- Support a minimum usable viewport of **960 × 640px**. Below that width, preserve the sidebar and allow the content region to scroll rather than collapsing into a mobile layout.
- Use a **224px dark sidebar**, a **56px top context bar**, and a scrollable content canvas.
- Cap ordinary page content at **1120px** and use a 24px page gutter. Chat and logs may use the entire available content width.
- Use an 8px base spacing rhythm. Prefer 24px between sections, 16px within cards, and 8–12px between related controls.
- Keep the primary page action in the top-right page header. Sticky form footers may contain `Discard` and `Save changes` when a settings page exceeds one viewport.
- Use two-column form layouts only when fields are closely related; otherwise use a readable 560–680px form column.

## Elevation & Depth

Prefer borders and surface contrast over shadows. Cards use a 1px neutral border and, at most, a subtle `0 1px 2px` shadow. Menus, dialogs, and popovers may use a stronger but soft shadow. Never place the entire application inside a floating rounded card.

## Shapes

Use 8px rounding for controls and 12px for cards. Pills are limited to compact statuses, filters, and version badges. Tables, log viewers, and chat panes should feel structured rather than bubbly. Avoid excessive fully rounded buttons.

## Components

- **Application shell:** Dark left sidebar with the Novaris mark, six labeled destinations, and version/update status at the bottom. A slim top bar shows current device identity and global agent/network state.
- **Page header:** One clear `h1`, optional one-line context, and no more than two immediate actions.
- **Status card:** Icon, short label, explicit state, and one operational detail such as `Last report 2 min ago`. Never invent metrics not supplied by the runtime.
- **Activity table:** Group rows by lifecycle, collection, reporting, and integration. Show state, interval, run count, last run, and configuration toggle. Failed rows expose a concise error with a path to logs.
- **Form section:** Titled white card with aligned labels, validation close to fields, and optional advanced disclosure. Credentials are password fields and never repopulate with stored secrets.
- **Chat workspace:** Conversation history occupies most of the page; connection controls live in a compact header; composer remains docked at the bottom. Approval, secret, sudo, and clarification requests render as explicit inline request cards.
- **Log viewer:** Monospaced, selectable output with level filter, search, refresh, open-file, and copy actions. Preserve raw content; do not color entire lines when a small severity marker is sufficient.
- **Switch:** Use for immediate binary configuration only. If changing a switch restarts the agent, label that consequence before confirmation and show the pending restart state.
- **Dialog:** Use for agent stop, real remote-action enablement, credential replacement, and app restart/update. Default focus must be the safe action.
- **Toast/banner:** Use a page-local banner for persistent errors and a toast only for completed, reversible feedback such as `Configuration saved`.

## Do's and Don'ts

### Do

- Lead with current health and the next useful action.
- Separate Overview, Activities, Assistant, Settings, and Diagnostics.
- Preserve existing IPC/data contracts and label unavailable values honestly.
- Use progressive disclosure for advanced intervals, retries, logging, and remote actions.
- Keep credentials redacted after save and distinguish `Configured` from `Not configured`.
- Pair every state color with text and an icon.
- Support keyboard navigation, 44px minimum hit targets for prominent actions, and WCAG AA contrast.
- Show when a configuration change requires an agent restart.

### Don't

- Do not put every status, integration, chat, process, update, log, and configuration control on one scrolling card.
- Do not mimic a browser SaaS dashboard with a marketing hero, oversized KPIs, or decorative charts.
- Do not fabricate CPU, memory, incident, sync, or activity data that the current Electron contracts do not provide.
- Do not use color alone for running, stopped, failed, or disabled states.
- Do not expose stored tokens or API keys in plain text.
- Do not allow a dangerous action to sit adjacent to a routine save action without separation and confirmation.
- Do not implement a compact/mobile navigation mode for this desktop-only redesign.
