#!/usr/bin/env bash
# =============================================================================
# PlaneOS 反向代理一键安装（Caddy，自动 HTTPS/443 → 应用入口 127.0.0.1:3011）
#
# Caddy 会自动申请并续期 Let's Encrypt 证书（需要域名已解析到本机公网 IP、
# 80/443 可从公网访问）。相比 nginx+certbot，这里真正做到"一次装完即用"。
#
# 用法（需 root / sudo）：
#   sudo ./proxy.sh app.example.com admin@example.com     # 正式域名 + ACME 邮箱
#   sudo DOMAIN=app.example.com ACME_EMAIL=admin@example.com ./proxy.sh
#   sudo ./proxy.sh 203.0.113.10 --self-signed            # 只有 IP / 无域名：自签证书(浏览器会告警)
#
# 可选环境变量：
#   UPSTREAM=127.0.0.1:3011   # 反代目标（默认应用前端入口；一般不用改）
#
# 前置：先用 ./deploy.sh 把应用跑起来（监听 3011）。装完反代后，
# 建议关闭 3011/3010 的公网暴露，只经 443 访问；并把应用 CORS_ORIGINS 收紧为 https://<域名>。
# =============================================================================
set -euo pipefail

if [ -t 1 ]; then C_G=$'\e[32m'; C_Y=$'\e[33m'; C_R=$'\e[31m'; C_B=$'\e[36m'; C_0=$'\e[0m'; else C_G=; C_Y=; C_R=; C_B=; C_0=; fi
info(){ echo "${C_B}[proxy]${C_0} $*"; }
ok(){   echo "${C_G}[✓]${C_0} $*"; }
warn(){ echo "${C_Y}[!]${C_0} $*"; }
die(){  echo "${C_R}[✗]${C_0} $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo ./proxy.sh <域名> [邮箱]"

# ── 解析参数 ──
DOMAIN="${DOMAIN:-}"; ACME_EMAIL="${ACME_EMAIL:-}"; SELF_SIGNED=0
for a in "$@"; do
  case "$a" in
    --self-signed) SELF_SIGNED=1 ;;
    *@*)           ACME_EMAIL="$a" ;;
    -*)            die "未知选项：$a" ;;
    *)             [ -z "$DOMAIN" ] && DOMAIN="$a" || ACME_EMAIL="$a" ;;
  esac
done
[ -n "$DOMAIN" ] || die "缺少域名/IP。用法：sudo ./proxy.sh <域名> [邮箱]"
UPSTREAM="${UPSTREAM:-127.0.0.1:3011}"
# 目标是 IP 且没显式给 --self-signed 时，自动转自签（Let's Encrypt 不给纯 IP 发证）
if [[ "$DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ "$SELF_SIGNED" -eq 0 ]; then
  warn "目标是 IP 地址，Let's Encrypt 无法为 IP 签发证书 → 自动改用自签证书（浏览器会告警）。"
  SELF_SIGNED=1
fi

# ── 安装 Caddy（Debian/Ubuntu 官方源；已装则跳过）──
install_caddy(){
  if command -v caddy >/dev/null 2>&1; then ok "已检测到 caddy，跳过安装"; return; fi
  command -v apt-get >/dev/null 2>&1 || die "本脚本的自动安装仅支持 Debian/Ubuntu(apt)。其它系统请手动安装 Caddy 后重跑（脚本会复用已装的 caddy）。"
  info "安装 Caddy（官方 apt 源）…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
  ok "Caddy 安装完成"
}
install_caddy

# ── 生成 Caddyfile ──
CADDYFILE=/etc/caddy/Caddyfile
mkdir -p /etc/caddy
[ -f "$CADDYFILE" ] && cp "$CADDYFILE" "${CADDYFILE}.bak.$(date +%s)" && info "已备份原 Caddyfile"

if [ "$SELF_SIGNED" -eq 1 ]; then
  TLS_LINE=$'\ttls internal'
  SITE="${DOMAIN}:443"
else
  [ -n "$ACME_EMAIL" ] || warn "未提供 ACME 邮箱（证书到期通知会缺失）；建议 sudo ./proxy.sh $DOMAIN you@example.com"
  TLS_LINE=""
  SITE="$DOMAIN"
fi

{
  if [ "$SELF_SIGNED" -eq 0 ] && [ -n "$ACME_EMAIL" ]; then
    printf '{\n\temail %s\n}\n\n' "$ACME_EMAIL"
  fi
  printf '%s {\n' "$SITE"
  [ -n "$TLS_LINE" ] && printf '%s\n' "$TLS_LINE"
  cat <<EOF
	encode zstd gzip
	# 反代到应用前端入口（它再同源反代 /api /auth /events /sse … 到后端）
	reverse_proxy ${UPSTREAM} {
		# SSE / 流式响应实时刷新，禁用缓冲（/events /sse /realtime 及工作流长请求需要）
		flush_interval -1
	}
}
EOF
} > "$CADDYFILE"

ok "已写入 $CADDYFILE"
info "内容："; sed 's/^/    /' "$CADDYFILE"

# ── 校验 + 启动 ──
info "校验配置…"; caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null || die "Caddyfile 校验失败，请检查上面的内容。"

# 放行 80/443（ufw 若启用）
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ok "ufw 已放行 80/443"
fi

info "启动 Caddy…"
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy
sleep 2
if systemctl is-active --quiet caddy; then ok "Caddy 运行中"; else die "Caddy 启动失败，看日志：journalctl -u caddy -e --no-pager"; fi

echo
ok "反向代理就绪！"
if [ "$SELF_SIGNED" -eq 1 ]; then
  echo "    访问： ${C_G}https://${DOMAIN}${C_0}   （自签证书，浏览器会提示不安全，点继续即可）"
else
  echo "    访问： ${C_G}https://${DOMAIN}${C_0}   （首次访问会自动申请证书，稍等几秒）"
  echo "    证书自动申请/续期，无需手动维护。"
fi
echo "    上游： ${UPSTREAM}"
echo
echo "常用命令：  systemctl status caddy | journalctl -u caddy -f | systemctl reload caddy"
warn "建议：装好反代后关闭 3011/3010 的公网暴露（安全组/防火墙），只经 443 访问；"
warn "      并把应用的 CORS_ORIGINS 收紧为 https://${DOMAIN}（改 .env 后 ./deploy.sh restart）。"
