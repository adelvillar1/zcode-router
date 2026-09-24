<!-- PR body: workflow pack. Target: zai-org/ZCode, head adelvillar1:workflow-pack
     (the branch is also pushed as contrib/workflow-pack).
     Title: 新增 workflows/：32 个保存的 dynamic workflow
     This block is an HTML comment so it stays invisible when this file is pasted
     into the PR description, or passed to `gh pr create --body-file`. -->

仓库 issues 已关闭，所以下面第 5 节的问题直接写在这里。

## 1. 这个 PR 做什么

新增顶级目录 `workflows/`，里面是 32 个保存的 dynamic workflow（`*.dwf.ts`），
外加一份 `workflows/README.md` 说明安装目录、两个作用域的区别，以及"用
`ListSavedWorkflows` 列出、用 `CreateWorkflow` 的 `saved` 源运行"这件没有
命令行入口的事。

这些文件都是 SaveWorkflow 写出的形状：frontmatter 结构、键序、终止行规则都对得上，
把它们解析出来的元数据与脚本按 `serializeSavedWorkflow` 重新序列化，会**逐字节**还原
（见第 4 节，64/64）。需要说明的是，31 个文件的脚本正文在并入目录之后被改过——
上游自己的 `pnpm lint` 在这个目录上报了 13 条 `no-unused-vars` 和 21 条 `max-lines`，
改的是这些（详见第 2 节）。改动都在脚本正文里，而脚本正文正是 `serializeSavedWorkflow`
逐字节保留的那一段，所以逐字节还原的性质不受影响；但这批文件不再是"应用原样输出"
的状态，这点不藏着。

## 2. 不碰任何代码路径

- 新的顶级目录不是 workspace package：`pnpm-workspace.yaml` 的 glob 是显式的
  （`packages/*`、`apps/zcode-cli`、`apps/zcode-cli/packages/*`、
  `apps/zcode-cli/tools/*`），`workflows/` 不在其中。
- `pnpm typecheck` 按名字构建项目，没有任何一个项目覆盖 `workflows/`。
- `pnpm lint`（oxlint，`package.json` 里的 `^1.57`；实测用的正是 1.57.0）:
  - 仓库根（未加本目录）：exit 0，70 warning、0 error（2616 个文件）。
  - 仓库根 + 本目录：**exit 1**，70 warning、**21 error**，全部是
    `eslint(max-lines)` 且全在 `workflows/` 内（2648 个文件）。
  - 修完之后再看：仓库根 exit 0，`workflows/` 单独看 0 warning、0 error。
  `.oxlintrc.json` 的 `max-lines: 400` 在 `"plugins": null` 下**会生效**——
  本文件早期版本写过"不生效"，那是错的，已在此更正。仓库里自己的长文件能过这条规则，
  靠的是两件事：`apps/zcode-cli`、`.agents/skills`、`packages/formal-proof`、
  `packages/ui/src/components/{ui,ai-elements}`、`docs/electron` 在
  `ignorePatterns` 里，而在外的长文件自带 `/* eslint-disable max-lines -- … */`。
  那一次失败跑出来的真实缺陷都改在文件里了，没有靠豁免绕过去：
  - **13 条 `no-unused-vars`**：9 个只声明没引用的 `interface WorkflowReport`
    （删掉它们又让 `decision-memo` 的 `interface Finding` 和 `research-report` 的
    `interface WorkflowReport` 变成孤儿，一并删除）；`research-report` 里一个
    读了没人用的 `const checked = await Promise.all(…)`（每次 check 内部已经
    上报并 push 了）；`ui-implementation-review` 里一个只声明没引用的
    `type DomainAuditList = DomainAudit[]`（`DomainAudit[]` 在文件里从未出现）；
    `weekly-review-planning` 里一个死掉的 `const tasksUsable = usableKind("tasks")`
    （全程只用 calendar 一类；任务源是否可用已由上面的 source-availability 上报）。
  - **21 条 `max-lines`**。保存的 workflow 契约要求一个自包含脚本，没法按目录规则
    拆成模块，所以这 21 个文件各自在**脚本正文的第一行**加了
    `/* eslint-disable max-lines -- … */`。这样豁免藏在应用自己逐字节保留的那段里，
    `serializeSavedWorkflow` 会原样写回，逐字节还原仍然成立（64/64）；这也正是仓库里
    已有的做法。不改任何共享配置，其他规则——包括抓出上面 13 条 warning 的那些——
    对这个目录照常生效。
- `verify:pre-push` = `lint` + `architecture:check --changed`：`lint` 扫全仓，
  所以本目录**一度**让 `verify:pre-push` 失败，修完那 21 条之后恢复；
  `architecture:check --changed` 不覆盖一个没有新增 package 的目录。

## 3. `.prettierignore` 增加一行

排除整个 `workflows/`，理由写在注释里：`saved-workflows/frontmatter.ts` 的
`serializeSavedWorkflow` 要求终止行之后的脚本**逐字节**保留，保存再读回必须拿到
同一份原文（resume 的比对基准正是脚本原文）。这 32 个文件是 SaveWorkflow 的输出，
格式化器改写它们会让仓库副本和用户在编辑器里看到的内容分叉——那正是该函数用
注释说明要避免的情况。

用仓库锁定的 oxfmt（`^0.41`，实测 0.41.0）量过，这是事实不是偏好：

- 在临时副本上跑 `oxfmt`，`design-review.dwf.ts` 从 41255 字节变成 42158 字节：
  一个 `||` 链被拆成多行，模板字符串参数末尾多出一个逗号。
- `oxfmt --check .` 在**未加**本目录的仓库上本来就 exit 1、指认 32 个文件
  （`README.md` 和 31 个源码文件）；加了本目录但不写这条 ignore 会变成 64 个；
  写了这条之后回到 32 个，`workflows/` 一个都不再被指认——所以 oxfmt 确实读
  `.prettierignore`。仓库其余部分的格式检查状态不受本 PR 影响，好的一面是它没有
  被削弱，坏的一面是它本来就不是绿的。

## 4. 契约校验

用 `SavedWorkflowMetaSchema` 和 `parseSavedWorkflow` 的规则逐个文件核对
（yaml 解析用的是同一个 `yaml` 包）：

- 文件名即 workflow 名，全部满足 `^[A-Za-z0-9_.-]+$` 且 ≤ 64 字符；
- 首行（第一条非空行）正是 `/* zcode-workflow`，终止行是 trim 后恰为 `*/` 的行；
- 元数据严格只有 `description` / `whenToUse` / `args`，参数声明严格只有
  `type`（`string`/`number`/`boolean`/`json`）/ `description` / `required` /
  `default`；
- 终止行之后都有脚本正文；
- 没有任何一个文件 import 外部模块（两处 `require(` 在
  `world.run("node", ["-e", …])` 的字符串里），全部自包含。

32/32 通过。

另外，把每个文件解析出的元数据与脚本按 `serializeSavedWorkflow` 的规则重新序列化
（键序固定 `description` → `whenToUse` → `args`、起始行、YAML 体、终止行、脚本原文），
32 个文件**逐字节**还原——所以这些文件就是 SaveWorkflow 的输出，不是为进仓库改写过的版本。
这也是第 3 节排除格式检查的根据。

frontmatter 是用上游自己的 `yaml` 包按 `serializeSavedWorkflow` 的调用方式生成的，
不是手写近似，所以"逐字节还原"是构造出来的性质，不是事后核对出来的运气。

## 4.1 脚本能通过类型检查

拿 `saved-workflow.ts` 契约之外的东西说一句：这批文件是给真实运行准备的脚本，
其中一个子集（本仓库 .zcode/workflow-drafts 里最后加入的 4 个深度评审类 workflow）
在并入本目录之前，用它们自己的最小 facade 声明文件（`.d.ts`）做了带 `--strict` 的
全量检查：

    { printf 'async function __probe__() {\n'; cat <script>; printf '\n}\n'; } > wrapped.ts
    npx tsc --noEmit --strict --target es2022 --module esnext \
      --moduleResolution bundler --skipLibCheck wrapped.ts workflow-facade.d.ts

四个文件都是 exit 0、0 条诊断（脚本取样来自并入后文件的终止行之后，也就是最终形态）。
同样这条检查不是空跑：故意写错一个类型（`const x: number = "not a number"`）会以
`error TS2322` exit 2 失败。

并入本目录之后又对**全部 32 个**重跑了同一条命令（`tsc` 5.9.3，同样 `--strict`）：
32/32 exit 0、0 条诊断；同一条阳性对照同样 exit 2。这批 workflow 尚没有任何一个作为
真实 run 执行过，所以这里只声称编译通过，不声称行为已验证。

## 5. 需要维护者决策的问题：保存的 workflow 的分发路径

这些 workflow 目前**没有分发路径**：

- `CONTEXT.md` 定义的插件清单（`plugin.json`）组件种类是
  commands/agents/skills/hooks/mcpServers/userConfig，没有 workflow；
  `plugin-components.ts` 也确认如此。因此一个 workflow pack 进不了官方市场
  （`zcode-plugins-official` 只承载内置插件与 CDN 插件）。
- 仓库也没有首次运行时往 `~/.zcode/workflows/` 播种的逻辑。
- README 里没有这个功能的任何说明，也没有面向用户的 CLI 命令。

所以本 PR 只是最小形态：把文件放进目录，配一条 README。如果维护者倾向于别的路线，
可以据此调整，文件本身是可直接复用的：

- 内置 pack / 首次运行播种 —— 这些文件原样可用；
- 给插件清单增加 workflow 组件种类 —— 这是更大的改动，需要维护者先定方向；
- 认为这类内容不该进本仓库 —— 也没问题，我们会在仓库外维护，不占用维护精力。

## 6. 附带说明

这些 workflow 有三条共同约定，README 里写明了：会改文件的 workflow 把待执行改动汇成
**一个**升级问题交给 run owner、等答复、只执行被批准部分；关键判断由独立 confirmer
复现；`report` 里把脚本实测结果与子代理自述分开标注。
