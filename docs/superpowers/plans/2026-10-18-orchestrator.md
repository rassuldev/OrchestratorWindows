# Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web app that takes a detailed software task and drives headless Claude Code CLI through analyze → plan → design → build/verify/review → finalize, with user checkpoints, until a verified working project exists on disk.

**Architecture:** A deterministic, pure state machine (`src/core/stateMachine.ts`) decides the next step; a runner (`src/core/pipeline.ts`) spawns a fresh `claude -p` per step with a role prompt, validates the files the agent wrote, and persists state atomically to `<project>/.orchestrator/state.json`. A Fastify server exposes a JSON API + SSE; a React panel shows the timeline, live log and checkpoint forms.

**Tech Stack:** Node ≥ 24, TypeScript (strict, ESM, run via `tsx` — no server build step), Fastify 5 + @fastify/static, zod 4, React 18 + Vite, Playwright (chromium), vitest.

**Spec:** `docs/superpowers/specs/2026-10-18-orchestrator-design.md`

## Global Constraints

- Single user, local only. Server binds `127.0.0.1`, port **4321** (config `port`).
- Storage = files only, no DB. Project dir `<workspace>/<slug>/`; service files in `<slug>/.orchestrator/`. Default workspace `~/orchestrator-projects` (config `workspace`, env `ORCH_WORKSPACE`).
- Every generated project gets `.gitignore` containing `.orchestrator/` and `.env`.
- One project runs at a time (FIFO queue). Projects waiting on a checkpoint do not block the queue.
- Build loop: implementer → verifier → reviewer; **max 3 attempts** per task, then checkpoint `help`.
- Non-build steps (questions/spec/plan/design/finalize): an agent failure or invalid output is retried **once** with the error as feedback, then checkpoint `help`.
- Step timeout default **45 min** (config `stepTimeoutMin`).
- Agent deny list (exact): `Bash(rm -rf *)`, `Bash(sudo *)`, `Bash(git push *)`, `Bash(docker *)`, `Bash(brew install *)`, `Read(~/.ssh/**)`.
- Sandbox on, `failIfUnavailable: true`, extra writable paths `~/.npm`, `~/Library/Caches`, `~/Library/Developer`; network open.
- Secrets never go into `state.json`, logs, SSE, or the UI after submission; they live only in `<project>/.env`.
- Generated projects: embedded DBs only (SQLite etc.), no Docker, no Homebrew — this is stated in the architect prompt.
- UI copy is Russian. Role prompts are English; agents write human-facing docs (questions, spec, decisions, REPORT) in the language of `task.md`.
- Observed fact (CLI 2.1.251): the final stream-json event can be `{"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate: OAuth session expired…"}` — `subtype` alone never means success.

## Review Focus

1. **Implementer produces no changes** — must count as a failed attempt with feedback "no changes were made", not advance the task. (Task 7 test)
2. **Garbage on stdout** (non-JSON lines, a JSON line split across chunks, a very long line) — parser skips/joins without crashing. (Task 4 test)
3. **Server restarts while a project waits at a checkpoint** — it stays waiting; nothing re-runs. Restart mid-step re-runs only that step, with a resume note. (Task 8 test)
4. **Stale or double input** (double-click "Одобрить", old tab) — rejected with 409, state advances once. (Tasks 3 and 9 tests)
5. **Non-Latin / duplicate project names** ("Мой сайт!", same name twice) — valid unique folder names. (Task 2 test)

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, config.example.json
bin/orch-shot, bin/orch-sim            sh wrappers the agents call (absolute paths go in prompts and sandbox excludedCommands)
prompts/_common.md, analyst_questions.md, analyst_spec.md, architect.md, designer.md,
        implementer.md, verifier.md, reviewer.md, finalizer.md
src/config.ts                          loadConfig
src/core/schemas.ts                    zod schemas + inferred types (state, plan, questions, verdict, design options, user input)
src/core/paths.ts                      projectPaths
src/core/store.ts                      slugify, createProject, loadState, saveState, listProjects, readJson, loadPlan, savePlan
src/core/git.ts                        headCommit, commitAll, diffSince
src/core/stateMachine.ts               pure: nextAction, applyStepOutcome, applyUserInput, flattenTasks
src/core/outputs.ts                    validateOutputs(role, …)
src/core/secrets.ts                    writeEnv, readSecretValues, maskSecrets
src/core/pipeline.ts                   ProjectRunner, submitInput
src/core/scheduler.ts                  Scheduler (queue, recovery, rate-limit backoff, pause/resume)
src/core/events.ts                     EventBus
src/core/notify.ts                     notify, keepAwake
src/core/appRunner.ts                  start/stop the generated app for the demo checkpoint
src/agents/streamParser.ts             StreamParser (stdout chunks → LogEntry + final result)
src/agents/classify.ts                 classifyResult
src/agents/settings.ts                 buildAgentSettings
src/agents/runClaude.ts                runClaude
src/agents/prompts.ts                  buildPrompt
src/tools/screenshot.ts, src/tools/simshot.ts
src/server/index.ts, src/server/routes.ts
web/ (Vite React app: index.html, src/main.tsx, App.tsx, api.ts, components/*.tsx, styles.css)
test/fixtures/fake-claude.mjs          fake CLI for tests
test/**/*.test.ts
```

## Shared Types (defined in Task 1, used everywhere)

```ts
// src/core/schemas.ts — zod schemas; types are z.infer of each
type Role = 'analyst_questions'|'analyst_spec'|'architect'|'designer'|'implementer'|'verifier'|'reviewer'|'finalizer'
type Phase = 'questions'|'await_answers'|'spec'|'await_spec'|'plan'|'design'|'await_plan'
           |'build'|'await_demo'|'finalize'|'needs_help'|'done'
type SubStep = 'implement'|'verify'|'review'

Questions = { questions: {id: string; text: string; options?: string[]}[];
              secrets: {name: string /* ENV_NAME, /^[A-Z][A-Z0-9_]*$/ */; description: string}[] }
Task = { id: string; title: string; description: string; acceptance: string[] /* ≥1 */; verify: string[] }
Milestone = { id: string; title: string; mvp: boolean; tasks: Task[] /* ≥1 */ }
Plan = { platform: 'web'|'ios'|'cli'|'api'|'bot'|'desktop'|'other'; hasUI: boolean;
         runCommand: string; testCommand: string; milestones: Milestone[] }
         // refine: ≥1 milestone, exactly one mvp, task ids unique
Verdict = { pass: boolean; issues: string[]; screenshots?: string[] }
DesignOptions = { options: {id: string; title: string; description: string; file: string /* relative to design/ */}[] } // 2..3
Checkpoint = { kind: 'answers'|'spec'|'plan'|'demo'|'help'; message: string }
StepRecord = { id: string; role: Role; label: string; taskId?: string; attempt: number;
               status: 'running'|'ok'|'failed'|'interrupted'|'limited'; startedAt: string; endedAt?: string;
               costUsd?: number; sessionId?: string; error?: string }
ProjectState = {
  id: string; slug: string; name: string; createdAt: string;
  phase: Phase; subStep: SubStep; taskIndex: number; attempt: number;
  feedback: string | null;          // fed to the next agent run, cleared after a successful step
  resumeNote: boolean;              // next run must first inspect the interrupted work
  help: { phase: Phase; subStep: SubStep } | null;   // where to return from needs_help
  checkpoint: Checkpoint | null;
  demoDone: boolean; chosenDesign: string | null; taskBase: string | null;
  feedbackRounds: number;           // number of demo-feedback milestones appended
  paused: boolean; limitUntil: string | null; limitHits: number; error: string | null;
  currentStepId: string | null; steps: StepRecord[];
}
UserInput =
  | { kind: 'answers'; answers: Record<string,string>; secrets: Record<string,string> }
  | { kind: 'approve'; designId?: string }
  | { kind: 'revise'; comment: string }
  | { kind: 'demo'; comments: string }                 // '' = all good
  | { kind: 'help'; action: 'retry'|'skip'|'continue'; hint?: string }
LogEntry = { t: number; kind: 'text'|'tool'|'tool_result'|'system'|'result'|'error'; text: string }
Config = { orchestratorRoot: string; workspace: string; port: number; claudeBin: string;
           model?: string; stepTimeoutMin: number }
```

---

### Task 1: Scaffold, config and schemas

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `config.example.json`, `.gitignore`, `src/config.ts`, `src/core/schemas.ts`, `src/core/paths.ts`
- Test: `test/core/schemas.test.ts`, `test/config.test.ts`

**Interfaces:**
- Produces: all Shared Types above as zod schemas named `RoleSchema, PhaseSchema, QuestionsSchema, TaskSchema, PlanSchema, VerdictSchema, DesignOptionsSchema, CheckpointSchema, StepRecordSchema, ProjectStateSchema, UserInputSchema` + exported types; `loadConfig(orchestratorRoot: string, env = process.env): Config`; `projectPaths(dir: string): ProjectPaths` with fields `root, orch, state, task, questions, answers, spec, architecture, plan, decisions, designDir, designOptions, logsDir, screenshotsDir, verdictsDir, readme, report, env`.

- [ ] **Step 1:** `npm init`, set `"type": "module"`, `"engines": {"node": ">=24"}`; install deps `fastify @fastify/static zod playwright` and dev deps `typescript tsx vitest @types/node react react-dom @types/react @types/react-dom vite @vitejs/plugin-react`. Scripts: `"test": "vitest run"`, `"start": "vite build web && tsx src/server/index.ts"`, `"dev:web": "vite web"`, `"typecheck": "tsc --noEmit"`. tsconfig: strict, `module`/`moduleResolution` `NodeNext`, `jsx: react-jsx`, include `src test web/src`. `.gitignore`: `node_modules/ web/dist/ config.json`.
- [ ] **Step 2: Write failing tests**

```ts
// test/core/schemas.test.ts
const plan = { platform:'web', hasUI:true, runCommand:'npm start', testCommand:'npm test',
  milestones:[{ id:'m1', title:'Core', mvp:true, tasks:[{ id:'t1', title:'Skeleton', description:'d', acceptance:['runs'], verify:['npm test'] }] }] }
it('accepts a valid plan', () => expect(PlanSchema.parse(plan)).toEqual(plan))
it('rejects a plan without an mvp milestone', () =>
  expect(() => PlanSchema.parse({ ...plan, milestones:[{ ...plan.milestones[0], mvp:false }] })).toThrow())
it('rejects duplicate task ids', () => /* two milestones both containing id 't1' */ expect(...).toThrow())
it('rejects a task with empty acceptance', ...)
it('rejects secret names that are not ENV_STYLE', () =>
  expect(() => QuestionsSchema.parse({ questions:[], secrets:[{ name:'bot token', description:'' }] })).toThrow())
it('requires 2..3 design options', ...)
// test/config.test.ts
it('defaults', () => { const c = loadConfig('/x', { HOME:'/h' });
  expect(c).toMatchObject({ workspace:'/h/orchestrator-projects', port:4321, claudeBin:'claude', stepTimeoutMin:45 }) })
it('reads config.json and env overrides ORCH_WORKSPACE / ORCH_CLAUDE_BIN', ...)
```

- [ ] **Step 3:** Run `npx vitest run test/core/schemas.test.ts test/config.test.ts` → FAIL (modules missing).
- [ ] **Step 4:** Implement schemas (plan refinements via `.superRefine`), `loadConfig` (reads optional `<root>/config.json`, `~` expansion), `projectPaths` (`.orchestrator/` children; `readme`/`report`/`env` are in project root: `README.md`, `REPORT.md`, `.env`).
- [ ] **Step 5:** Run tests → PASS; `npm run typecheck` → no errors.
- [ ] **Step 6:** Commit `feat: scaffold, config and schemas`.

---

### Task 2: Store and git helpers

**Files:**
- Create: `src/core/store.ts`, `src/core/git.ts`
- Test: `test/core/store.test.ts`, `test/core/git.test.ts`

**Interfaces:**
- Consumes: `Config`, `ProjectState`, `projectPaths`, schemas.
- Produces:
  - `slugify(name: string): string` — lowercase, Cyrillic transliterated (simple map а→a … я→ya), non-alnum → `-`, trimmed, max 40 chars; empty → `project`.
  - `createProject(cfg: Config, input: {name: string; task: string}): Promise<{dir: string; state: ProjectState}>` — unique dir (`slug`, `slug-2`, …), `git init`, `.gitignore` (`.orchestrator/\n.env\n`), commit `chore: init`, writes `task.md`, empty `decisions.md`, initial state: `phase:'questions', subStep:'implement', taskIndex:0, attempt:1`, everything else null/false/0/[]; `id` = `randomUUID()`.
  - `loadState(dir): Promise<ProjectState>`, `saveState(dir, s): Promise<void>` (write `state.json.tmp` then `rename`).
  - `listProjects(cfg): Promise<{dir: string; state: ProjectState}[]>` (dirs in workspace that have `.orchestrator/state.json`, newest first).
  - `findProject(cfg, id): Promise<string | null>` (dir by state id).
  - `readJson<T>(file: string, schema: z.ZodType<T>): Promise<T>`; `loadPlan(dir): Promise<Plan | null>`; `savePlan(dir, plan)`.
  - `headCommit(dir): Promise<string>`, `commitAll(dir, message): Promise<boolean>` (false when nothing to commit), `diffSince(dir, base): Promise<string>` (`git diff base..HEAD`, truncated to 200 KB).

- [ ] **Step 1: Write failing tests** (temp workspace via `fs.mkdtemp` in `os.tmpdir()`)

```ts
it('slugify', () => {
  expect(slugify('Мой сайт!')).toBe('moy-sayt')
  expect(slugify('Todo App 2')).toBe('todo-app-2')
  expect(slugify('!!!')).toBe('project')
})
it('createProject makes a git repo with gitignore, task.md and queued state', async () => {
  const { dir, state } = await createProject(cfg, { name:'Мой сайт', task:'Сделай сайт' })
  expect(path.basename(dir)).toBe('moy-sayt')
  expect(await readFile(join(dir,'.gitignore'),'utf8')).toContain('.orchestrator/')
  expect(await readFile(join(dir,'.gitignore'),'utf8')).toContain('.env')
  expect(await readFile(projectPaths(dir).task,'utf8')).toBe('Сделай сайт')
  expect(state.phase).toBe('questions')
  expect((await execGit(dir,'log','--oneline')).trim()).toMatch(/chore: init/)
})
it('same name twice → moy-sayt-2', ...)
it('saveState is atomic and round-trips; no .tmp left behind', ...)
it('listProjects returns both projects, newest first', ...)
it('commitAll returns false on a clean tree, true after a change; diffSince shows the change', ...)
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement (`execFile('git', …)` via `node:child_process` promisified; set `GIT_AUTHOR_NAME/EMAIL` fallbacks `Orchestrator`/`orchestrator@localhost` in env so commits work without global git config).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: file store and git helpers`.

---

### Task 3: Pure state machine

**Files:**
- Create: `src/core/stateMachine.ts`
- Test: `test/core/stateMachine.test.ts`

**Interfaces:**
- Consumes: schema types.
- Produces:
  - `type Action = {kind:'run'; role: Role; taskId?: string} | {kind:'wait'} | {kind:'done'}`
  - `type StepOutcome = {ok: true; verdict?: Verdict} | {ok: false; error: string}`
  - `nextAction(s: ProjectState, plan: Plan | null): Action`
  - `applyStepOutcome(s: ProjectState, plan: Plan | null, o: StepOutcome): ProjectState`
  - `applyUserInput(s: ProjectState, plan: Plan | null, input: UserInput): {state: ProjectState; plan: Plan | null}` — throws `CheckpointMismatchError` (exported class) when input kind doesn't fit `s.checkpoint`.
  - `flattenTasks(plan: Plan): Task[]`
  - `MAX_BUILD_ATTEMPTS = 3`, `MAX_OTHER_ATTEMPTS = 2`

Rules (the implementer must encode exactly these):
- `nextAction`: `paused` or `limitUntil` set or `error` set → `wait`. Phase → role: `questions→analyst_questions`, `spec→analyst_spec`, `plan→architect`, `design→designer`, `build` → `implementer|verifier|reviewer` by `subStep` (with `taskId` = current task id), `finalize→finalizer`; `await_*`/`needs_help` → `wait`; `done` → `done`.
- `applyStepOutcome` success (clears `feedback`, `resumeNote`, `limitHits`; `attempt=1` unless stated):
  - `questions → await_answers` (checkpoint `answers`); `spec → await_spec` (`spec`); `plan → design` if `plan.hasUI` else `await_plan` (`plan`); `design → await_plan`; `finalize → done`.
  - build `implement → verify`; `verify` pass → `review`; `review` pass → advance task.
  - `verify`/`review` with `verdict.pass === false` → `subStep:'implement'`, `attempt+1`, `feedback` = `"Verifier found:\n- …"` / `"Reviewer found:\n- …"`; if new attempt > 3 → `needs_help`.
  - Advance task: `taskIndex+1, subStep:'implement', attempt:1, taskBase:null`. If the finished task was the last task of the `mvp` milestone and `!demoDone` → `await_demo` (checkpoint `demo`). Else if `taskIndex` ≥ task count → `finalize`.
- Failure (`ok:false`): same phase/subStep, `attempt+1`, `feedback = "Previous attempt failed: " + error`; exceeding the limit (3 in build, 2 elsewhere) → `needs_help`.
- Entering `needs_help`: `help = {phase, subStep}` of the failing step, checkpoint `{kind:'help', message: <last error or issues>}`.
- `applyUserInput` (clears `checkpoint`):
  - `answers` @ `answers` → `spec`. (Secrets are handled by the pipeline, never stored here.)
  - `approve` @ `spec` → `plan`; @ `plan` → `build` (`taskIndex 0`, `chosenDesign = designId ?? null`).
  - `revise` @ `spec` → `spec` with `feedback = "User asked for changes:\n" + comment`; @ `plan` → `plan` likewise (design is regenerated after).
  - `demo` @ `demo` → `demoDone:true`; non-empty comments → plan gets an appended milestone `{id:'feedback-N', title:'Demo feedback', mvp:false, tasks:[{id:'fb-N', title:'Address demo feedback', description: comments, acceptance:['Every point of the demo feedback is addressed'], verify:[plan.testCommand]}]}` (`N = feedbackRounds+1`); then `build` if tasks remain else `finalize`.
  - `help` @ `help`: `retry` → back to `help.phase/subStep`, `attempt:1`, `feedback = hint ? "User hint: " + hint : null`; `skip` (build only, else mismatch) → advance task; `continue` → build: `subStep:'verify', attempt:1`; non-build: same as `retry`.

- [ ] **Step 1: Write failing tests.** Helper `run(s, plan, outcomes…)` folds outcomes. Required cases:

```ts
const plan2 = /* hasUI:true, milestones m1(mvp:[t1]) and m2([t2]) */
it('happy path reaches done with checkpoints in order', () => {
  let s = initial()                                   // phase 'questions'
  expect(nextAction(s, null)).toEqual({ kind:'run', role:'analyst_questions' })
  s = applyStepOutcome(s, null, { ok:true });              expect(s.checkpoint?.kind).toBe('answers')
  s = applyUserInput(s, null, { kind:'answers', answers:{}, secrets:{} }).state; expect(s.phase).toBe('spec')
  s = applyStepOutcome(s, null, { ok:true });              expect(s.phase).toBe('await_spec')
  s = applyUserInput(s, null, { kind:'approve' }).state;   expect(s.phase).toBe('plan')
  s = applyStepOutcome(s, plan2, { ok:true });             expect(s.phase).toBe('design')
  s = applyStepOutcome(s, plan2, { ok:true });             expect(s.phase).toBe('await_plan')
  s = applyUserInput(s, plan2, { kind:'approve', designId:'b' }).state
  expect(s.chosenDesign).toBe('b'); expect(nextAction(s, plan2)).toEqual({ kind:'run', role:'implementer', taskId:'t1' })
  s = applyStepOutcome(s, plan2, { ok:true })                                    // → verify
  s = applyStepOutcome(s, plan2, { ok:true, verdict:{ pass:true, issues:[] } })  // → review
  s = applyStepOutcome(s, plan2, { ok:true, verdict:{ pass:true, issues:[] } })  // t1 done, mvp boundary
  expect(s.phase).toBe('await_demo')
  s = applyUserInput(s, plan2, { kind:'demo', comments:'' }).state
  expect(nextAction(s, plan2)).toEqual({ kind:'run', role:'implementer', taskId:'t2' })
  /* t2 implement/verify/review pass */                expect(s.phase).toBe('finalize')
  s = applyStepOutcome(s, plan2, { ok:true });             expect(s.phase).toBe('done'); expect(nextAction(s, plan2)).toEqual({ kind:'done' })
})
it('hasUI=false skips design', ...)
it('verify fail sends issues back to implementer as feedback, attempt 2', () => {
  /* at build/verify attempt 1 */ s = applyStepOutcome(s, plan2, { ok:true, verdict:{ pass:false, issues:['button broken'] } })
  expect(s).toMatchObject({ subStep:'implement', attempt:2 }); expect(s.feedback).toContain('button broken')
})
it('third failed attempt goes to needs_help with help pointer', () => { /* … */ expect(s.phase).toBe('needs_help'); expect(s.help).toEqual({ phase:'build', subStep:'implement' }) })
it('non-build failure retries once then needs_help', ...)
it('help retry returns to the failed step with the hint as feedback', ...)
it('help skip advances to the next task; help continue goes to verify', ...)
it('help skip outside build throws CheckpointMismatchError', ...)
it('revise spec re-runs analyst_spec with the comment as feedback', ...)
it('demo comments append a feedback milestone and build it before finalize', () => {
  const { state, plan } = applyUserInput(atDemo, plan2, { kind:'demo', comments:'make header blue' })
  expect(flattenTasks(plan!).at(-1)).toMatchObject({ id:'fb-1', description:'make header blue' })
})
it('approve while at answers checkpoint throws CheckpointMismatchError', ...)
it('second approve after the first (no checkpoint) throws CheckpointMismatchError', ...)  // Review Focus 4
it('paused / limitUntil / error → wait', ...)
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement as pure functions (`structuredClone` input, return new objects).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: pure pipeline state machine`.

---

### Task 4: Stream parser and result classifier

**Files:**
- Create: `src/agents/streamParser.ts`, `src/agents/classify.ts`
- Test: `test/agents/streamParser.test.ts`, `test/agents/classify.test.ts`

**Interfaces:**
- Produces:
  - `type ResultEvent = { subtype: string; is_error: boolean; result?: string; session_id?: string; total_cost_usd?: number; api_error_status?: number | null; terminal_reason?: string }`
  - `class StreamParser { push(chunk: string): LogEntry[]; end(): LogEntry[]; result: ResultEvent | null }` — buffers partial lines; ignores blank and non-JSON lines (emits nothing for them); maps `assistant` content `text` → `{kind:'text'}`, `tool_use` → `{kind:'tool', text: name + ' ' + short input}` (Bash → command, Edit/Write/Read → file_path, else JSON truncated to 200 chars); `user` `tool_result` → `{kind:'tool_result', text: first 300 chars}`; `system` `init` → `{kind:'system', text:'session started (model …)'}` (other system subtypes ignored, except `api_retry` → `{kind:'system', text:'API retry: <error>'}`); `result` → stores `result`, emits `{kind:'result', text: result ?? subtype}`.
  - `type Classified = {kind:'ok'} | {kind:'rate_limited'} | {kind:'auth'; message: string} | {kind:'error'; message: string}`
  - `classifyResult(result: ResultEvent | null, exitCode: number | null, stderrTail: string): Classified`

Classification rules: `result && !result.is_error && result.subtype === 'success'` → ok. Otherwise build `msg = result?.result ?? stderrTail`; `api_error_status === 429` or `/hit your .*limit|rate.?limit|429|temporarily limiting|usage limit/i` → rate_limited; `api_error_status` 401/403 or `/authenticat|log ?in|oauth|invalid api key|token revoked/i` → auth; else error (`message` = msg or `exit code N`).

- [ ] **Step 1: Write failing tests**

```ts
it('joins a JSON line split across chunks', () => {
  const p = new StreamParser(); const line = JSON.stringify({ type:'assistant', message:{ content:[{ type:'text', text:'hi' }] } })
  expect(p.push(line.slice(0,10))).toEqual([]); expect(p.push(line.slice(10)+'\n')[0]).toMatchObject({ kind:'text', text:'hi' })
})
it('skips non-JSON lines and survives a 2 MB line', ...)                      // Review Focus 2
it('summarizes Bash tool_use by command', ...)
it('captures the result event', ...)
it('real auth failure from CLI 2.1.251 is auth', () => expect(classifyResult(
  { subtype:'success', is_error:true, result:'Failed to authenticate: OAuth session expired and could not be refreshed' }, 1, '')).toMatchObject({ kind:'auth' }))
it("\"You've hit your session limit · resets 3:45pm\" is rate_limited", ...)
it('api_error_status 429 is rate_limited', ...)
it('no result + exit 1 is error with stderr tail', ...)
it('success is ok', ...)
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: stream-json parser and result classifier`.

---

### Task 5: Agent settings, runClaude and the fake CLI

**Files:**
- Create: `src/agents/settings.ts`, `src/agents/runClaude.ts`, `test/fixtures/fake-claude.mjs`
- Test: `test/agents/settings.test.ts`, `test/agents/runClaude.test.ts`

**Interfaces:**
- Consumes: `StreamParser`, `classifyResult`, `Config`.
- Produces:
  - `buildAgentSettings(orchestratorRoot: string): object` — exactly:
    ```json
    { "sandbox": { "enabled": true, "autoAllowBashIfSandboxed": true, "failIfUnavailable": true,
        "allowUnsandboxedCommands": false,
        "excludedCommands": ["xcodebuild *", "xcrun simctl *", "<root>/bin/orch-shot *", "<root>/bin/orch-sim *"],
        "filesystem": { "allowWrite": ["~/.npm", "~/Library/Caches", "~/Library/Developer"] } },
      "permissions": {
        "allow": ["WebFetch(domain:*)", "WebSearch", "Bash(xcodebuild *)", "Bash(xcrun simctl *)",
                  "Bash(<root>/bin/orch-shot *)", "Bash(<root>/bin/orch-sim *)"],
        "deny": ["Bash(rm -rf *)", "Bash(sudo *)", "Bash(git push *)", "Bash(docker *)", "Bash(brew install *)", "Read(~/.ssh/**)"] } }
    ```
    (`WebFetch(domain:*)` is the documented way to open sandbox network to all hosts.)
  - `type RunResult = { classified: Classified; result: ResultEvent | null; exitCode: number | null; durationMs: number }`
  - `runClaude(opts: { cfg: Config; cwd: string; systemPrompt: string; prompt: string; onEntry: (e: LogEntry) => void; signal?: AbortSignal; timeoutMs?: number }): Promise<RunResult>` — spawns `cfg.claudeBin` with args `['-p', prompt, '--output-format','stream-json', '--verbose', '--append-system-prompt', systemPrompt, '--permission-mode','acceptEdits', '--settings', JSON.stringify(buildAgentSettings(cfg.orchestratorRoot)), ...(cfg.model ? ['--model', cfg.model] : [])]`, `stdin` ignored; on timeout/abort sends SIGTERM, then SIGKILL after 5 s, and returns `classified: {kind:'error', message:'timeout'|'aborted'}`; keeps last 4 KB of stderr.
- `fake-claude.mjs` behavior: reads the role from the first line of the `--append-system-prompt` value (`ROLE: <role>`); reads JSON from env `FAKE_CLAUDE_SCRIPT` (a file path) shaped `{ [role]: Array<'ok'|'fail'|'crash'|'rate_limit'|'auth'|'hang'|'noop'> }`, consuming one entry per call via a counter file next to it (default `'ok'`); on `ok`/`fail` it writes that role's output files in cwd (questions.json, spec.md, architecture.md + plan.json from env `FAKE_PLAN` or a built-in 2-task plan with hasUI false, design files, a code file `src/<task>.txt` for implementer, verdict files with `pass` true for ok / false for fail, README.md + REPORT.md for finalizer); the verdict file path and task id come from the prompt text lines `VERDICT_FILE: …` and `TASK_ID: …` (Task 6 guarantees these lines); emits `system init`, one `assistant` text, and a `result` event (`rate_limit` → `is_error:true, result:"You've hit your session limit · resets 3:45pm"`; `auth` → the OAuth text above; `crash` → exit 1 with stderr `boom`, no result; `hang` → sleeps forever; `noop` → success but writes nothing). Extra env switches: `FAKE_ARGV_FILE` — append `JSON.stringify(process.argv.slice(2))` + newline to that file; `FAKE_ECHO_ENV=1` — include the contents of `./.env` in the assistant text (to test masking).

- [ ] **Step 1: Write failing tests**

```ts
it('settings deny list and sandbox are exact', () => {
  const s = buildAgentSettings('/orch') as any
  expect(s.permissions.deny).toEqual(['Bash(rm -rf *)','Bash(sudo *)','Bash(git push *)','Bash(docker *)','Bash(brew install *)','Read(~/.ssh/**)'])
  expect(s.sandbox).toMatchObject({ enabled:true, failIfUnavailable:true, allowUnsandboxedCommands:false })
  expect(s.sandbox.excludedCommands).toContain('/orch/bin/orch-shot *')
})
it('runs the fake CLI and streams entries; ok result', async () => { /* cfg.claudeBin = fake; expect entries include kind 'text' and classified.kind 'ok' */ })
it('passes --append-system-prompt and --settings', ...)   // fake echoes argv into a file when FAKE_ARGV_FILE is set
it('timeout kills a hanging process and reports timeout', async () => { /* timeoutMs: 300 */ })
it('abort signal kills the process', ...)
it('crash → error with stderr tail "boom"', ...)
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (make `fake-claude.mjs` executable, `#!/usr/bin/env node`). **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: headless claude runner with sandbox settings`.

---

### Task 6: Role prompts and prompt builder

**Files:**
- Create: `prompts/_common.md`, `prompts/{analyst_questions,analyst_spec,architect,designer,implementer,verifier,reviewer,finalizer}.md`, `src/agents/prompts.ts`
- Test: `test/agents/prompts.test.ts`

**Interfaces:**
- Consumes: `projectPaths`, `Plan`, `Task`, `ProjectState`, `Role`.
- Produces: `buildPrompt(role: Role, ctx: { dir: string; state: ProjectState; plan: Plan | null; orchestratorRoot: string }): Promise<{ system: string; prompt: string; verdictFile?: string }>`
  - `system` = `"ROLE: <role>\n"` + `_common.md` + `<role>.md`.
  - `prompt` contains: absolute paths of every `.orchestrator` file the role reads/writes; for build roles the lines `TASK_ID: <id>` and the task JSON (title, description, acceptance, verify), plan `testCommand`/`runCommand`, `platform`; for verifier/reviewer `VERDICT_FILE: <verdictsDir>/<taskId>-a<attempt>-<verify|review>.json` (returned as `verdictFile`); reviewer also `BASE_COMMIT: <state.taskBase>`; `FEEDBACK:` block when `state.feedback`; a resume block when `state.resumeNote` ("A previous run of this step was interrupted. First inspect `git status` and the working tree, keep good work, then finish the step."); `chosenDesign` file path for implementer when set; tool commands `<root>/bin/orch-shot <url> <outDir>` and `<root>/bin/orch-sim <app-path> <bundle-id> <out.png>`.
- Prompt content requirements (what each `.md` must say):
  - `_common.md`: you are one step of an automated pipeline; nobody will answer questions — never ask, decide and record; finish the whole step in this run; read the listed `.orchestrator` files first; append significant decisions with a one-line "why" to `decisions.md`; write human-facing text in the language of `task.md`; never touch `.env` except reading; output files must match the given JSON shape exactly.
  - `analyst_questions`: write `questions.json` (shape inline) — only questions whose answer changes what gets built, ≤ 8; list every external secret the product needs in `secrets`.
  - `analyst_spec`: from `task.md` + `answers.json` write `spec.md`: goals, features, acceptance criteria, non-goals; apply FEEDBACK if present.
  - `architect`: write `architecture.md` and `plan.json` (shape inline); first task = skeleton + test runner + run command; each task small (≤ ~1 h of work) with testable `acceptance` and runnable `verify`; exactly one `mvp` milestone; embedded DBs only, no Docker, no Homebrew; for iOS use Xcode project + XCTest; set `platform`, `hasUI`, `runCommand`, `testCommand`.
  - `designer`: 2–3 visibly different directions (typography, layout, color — not the same template recolored), each a self-contained static HTML file in `design/`, screenshot each with `orch-shot` into `design/`; write `design/options.json`; explicitly avoid generic AI look (centered hero + three cards + purple gradient); may use available skills like `impeccable`.
  - `implementer`: implement only TASK_ID with tests; run `verify` commands and the test command until green; follow chosen design; do not commit (the orchestrator commits); apply FEEDBACK.
  - `verifier`: run test command and every `verify` command; start the app when relevant; web → `orch-shot` desktop+mobile and look at the PNGs; iOS → build for simulator (`xcodebuild -project … -destination 'platform=iOS Simulator,name=…'`, no `cd`) and `orch-sim`; check each acceptance criterion; write VERDICT_FILE `{pass, issues, screenshots}`; do not modify source code; stop any servers you started.
  - `reviewer`: review `git diff BASE_COMMIT..HEAD` against the task, spec and architecture; fail only for real defects (bugs, missing acceptance criteria, broken structure, missing tests), not style; write VERDICT_FILE.
  - `finalizer`: run the full test suite; write/refresh `README.md` (what it is, setup, the single run command, tests) and `REPORT.md` (what was built, how to run, decisions summary, known limitations, which secrets go in `.env`); copy `spec.md` and `architecture.md` into `docs/`.

- [ ] **Step 1: Write failing tests**

```ts
it('system starts with ROLE line', async () => expect((await buildPrompt('architect', ctx)).system.split('\n')[0]).toBe('ROLE: architect'))
it('verifier prompt has TASK_ID and VERDICT_FILE for current attempt', async () => {
  const r = await buildPrompt('verifier', ctxAtBuild /* task t1, attempt 2 */)
  expect(r.prompt).toContain('TASK_ID: t1'); expect(r.verdictFile).toMatch(/verdicts\/t1-a2-verify\.json$/); expect(r.prompt).toContain(`VERDICT_FILE: ${r.verdictFile}`)
})
it('includes FEEDBACK block only when feedback is set', ...)
it('includes the resume block when resumeNote', ...)
it('reviewer gets BASE_COMMIT', ...)
it('every role has a prompt file', async () => { for (const r of RoleSchema.options) await expect(buildPrompt(r, ctxFor(r))).resolves.toBeTruthy() })
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Write the prompt files and `buildPrompt`. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: role prompts and prompt builder`.

---

### Task 7: Output validation, secrets and the project runner

**Files:**
- Create: `src/core/outputs.ts`, `src/core/secrets.ts`, `src/core/events.ts`, `src/core/pipeline.ts`
- Test: `test/core/secrets.test.ts`, `test/core/outputs.test.ts`, `test/core/pipeline.e2e.test.ts`

**Interfaces:**
- Consumes: store, git, stateMachine, runClaude, buildPrompt, schemas.
- Produces:
  - `validateOutputs(role: Role, dir: string, verdictFile?: string): Promise<{ok: true; verdict?: Verdict} | {ok: false; error: string}>` — questions → `QuestionsSchema`; spec → `spec.md` non-empty; architect → `architecture.md` non-empty + `PlanSchema`; designer → `DesignOptionsSchema` + every `file` exists in `design/`; verifier/reviewer → `VerdictSchema` at `verdictFile`; finalizer → `README.md` and `REPORT.md` exist; implementer → ok. Error strings name the file and the zod issue.
  - `writeEnv(dir, secrets: Record<string,string>): Promise<void>` (`KEY=value` lines, values with spaces/quotes double-quoted and escaped, mode 0600); `readSecretValues(dir): Promise<string[]>`; `maskSecrets(text: string, values: string[]): string` (values shorter than 4 chars ignored; replaced by `***`).
  - `class EventBus extends EventEmitter` with typed `emitState(id: string, s: ProjectState)` / `emitLog(id: string, stepId: string, e: LogEntry)`; events `'state'`, `'log'`.
  - `class ProjectRunner { constructor(cfg: Config, dir: string, deps: { bus: EventBus; run?: typeof runClaude; notify?: (title: string, msg: string) => void }); runUntilBlocked(): Promise<'waiting'|'done'|'paused'|'rate_limited'|'error'>; abort(): void }`
  - `submitInput(cfg: Config, dir: string, input: UserInput, bus: EventBus): Promise<ProjectState>` — on `answers`: writes `answers.json` (answers only) and `.env` (secrets) **before** the transition; calls `applyUserInput`; saves state and plan if changed; emits state. Re-throws `CheckpointMismatchError`.

`runUntilBlocked` loop (per iteration):
1. Load state + plan. If `currentStepId` is set (interrupted): mark that step `interrupted`, set `resumeNote = true`, clear `currentStepId`, save.
2. `a = nextAction(s, plan)`; `wait` → return `'paused'` if `paused`, `'rate_limited'` if `limitUntil`, `'error'` if `error`, else `'waiting'`; `done` → return `'done'`.
3. If role is implementer and `taskBase` is null → `taskBase = await headCommit(dir)`.
4. Append `StepRecord` (`id` = `${Date.now()}-${role}`, label e.g. `"Задача t1: Skeleton — исполнитель (попытка 1)"`), set `currentStepId`, save, emit.
5. `buildPrompt` → `runClaude` with `onEntry`: mask with `readSecretValues` (read once per step), append JSON line to `logs/<stepId>.jsonl`, `bus.emitLog`.
6. On `rate_limited`: step `limited`, `limitHits+1`, `limitUntil = now + [10,20,40,60][min(limitHits-1,3)] min`, clear `currentStepId`, save, return `'rate_limited'`. On `auth`: step `failed`, `error = "Claude CLI не авторизован: запустите \`claude\` в терминале и выполните /login, затем нажмите «Продолжить»."`, `paused = true`, save, notify, return `'error'`.
7. Outcome: classified `error` → `{ok:false, error: message}`; else `validateOutputs`. Implementer ok → `commitAll(dir, "task-<id>: <title> (attempt N)")`; `false` (no changes) → `{ok:false, error:'No changes were made to the project'}`. Finalizer ok → `commitAll(dir, 'docs: README and REPORT')`.
8. `applyStepOutcome`; step status `ok`/`failed` with `costUsd`, `sessionId`, `error`; clear `currentStepId`; save; emit. If the new phase is `await_*` or `needs_help` → `notify('Orchestrator', '<name>: нужно ваше решение')`; `done` → `notify(…, 'проект готов')`.

`abort()` aborts the current `runClaude` via `AbortController`; the step is then left with `currentStepId` set so the next run treats it as interrupted.

- [ ] **Step 1: Write failing tests**

```ts
// secrets
it('writeEnv quotes values with spaces; file mode 0600', ...)
it('maskSecrets replaces every occurrence, ignores short values', () =>
  expect(maskSecrets('token=abcd1234 and abcd1234', ['abcd1234','ab'])).toBe('token=*** and ***'))
// outputs
it('architect output without plan.json fails naming plan.json', ...)
it('designer option pointing at a missing file fails', ...)
// pipeline e2e (fake claude via cfg.claudeBin, FAKE_CLAUDE_SCRIPT per test, temp workspace)
it('full run with checkpoints produces a committed project', async () => {
  const { dir } = await createProject(cfg, { name:'demo', task:'Make a CLI' })
  const r = new ProjectRunner(cfg, dir, { bus })
  expect(await r.runUntilBlocked()).toBe('waiting')                       // at answers
  await submitInput(cfg, dir, { kind:'answers', answers:{ q1:'yes' }, secrets:{ API_KEY:'secret-value-1' } }, bus)
  expect(await readFile(join(dir,'.env'),'utf8')).toContain('API_KEY=secret-value-1')
  expect(JSON.stringify(await loadState(dir))).not.toContain('secret-value-1')
  expect(await r.runUntilBlocked()).toBe('waiting'); await submitInput(cfg, dir, { kind:'approve' }, bus)   // spec
  expect(await r.runUntilBlocked()).toBe('waiting'); await submitInput(cfg, dir, { kind:'approve' }, bus)   // plan (hasUI false)
  expect(await r.runUntilBlocked()).toBe('waiting'); await submitInput(cfg, dir, { kind:'demo', comments:'' }, bus) // after mvp task
  expect(await r.runUntilBlocked()).toBe('done')
  expect(await gitLog(dir)).toMatch(/task-t1/); expect(await gitLog(dir)).toMatch(/task-t2/)
  expect(existsSync(join(dir,'REPORT.md'))).toBe(true)
})
it('implementer that changes nothing counts as a failed attempt', async () => {  // Review Focus 1
  /* script implementer: ['noop','ok'] → after first build iteration state.attempt === 2 and feedback contains 'No changes' */ })
it('verifier fail loops back to implementer with issues', ...)
it('rate limit sets limitUntil and returns rate_limited without consuming an attempt', ...)
it('auth failure pauses with the login message', ...)
it('secrets are masked in logs/*.jsonl', ...)              // fake echoes the .env value in its assistant text when FAKE_ECHO_ENV=1
it('interrupted step is re-run with the resume note', async () => {
  /* set state.currentStepId to a fake running step, save; run → that step marked 'interrupted';
     FAKE_ARGV_FILE shows prompt contains 'was interrupted' */ })
it('submitInput with the wrong checkpoint throws CheckpointMismatchError and does not change state', ...)
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: project runner with validation, secrets and masking`.

---

### Task 8: Scheduler, recovery, notifications, keep-awake

**Files:**
- Create: `src/core/scheduler.ts`, `src/core/notify.ts`
- Test: `test/core/scheduler.test.ts`, `test/core/notify.test.ts`

**Interfaces:**
- Consumes: `ProjectRunner`, `submitInput`, store, `EventBus`.
- Produces:
  - `notify(title: string, message: string): void` — `execFile('osascript', ['-e', \`display notification ${q(message)} with title ${q(title)}\`])`, errors ignored; `appleScriptString(s: string): string` exported (wraps in quotes, escapes `\` and `"`).
  - `keepAwake: { acquire(): void; release(): void }` — refcounted; first acquire spawns `caffeinate -i`, last release kills it; no-op when `process.platform !== 'darwin'` or env `ORCH_NO_CAFFEINATE=1`.
  - `class Scheduler { constructor(cfg: Config, bus: EventBus, deps?: { runnerFactory?: (dir: string) => ProjectRunner }); start(): Promise<void>; enqueue(dir: string): void; input(dir: string, input: UserInput): Promise<ProjectState>; pause(dir: string): Promise<void>; resume(dir: string): Promise<void>; activeDir(): string | null; idle(): Promise<void> }`
    - `start()`: `listProjects`; enqueue every project whose `nextAction` is `run` (this includes interrupted ones); for `limitUntil` in the future → `setTimeout` to clear it and enqueue; past → clear and enqueue.
    - Queue: FIFO, no duplicates, one runner at a time; `keepAwake.acquire()` while a runner is active. After `runUntilBlocked`: `'rate_limited'` → timer as above; others → next in queue.
    - `input()`: `submitInput` then `enqueue`. `pause()`: set `paused`, save, abort the runner if it is this project. `resume()`: clear `paused` and `error`, save, enqueue.
    - `idle()`: resolves when the queue is empty and nothing is running (for tests).

- [ ] **Step 1: Write failing tests**

```ts
it('appleScriptString escapes quotes and backslashes', () => expect(appleScriptString('a "b" \\c')).toBe('"a \\"b\\" \\\\c"'))
it('start() leaves a project waiting at a checkpoint untouched', async () => {          // Review Focus 3
  /* project at await_spec; start(); await idle(); state unchanged, no new steps */ })
it('start() resumes an interrupted project', ...)
it('runs projects one at a time in FIFO order', ...)   // runnerFactory stub records start/end order with delays
it('pause aborts the active runner; resume continues from the same step', ...)
it('rate-limited project is re-enqueued after limitUntil', ...)   // vi.useFakeTimers
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: scheduler with recovery, backoff and notifications`.

---

### Task 9: HTTP API, SSE and demo app runner

**Files:**
- Create: `src/server/index.ts`, `src/server/routes.ts`, `src/core/appRunner.ts`
- Test: `test/server/api.test.ts`, `test/core/appRunner.test.ts`

**Interfaces:**
- Consumes: `Scheduler`, store, `EventBus`, schemas.
- Produces:
  - `buildServer(cfg: Config, deps: { scheduler: Scheduler; bus: EventBus }): FastifyInstance` (exported from `routes.ts`); `index.ts` = loadConfig, bus, scheduler.start(), listen on `127.0.0.1:cfg.port`, serve `web/dist` via @fastify/static with SPA fallback.
  - `appRunner: { start(dir: string, command: string): Promise<{ url: string | null }>; stop(dir: string): void; status(dir: string): { running: boolean; url: string | null } }` — spawns `sh -c command` in `dir` (detached process group, killed as a group on stop), resolves when the first `https?://(localhost|127\.0\.0\.1)(:\d+)?\S*` appears in stdout/stderr or after 20 s with `url: null`.
  - Routes (all JSON; ids are state ids resolved with `findProject`, 404 if unknown):
    - `GET /api/projects` → `{ id, name, phase, displayStatus, updatedAt }[]` where `displayStatus` ∈ `running|waiting|paused|rate_limited|error|done|queued`.
    - `POST /api/projects` `{ name: string (1..80), task: string (≥10) }` → `201 { id }`; enqueues.
    - `GET /api/projects/:id` → `{ state, plan, questions, designOptions, app: appRunner.status }`.
    - `GET /api/projects/:id/doc/:name` — `name` ∈ `task|spec|architecture|decisions|report|readme` → `text/markdown`.
    - `GET /api/projects/:id/asset/*` — file under `.orchestrator/` (screenshots, design html/png); resolved path must stay inside `.orchestrator/` else 400.
    - `GET /api/projects/:id/logs/:stepId` → `LogEntry[]` (stepId `/^[\w-]+$/`).
    - `POST /api/projects/:id/input` body `UserInput` → `200 { state }`; zod error → 400; `CheckpointMismatchError` → **409**.
    - `POST /api/projects/:id/pause|resume` → `{ state }`.
    - `POST /api/projects/:id/app/start|stop` → `{ running, url }` (start uses `plan.runCommand`; 409 if no plan).
    - `GET /api/projects/:id/events` — SSE: initial `event: state`, then `state` and `log` events from the bus for this id; heartbeat comment every 15 s.

- [ ] **Step 1: Write failing tests** (`app.inject`, scheduler with stub runner)

```ts
it('POST /api/projects validates and creates', ...)                       // 400 on short task
it('input with the wrong checkpoint → 409; same approve twice → second is 409', ...)  // Review Focus 4
it('asset path traversal (../state.json, ../../.env) → 400', ...)
it('doc with unknown name → 404', ...)
it('GET /api/projects/:id never contains .env values', ...)
it('appRunner detects the URL printed by the command', async () => {
  const r = await appRunner.start(tmp, `node -e "console.log('Listening on http://localhost:5179'); setInterval(()=>{},1000)"`)
  expect(r.url).toBe('http://localhost:5179'); appRunner.stop(tmp)
})
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: HTTP API, SSE and demo app runner`.

---

### Task 10: Web panel

**Files:**
- Create: `web/index.html`, `web/vite.config.ts` (proxy `/api` → `http://127.0.0.1:4321`, outDir `dist`), `web/src/main.tsx`, `web/src/App.tsx`, `web/src/api.ts`, `web/src/components/{ProjectList,NewProject,ProjectPage,Timeline,LogView,Checkpoint,Docs}.tsx`, `web/src/styles.css`
- Test: `test/web/checkpoint.test.tsx` (vitest + jsdom + @testing-library/react — add as dev deps)

**Interfaces:**
- Consumes: the Task 9 API exactly.
- Produces (UI behavior):
  - Hash routing: `#/` list, `#/new`, `#/p/<id>`.
  - List: name, phase in Russian, status badge (waiting = accent color + «ждёт вас»), auto-refresh every 5 s; the page title shows `(N)` when N projects wait.
  - New project: name + large textarea for the task; submit → navigate to the project.
  - Project page: header (name, status, Пауза/Продолжить); left = timeline of `state.steps` (label, status icon, duration, cost); right = checkpoint panel on top (when `state.checkpoint`) and live log below (`EventSource` on `/events`; log entries appended; selecting a past step loads `/logs/:stepId`); tabs below: Задача, Спецификация, Архитектура, План (render plan.json as milestone/task list with done/current markers), Решения, Скриншоты, Отчёт.
  - Checkpoint panel by kind:
    - `answers`: one field per question (options → radio + «свой вариант»), one password field per secret with its description; «Отправить».
    - `spec` / `plan`: rendered doc (spec.md / plan + architecture), for plan with `designOptions` a picker of option cards (screenshot thumbnail + open HTML link) — approve requires a choice when options exist; «Одобрить» and «Поправить» (textarea → `revise`).
    - `demo`: «Запустить приложение» (app/start → link), latest verifier screenshots, textarea for remarks, «Всё хорошо, продолжай» / «Отправить замечания».
    - `help`: the message, a hint textarea, buttons «Повторить с подсказкой», «Пропустить задачу» (build only), «Исправил сам — продолжай».
  - Buttons disable after click until the response; on 409 show «Состояние уже изменилось» and refetch.
  - Markdown rendering: a minimal renderer (headings, lists, code, bold, links) in `web/src/markdown.ts` — no dependency.
  - Visual: calm, dense, readable; system font stack; light + dark via `prefers-color-scheme`; no gradients.

- [ ] **Step 1: Write failing tests**

```tsx
it('answers form submits answers and secrets', async () => { /* render <Checkpoint kind='answers' questions=… onSubmit=spy/>; fill; click Отправить;
  expect(spy).toHaveBeenCalledWith({ kind:'answers', answers:{ q1:'Да' }, secrets:{ BOT_TOKEN:'x1234' } }) */ })
it('plan approve is disabled until a design is chosen when options exist', ...)
it('help panel hides «Пропустить задачу» outside build', ...)
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npx vite build web` succeeds.
- [ ] **Step 5: Browser check.** Start the server with `ORCH_CLAUDE_BIN=test/fixtures/fake-claude.mjs` and a temp `ORCH_WORKSPACE`, open `http://127.0.0.1:4321` in the browser pane, create a project, walk every checkpoint to `done`, take screenshots at desktop and mobile widths; fix anything broken.
- [ ] **Step 6:** Commit `feat: web panel`.

---

### Task 11: Screenshot and simulator tools

**Files:**
- Create: `src/tools/screenshot.ts`, `src/tools/simshot.ts`, `bin/orch-shot`, `bin/orch-sim` (sh: `exec node --import tsx "<dir>/../src/tools/x.ts" "$@"`, chmod +x)
- Test: `test/tools/screenshot.test.ts`, `test/tools/simshot.test.ts`

**Interfaces:**
- Produces:
  - `screenshot(url: string, outDir: string): Promise<string[]>` — chromium headless; `desktop.png` 1440×900 full page and `mobile.png` 390×844 (deviceScaleFactor 2, isMobile); waits for `networkidle` (timeout 15 s, then shoots anyway); prints each path on stdout; exit 1 with message on navigation failure. File URLs and `http(s)` allowed.
  - `simshotArgs(...)`-level helpers: `pickDevice(simctlListJson: string): string | null` (first available, booted preferred, iPhone name preferred); `simshot(appPath: string, bundleId: string, outPng: string): Promise<void>` — `xcrun simctl list devices available -j` → pickDevice → `boot` (ignore "already booted") → `bootstatus -b` → `install` → `launch` → wait 3 s → `io <udid> screenshot outPng`.
- Setup: `npx playwright install chromium` (note in README of the orchestrator).

- [ ] **Step 1: Write failing tests**

```ts
it('screenshots a local HTML file at two sizes', async () => {
  const files = await screenshot(pathToFileURL(fixtureHtml).href, out)
  expect(files.map(f => basename(f))).toEqual(['desktop.png','mobile.png'])
  expect((await stat(files[0])).size).toBeGreaterThan(1000)
})
it('pickDevice prefers a booted iPhone', () => expect(pickDevice(simctlFixture)).toBe('BOOTED-IPHONE-UDID'))
it('pickDevice returns null when no devices', ...)
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; also run `bin/orch-shot file://… /tmp/x` manually → two paths printed.
- [ ] **Step 5:** Commit `feat: screenshot and iOS simulator tools for agents`.

---

### Task 12: Orchestrator README and live dogfood

**Files:**
- Create: `README.md` (setup: `npm i`, `npx playwright install chromium`, `claude` logged in, `npm start`, open `http://127.0.0.1:4321`; config keys; how checkpoints work)
- Modify: `prompts/*.md` per dogfood findings

- [ ] **Step 1:** Precondition: `claude -p "reply OK" --output-format json` returns `"is_error": false` (if not, ask the user to log in via `claude` → `/login`; observed expired OAuth on 2026-10-18).
- [ ] **Step 2:** Verify the sandbox actually holds with the real CLI: in a temp project run one agent step whose prompt asks to `touch ~/orch-sandbox-probe`; expect the file **not** created and the denial visible in the log. Then confirm `npm install` of a small package succeeds inside a project (network + `~/.npm` writable). Adjust `buildAgentSettings` if either fails and update its test.
- [ ] **Step 3:** Run a real web task end to end via the panel: «Todo-приложение: бэкенд на Node + SQLite, фронтенд, добавление/удаление/отметка задач». Pass all checkpoints. Expect: project tests green with the plan's `testCommand`; `runCommand` starts it; REPORT.md and decisions.md filled; screenshots present.
- [ ] **Step 4:** Kill the server mid-build, restart → the interrupted step re-runs with the resume note and the project completes.
- [ ] **Step 5:** Run a small iOS task («Счётчик нажатий на SwiftUI»): verifier builds for the simulator and produces a screenshot.
- [ ] **Step 6:** Fix prompts/settings for every problem seen; record findings in `docs/dogfood-2026-10.md`.
- [ ] **Step 7:** `npm test` and `npm run typecheck` green. Commit `docs: README; tune prompts from dogfood`.
