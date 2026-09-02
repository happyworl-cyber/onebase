# PlaneOS 官网部署指南

## 📋 项目说明

这是 PlaneOS 的官方网站，采用单页面 HTML 设计，包含多语言支持（中文/英文）。

- **域名**: planeos.net
- **技术**: 静态 HTML + CSS + JavaScript
- **文件**: `index.html` (100KB)

---

## 🚀 部署方式

### 方式 1：Vercel 部署（推荐）⭐

**优势**: 免费、自动部署、全球 CDN、自动 HTTPS

#### 步骤：

1. **安装 Vercel CLI**（如果还没安装）
```bash
npm install -g vercel
```

2. **登录 Vercel**
```bash
vercel login
```

3. **部署到 Vercel**
```bash
cd website
vercel
```

首次部署会询问：
- Set up and deploy? → **Y**
- Which scope? → 选择你的账号
- Link to existing project? → **N**
- What's your project's name? → `planeos-website`（或其他名称）
- In which directory is your code located? → `.`（直接回车）

4. **配置自定义域名**（可选）

在 Vercel Dashboard 中：
- 进入项目 → Settings → Domains
- 添加 `planeos.net`
- 按照提示配置 DNS 记录

5. **生产环境部署**
```bash
vercel --prod
```

---

### 方式 2：GitHub Pages 部署

**优势**: 完全免费、简单

#### 步骤：

1. **创建 GitHub Actions 工作流**

在项目根目录创建 `.github/workflows/deploy-website.yml`:

```yaml
name: Deploy Website to GitHub Pages

on:
  push:
    branches: [main]
    paths:
      - 'website/**'

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Pages
        uses: actions/configure-pages@v4

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: './website'

      - name: Deploy to GitHub Pages
        uses: actions/deploy-pages@v4
```

2. **在 GitHub 仓库设置中启用 Pages**
   - Settings → Pages
   - Source: GitHub Actions

3. **推送代码**
```bash
git add .
git commit -m "chore: add GitHub Pages deployment"
git push
```

---

### 方式 3：Cloudflare Pages 部署

**优势**: 免费、全球最快 CDN、无限带宽

#### 步骤：

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Pages → Create a project → Connect to Git
3. 选择 GitHub 仓库 `onebase`
4. 配置构建设置：
   - Build command: （留空）
   - Build output directory: `website`
5. 点击 **Save and Deploy**

---

### 方式 4：自建服务器（Nginx）

**适用于**: 已有服务器，需要完全控制

#### Nginx 配置示例：

```nginx
server {
    listen 80;
    server_name planeos.net www.planeos.net;

    # 重定向到 HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name planeos.net www.planeos.net;

    # SSL 证书（使用 Let's Encrypt）
    ssl_certificate /etc/letsencrypt/live/planeos.net/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/planeos.net/privkey.pem;

    root /var/www/planeos-website;
    index index.html;

    # 启用 gzip 压缩
    gzip on;
    gzip_types text/html text/css application/javascript;

    # 缓存策略
    location ~* \.(css|js|jpg|jpeg|png|gif|svg|woff|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

#### 部署步骤：

```bash
# 1. 上传文件到服务器
scp -r website/* user@your-server:/var/www/planeos-website/

# 2. 配置 Nginx
sudo nano /etc/nginx/sites-available/planeos

# 3. 启用站点
sudo ln -s /etc/nginx/sites-available/planeos /etc/nginx/sites-enabled/

# 4. 安装 SSL 证书（Let's Encrypt）
sudo certbot --nginx -d planeos.net -d www.planeos.net

# 5. 重启 Nginx
sudo systemctl reload nginx
```

---

## 🔧 本地预览

使用任意 HTTP 服务器预览：

**方式 1: Python**
```bash
cd website
python3 -m http.server 8080
```

**方式 2: Node.js**
```bash
npx http-server website -p 8080
```

**方式 3: PHP**
```bash
cd website
php -S localhost:8080
```

然后访问 http://localhost:8080

---

## 📝 域名配置

### DNS 记录示例（Vercel）

```
A    planeos.net        76.76.21.21
CNAME www.planeos.net   cname.vercel-dns.com
```

### DNS 记录示例（Cloudflare Pages）

```
CNAME planeos.net       your-project.pages.dev
CNAME www.planeos.net   your-project.pages.dev
```

---

## ✅ 部署后检查清单

- [ ] 网站可以正常访问
- [ ] HTTPS 证书正常
- [ ] 中英文切换正常
- [ ] 移动端适配正常
- [ ] 页面加载速度 < 2 秒
- [ ] SEO meta 标签正确
- [ ] Favicon 正常显示

---

## 📊 性能优化建议

已完成：
- ✅ 单页面 HTML（无需构建）
- ✅ 内联样式（减少 HTTP 请求）
- ✅ 响应式设计
- ✅ SEO 优化

可选优化：
- 启用 CDN（Vercel/Cloudflare 自动启用）
- 图片懒加载（如有图片）
- Service Worker（离线支持）

---

## 🆘 常见问题

**Q: 域名还未生效？**
A: DNS 解析需要 24-48 小时，可以使用 `dig planeos.net` 检查

**Q: HTTPS 证书错误？**
A: Vercel/Cloudflare 会自动配置，等待几分钟即可

**Q: 如何回滚到之前的版本？**
A: Vercel Dashboard → Deployments → 选择历史版本 → Promote to Production

---

**最后更新**: 2026-09-02
**维护者**: OneBase Team
