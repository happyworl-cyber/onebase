-- OneBase 示例数据库 Schema

-- 创建 Schema（如果需要）
CREATE SCHEMA IF NOT EXISTS public;

-- 用户表
CREATE TABLE IF NOT EXISTS public.users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    age INTEGER CHECK (age >= 0 AND age <= 150),
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'inactive', 'verified')),
    bio TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL
);

-- 文章表
CREATE TABLE IF NOT EXISTS public.posts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES public.users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    content TEXT,
    status VARCHAR(50) DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
    views INTEGER DEFAULT 0,
    published_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 评论表
CREATE TABLE IF NOT EXISTS public.comments (
    id SERIAL PRIMARY KEY,
    post_id INTEGER REFERENCES public.posts(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES public.users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    parent_id INTEGER REFERENCES public.comments(id) ON DELETE CASCADE NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 标签表
CREATE TABLE IF NOT EXISTS public.tags (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 文章标签关联表
CREATE TABLE IF NOT EXISTS public.post_tags (
    post_id INTEGER REFERENCES public.posts(id) ON DELETE CASCADE,
    tag_id INTEGER REFERENCES public.tags(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, tag_id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引（提升查询性能）
CREATE INDEX IF NOT EXISTS idx_users_status ON public.users(status);
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON public.users(created_at);

CREATE INDEX IF NOT EXISTS idx_posts_user_id ON public.posts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_status ON public.posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON public.posts(created_at);

CREATE INDEX IF NOT EXISTS idx_comments_post_id ON public.comments(post_id);
CREATE INDEX IF NOT EXISTS idx_comments_user_id ON public.comments(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent_id ON public.comments(parent_id);

-- 插入示例数据
INSERT INTO public.users (name, email, age, status, bio) VALUES
('张三', 'zhangsan@example.com', 25, 'active', '热爱编程的开发者'),
('李四', 'lisi@example.com', 30, 'active', '全栈工程师'),
('王五', 'wangwu@example.com', 22, 'pending', '前端开发者'),
('赵六', 'zhaoliu@example.com', 28, 'verified', 'Rust 爱好者'),
('钱七', 'qianqi@example.com', 35, 'active', '数据库专家')
ON CONFLICT (email) DO NOTHING;

INSERT INTO public.posts (user_id, title, content, status, views, published_at) VALUES
(1, 'Rust 入门指南', '这是一篇关于 Rust 编程语言的入门教程...', 'published', 1500, NOW() - INTERVAL '7 days'),
(1, 'PostgreSQL 优化技巧', '分享一些 PostgreSQL 性能优化的经验...', 'published', 800, NOW() - INTERVAL '5 days'),
(2, 'React Hooks 深入解析', '深入探讨 React Hooks 的原理和最佳实践...', 'published', 2000, NOW() - INTERVAL '3 days'),
(3, 'CSS Grid 布局完全指南', '全面介绍 CSS Grid 布局系统...', 'published', 1200, NOW() - INTERVAL '2 days'),
(4, 'Axum Web 框架实战', '使用 Rust Axum 构建高性能 Web 服务...', 'draft', 0, NULL)
ON CONFLICT DO NOTHING;

INSERT INTO public.tags (name, description) VALUES
('Rust', 'Rust 编程语言相关'),
('PostgreSQL', '数据库相关'),
('React', 'React 框架相关'),
('CSS', '样式和布局相关'),
('Web', 'Web 开发相关'),
('Performance', '性能优化相关')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.post_tags (post_id, tag_id) VALUES
(1, 1), (1, 5),
(2, 2), (2, 6),
(3, 3), (3, 5),
(4, 4), (4, 5),
(5, 1), (5, 5)
ON CONFLICT DO NOTHING;

INSERT INTO public.comments (post_id, user_id, content) VALUES
(1, 2, '写得很好，对新手很友好！'),
(1, 3, '期待更多 Rust 相关的文章'),
(2, 4, '这些优化技巧很实用'),
(3, 1, '清晰易懂，感谢分享'),
(3, 5, 'Grid 布局确实很强大')
ON CONFLICT DO NOTHING;

-- 创建更新时间触发器
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON public.users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_posts_updated_at BEFORE UPDATE ON public.posts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_comments_updated_at BEFORE UPDATE ON public.comments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 查看数据统计
SELECT 
    'users' as table_name, 
    COUNT(*) as count 
FROM public.users
UNION ALL
SELECT 
    'posts' as table_name, 
    COUNT(*) as count 
FROM public.posts
UNION ALL
SELECT 
    'comments' as table_name, 
    COUNT(*) as count 
FROM public.comments
UNION ALL
SELECT 
    'tags' as table_name, 
    COUNT(*) as count 
FROM public.tags;

-- 示例查询
-- 1. 查询所有活跃用户
-- SELECT * FROM public.users WHERE status = 'active';

-- 2. 查询最新的文章
-- SELECT * FROM public.posts WHERE status = 'published' ORDER BY created_at DESC LIMIT 10;

-- 3. 查询用户的文章及评论数
-- SELECT 
--     u.name,
--     COUNT(DISTINCT p.id) as post_count,
--     COUNT(DISTINCT c.id) as comment_count
-- FROM public.users u
-- LEFT JOIN public.posts p ON u.id = p.user_id
-- LEFT JOIN public.comments c ON u.id = c.user_id
-- GROUP BY u.id, u.name;

