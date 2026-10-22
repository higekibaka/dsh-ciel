<!-- ciel-doc: historical -->
## 2026-10-14 - Add aria-hidden to decorative icons
**Learning:** Decorative icons and emojis (like carets and lightbulbs) in UI components can be noisy for screen reader users, especially when the state (like expanded/collapsed) is already communicated via attributes like `aria-expanded` on the parent element.
**Action:** Add `aria-hidden=true` to decorative icons that don't provide unique semantic meaning to prevent screen readers from redundantly announcing them.
## 2026-10-15 - [Added explicit label-to-input association for form fields]
**Learning:** Replaced aria-label with semantic HTML <label>s using htmlFor/id pairs. This expands the clickable hit area for mouse users (click-to-focus) and provides better semantic associations for screen readers without relying purely on ARIA. This also required updating the custom test utilities to find inputs by their associated labels.
**Action:** Prioritize native HTML semantics (<label htmlFor>) over ARIA attributes (aria-label) for form inputs whenever possible. When doing so, ensure test utilities that rely on aria-label are updated to trace label associations.
## 2024-05-18 - Improve Context of Repeated UI Elements
**Learning:** In dynamically generated forms like Settings, identical text buttons like "重置" (Reset) or "重试" (Retry) appear multiple times across different inputs, which causes screen reader users to lose the context of *what* is being reset or retried.
**Action:** Always append dynamic contextual labels via `aria-label` and `title` on identical buttons inside mapping functions to provide context to screen readers and visually-impaired users using tooltips.
## 2024-05-18 - Improve Screen Reader Context for Disclosure Components
**Learning:** This app heavily uses native `<button>` tags paired with generic ARIA patterns via `h(button, ...)` for UI interactability. However, complex toggle states (like `adv-disclosure` toggling `adv-body` or settings groups toggling forms) often missed explicit linkage via `aria-controls`, and repetitive generic actions (like "Reset") lacked specific context.
**Action:** Always link expandable sections to their triggers via `id` and `aria-controls` explicitly when dealing with grouped content or disclosures, especially in custom UI built with `React.createElement`. Ensure generic actions specify their target context.

## 2026-10-20 - Keep keyboard focus visible across settings controls
**Learning:** Inline reset-button styles cannot express focus-visible, hover, or disabled states, leaving keyboard users without a consistent focus indicator.
**Action:** Use the shared ciel-reset-button class for reset, retry, and secret-clear actions while preserving contextual aria-label/title attributes. Apply themed focus outlines to settings inputs, selects, help disclosures, and group headings.
## 2026-10-21 - Guarantee aria-controls linkage for dynamic disclosures
**Learning:** Disclosure patterns in components like `adv-card` might miss explicit `aria-controls` if the target content lacks an ID (e.g., relying on optional props like `callId`). Screen reader users require this explicit linkage to understand the relationship between the trigger and the content it toggles. Furthermore, manual DOM updates with React.createElement make missing hook invariants easier to overlook.
**Action:** When a dynamic component lacks a deterministic ID from props, generate a stable local ID using `useState` at the top of the component to guarantee `aria-controls` always correctly references the `adv-body` container. Always place hooks before early returns.
