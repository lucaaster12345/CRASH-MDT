---
version: alpha
colors:
  canvas: "#141a22"
  panel: "#1b2430"
  rule: "#344252"
  ink: "#eef2f5"
  secondary: "#aebdca"
  primary: "#e3bc78"
typography:
  headings:
    fontFamily: "Barlow Semi Condensed, Segoe UI, sans-serif"
  body:
    fontFamily: "Source Sans 3, Segoe UI, sans-serif"
  identifiers:
    fontFamily: "IBM Plex Mono, Consolas, monospace"
rounded:
  control: 4px
spacing:
  small: 8px
  medium: 16px
  large: 24px
omitted:
  - section: components
    reason: Component state rules live in UX-CONTRACT.md and the application stylesheet.
---

# C.R.A.S.H. MDT

## Overview

An English-language investigation desk with the hierarchy of a case jacket. Record numbers anchor the page. Open records stay in a separate strip above the working surface so investigators can switch without losing their place.

## Colors

Slate navy is the dominant surface. The primary amber maps to the runtime accent and identifies the active record, keyboard focus, and primary actions. Error and success colors accompany explicit text. Runtime values live in apps/web/src/styles.css.

## Typography

Condensed headings keep wide records scannable. Body text uses a regular humanist sans and grows to a comfortable report-reading size. Monospace is reserved for identifiers and one-time codes. System fallbacks keep the app self-hosted.

## Layout

Persistent desktop rail, horizontal record strip, and one scroll surface per open record. Narrow layouts convert the rail into horizontal navigation, wrap forms, and keep wide tables locally scrollable.

## Elevation & Depth

Flat surfaces use rules. A modal uses the native dialog backdrop.

## Shapes

Small control radii and rectangular panels echo the filing interface without adding decoration.

## Components

Shared page headings, field labels, forms, record tables, status regions, and confirmation dialogs keep the same hierarchy across workflows.

## Do's and Don'ts

Give case numbers and long titles separate lines when needed. Use text branding and avoid decorative media or data.
