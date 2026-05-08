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

feat(profile): implement user profile screen with Compose

Replace the legacy XML-based profile view with a declarative Jetpack Compose UI to improve rendering performance and simplify state management.

- Create `UserProfileScreen` composable for the main layout
- Migrate `ProfileViewModel` to expose state via `StateFlow`
- Add `AvatarImage` component using `coil-compose` for image loading

---

fix(ui): prevent infinite recomposition in `LazyColumn`

---

refactor(data): replace `LiveData` with `StateFlow` in repository layer

---

chore(deps): bump `compose-bom` from 2023.08.00 to 2023.10.00

---

docs(changelog): update for v0.10.2 and clear completed active plan

Record the newly extracted `ConfirmableDeleteButton` and `ConfirmableDeleteMenuItem` components in `CHANGELOG.md` for the v0.10.2 release, and remove the finished goal from `ACTIVE_PLAN.md`.

---

build(deps)!: remove Material 2 and enforce Material 3

Update the Gradle version catalog to remove `androidx.compose.material` entirely, enforcing the new Material Design 3 guidelines across the application.

BREAKING CHANGE: The legacy Material 2 library is no longer available. The `MaterialTheme` now explicitly requires a `ColorScheme` instead of `Colors`. All downstream modules must update their components (e.g., `Scaffold`, `Button`) to use imports from `androidx.compose.material3.*`.
