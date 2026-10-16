<!-- ciel-doc: historical -->
## 2026-10-14 - Add aria-hidden to decorative icons
**Learning:** Decorative icons and emojis (like carets and lightbulbs) in UI components can be noisy for screen reader users, especially when the state (like expanded/collapsed) is already communicated via attributes like `aria-expanded` on the parent element.
**Action:** Add `aria-hidden=true` to decorative icons that don't provide unique semantic meaning to prevent screen readers from redundantly announcing them.
## 2026-10-15 - [Added explicit label-to-input association for form fields]
**Learning:** Replaced aria-label with semantic HTML <label>s using htmlFor/id pairs. This expands the clickable hit area for mouse users (click-to-focus) and provides better semantic associations for screen readers without relying purely on ARIA. This also required updating the custom test utilities to find inputs by their associated labels.
**Action:** Prioritize native HTML semantics (<label htmlFor>) over ARIA attributes (aria-label) for form inputs whenever possible. When doing so, ensure test utilities that rely on aria-label are updated to trace label associations.
## 2024-05-18 - Improve Screen Reader Context for Disclosure Components
**Learning:** This app heavily uses native `<button>` tags paired with generic ARIA patterns via `h(button, ...)` for UI interactability. However, complex toggle states (like `adv-disclosure` toggling `adv-body` or settings groups toggling forms) often missed explicit linkage via `aria-controls`, and repetitive generic actions (like "Reset") lacked specific context.
**Action:** Always link expandable sections to their triggers via `id` and `aria-controls` explicitly when dealing with grouped content or disclosures, especially in custom UI built with `React.createElement`. Ensure generic actions specify their target context.
