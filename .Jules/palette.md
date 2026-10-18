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
