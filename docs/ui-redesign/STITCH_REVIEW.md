# Novaris Agent desktop UI/UX — Stitch review handoff

Status: design-only review package. No mockup has been implemented in the Electron UI.

## Source artifacts

- Requirements: `docs/ui-redesign/REQUIREMENTS.md`
- Design system: `DESIGN.md`
- Contact sheet: `docs/ui-redesign/stitch-mockups/00-contact-sheet.jpg`
- Individual mockup screenshots: `docs/ui-redesign/stitch-mockups/01-overview.png` through `06-diagnostics.png`

## Google Stitch project

- Title: `Novaris Agent Desktop UI/UX Review`
- Project ID: `5034246502035988727`
- Project resource: `projects/5034246502035988727`
- Visibility: Private
- Device type: Desktop
- Design system: `Novaris Ops Console`
- Design system asset: `assets/ed016a415bdd4861be05bb53b0bb90f2`
- Owner-account URL: <https://stitch.withgoogle.com/projects/5034246502035988727>

The project is private. Open the URL while signed in to the Google account that owns the Stitch project. If Stitch does not resolve the direct URL, open the Stitch home page and select the project by title.

## Generated screens

| Order | Screen | Stitch screen resource | Local review image |
|---|---|---|---|
| 1 | Overview | Project thumbnail / generated Overview screen | `stitch-mockups/01-overview.png` |
| 2 | Activities | `projects/5034246502035988727/screens/1776ece71f9049c9aaa87c85cf49c677` | `stitch-mockups/02-activities.png` |
| 3 | Hermes Chat | `projects/5034246502035988727/screens/5d348454531c46c588e80fa21e821f6e` | `stitch-mockups/03-hermes-chat.png` |
| 4 | Channels | `projects/5034246502035988727/screens/c843c908c1254d058b29746fdf711a46` | `stitch-mockups/04-channels.png` |
| 5 | Settings / Connection | `projects/5034246502035988727/screens/34b2b827df874711aed48f11fd0d014d` | `stitch-mockups/05-settings.png` |
| 6 | Diagnostics / Logs | `projects/5034246502035988727/screens/01e4a62ea5994219bfb6da5321caab20` | `stitch-mockups/06-diagnostics.png` |

Stitch reports each resource-backed screen as Desktop, 2560 × 2048. The downloaded review thumbnails are 512 × 410; the contact sheet is 1520 × 1920.

## Visual verification

All six screens use the intended desktop application structure:

- persistent dark evergreen sidebar;
- compact top context bar with device identity;
- light operational workspace;
- explicit text-and-icon status treatment;
- dense desktop-sized tables, forms, chat, and logs;
- consistent navigation and visual tokens across screens.

No screen looks like a mobile layout or a marketing website. No obvious horizontal clipping is visible in the captured mockups.

### Screen-specific observations

- **Overview:** Strong state-first hierarchy. Health, device configuration, attention state, update strip, and safe stop action are visible.
- **Activities:** The grouped process table, failure expansion, filters, and managed/toggle configuration states are visible and fit the viewport.
- **Hermes Chat:** Uses a full workspace rather than a small widget. The approval request and docked composer are visible.
- **Channels:** The four channel summary cards and gateway controls are visible. The requested Telegram pairing card is not visible in the captured viewport and should be revised or confirmed before implementation.
- **Settings:** The connection form, write-only API-key treatment, status card, restart warning, dirty state, and sticky save actions are visible.
- **Diagnostics:** The dark log viewer, toolbar, tabs, file path, severity labels, and status bar are visible. The sidebar contrast is slightly darker than the other screens and should be normalized during refinement.

## Review decisions requested

1. Approve or change the persistent sidebar information architecture.
2. Approve the evergreen/light operational visual direction.
3. Confirm whether Activities should remain a dense table or use a less dense grouped-list treatment.
4. Confirm Hermes approval requests should remain inline in the conversation.
5. Decide whether Channels should show pending pairings below the cards or in a separate panel.
6. Approve the split Settings structure: tabs plus focused form and status context.
7. Confirm Diagnostics should prioritize the log viewer over update/about content.
8. Identify any screens or states that need another Stitch variant before implementation.

## Scope boundary

This package intentionally contains requirements, a DESIGN.md system, and review mockups only. It does not alter or replace the existing `src-electron/ui/index.html` implementation.
