# Project guidance

See README.md for setup, tool behavior, and Localazy retry, caching, and pagination constraints.

- For behavior changes, add or adjust a focused test first and observe it fail for the intended reason before changing production code.
- Implement the fix, then refactor while the tests remain green. Existing tests can cover behavior-preserving refactors.
- Extend existing tests or case tables where practical. Add cases for distinct failure modes, not implementation details or speculative scenarios.
- Keep mocks and fixtures local to tests that need them.
- Preserve supported behavior when simplifying. Flag proposed behavior reductions explicitly before implementing them.
- Single-project operation is deliberate. Do not add project ID parameters or multi-project support unless explicitly requested.
- The rate-limit defaults are intentional and based on observed API behavior; do not align them with published limits without new measurements. See README.md.

## Verification

- Automated tests must not call the live Localazy API. During manual verification, live reads are allowed, but uploads are prohibited because the project contains production translations.
- During TDD, run the focused test. After the completed code change, run `npm run build`, `npm test`, and `node_modules/.bin/tsc -p test/tsconfig.json`.
- Documentation-only changes need no tests.
