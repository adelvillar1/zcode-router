# 保存的 workflow 库（saved dynamic workflows）

本目录是 32 个保存的 dynamic workflow（`*.dwf.ts`）——每个文件都是一个完整的、
可独立运行的 dwf 脚本，形状是应用自己写出的那一种：文件第一行是
`/* zcode-workflow` 元数据块，块内是 YAML，块之后到文件末尾是脚本原文。

需要说明的是：把每个文件解析后按 `serializeSavedWorkflow` 的规则重新序列化，
都能**逐字节**还原（保存再读回稳定，resume 的比对基准正是脚本原文）。但其中 31 个
脚本正文在进目录之后被改过——上游自己的 lint 在这个目录上报了 13 条
`no-unused-vars` 和 21 条 `max-lines`，改动就是修这些（见下面"格式与检查"）。
改动都在脚本正文里，被逐字节保留的正是这一段，所以还原性质不受影响。

## 安装

保存的 workflow 有两个作用域，由**所在目录**决定，frontmatter 里不存作用域：

| 作用域 | 目录 | 可见范围 |
| --- | --- | --- |
| project | `<项目>/.zcode/workflows/` | 只在那个项目里 |
| global | `~/.zcode/workflows/` | 该 agent 进程对所有项目都可见 |

把文件复制进其中一个目录即可，不需要注册步骤，也没有索引文件要更新：

```sh
# 全局（所有项目可用）
mkdir -p ~/.zcode/workflows && cp ./*.dwf.ts ~/.zcode/workflows/

# 只在某个项目里
mkdir -p ./.zcode/workflows && cp ./*.dwf.ts ./.zcode/workflows/
```

两个作用域都放了同名定义时，项目档在项目内遮蔽全局档。卸载就是删文件。

## 运行

**没有 CLI 命令。** `__zcode-dwf-child` 只是 SEA 单文件二进制内部的沙箱子进程入口，
不是给用户用的。保存的 workflow 通过模型侧工具列出和运行：

1. `ListSavedWorkflows` — 列出两个作用域下读得出来的定义，以及读不出来的文件及其原因；
2. `CreateWorkflow`，以 `saved` 源指定名字（按需附带 `args`）运行。

也就是说，装好之后在会话里提出对应任务即可；`whenToUse` 是给模型判断"这一条该不该用"的
说明，`args` 声明了这个 workflow 接受什么参数（`string` / `number` / `boolean` / `json`）。

## 这些 workflow 的共同约定

- **写入前必须有 run owner 的明确批准。** 会改文件的 workflow 会把待执行的改动汇成**一个**
  升级问题交给 run owner，等答复，只执行被批准的部分；拿不到答复就上报，不绕过去。
- **结论要有证据。** 关键判断由独立的 confirmer 复现，`report` 里把"脚本实测到的"和
  "子代理自述的"分开标注，没有测量支撑的判定写成未经确认，而不是写成通过。
- **不自相矛盾地兜底。** 指令互相冲突或无法完成时，直接升级说明，而不是加一条绕过分支。

## 索引

| 名字 | 做什么 | 参数 |
| --- | --- | --- |
| `adversarial-solve` | Solves a problem with several plausible solutions by competition: champions build competing solutions independently (no peeking), a judge compares them head to head and names the winner's weaknesses and the elements worth adopting from the rest, and the winner is finalized with those elements folded in. | task |
| `bug-hunt` | Finds out why something is broken: a detective lists 3-5 distinct plausible causes, testers try to prove each one in parallel, and an independent confirmer reproduces the winning cause. Returns the diagnosed cause and a proposed fix, with unconfirmed hypotheses labelled. | symptom |
| `content-production` | Produces a document, report, or deck content from a brief: an outliner shapes the thesis and sections, section writers draft in parallel, and a fresh reviewer with a fix pass polishes the assembled draft before it is written to its final file. | brief |
| `coverage-push` | Adds the missing tests: per-area gap finders and test writers work chained in parallel, then the test suite decides — fix rounds until npm test passes. Each area reports which gaps its new tests cover. | target |
| `cross-env-data-comparison` | Compares data across two environments: generates read-only compare scripts per entity, measures staging and production counts, confirms every count with an independent recount, and reports divergences behind an owner approval gate before any remediation. Embodies the cross-env-data-comparison skill. Never writes to either database. | entities, question |
| `data-drift-detection` | Detects data drift: runs the drift checks, measures the drift with independent confirmation, proposes redacted fixes behind an owner approval gate, and publishes the drift report. Embodies the data-drift-detection skill. Never writes without explicit owner approval. | — |
| `data-triage` | Triages a data bug end to end: reproduces from the bug report, verifies data prerequisites and xlsx row gates via the skill's own scripts, audits six data-integrity categories against the database, confirms the root cause independently, implements the fix with a human approval gate before any data write, and publishes a triage report. Embodies the data-triage skill. | bugReport, pageOrEndpoint, sourceFile, stagingEndpoint |
| `decision-memo` | Decides between options with a written memo: independent advocates make each option's strongest honest case in parallel, a judge picks (and says if a merged recommendation would beat the single best), and the memo gets an independent read before handover. | question |
| `deep-dive` | Explains or assesses a system: explorers cover the subsystems in parallel and flag risks, a writer integrates one architecture assessment with the highest-impact improvements, and a cold reader closes the gaps before handover. Risks are labelled as judged, not reproduced. | scope |
| `design-review` | Runs a deep 30-item design critique of a UI surface: an independent read-only auditor per checklist item across the skill's dimensions, the mechanical anti-pattern checks run as real command gates whose exit codes decide, and one independent reader over the composed report before handover. Embodies the design-review skill. | target |
| `document-to-action-items` | Turns documents into tracked action items: extracts proposed actions from each document in parallel, confirms them, files approved ones to the tracker behind an owner approval gate, and verifies every written record independently. Embodies the document-to-action-items skill. | documents, outputSchema, tracker, trackerTarget |
| `documentation-consolidation` | Consolidates a documentation set: inventories docs, audits each for staleness and overlap in parallel with independent confirmation, plans merges/deduplications, applies them, and reports what changed. Embodies the documentation-consolidation skill (its SKILL.md and references/ are read at runtime for detail). | commit |
| `documentation-staleness-audit` | Audits documentation staleness: inventories docs, checks each against the code and drift signals in parallel (deep audits on the worst, confirmed findings), brokers open decisions to the run owner, and publishes a staleness report. Embodies the documentation-staleness-audit skill; its detect-* drift scripts are used as gates when the audited repo has them. | — |
| `email-inbox-triage` | Triages an inbox: retrieves threads through the named connector, classifies each by disposition with parallel classifiers and an independent review, drafts replies or actions per disposition, and escalates one whole-batch approval gate to the run owner before any send/write. Embodies the email-inbox-triage skill. | connector, mailbox, replyGuidance |
| `git-history-analytics` | Turns a repository's history into measured analytics: pulls every commit through the skill's own script as a deterministic gate, runs the analytics dimensions in parallel with independent audit rounds against measured command output, and publishes the analytics report. Embodies the git-history-analytics skill. | branch, repo, skillDir, timezone |
| `git-history-project-retrospective` | Turns a repository's full GitHub history into an evidence-based project retrospective: pulls every commit through the skill's own analysis script as a deterministic gate, assembles and cross-checks headline figures against measured command output with independent audit rounds, and writes the retrospective. Embodies the git-history-project-retrospective skill. | branch, repo, skillDir |
| `meeting-action-items` | Turns a meeting into tracked action items: extracts items from transcripts in parallel, resolves owners, files each to the issue tracker behind an owner approval gate, and reads every record back with independent verification. Embodies the meeting-action-items skill. | meetingContext, meetingSources, tracker, trackerTarget |
| `migration` | Migrates a codebase from one approach to another with command gates: a planner splits the work into independent areas, migrators work in parallel, and the test suite and build decide when it is done — fix rounds until npm test passes, then npm run build before handover. | task |
| `ocr-code-review` | Runs a coverage-guaranteed code review over a git range using the alibaba open-code-review CLI as its scaffolding: the delegate preview fixes the manifest up front, every file on it is reviewed and its findings confirmed as they land, a ledger accounts for every file and every finding so nothing is silently skipped, the paid review round runs behind an owner gate, and this repository's OCR GitHub Action is audited against the hardening rules. Embodies the ocr-code-review skill. | from, to, skillPath |
| `pipeline-event-log` | Audits a workspace implementation against the pipeline-event-log skill's verification checklist: one auditor plus independent confirmers per checklist item, a synthesizer that reconciles verdicts, and a checklist report where every pass rests on named evidence or is labelled unconfirmed. Embodies the pipeline-event-log skill. | — |
| `plan-backlog-generation` | Generates a plan backlog: scans scope for gaps in parallel, writes numbered plan files with dependency waves, settles sequencing with the run owner by escalation, commits the batch behind an explicit owner yes, and appends the post-recap section. Embodies the plan-backlog-generation skill. | scope |
| `plan-status-audit` | Audits existing plans: discovers candidate plans with deterministic gates, runs each plan's evidence checks (git history, branches, recaps) through a verifier and independent confirmer, renders the verdict table with a fresh-eyes review, and flips only owner-approved plan statuses. Embodies the plan-status-audit skill. | — |
| `postmortem` | Writes up an incident: investigators reconstruct the timeline from each evidence source in parallel, one analyst finds the root cause and contributing factors, an independent confirmer checks the causal claim against the evidence, and a blameless postmortem is written with concrete actions. | incident |
| `production-sync-procedure` | Prepares and verifies a production database sync: enforces the never-sync-before-deprecating sequencing with the owner-supplied classification authoritative, builds the migration plan with dry-run gates, runs compliance review and post-sync drift checks from the skill's own scripts where present, and publishes a ready-to-execute plan whose verdicts are labelled as attestation where nothing measured them. Embodies the production-sync-procedure skill. | destructiveApproved, isCleanupSync |
| `regression-claim-verification` | Verifies a regression claim against evidence in three branches (code audit, production audit, prerequisite check): independent confirmers reproduce each finding from served bytes and git history rather than trusting the finder, handoff conditions are evaluated at the end, and the verdict separates script-observed facts from subagent-reported ones. Embodies the regression-claim-verification skill. Assumes a Railway-deployed project with hashed CSS bundles. | claim |
| `research-report` | Researches a topic and writes it up with sources: parallel scouts cover 4-6 angles, checkers verify each angle's load-bearing claims against their cited sources, a writer synthesizes with citations, and a cold reader closes the gaps before handover. | topic |
| `review-sweep` | Reviews changed files with confirmed findings: one reviewer per changed file, one independent confirmer per finding chained as reviews land, findings sorted by severity and published as a review report. Every finding is either reproduced by a confirmer who did not produce the review or labelled unconfirmed. | base, task |
| `spec-compliance-review` | Grades a plan against itself acceptance criterion by acceptance criterion: the checklist is read by a subagent that did not write the plan, every verification command the plan claims passed is re-executed as a real gate, findings are independently confirmed, gaps are adjudicated and challenged by a fresh session, and the verdict is a go, no-go, or go-with-caveats. Embodies the spec-compliance-review skill. | plan, base, commit |
| `swarm` | Runs a task as a multi-agent swarm with router-decided topology: the auto-router decides single vs mixture vs swarm, the swarm path decomposes the task, builds parts in parallel with per-part reviewers and a bounded fix loop, integrates one deliverable, and gives it an independent read before handover. Fails loudly when no task is provided. Subagents run on the router's auto model, so every delegation call routes by workload. | task |
| `ui-implementation-review` | Runs a deep, checklist-driven UI implementation review: the skill's grep recipes run as deterministic gates with absence never recorded as clean, per-domain auditors fan out over the checklist, every finding they return is independently confirmed up to a per-domain cap, live checks run where the skill demands them, and the findings are deduplicated, triaged, and ranked before the report is written. Embodies the ui-implementation-review skill. | target, base |
| `weekly-review-planning` | Runs a weekly review and planning cycle: gathers the week's evidence across systems in parallel, reviews what happened against the plan, holds the criteria walks and decisions with the run owner by escalation, and produces the next week's plan. Embodies the weekly-review-planning skill. | planningHorizon, reviewWindow, systems, timezone |
| `write-session-recap` | Writes a session recap: walks the session's git evidence and areas with parallel walkers and proposers, holds shape/criteria/doc decisions with the run owner by escalation, fills the recap template with per-line substitution safety (concurrent-session-safe append/replace semantics), and runs the recap sweep with owner approval. Embodies the write-session-recap skill. | — |

## 格式与检查

这些文件不参与格式检查（见仓库根的 `.prettierignore`）：`serializeSavedWorkflow`
要求终止行之后的脚本**逐字节**保留，保存再读回必须拿到同一份原文，格式化器改写它们
会让仓库副本和用户在编辑器里看到的内容分叉。

它们仍然满足保存 workflow 的契约：文件名即 workflow 名（`^[A-Za-z0-9_.-]+$`，
≤ 64 字符）、首行是 `/* zcode-workflow`、元数据只含 `description` / `whenToUse` /
`args`、参数声明只含 `type` / `description` / `required` / `default`。

部分超过 400 行的脚本第一行是 `/* eslint-disable max-lines -- … */`：保存的
workflow 契约要求一个自包含脚本，没法按目录规则拆成模块，所以按仓库里已有的做法
在文件内声明豁免。这一行落在脚本正文里，`serializeSavedWorkflow` 会原样保留，
"保存再读回得到同一份原文"不受影响。该目录在仓库自己的 oxlint 配置下
0 warning、0 error——这条豁免之外的所有规则照常生效。
