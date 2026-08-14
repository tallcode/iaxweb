#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
用法: ./scripts/backup-sqlite.sh <data-dir> [backup-dir]

从 <data-dir>/ai.sqlite 创建一个可在服务运行时使用的一致性 SQLite 备份。
备份目录默认是 <data-dir>/backups。
EOF
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage >&2
  exit 64
fi

data_dir=$1
backup_dir=${2:-"$data_dir/backups"}
database="$data_dir/ai.sqlite"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo '错误: 未找到 sqlite3 命令。请先安装 SQLite 命令行工具。' >&2
  exit 69
fi
if [ ! -r "$database" ]; then
  echo "错误: 找不到或无法读取数据库：$database" >&2
  exit 66
fi

umask 077
mkdir -p "$backup_dir"
timestamp=$(date -u '+%Y%m%dT%H%M%SZ')
backup="$backup_dir/ai-$timestamp.sqlite"
temporary_backup="$backup_dir/.ai-$timestamp.$$.sqlite"

cleanup() {
  rm -f "$temporary_backup"
}
trap cleanup EXIT HUP INT TERM

# The SQLite backup command reads a transactionally consistent snapshot even
# while the source database is in WAL mode and being written to.
sqlite3 "$database" ".timeout 5000" ".backup \"$temporary_backup\""

if [ "$(sqlite3 "$temporary_backup" 'PRAGMA query_only = ON; PRAGMA integrity_check;')" != 'ok' ]; then
  echo '错误: 备份完整性检查失败。' >&2
  exit 65
fi

mv "$temporary_backup" "$backup"
trap - EXIT HUP INT TERM
printf '备份完成：%s\n' "$backup"
