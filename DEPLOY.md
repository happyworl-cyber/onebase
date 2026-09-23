# 部署指南（DEPLOY）

本项目把 **Rust API + Next.js 前端打包进同一个容器**，由 supervisor 同时拉起（后端 `:3000`、前端 `:3001`）。前端通过 Next.js rewrites **同源反代** `/api /auth /query /events /sse /mcp /health …` 到后端；只有 `/gateway-admin /healthz` 转发到独立的 Go 网关控制面。**所以 Rust 与 Web UI 不需要分开部署**，浏览器只访问前端入口即可。

两种镜像：
- **方案 A（`Dockerfile`）**：仅 App（API+UI），PostgreSQL / Redis 用外部服务。生产 / 需扩容时用。
- **方案 B（`Dockerfile.aio` + `docker-compose.yml`）**：PG + Redis + API + UI 全在一个容器。单机 / 演示 / POC。**下面以方案 B + 一键脚本为主。**

---

## 一、快速部署（方案 B，一键）

服务器需先装好 **Docker** 与 **docker compose 插件**，能联网拉基础镜像，建议 **≥ 8GB 内存**（Rust 首次编译较吃内存）。

```bash
# 1) 拉代码（私有仓库，需凭证或部署密钥）
git clone https://github.com/happyworl-cyber/onebase.git
cd onebase

# 2) 起应用（自动生成 .env 密钥 → 构建 → 启动 → 等就绪）
./deploy.sh
#    本机验证：http://localhost:3011

# 3) 上 HTTPS 反代（443 → 应用入口 3011，自动申请/续期证书）
sudo ./proxy.sh app.example.com admin@example.com
#    只有 IP、无域名时：sudo ./proxy.sh <服务器IP> --self-signed
```

完成后访问 **https://app.example.com**，用初始账号登录并**立即改密**：

```
admin@example.com / Admin123
```

---

## 一·B、本地打包 → 服务器直接加载（**小内存服务器推荐**）

服务器内存小（如 4GB）时，在本机/构建机编译 Rust 容易慢或 OOM。改成**本地打包镜像、上传、服务器只加载不编译**：

```bash
# 本机（装了 Docker Desktop / buildx，在仓库根目录）
./build-image.sh                       # 构建 linux/amd64 一体机镜像 → planeos-aio.tar.gz
                                       # M 芯片走模拟偏慢但不 OOM，只需一次

# 上传到服务器
scp planeos-aio.tar.gz root@<服务器IP>:/data/code/onebase/

# 服务器（已 git clone 过本仓库）
cd /data/code/onebase
git pull                               # 确保脚本/compose 最新
./deploy.sh load planeos-aio.tar.gz    # 加载镜像
./deploy.sh start                      # 用预构建镜像启动（不编译）
sudo ./proxy.sh <域名> <邮箱>          # 上 HTTPS（可选）
```

- 目标架构默认 `linux/amd64`（阿里云 ECS 基本是 x86_64）；ARM 服务器：`PLATFORM=linux/arm64 ./build-image.sh`。
- 镜像名固定 `planeos:aio`（与 `docker-compose.yml` 的 `image:` 对应），`start` 会用它、跳过构建。
- 更新版本：本机重跑 `./build-image.sh` → 传新包 → 服务器 `./deploy.sh load 新包 && ./deploy.sh restart`。

---

## 二、`deploy.sh` 子命令

| 命令 | 作用 |
|---|---|
| `./deploy.sh` / `up` | 生成/校验 `.env`、构建并启动、等健康、打印入口 |
| `./deploy.sh rebuild` | **改了代码 / 前端词条 / 迁移后**：重建镜像并启动 |
| `./deploy.sh restart` | 重启容器（不重建镜像） |
| `./deploy.sh logs` | 跟随查看日志 |
| `./deploy.sh status` | 容器 + 健康状态 |
| `./deploy.sh admin` | 重置/确保初始管理员 `admin@example.com / Admin123` |
| `./deploy.sh stop` | 停止并移除容器（**保留数据卷**） |
| `./deploy.sh destroy` | 停止并删除数据卷（**清库**，二次确认） |

- 首启 `AUTO_MIGRATE=on` 会自动建表并跑到最新迁移（含 `077`，`ADD COLUMN IF NOT EXISTS`，可重复执行）。
- 镜像**从当前工作目录构建**，`git pull` 到最新后 `./deploy.sh rebuild` 即可，无需手动改配置。

---

## 三、`proxy.sh`（Caddy 一键 HTTPS）

```bash
sudo ./proxy.sh <域名> [ACME邮箱]     # 正式域名：自动 Let's Encrypt 证书
sudo ./proxy.sh <IP> --self-signed    # 纯 IP / 无域名：自签证书（浏览器会告警）
```

- Debian/Ubuntu 上用官方源自动装 Caddy（已装则跳过），写 `/etc/caddy/Caddyfile` 并 `systemctl` 起服务。
- 反代 `443 → 127.0.0.1:3011`；`flush_interval -1` 保证 SSE / 流式 / 工作流长请求实时刷新。
- 前置：**域名 A 记录先指向服务器公网 IP**，放行 **80 + 443**（80 供 ACME 验证）。`ufw` 若启用会自动放行。
- 常用：`systemctl status caddy`、`journalctl -u caddy -f`、`systemctl reload caddy`。

---

## 四、端口与安全

| 端口 | 用途 |
|---|---|
| 443 | HTTPS 入口（Caddy）→ 3011 |
| 3011 | 应用前端入口（UI + 同源反代 API） |
| 3010 | Rust API 直连（API Key / 外部直连 / 网关注入时用） |
| 5432 / 6379 | 容器内 PG / Redis，**生产不要对外暴露** |

装好反代后建议：
- 关闭 3010 / 3011 的公网暴露（安全组/防火墙只留 443）。
- 应用 `CORS_ORIGINS` 收紧为 `https://<域名>`（改 `.env` 后 `./deploy.sh restart`）。

---

## 五、必填环境变量（`.env`，`deploy.sh` 会自动生成密钥）

| 变量 | 说明 |
|---|---|
| `JWT_SECRET` | ≥16 字符、非占位；`deploy.sh` 用 `openssl rand -base64 48` 自动生成 |
| `ENCRYPTION_KEY` | base64 的 32 字节；`openssl rand -base64 32` 自动生成 |
| `CORS_ORIGINS` | 默认 `*`；生产改为你的域名 |

> 方案 B 的 `DATABASE_URL / REDIS_URL / PROVISION_PG_URL` 指向容器内自带的 PG/Redis，**无需手填**。
> 方案 A（外部库）则必须提供这三项 + 上面三项。

---

## 六、更新与运维

```bash
cd onebase
git pull
./deploy.sh rebuild      # 重建镜像并启动（反代不用动）
```

- 迁移在启动时自动执行（`src/migrate.rs` 的 `include_str!` 序列，改迁移只动这一处 + 加 `migrations/NNN_*.sql`）。
- 数据在 named volume（`pgdata` / `redisdata` / `logs`）；`stop` 保留、`destroy` 清空。

---

## 七、网关策略（可选，企业版基础设施）

「网关策略」页依赖独立的 **Go 网关控制面**（走 `GATEWAY_CONTROL_URL` / Ingress `/gateway-admin`）。**不部署也不影响主功能**——页面会显示"暂不可用"友好占位而非报错；控制面部署可达后自动恢复。
