# Reviewing Security Pull Requests

Treat a security pull request as a report to investigate, not an automatic fix. A scanner becoming green does not prove that the change is safe or necessary.

## Quick review

Answer these five questions:

1. **Is the advisory real?** Find the authoritative GitHub, NVD, package-registry, or project advisory and check the affected and patched versions.
2. **Why is the package installed?** Run `npm explain PACKAGE_NAME` and `npm ls PACKAGE_NAME`.
3. **Can GDMS reach the vulnerable function?** Look for direct or transitive use and determine whether untrusted input can reach it. Package presence alone is not proof of exposure.
4. **Is the proposed fix compatible?** Prefer an ordinary direct-dependency or lockfile update. Do not force a transitive package across a major version without specific compatibility evidence.
5. **Does validation cover the risk?** Run the full checks and a focused reproduction of the vulnerable or overridden behavior.

Useful commands:

```sh
npm explain PACKAGE_NAME
npm ls PACKAGE_NAME
npm audit
npm run check
```

Review the manifest and lockfile diff for unrelated churn, changed Node requirements, new install scripts, unexpected registries, and mismatches between the pull-request description and the versions actually installed.

## Decide

- **Merge** when the advisory applies, the fix is compatible and proportionate, and focused plus complete validation passes.
- **Request changes** when the risk may be real but the proposed fix is broad, incompatible, unexplained, or insufficiently tested.
- **Wait for upstream** when the package is only transitive, the vulnerable path is not credibly reachable, and no compatible update is available.
- **Act quickly** when untrusted input can reach a high- or critical-severity vulnerability. Prefer disabling the exposed path or upgrading a direct dependency before adding a custom patch.

## Overrides

Use an npm override only when a timely fix is needed and a compatible ordinary update is unavailable. Keep it scoped to the affected parent dependency, add a focused regression test, and record when it can be removed. npm does not remove stale overrides automatically.

## Response template

> Thanks for reporting this. Could you provide the authoritative advisory and affected versions, the installed dependency path, and evidence that the vulnerable function is reachable in GDMS? Please also explain why a normal dependency update is unavailable and show that the proposed versions are compatible with their parent dependencies. If the fix uses an override, please add a focused regression test. A clean scanner result alone does not establish that the resulting dependency tree is safe to run.
