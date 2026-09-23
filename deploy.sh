#!/usr/bin/env bash
# =============================================================================
# PlaneOS 一体机（方案 B）一键部署脚本
#
# 用 Dockerfile.aio + docker-compose：把 PostgreSQL + Redis + Rust API + Next.js
# 前端全部跑在一个容器里。适合单机 / 演示 / POC。
#
# 用法：
#   ./deploy.sh              # = up：生成/校验 .env，构建并启动，等健康，打印入口
#   ./deploy.sh up           # 同上
#   ./deploy.sh rebuild      # 改了代码/前端词条/迁移后：重新构建镜像并启动
#   ./deploy.sh restart      # 重启容器（不重建镜像）
#   ./deploy.sh stop         # 停止并移除容器（保留数据卷）
#   ./deploy.sh logs         # 跟随查看日志（Ctrl-C 退出）
#   ./deploy.sh status       # 查看容器与健康状态
#   ./deploy.sh admin        # 重置/确保初始管理员 admin@example.com / Admin123
#   ./deploy.sh destroy      # 停止并删除数据卷（清库！二次确认）
#   ./deploy.sh help
# =============================================================================
set -euo pipefail

# 切到脚本所在目录（= 仓库根，docker-compose.yml 在这里）
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 可按需覆盖的入口端口（与 docker-compose.override.yml 对齐）──
FRONT_PORT="${FRONT_PORT:-3011}"   # 浏览器入口
API_PORT="${API_PORT:-3010}"       # Rust API 直连
HEALTH_URL="http://127.0.0.1:${API_PORT}/health/live"

# ── 颜色 ──
if [ -t 1 ]; then C_G=$'\e[32m'; C_Y=$'\e[33m'; C_R=$'\e[31m'; C_B=$'\e[36m'; C_0=$'\e[0m'; else C_G=; C_Y=; C_R=; C_B=; C_0=; fi
info(){ echo "${C_B}[部署]${C_0} $*"; }
ok(){   echo "${C_G}[✓]${C_0} $*"; }
warn(){ echo "${C_Y}[!]${C_0} $*"; }
die(){  echo "${C_R}[✗]${C_0} $*" >&2; exit 1; }

# ── 依赖检查 + 探测 docker compose 命令 ──
command -v docker >/dev/null 2>&1 || die "未找到 docker，请先安装 Docker。"
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  die "未找到 docker compose（v2 插件）或 docker-compose（v1）。"
fi

# ── 生成 / 校验 .env（只需 JWT_SECRET 与 ENCRYPTION_KEY；aio 的库/缓存在容器内）──
gen_secret(){ # $1 = 字节数；输出 base64
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 "$1"
  else head -c "$1" /dev/urandom | base64; fi
}
# 读取 .env 里某个键的值（去掉引号/空白）
env_val(){ [ -f .env ] || return 0; sed -n "s/^$1=//p" .env | tail -1 | tr -d '"'"'"' \r'; }
is_placeholder(){ case "$1" in ""|*"请用"*|*"change-me"*|*"replace"*|*"<"*">"*) return 0;; *) return 1;; esac; }

ensure_env(){
  local jwt enc
  if [ -f .env ]; then jwt="$(env_val JWT_SECRET)"; enc="$(env_val ENCRYPTION_KEY)"; else jwt=""; enc=""; fi

  if is_placeholder "$jwt" || is_placeholder "$enc"; then
    warn ".env 缺少有效的 JWT_SECRET / ENCRYPTION_KEY，自动生成随机密钥…"
    [ -f .env ] && cp .env ".env.bak.$(date +%s)" && info "已备份原 .env"
    is_placeholder "$jwt" && jwt="$(gen_secret 48)"
    is_placeholder "$enc" && enc="$(gen_secret 32)"   # 必须是 base64 的 32 字节
    local cors; cors="$(env_val CORS_ORIGINS)"; [ -z "$cors" ] && cors="*"
    cat > .env <<EOF
# PlaneOS 部署密钥（由 deploy.sh 自动生成；.env 已被 .gitignore，勿提交）
# 如需轮换密钥：删除对应行后重跑 ./deploy.sh，或手动替换。
JWT_SECRET=$jwt
ENCRYPTION_KEY=$enc
# CORS 白名单：单机用 * 即可；生产多域名请改成 https://a.example.com,https://b.example.com
CORS_ORIGINS=$cors
EOF
    chmod 600 .env
    ok "已写入 .env（JWT_SECRET / ENCRYPTION_KEY / CORS_ORIGINS）"
  else
    ok ".env 已存在且密钥有效，沿用现有配置"
  fi
}

wait_healthy(){
  info "等待服务就绪（探针 ${HEALTH_URL}）…"
  local n=0 max=90
  while [ "$n" -lt "$max" ]; do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then ok "后端已就绪"; return 0; fi
    n=$((n+1)); sleep 2
    [ $((n % 15)) -eq 0 ] && info "仍在启动中…（首次构建/迁移较慢，已等 $((n*2))s）"
  done
  warn "等待超时（${max}x2s）。可能仍在迁移或构建；用 './deploy.sh logs' 查看，或 './deploy.sh status'。"
  return 1
}

print_access(){
  echo
  ok "部署完成，访问入口："
  echo "    浏览器 :  ${C_G}http://<本机IP>:${FRONT_PORT}${C_0}   (本机: http://localhost:${FRONT_PORT})"
  echo "    API   :  http://<本机IP>:${API_PORT}"
  echo "    初始账号: ${C_Y}admin@example.com / Admin123${C_0}  （登录后请立即改密）"
  echo
}

cmd_up(){
  ensure_env
  info "构建并启动（首次会编译 Rust，较慢，请耐心）…"
  $DC up -d --build
  wait_healthy || true
  $DC ps
  print_access
}

cmd_rebuild(){
  ensure_env
  info "重新构建镜像并启动（改了代码 / 前端词条 / 迁移后用这个）…"
  $DC build
  $DC up -d
  wait_healthy || true
  $DC ps
  print_access
}

cmd_restart(){ info "重启容器…"; $DC restart; wait_healthy || true; $DC ps; }
cmd_stop(){    info "停止并移除容器（数据卷保留）…"; $DC down; ok "已停止。数据仍在（pgdata/redisdata/logs 卷）。"; }
cmd_logs(){    info "跟随日志（Ctrl-C 退出）…"; $DC logs -f --tail=200; }
cmd_status(){  $DC ps; echo; info "健康探针："; curl -fsS "$HEALTH_URL" && echo " -> OK" || echo " -> 未就绪"; }

cmd_admin(){
  info "确保初始管理员 admin@example.com / Admin123 可用…"
  $DC exec planeos /app/bin/create_admin || die "执行失败（容器是否在运行？先 ./deploy.sh up）"
  ok "已重置。用 admin@example.com / Admin123 登录后请立即改密。"
}

cmd_destroy(){
  warn "这会删除容器 **和数据卷**（PostgreSQL / Redis 数据将丢失，不可恢复）。"
  read -r -p "确认清库销毁？输入大写 YES 继续：" ans
  [ "$ans" = "YES" ] || { info "已取消。"; exit 0; }
  $DC down -v
  ok "已销毁容器与数据卷。"
}

usage(){ awk 'NR>1{ if(/^#/){sub(/^# ?/,"");print} else exit }' "$0"; }

case "${1:-up}" in
  up|start)      cmd_up ;;
  rebuild|build) cmd_rebuild ;;
  restart)       cmd_restart ;;
  stop|down)     cmd_stop ;;
  logs|log)      cmd_logs ;;
  status|ps)     cmd_status ;;
  admin)         cmd_admin ;;
  destroy)       cmd_destroy ;;
  help|-h|--help) usage ;;
  *) die "未知命令：$1（用 ./deploy.sh help 查看用法）" ;;
esac
