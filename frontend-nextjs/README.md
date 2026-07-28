# OneBase Frontend (Next.js + React)

基于 React 18 + Next.js 14 + TypeScript + Tailwind CSS 的企业级前端应用。

## 技术栈

- **Next.js 14**: React 框架，支持 App Router
- **React 18**: UI 库
- **TypeScript**: 类型安全
- **Tailwind CSS**: 样式框架
- **Axios**: HTTP 客户端
- **Zustand**: 状态管理（轻量级）
- **React Query**: 服务端状态管理

## 快速开始

### 1. 安装依赖

```bash
cd frontend-nextjs
npm install
# 或
yarn install
# 或
pnpm install
```

### 2. 配置环境变量

```bash
cp .env.local.example .env.local
```

编辑 `.env.local`：

```env
NEXT_PUBLIC_API_URL=http://localhost:3000
```

### 3. 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:3001 （Next.js 默认端口）

### 4. 构建生产版本

```bash
npm run build
npm start
```

## 项目结构

```
frontend-nextjs/
├── app/                    # Next.js 13+ App Router
│   ├── layout.tsx         # 根布局
│   ├── page.tsx           # 首页（重定向）
│   ├── globals.css        # 全局样式
│   ├── login/             # 登录页面
│   │   └── page.tsx
│   └── dashboard/         # 管理后台
│       ├── layout.tsx     # 后台布局
│       ├── page.tsx       # 仪表盘
│       ├── schema/        # Schema 浏览器
│       ├── tables/        # 数据表管理
│       ├── query/         # SQL 查询
│       ├── transaction/   # 事务管理
│       └── users/         # 用户管理
├── components/            # 通用组件
│   ├── Sidebar.tsx        # 侧边栏
│   ├── Header.tsx         # 顶部导航
│   └── ...
├── lib/                   # 工具库
│   ├── api.ts            # API 客户端
│   └── utils.ts          # 工具函数
├── hooks/                 # 自定义 Hooks
├── store/                 # Zustand 状态管理
├── types/                 # TypeScript 类型定义
├── public/                # 静态资源
├── next.config.js         # Next.js 配置
├── tailwind.config.ts     # Tailwind 配置
└── tsconfig.json          # TypeScript 配置
```

## 开发指南

### API 调用

在 `lib/api.ts` 中封装 API 调用：

```typescript
import axios from 'axios'

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
})

// 请求拦截器
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

export default api
```

### 状态管理

使用 Zustand 进行客户端状态管理：

```typescript
import create from 'zustand'

interface AppState {
  user: User | null
  setUser: (user: User) => void
}

export const useStore = create<AppState>((set) => ({
  user: null,
  setUser: (user) => set({ user }),
}))
```

### 样式规范

1. 使用 Tailwind CSS 实用类
2. 自定义组件样式在 `globals.css` 中定义
3. 使用 `clsx` 或 `cn` 工具合并类名

### 路由

Next.js 13+ 使用文件系统路由：

- `/app/page.tsx` → `/`
- `/app/login/page.tsx` → `/login`
- `/app/dashboard/page.tsx` → `/dashboard`

## 与后端集成

### 开发环境

使用 Next.js 的 `rewrites` 功能代理 API 请求：

```javascript
// next.config.js
async rewrites() {
  return [
    {
      source: '/api/:path*',
      destination: 'http://localhost:3000/api/:path*',
    },
  ]
}
```

### 生产环境

1. **分离部署**：前端部署到 Vercel/Netlify，配置 CORS
2. **一体部署**：构建后放入 Rust 项目的 `static` 目录

## 从 Vue 迁移指南

### 1. 组件迁移

**Vue 组件：**
```vue
<template>
  <button @click="handleClick">{{ text }}</button>
</template>

<script>
export default {
  data() {
    return { text: 'Click me' }
  },
  methods: {
    handleClick() { ... }
  }
}
</script>
```

**React 组件：**
```tsx
function MyButton() {
  const [text, setText] = useState('Click me')
  
  const handleClick = () => { ... }
  
  return <button onClick={handleClick}>{text}</button>
}
```

### 2. 状态管理

- Vue: `data()` → React: `useState()`
- Vue: `computed` → React: `useMemo()`
- Vue: `watch` → React: `useEffect()`
- Vuex → Zustand / Redux

### 3. 生命周期

- Vue: `mounted` → React: `useEffect(() => {}, [])`
- Vue: `beforeDestroy` → React: `useEffect(() => () => {}, [])`

## 部署

### Vercel（推荐）

```bash
npm install -g vercel
vercel
```

### Docker

```dockerfile
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:18-alpine
WORKDIR /app
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package*.json ./
RUN npm ci --only=production
EXPOSE 3000
CMD ["npm", "start"]
```

### Nginx

构建后的静态文件在 `.next/` 目录，需要 Node.js 服务器运行。

## 常见问题

### Q: 如何处理认证？

使用 localStorage 存储 JWT token，在 API 拦截器中自动添加。

### Q: 如何优化性能？

1. 使用 Next.js 的 Image 组件
2. 使用 React.lazy() 懒加载组件
3. 使用 React Query 缓存数据
4. 启用 Next.js 的增量静态再生成

### Q: 如何调试？

使用 React DevTools 和 Next.js DevTools。

## License

MIT

