-- ============================================
-- ER 图演示：带外键关系的表结构
-- ============================================
-- 这个脚本会创建一组有外键关系的示例表，
-- 用于测试 ER 图的连线显示功能

-- 1. 作者表 (authors)
CREATE TABLE IF NOT EXISTS authors (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE,
    bio TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. 分类表 (categories)
CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. 文章表 (articles) - 引用 authors 和 categories
CREATE TABLE IF NOT EXISTS articles (
    id SERIAL PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    content TEXT,
    author_id INTEGER NOT NULL,
    category_id INTEGER,
    published_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- 外键约束
    CONSTRAINT fk_articles_author 
        FOREIGN KEY (author_id) REFERENCES authors(id) ON DELETE CASCADE,
    CONSTRAINT fk_articles_category 
        FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

-- 4. 评论表 (comments) - 引用 articles 和 authors
CREATE TABLE IF NOT EXISTS comments (
    id SERIAL PRIMARY KEY,
    article_id INTEGER NOT NULL,
    author_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- 外键约束
    CONSTRAINT fk_comments_article 
        FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE,
    CONSTRAINT fk_comments_author 
        FOREIGN KEY (author_id) REFERENCES authors(id) ON DELETE CASCADE
);

-- 5. 标签表 (tags)
CREATE TABLE IF NOT EXISTS tags (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. 文章-标签关联表 (article_tags) - 多对多关系
CREATE TABLE IF NOT EXISTS article_tags (
    id SERIAL PRIMARY KEY,
    article_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- 外键约束
    CONSTRAINT fk_article_tags_article 
        FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE,
    CONSTRAINT fk_article_tags_tag 
        FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE,
    
    -- 唯一约束
    UNIQUE(article_id, tag_id)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_articles_author ON articles(author_id);
CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category_id);
CREATE INDEX IF NOT EXISTS idx_comments_article ON comments(article_id);
CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_id);
CREATE INDEX IF NOT EXISTS idx_article_tags_article ON article_tags(article_id);
CREATE INDEX IF NOT EXISTS idx_article_tags_tag ON article_tags(tag_id);

-- 插入示例数据
INSERT INTO authors (name, email, bio) VALUES
    ('张三', 'zhangsan@example.com', '资深技术博主'),
    ('李四', 'lisi@example.com', 'Python 开发者'),
    ('王五', 'wangwu@example.com', '全栈工程师')
ON CONFLICT (email) DO NOTHING;

INSERT INTO categories (name, description) VALUES
    ('技术', '技术相关文章'),
    ('生活', '生活随笔'),
    ('教程', '技术教程')
ON CONFLICT (name) DO NOTHING;

INSERT INTO tags (name) VALUES
    ('PostgreSQL'), ('React'), ('Node.js'), ('数据库'), ('前端')
ON CONFLICT (name) DO NOTHING;

-- 插入文章（使用子查询获取真实的 ID）
INSERT INTO articles (title, content, author_id, category_id, published_at)
SELECT 
    'PostgreSQL 高级特性详解',
    '本文介绍 PostgreSQL 的高级特性...',
    a.id,
    c.id,
    CURRENT_TIMESTAMP
FROM authors a, categories c
WHERE a.email = 'zhangsan@example.com' AND c.name = '技术'
ON CONFLICT DO NOTHING;

INSERT INTO articles (title, content, author_id, category_id, published_at)
SELECT 
    'React 性能优化技巧',
    '介绍 React 应用的性能优化方法...',
    a.id,
    c.id,
    CURRENT_TIMESTAMP
FROM authors a, categories c
WHERE a.email = 'lisi@example.com' AND c.name = '教程'
ON CONFLICT DO NOTHING;

-- 插入评论
INSERT INTO comments (article_id, author_id, content)
SELECT 
    ar.id,
    au.id,
    '很棒的文章，学到了很多！'
FROM articles ar, authors au
WHERE ar.title = 'PostgreSQL 高级特性详解' AND au.email = 'lisi@example.com'
ON CONFLICT DO NOTHING;

-- 插入文章标签关联
INSERT INTO article_tags (article_id, tag_id)
SELECT ar.id, t.id
FROM articles ar, tags t
WHERE ar.title = 'PostgreSQL 高级特性详解' AND t.name IN ('PostgreSQL', '数据库')
ON CONFLICT DO NOTHING;

INSERT INTO article_tags (article_id, tag_id)
SELECT ar.id, t.id
FROM articles ar, tags t
WHERE ar.title = 'React 性能优化技巧' AND t.name IN ('React', '前端')
ON CONFLICT DO NOTHING;

-- 完成提示
SELECT 'ER 图演示数据创建完成！' AS message,
       '已创建 6 个表，包含多个外键关系' AS details,
       '请刷新 ER 图页面查看连线效果' AS next_step;

