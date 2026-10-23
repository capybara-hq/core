#!/usr/bin/env bash
# 读 stdin 上的改动文件列表（每行一个，相对仓库根），只要有一个可能影响测试 / 构建就输出 true，
# 全是文档类改动输出 false。CI 的 changes 任务用它决定跳不跳测试分片、web、e2e、visual。
#
# 文档类 = docs/**、任意 *.md、.gitignore、.claude/**，但以下例外按代码算：
# - docs/config.md：pnpm check（check:config-docs）比对它；
# - .claude/hooks/**、.claude/settings.json：tools/worktree 的测试直接执行 hook；
# - packages/ apps/ plugins/ tools/ 下的一切（含 md：插件 README、apps/web/AGENTS.md 等，
#   保守起见不细分）。
# 新增「测试或检查会读的 md / .claude 文件」时，要在这里加例外。
set -euo pipefail

code=false
while IFS= read -r f || [[ -n "$f" ]]; do
  [[ -z "$f" ]] && continue
  case "$f" in
    docs/config.md | .claude/hooks/* | .claude/settings.json) code=true ;;
    packages/* | apps/* | plugins/* | tools/*) code=true ;;
    docs/* | *.md | .gitignore | .claude/*) ;;
    *) code=true ;;
  esac
done
echo "$code"
