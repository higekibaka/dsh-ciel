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
## 2024-10-20 - Ensure consistent focus visible styles
**Learning:** Found several interactive elements (reset buttons, inputs, selects, `<summary>`, and custom group headers) missing standard keyboard focus indicators. The host application leverages `--dsw-alias-state-business-primary` as a standard CSS variable for interactive primary states, making it ideal for standardizing `outline` based focus-visible indicators across custom components.
**Action:** When creating new custom interactive components or refactoring inline styles to classes, always map `:focus-visible` pseudo-class to use standard 2px outline styled with `--dsw-alias-state-business-primary` to guarantee accessible keyboard navigation tracking.
