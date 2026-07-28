-- 创建产品分类表
CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 创建产品表（外键到 categories）
CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    category_id INTEGER NOT NULL,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    price DECIMAL(10, 2) NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_products_category 
        FOREIGN KEY (category_id) 
        REFERENCES categories(id) 
        ON DELETE CASCADE
);

-- 创建订单表（外键到 users）
CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    total_amount DECIMAL(10, 2) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_orders_user 
        FOREIGN KEY (user_id) 
        REFERENCES users(id) 
        ON DELETE CASCADE
);

-- 创建订单明细表（外键到 orders 和 products）
CREATE TABLE IF NOT EXISTS order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_order_items_order 
        FOREIGN KEY (order_id) 
        REFERENCES orders(id) 
        ON DELETE CASCADE,
    CONSTRAINT fk_order_items_product 
        FOREIGN KEY (product_id) 
        REFERENCES products(id) 
        ON DELETE CASCADE
);

-- 创建用户地址表（外键到 users）
CREATE TABLE IF NOT EXISTS user_addresses (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    address_line1 VARCHAR(255) NOT NULL,
    address_line2 VARCHAR(255),
    city VARCHAR(100) NOT NULL,
    state VARCHAR(100),
    postal_code VARCHAR(20),
    country VARCHAR(100) NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_user_addresses_user 
        FOREIGN KEY (user_id) 
        REFERENCES users(id) 
        ON DELETE CASCADE
);

-- 创建产品评论表（外键到 users 和 products）
CREATE TABLE IF NOT EXISTS product_reviews (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    comment TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_product_reviews_user 
        FOREIGN KEY (user_id) 
        REFERENCES users(id) 
        ON DELETE CASCADE,
    CONSTRAINT fk_product_reviews_product 
        FOREIGN KEY (product_id) 
        REFERENCES products(id) 
        ON DELETE CASCADE
);

-- 插入示例数据

-- 分类
INSERT INTO categories (name, description) VALUES
    ('电子产品', '各类电子设备和配件'),
    ('图书', '各类书籍和杂志'),
    ('服装', '男女服装和配饰')
ON CONFLICT DO NOTHING;

-- 产品
INSERT INTO products (category_id, name, description, price, stock) VALUES
    (1, '笔记本电脑', '高性能办公笔记本', 5999.00, 50),
    (1, '无线鼠标', '人体工学设计', 99.00, 200),
    (2, 'PostgreSQL 实战', '数据库开发指南', 89.00, 100),
    (3, 'T恤衫', '纯棉舒适', 59.00, 500)
ON CONFLICT DO NOTHING;

-- 订单（使用已存在的 admin 用户）
INSERT INTO orders (user_id, total_amount, status)
SELECT id, 6087.00, 'completed'
FROM users 
WHERE username = 'admin'
LIMIT 1
ON CONFLICT DO NOTHING;

-- 订单明细
INSERT INTO order_items (order_id, product_id, quantity, price)
SELECT o.id, 1, 1, 5999.00
FROM orders o
WHERE o.user_id = (SELECT id FROM users WHERE username = 'admin' LIMIT 1)
LIMIT 1
ON CONFLICT DO NOTHING;

INSERT INTO order_items (order_id, product_id, quantity, price)
SELECT o.id, 2, 1, 99.00
FROM orders o
WHERE o.user_id = (SELECT id FROM users WHERE username = 'admin' LIMIT 1)
LIMIT 1
ON CONFLICT DO NOTHING;

-- 用户地址
INSERT INTO user_addresses (user_id, address_line1, city, country, is_default)
SELECT id, '北京市朝阳区XX路XX号', '北京', '中国', true
FROM users 
WHERE username = 'admin'
LIMIT 1
ON CONFLICT DO NOTHING;

-- 产品评论
INSERT INTO product_reviews (user_id, product_id, rating, comment)
SELECT u.id, 1, 5, '性能很好，物有所值！'
FROM users u
WHERE u.username = 'admin'
LIMIT 1
ON CONFLICT DO NOTHING;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_user_addresses_user_id ON user_addresses(user_id);
CREATE INDEX IF NOT EXISTS idx_product_reviews_user_id ON product_reviews(user_id);
CREATE INDEX IF NOT EXISTS idx_product_reviews_product_id ON product_reviews(product_id);

