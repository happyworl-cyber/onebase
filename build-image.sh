#!/usr/bin/env bash
# =============================================================================
# 本地打包镜像（给小内存服务器用）：在本机构建 linux/amd64 的一体机镜像，
# 导出成 planeos-aio.tar.gz，scp 到服务器后 `./deploy.sh load` + `start` 直接跑，
# 服务器不再编译。
#
# 用法（在本仓库根目录、装了 Docker Desktop / buildx 的机器上跑）：
#   ./build-image.sh
#
# 可选环境变量：
#   PLATFORM=linux/amd64   # 目标架构（阿里云 ECS 基本是 x86_64=amd64，默认即可；ARM 服务器用 linux/arm64）
#   IMAGE=planeos:aio      # 镜像名（需与 docker-compose.yml 的 image 一致）
#   OUT=planeos-aio.tar.gz # 导出文件名
#
# 注意：Apple Silicon(M 芯片) 构建 amd64 走 QEMU 模拟，Rust 编译会偏慢，但本机内存大不会 OOM，
#       且只需一次。若有 amd64 的构建机会更快。
# =============================================================================
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PLATFORM="${PLATFORM:-linux/amd64}"
IMAGE="${IMAGE:-planeos:aio}"
OUT="${OUT:-planeos-aio.tar.gz}"

command -v docker >/dev/null 2>&1 || { echo "未找到 docker" >&2; exit 1; }
docker buildx version >/dev/null 2>&1 || { echo "未找到 docker buildx（请用 Docker Desktop 或安装 buildx 插件）" >&2; exit 1; }

echo "[打包] 目标架构：$PLATFORM  镜像：$IMAGE"
echo "[打包] 开始构建（首次较慢；M 芯片走模拟更慢，请耐心）…"
docker buildx build --platform "$PLATFORM" -f Dockerfile.aio -t "$IMAGE" --load .

echo "[打包] 导出为 $OUT …"
docker save "$IMAGE" | gzip > "$OUT"

SIZE="$(du -h "$OUT" | cut -f1)"
echo
echo "[✓] 打包完成：$OUT （$SIZE）"
echo
echo "下一步（把包传到服务器并启动）："
echo "  1) 上传：  scp $OUT root@<服务器IP>:/data/code/onebase/"
echo "  2) 服务器：cd /data/code/onebase && git pull            # 确保脚本/compose 是最新"
echo "  3) 服务器：./deploy.sh load $OUT && ./deploy.sh start   # 加载镜像并启动（不编译）"
echo "  4) 服务器：sudo ./proxy.sh <域名> <邮箱>                 # 上 HTTPS（可选）"
