Generate a commit message strictly following the "Conventional Commits" specification based on the provided diffs.

## Format

<type>(<scope>): <subject>

<body>

## Rules

### Type (required)
Use ONLY one of the following:
- feat: A new feature
- fix: A bug fix
- refactor: Code change that neither fixes a bug nor adds a feature
- docs: Documentation only changes
- style: Formatting, missing semicolons, etc; no code logic change
- perf: Performance improvement
- test: Adding or updating tests
- build: Changes affecting the build system
- ci: CI/CD configuration changes
- chore: Maintenance tasks, dependency updates, or auxiliary tool changes
- revert: Reverting a previous commit

### Scope (optional)
A noun describing the section of the codebase (e.g., auth, api, ui, parser, config).

### Subject (required)
- Use imperative mood (e.g., "add feature" not "added feature" or "adding feature")
- Lowercase the first letter
- No period at the end
- Keep it short and concise
- If the change introduces a BREAKING CHANGE, add ! after type/scope (e.g., feat(api)!: remove deprecated endpoints)

### Body (optional, use when changes are complex)
- Explain the "what" and "why", not just "how"
- Use a hyphen (-) for bullet points, start each point with uppercase
- CRITICAL: Keep each bullet point on a SINGLE line. Do NOT insert manual line breaks. Let the editor handle wrapping
- CRITICAL: Do NOT use Markdown formatting (no **bold**, no ### headers). Keep it plain text suitable for terminal git log

## Constraints
- Output ONLY the raw commit message. No explanations, no code fences, no extra commentary
- Do NOT output names, email addresses, or any PII not explicitly in the diffs
- Do NOT output bug IDs or unique identifiers not explicitly in the diffs
- If multiple logical changes exist, focus on the primary change for the type

## Examples

feat(profile): implement user profile component with React and TypeScript

Replace the legacy class-based profile view with functional components and Hooks to improve readability and leverage strict type checking.

- Create UserProfile functional component with TypeScript interfaces for props
- Migrate profile state management to use the useReducer hook
- Add Avatar component using next/image for optimized image loading

---

fix(ui): prevent infinite re-render loop in `useEffect`

---

refactor(api): replace `axios` with native `fetch` in service layer

---

chore(deps): bump `typescript` from 5.0.4 to 5.2.2

---

docs(changelog): update for v1.2.0 and clear completed active plan

Record the newly extracted `CommonButton` and `ModalDialog` components in `CHANGELOG.md` for the v1.2.0 release.

---

build(deps)!: remove TSLint and enforce ESLint

Update `package.json` to remove TSLint entirely and migrate to ESLint with the latest TypeScript plugin for modern linting standards across the project.

BREAKING CHANGE: The legacy `.tslintrc` configuration is no longer supported. All developers must use the new `.eslintrc.js` configuration and update their IDE plugins to support ESLint.
