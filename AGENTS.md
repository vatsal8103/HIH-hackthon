## Project Documentation Requirements

### descision.md — Decision Log
- Maintain this file whenever a meaningful implementation, architecture, dependency, debugging, testing, or design decision is made during code changes.
- For each decision, record the date, the decision, the reason, the approach chosen, alternatives considered when relevant, and the expected trade-offs.
- Briefly explain which files, components, methods, or technologies are involved and why they were selected.
- Record important rejected approaches and why they were rejected.
- Update existing entries when a decision changes; do not silently rewrite history.
- Do not log trivial edits, routine formatting, or every line of code.
- Never invent decisions or claim tests passed when they were not run.

### flow.md — Execution Flow
- Document the actual end-to-end execution path through the codebase.
- Trace the flow in execution order, from the entry point through modules, files, functions, services, and important data transformations to the output.
- Explain which file calls which function or module, what data passes between them, and why each stage exists.
- Include relevant branches, asynchronous operations, error handling, and hardware interactions where applicable.
- Update the document whenever a code change materially changes the execution flow.
- Verify the flow against the source code. Mark uncertain or unverified paths clearly.
- Use concise numbered steps and Mermaid diagrams when they improve clarity.

### Required workflow
- Before changing code, inspect the relevant existing implementation and documentation.
- Follow Ponytail's simplicity-first rules. Avoid unnecessary abstractions, dependencies, and unrelated refactoring.
- After meaningful code changes, update descision.md and flow.md as applicable.
- Run relevant tests or checks and report what was actually verified.
- Review the final diff for regressions and unintended changes.
- Preserve existing project conventions and user changes.