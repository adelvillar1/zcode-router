#!/usr/bin/env bash
# Open the upstream PR for the workflow pack. Idempotent: safe to re-run.
#
# Requires a token that can fork zai-org/ZCode. The current PAT (fine-grained,
# scoped to adelvillar1/zcode-router) cannot — it gets 403 on POST /forks and has
# push:false on zai-org/ZCode. Grant fork access, or run this yourself.
#
# What it does: fresh clone of upstream main, branch contrib/workflow-pack,
# copy the pack in, add the .prettierignore entry, commit, push to the fork,
# open the PR. The diff is add-only: one new directory plus six lines.
set -euo pipefail

UPSTREAM="zai-org/ZCode"
BRANCH="contrib/workflow-pack"
KIT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/zcode-upstream-pr"

echo "== fork $UPSTREAM (needs fork permission on the PAT) =="
gh repo fork "$UPSTREAM" --clone=false

echo "== clone upstream main =="
rm -rf "$WORK"
git clone --quiet "https://github.com/$UPSTREAM.git" "$WORK"
cd "$WORK"
git checkout -q -B "$BRANCH"

echo "== copy the pack from $KIT/workflows =="
mkdir -p workflows
cp "$KIT"/workflows/*.dwf.ts workflows/
cp "$KIT"/workflows/README.md workflows/

# A clean clone has no node_modules, so the two gates below would silently pass or
# fail for the wrong reason. Install exactly what upstream pins — these are the
# versions every number in the PR body was measured with — into a scratch prefix.
echo "== install the pin-matched gate tools (yaml, oxlint, oxfmt) =="
TOOLS="$WORK.gates"
rm -rf "$TOOLS"
mkdir -p "$TOOLS"
npm install --prefix "$TOOLS" --no-audit --no-fund --loglevel=error \
  "yaml@^2.9.0" "oxlint@1.57.0" "oxfmt@0.41.0"
export ZCODE_REF_CLONE="$TOOLS"
export PATH="$TOOLS/node_modules/.bin:$PATH"

echo "== add the .prettierignore entry =="
grep -q '^workflows/$' .prettierignore || cat >> .prettierignore <<'IGNORE'

# 保存的 dynamic workflow 库：每个 .dwf.ts 在 frontmatter 之后是逐字节保留的脚本正文，
# saved-workflows/frontmatter.ts 的 serializeSavedWorkflow 要求保存再读回拿到同一份原文
# （resume 的比对基准正是脚本原文）。格式化器改写其中一个字节，仓库副本就和用户在编辑器里
# 看到的内容分叉。
workflows/
IGNORE

echo "== verify before committing (lint must be exit 0, pack must be clean) =="
oxlint || { echo "FATAL: lint failed at repo root"; exit 1; }
node "$KIT/tools/verify-pack.mjs" "$PWD/workflows" || { echo "FATAL: pack failed its own checks"; exit 1; }

# Reported, not gated: the pristine upstream repo already fails this on 32 files, so
# the count the PR body quotes is 32 with the pack in, not 64 with it absent.
echo "== oxfmt (report only; upstream's baseline is already failing) =="
oxfmt --check . 2>&1 | tail -3 || true

echo "== commit and push =="
git add -A
git -c user.name="$(gh api user --jq .login)" \
    -c user.email="$(gh api user --jq .login)@users.noreply.github.com" \
    commit -q -F - <<'MSG'
新增 workflows/：32 个保存的 dynamic workflow

把 32 个保存的 dynamic workflow（`*.dwf.ts`）和一份 README 放进顶级目录
`workflows/`。README 说明两个安装目录、作用域的区别，以及"用 ListSavedWorkflows
列出、用 CreateWorkflow 的 saved 源运行"这件没有命令行入口的事。

需要说明的是：其中 31 个脚本正文在进目录之后被改过——上游自己的 `pnpm lint`
在这个目录上报了 13 条 `no-unused-vars` 和 21 条 `max-lines`，仓库根的 lint
从 exit 0 变成 exit 1。改动就是修这些，全部落在脚本正文里（被逐字节保留的
正是这一段），所以"解析后重新序列化逐字节还原"的性质不受影响。

`.prettierignore` 加一行排除整个 `workflows/`：`serializeSavedWorkflow` 要求
脚本正文逐字节保留，格式化器改写会让仓库副本和用户在编辑器里看到的内容分叉。

不碰任何代码路径：`workflows/` 不在 `pnpm-workspace.yaml` 的显式 glob 里，
不是 workspace package；`pnpm typecheck` 按名字构建项目，没有一个覆盖它。
MSG
git push --force --set-upstream "git@github.com:$(gh api user --jq .login)/ZCode.git" "$BRANCH"

echo "== open the PR =="
gh pr create --repo "$UPSTREAM" --base main --head "$(gh api user --jq .login):$BRANCH" \
  --title "新增 workflows/：32 个保存的 dynamic workflow" \
  --body-file "$KIT/docs/upstream-pr-workflow-pack.md"
