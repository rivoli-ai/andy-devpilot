# SonarCloud remediation plan — DevPilot

**Project:** `benamaraissam86_DevPilot` (SonarCloud org `benamaraissam86`)  
**Purpose:** Open issues grouped by **severity** with a practical **fix order** and approach.  
**Last snapshot:** Based on analysis run ~2026-04-03 (counts may change after new scans).

To refresh numbers locally:

```bash
export SONAR_TOKEN='<token>'   # My Account → Security on sonarcloud.io — never commit
curl -sS -u "${SONAR_TOKEN}:" \
  "https://sonarcloud.io/api/issues/search?organization=benamaraissam86&componentKeys=benamaraissam86_DevPilot&resolved=false&ps=500" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('total', d['total'])"
```

---

## 1. Overview by severity

| Severity | Count (snapshot) | Nature |
|----------|------------------|--------|
| **BLOCKER** | 6 | Must fix or Sonar-exempt with documented rationale |
| **CRITICAL** | 52 | High priority: security-adjacent, complexity, correctness |
| **MAJOR** | 663 | Significant debt: rules, a11y, duplication, shells |
| **MINOR** | 316 | Polish: many Web/a11y, small smells |
| **INFO** | 83 | Lowest urgency |
| **Total** | **~1120** | |

## 2. Overview by issue type

| Type | Count (snapshot) | Plan |
|------|------------------|------|
| **VULNERABILITY** | 12 | Phase A — security hardening (see §4) |
| **BUG** | 54 | Phase D — after security/blockers; prioritize MAJOR bugs |
| **CODE_SMELL** | 1054 | Phases B–C and bulk cleanup (§5–§7) |

---

## 3. BLOCKER — what to fix and how

| # | Rule / theme | Location (examples) | Fix plan |
|---|----------------|----------------------|----------|
| 1 | `typescript:S7651` — `@Output()` must not mimic standard DOM event names | `add-backlog-item-modal.component.ts` (~760), `ai-settings-modal.component.ts` (~543), `backlog-generator-modal.component.ts` (~397) | Rename outputs to non-reserved names (e.g. `itemSaved`, `settingsApplied`); update parent templates `(binding)="..."`. |
| 2 | `csharpsquid:S2953` — `Dispose` naming / `IDisposable` | `ACPClient.cs` (~299, ~308) | Either implement real `IDisposable` + `Dispose(bool)` pattern **or** rename methods so they are not `Dispose` unless they are the official disposal contract. |
| 3 | `python:S8392` — bind to all interfaces | `infra/sandbox/manager/manager.py` (~531) | Bind to `127.0.0.1` or a configurable host; avoid `0.0.0.0` unless required and documented behind firewall/reverse proxy. |

**Exit criteria:** 0 open BLOCKER, or each marked **Accepted** in Sonar with a short comment.

---

## 4. CRITICAL — security & high-impact (prioritize first among CRITICAL)

### 4.1 Vulnerability-related (also listed under MAJOR/CRITICAL in Sonar)

| Theme | Rule | Locations / notes | Fix plan |
|-------|------|---------------------|----------|
| TLS validation off | `csharpsquid:S4830` | `OidcAuthProvider.cs` (~41, ~127) | Remove custom certificate bypass in production; use default validation. Dev-only exceptions must be gated (`#if DEBUG` / env flag) and never default-on. |
| URL path injection | `roslyn.sonaranalyzer.security.cs:S7044` | `AzureDevOpsService.cs` (several lines, e.g. ~101, ~211, ~372, ~444, ~514, ~565, ~1465) | Do not build URL paths from raw user/org/project strings. Use **allow-lists**, `UriBuilder`, encode segments, or typed REST paths; validate IDs (GUIDs, allowed slugs). |
| Credentials in config | `csharpsquid:S2068` | `backend/src/API/appsettings.json` | Ensure no real secrets in repo; use **environment variables**, user secrets, or Key Vault. Placeholder keys still trigger rule — move samples to `appsettings.Development.json.example` without real values. |
| K8s service account | `kubernetes:S6865` | `infra/sandbox/k8s/manifests/backend-deployment.yaml` (~18) | Restrict automounted SA tokens with RBAC or set `automountServiceAccountToken: false` where not needed. |

### 4.2 Maintainability CRITICAL (fix in sprints after §4.1)

| Theme | Rule | Hot spots | Fix plan |
|-------|------|-----------|----------|
| Cognitive complexity | `csharpsquid:S3776` / `typescript:S3776` | `AzureDevOpsService.cs`, `RepositoriesController.cs`, `BacklogController.cs`, sync handlers (`SyncBacklogToAzureDevOpsCommandHandler`, `SyncBacklogToGitHubCommandHandler`), `GitHubService.cs`, `ai-config.service.ts`, `backlog.service.ts`, `vnc.service.ts`, `backlog.component.ts` | Extract private methods, guard clauses, helper classes; split “god methods” into orchestration + steps; target complexity ≤ 15 per function. |
| Unused private fields | `csharpsquid:S4487` | `AuthController`, `UsersController`, `CodeAnalysisService` | Remove unused injections or **use** them (logging, mediator). |
| Async in constructor | `typescript:S7059` | `ai-config.service.ts`, `artifact-feed.service.ts`, `mcp-config.service.ts` | Move async init to `ngOnInit`, `afterNextRender`, or explicit `init()` called from `APP_INITIALIZER` / resolver. |
| Deep nesting | `typescript:S2004` | `backlog.service.ts`, `sandbox-bridge.service.ts`, `backlog.component.ts` | Replace nested lambdas with named functions / private methods; flatten `subscribe` chains with `switchMap`/`finalize` or async/await in dedicated functions. |

---

## 5. MAJOR — bulk themes and plan

| Rule (examples) | Approx. volume | Fix plan |
|-----------------|----------------|----------|
| `css:S7924` / `css:S4666` | Very large (CSS hygiene) | Batch-fix per file: `backlog.component.css`, `repositories.component.css`, `code.component.css`, `vnc-viewer.component.css` — align shorthand/longhand, remove conflicting declarations. |
| `typescript:S2933` | ~119 | Remove redundant `public` on class members where not needed (mechanical codemod / IDE). |
| Shell (`shelldre:*`) | ~77+ | Harden `infra/sandbox/setup.sh`, `install.sh`, `start.sh`: quoting, `set -euo pipefail`, avoid word-splitting; or narrow Sonar scope only for vendored scripts (prefer fixing first-party). |
| `csharpsquid:S1192` | ~49 | Introduce **const** strings / resource class for repeated literals in C#. |
| `typescript:S7781`, `S7764`, `S7735`, etc. | Various | Apply rule messages per file; often modern TS / readonly / use optional chaining consistently. |
| `Web:MouseEventWithoutKeyboardEquivalentCheck` | ~45 | Prefer `<button>`/links for clickable rows; add `keydown`/tabindex where custom controls remain. |
| `Web:S6853`, `FrameWithoutTitleCheck` | Various | Labels, iframes `title`, associate `label for=` with controls. |

**Strategy:** Fix **security-linked MAJOR** first, then **rule families** in bulk (CSS batch, TS `S2933` batch) to drop issue count quickly.

---

## 6. MINOR & INFO

| Focus | Plan |
|-------|------|
| Web accessibility & HTML rules | Batch per feature module after MAJOR CSS/TS waves. |
| INFO findings | Triage in Sonar UI; fix opportunistically or accept with justification. |

---

## 7. Suggested execution order (summary)

| Phase | Scope | Goal |
|-------|--------|------|
| **A** | All **VULNERABILITY** + `S4830`, `S7044`, appsettings secret smell, K8s SA, Python bind | Reduce real risk; pass security gate |
| **B** | All **BLOCKER** | Unblock quality gate / release policy |
| **C** | **CRITICAL** complexity + unused fields + Angular constructor async | Stabilize hot paths (`AzureDevOpsService`, controllers, core services) |
| **D** | **BUG** type (MAJOR first) | Correctness |
| **E** | **MAJOR** bulk: CSS, `S2933`, shell, `S1192`, Web checks | Lower noise; improve UX/a11y |
| **F** | **MINOR** / **INFO** | Continuous cleanup (“clean as you code”) |

---

## 8. Files with highest issue counts (snapshot)

Use as scheduling hints (fix security in these first if flagged):

- `frontend/src/app/features/backlog/backlog.component.css`
- `backend/src/Infrastructure/AzureDevOps/AzureDevOpsService.cs`
- `frontend/src/app/features/backlog/backlog.component.ts` / `.html`
- `frontend/src/app/features/repositories/repositories.component.css`
- `frontend/src/app/features/code/code.component.css` / `.ts`
- `backend/src/Infrastructure/GitHub/GitHubService.cs`
- `infra/sandbox/setup.sh`, `infra/identity/install.sh`, `start.sh`
- `frontend/src/app/features/settings/settings.component.html`
- `frontend/src/app/components/vnc-viewer/vnc-viewer.component.css`

---

## 9. Maintenance

- Re-run the SonarCloud pipeline on each PR; keep **New code** clean under your Quality Gate.
- Update this document when you close a phase or when totals shift significantly after a scan.
