-- =====================================================================
-- Acme → Elasticsearch 同步：纯 SQL 方案
--   PG http 扩展 ──> onebase /api/es-app/* ──> Elasticsearch
-- =====================================================================
--
-- 在 onebase 的【SQL 编辑器】里按 `acme_test` (库=supabase, schema=gamesq)
-- 整段 paste & run。需要超管权限。
--
-- 设计要点：
--   · ES 的真实地址/账密**不**进这张库；只配 onebase HTTP 入口 + 一个 cres_es_* token。
--   · 写入走 onebase 的应用 API (`/api/es-app/:index/bulk`)，onebase 帮忙转 ES `_bulk`、
--     做审计、强制 token ACL（method 白名单、index 白名单）。
--   · 这份脚本会在 gamesq 下创建：
--       _es_sync_config            设置表（onebase 入口 / token / 索引名 / batch）
--       _es_setting / _strip_html / _parse_tac / _parse_description    工具函数
--       _es_call / _es_bulk        onebase HTTP 客户端
--       _es_*_fields / _es_common_settings   mapping 片段
--       _es_ensure_index           按 mapping 建索引（幂等；走 /api/es-app/:idx/_init）
--       es_init_indices            外层入口
--       es_sync_articles           帖子同步（含软删/隐藏清理）
--       es_sync_communities        社区同步（含转私有/下架清理）
--       es_sync_users              用户同步（含封禁清理）
--       es_sync_all                一键全量/增量（定时任务调它）
--
-- 适用版本：PostgreSQL 12+，pgsql-http 1.5+。
-- =====================================================================

-- ── 0. 前置依赖：pgsql-http 扩展必须由 DBA 已经装好
--   RDS：控制台 → 扩展管理 → 勾选 http
--   自建：用 superuser 跑 `CREATE EXTENSION http;`
--
-- 这里不直接 `CREATE EXTENSION`，因为在 onebase SQL 编辑器里通常没有 superuser，
-- 静默失败会让后面所有 `http_response` 类型引用都报"type does not exist"，
-- 不如先用一个明确的检查兜住。注意：很多托管 PG 会把扩展装在 `extensions`
-- 等非 public schema；下面的函数会动态读取实际 schema，不要求必须是 public。
DO $$
DECLARE
    ext_schema name;
BEGIN
    SELECT n.nspname INTO ext_schema
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'http';

    IF ext_schema IS NULL THEN
        RAISE EXCEPTION
          'pgsql-http 扩展未安装。请先：1) 阿里云 RDS 控制台 -> 扩展管理 -> 安装 http；'
          '或 2) 用 superuser 执行 `CREATE EXTENSION http;`。'
          '装好后回到 onebase SQL 编辑器重跑本脚本。';
    END IF;
END $$;

-- ── 1. 设置表
CREATE TABLE IF NOT EXISTS gamesq._es_sync_config (
    key   text PRIMARY KEY,
    value text NOT NULL
);

-- 占位行：apply 后改成真实值。
--   onebase_base_url：onebase HTTP 监听地址（必须从 PG 这台机器能访问到；
--     如果 PG 在公网 RDS、onebase 在内网，请填 onebase 公网/反代地址）。
--   onebase_es_token：在 onebase【ES 反向代理】页面给目标连接申请的 `cres_es_*` token，
--     methods_allow 至少含 GET/POST/PUT/DELETE，indices_allow 至少覆盖三个目标索引。
INSERT INTO gamesq._es_sync_config(key, value) VALUES
    ('onebase_base_url',  'http://127.0.0.1:3006'),
    ('onebase_es_token',  'cres_es_REPLACE_ME'),
    ('article_index',       'way_article_search_main'),
    ('community_index',     'way_community_search'),
    ('user_index',          'way_user_search'),
    ('article_batch',       '500'),
    ('community_batch',     '200'),
    ('user_batch',          '500'),
    ('http_connect_timeout_ms', '10000'),
    ('http_timeout_ms',     '30000')
ON CONFLICT (key) DO NOTHING;

-- 即便老库已经存在 _es_sync_config，也补一行 connect_timeout（如缺失）
INSERT INTO gamesq._es_sync_config(key, value)
VALUES ('http_connect_timeout_ms', '10000')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION gamesq._es_setting(p_key text) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT value FROM gamesq._es_sync_config WHERE key = p_key;
$$;

CREATE OR REPLACE FUNCTION gamesq._es_http_schema() RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT n.nspname::text
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'http';
$$;


-- ── 2. 工具：HTML 去标签
CREATE OR REPLACE FUNCTION gamesq._es_strip_html(t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT trim(regexp_replace(COALESCE(t, ''), '<[^>]+>', ' ', 'g'));
$$;


-- ── 3. 工具：解析 article.titleAndcontent → (titles[], contents[]) jsonb
-- 源数据每个元素形如：
--   {"lang":"en","lang_zn":"en","title":"标题(可能为空)","content":"正文 markdown/html"}
-- 注意键名是 lang / content（不是 flang / value）；反馈类帖子 title 常为空，正文在 content。
CREATE OR REPLACE FUNCTION gamesq._es_parse_tac(raw text)
RETURNS TABLE (titles jsonb, contents jsonb)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    parsed jsonb;
BEGIN
    IF raw IS NULL OR raw = '' THEN
        titles := '[]'::jsonb; contents := '[]'::jsonb; RETURN NEXT; RETURN;
    END IF;
    BEGIN
        parsed := raw::jsonb;
    EXCEPTION WHEN others THEN
        titles := '[]'::jsonb; contents := '[]'::jsonb; RETURN NEXT; RETURN;
    END;
    IF jsonb_typeof(parsed) <> 'array' THEN
        titles := '[]'::jsonb; contents := '[]'::jsonb; RETURN NEXT; RETURN;
    END IF;

    SELECT
        COALESCE(jsonb_agg(jsonb_build_object(
            'flang',       item->>'lang',
            'value',       item->>'title',
            'is_original', COALESCE((item->>'is_original')::boolean, false)
        )) FILTER (WHERE COALESCE(item->>'title','') <> ''), '[]'::jsonb),
        COALESCE(jsonb_agg(jsonb_build_object(
            'flang',       item->>'lang',
            'value',       gamesq._es_strip_html(item->>'content'),
            'is_original', COALESCE((item->>'is_original')::boolean, false)
        )) FILTER (WHERE gamesq._es_strip_html(item->>'content') <> ''), '[]'::jsonb)
    INTO titles, contents
    FROM jsonb_array_elements(parsed) AS item;

    RETURN NEXT;
END;
$$;


-- ── 4. 工具：解析社区 description（dict 或 array 都接受）
CREATE OR REPLACE FUNCTION gamesq._es_parse_description(raw text)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    parsed jsonb;
    result jsonb := '[]'::jsonb;
BEGIN
    IF raw IS NULL OR raw = '' THEN RETURN '[]'::jsonb; END IF;
    BEGIN
        parsed := raw::jsonb;
    EXCEPTION WHEN others THEN
        RETURN '[]'::jsonb;
    END;
    IF jsonb_typeof(parsed) = 'object' THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object('lang', k, 'value', v)) FILTER (WHERE COALESCE(v,'') <> ''), '[]'::jsonb)
        INTO result
        FROM jsonb_each_text(parsed) AS t(k, v);
    ELSIF jsonb_typeof(parsed) = 'array' THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'lang',  COALESCE(item->>'flang', item->>'lang'),
            'value', item->>'value'
        )) FILTER (WHERE COALESCE(item->>'value','') <> ''), '[]'::jsonb)
        INTO result
        FROM jsonb_array_elements(parsed) AS item;
    END IF;
    RETURN result;
END;
$$;


-- ── 5. onebase HTTP 客户端：方法 / path / json body → (status, response_jsonb)
-- path 以 / 开头，例如 '/api/es-app/way_article_search_main/bulk'
-- body 为 NULL 时不带 body（GET/DELETE 用）；非 NULL 时按 application/json 发送
CREATE OR REPLACE FUNCTION gamesq._es_call(method text, path text, body jsonb DEFAULT NULL,
                                            OUT status int, OUT response jsonb)
LANGUAGE plpgsql AS $$
DECLARE
    base_url   text := gamesq._es_setting('onebase_base_url');
    token      text := gamesq._es_setting('onebase_es_token');
    ext_schema text := gamesq._es_http_schema();
    conn_to    text := COALESCE(NULLIF(gamesq._es_setting('http_connect_timeout_ms'), ''), '10000');
    total_to   text := COALESCE(NULLIF(gamesq._es_setting('http_timeout_ms'), ''),         '30000');
    r          record;
    body_text  text;
BEGIN
    IF base_url IS NULL OR base_url = '' THEN
        RAISE EXCEPTION 'gamesq._es_sync_config.onebase_base_url 未配置';
    END IF;
    IF token IS NULL OR token = '' OR token LIKE '%REPLACE_ME%' THEN
        RAISE EXCEPTION 'gamesq._es_sync_config.onebase_es_token 未配置或仍是占位值';
    END IF;
    IF ext_schema IS NULL OR ext_schema = '' THEN
        RAISE EXCEPTION 'pgsql-http 扩展未安装，找不到扩展 schema';
    END IF;

    -- pgsql-http 默认 CONNECTTIMEOUT_MS=1000 / TIMEOUT_MS=5000，并且这些 curlopt
    -- 是 session 级；onebase SQL 编辑器每次执行可能复用不同连接，所以这里
    -- 在每次 _es_call 都重新设一遍，保证不依赖前置 SQL。
    EXECUTE format('SELECT %I.http_set_curlopt($1, $2)', ext_schema)
        USING 'CURLOPT_CONNECTTIMEOUT_MS', conn_to;
    EXECUTE format('SELECT %I.http_set_curlopt($1, $2)', ext_schema)
        USING 'CURLOPT_TIMEOUT_MS', total_to;

    body_text := CASE WHEN body IS NULL THEN NULL ELSE body::text END;

    EXECUTE format(
        'SELECT * FROM %I.http(($1, $2, ARRAY[%I.http_header($3, $4)], $5, $6)::%I.http_request)',
        ext_schema, ext_schema, ext_schema
    )
    INTO r
    USING
        upper(method),
        rtrim(base_url, '/') || path,
        'Authorization',
        'ApiKey ' || token,
        CASE WHEN body_text IS NULL THEN NULL ELSE 'application/json' END,
        body_text;

    status := r.status;
    BEGIN
        response := r.content::jsonb;
    EXCEPTION WHEN others THEN
        response := jsonb_build_object('raw', r.content);
    END;
END;
$$;


-- ── 6. 索引 mapping 片段
-- 共用 settings：3 shards / 1 replica + edge_ngram autocomplete 分词
CREATE OR REPLACE FUNCTION gamesq._es_common_settings() RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$ SELECT $body$
{
  "number_of_shards": 3, "number_of_replicas": 1,
  "analysis": {
    "analyzer": { "autocomplete_analyzer": { "type": "custom", "tokenizer": "ac_tokenizer", "filter": ["lowercase"] } },
    "tokenizer": { "ac_tokenizer": { "type": "edge_ngram", "min_gram": 1, "max_gram": 20, "token_chars": ["letter","digit"] } }
  }
}
$body$::jsonb $$;

-- 帖子字段（含 nested title/content）
CREATE OR REPLACE FUNCTION gamesq._es_article_fields() RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$ SELECT $body$
{
  "article_id":      { "type": "long" },
  "project_id":      { "type": "integer" },
  "uid":             { "type": "integer" },
  "way_uid":         { "type": "keyword" },
  "title":   { "type": "nested", "properties": {
    "flang": {"type":"keyword"}, "is_original": {"type":"boolean"},
    "value": {"type":"text", "fields":{"autocomplete":{"type":"text","analyzer":"autocomplete_analyzer","search_analyzer":"standard"}}}
  } },
  "content": { "type": "nested", "properties": {
    "flang": {"type":"keyword"}, "is_original": {"type":"boolean"},
    "value": {"type":"text", "fields":{"autocomplete":{"type":"text","analyzer":"autocomplete_analyzer","search_analyzer":"standard"}}}
  } },
  "flang":           { "type": "keyword" },
  "review_status":   { "type": "integer" },
  "top_status":      { "type": "integer" },
  "hide_status":     { "type": "integer" },
  "delete_status":   { "type": "integer" },
  "comment_status":  { "type": "integer" },
  "visibility_type": { "type": "integer" },
  "is_official":     { "type": "integer" },
  "official_id":     { "type": "integer" },
  "title_type_id":   { "type": "integer" },
  "tag_id":          { "type": "integer" },
  "article_type":    { "type": "integer" },
  "is_feedback":     { "type": "integer" },
  "see_count":       { "type": "long" },
  "like_count":      { "type": "long" },
  "comment_sum":     { "type": "long" },
  "region_scope":    { "type": "integer" },
  "country_code":    { "type": "keyword" },
  "created_at":      { "type": "long" },
  "updated_at":      { "type": "long" }
}
$body$::jsonb $$;

-- 社区字段
CREATE OR REPLACE FUNCTION gamesq._es_community_fields() RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$ SELECT $body$
{
  "project_id":          { "type": "long" },
  "name":         { "type":"text", "fields":{"keyword":{"type":"keyword"},"autocomplete":{"type":"text","analyzer":"autocomplete_analyzer","search_analyzer":"standard"}} },
  "show_name":    { "type":"text", "fields":{"keyword":{"type":"keyword"},"autocomplete":{"type":"text","analyzer":"autocomplete_analyzer","search_analyzer":"standard"}} },
  "show_name_cn": { "type":"text", "fields":{"keyword":{"type":"keyword"},"autocomplete":{"type":"text","analyzer":"autocomplete_analyzer","search_analyzer":"standard"}} },
  "description_texts": { "type": "nested", "properties": {
    "lang":  {"type":"keyword"},
    "value": {"type":"text", "fields":{"autocomplete":{"type":"text","analyzer":"autocomplete_analyzer","search_analyzer":"standard"}}}
  } },
  "project_image":       { "type": "keyword" },
  "status":              { "type": "integer" },
  "is_private":          { "type": "integer" },
  "verify_level":        { "type": "integer" },
  "follow_count":        { "type": "long" },
  "project_scope":       { "type": "integer" },
  "project_category_id": { "type": "integer" },
  "owner_way_uid":       { "type": "keyword" },
  "created_at":          { "type": "long" },
  "updated_at":          { "type": "long" }
}
$body$::jsonb $$;

-- 用户字段
CREATE OR REPLACE FUNCTION gamesq._es_user_fields() RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$ SELECT $body$
{
  "user_id":         { "type": "integer" },
  "way_uid":         { "type": "keyword" },
  "username": { "type":"text", "fields":{"keyword":{"type":"keyword"},"autocomplete":{"type":"text","analyzer":"autocomplete_analyzer","search_analyzer":"standard"}} },
  "avatar":          { "type": "keyword" },
  "project_id":      { "type": "integer" },
  "is_official":     { "type": "integer" },
  "user_auth_level": { "type": "integer" },
  "user_desc":       { "type": "text" },
  "lang":            { "type": "keyword" },
  "last_active_time":{ "type": "long" },
  "created_at":      { "type": "long" }
}
$body$::jsonb $$;


-- ── 7. 索引初始化（走 onebase 的 /api/es-app/:idx/_init，幂等）
CREATE OR REPLACE FUNCTION gamesq._es_ensure_index(idx text, fields jsonb, p_recreate boolean)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    st int;
    resp jsonb;
BEGIN
    IF p_recreate THEN
        -- DELETE 不存在时 onebase 透传 ES 404；当 idempotent 处理
        SELECT c.status, c.response INTO st, resp
        FROM gamesq._es_call('DELETE', '/api/es-app/' || idx) c;
        IF st >= 400 AND st <> 404 THEN
            RAISE EXCEPTION 'DELETE %s failed: status=% body=%', idx, st, resp;
        END IF;
    END IF;

    -- POST _init { fields, settings, if_not_exists: true } → 已存在则返回 already_exists:true
    SELECT c.status, c.response INTO st, resp
    FROM gamesq._es_call(
        'POST', '/api/es-app/' || idx || '/_init',
        jsonb_build_object(
            'fields',       fields,
            'settings',     gamesq._es_common_settings(),
            'if_not_exists', NOT p_recreate
        )
    ) c;
    IF st >= 400 THEN
        RAISE EXCEPTION '_init % failed: status=% body=%', idx, st, resp;
    END IF;

    IF COALESCE((resp->>'already_exists')::boolean, false) THEN
        RETURN 'exists';
    ELSE
        RETURN 'created';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION gamesq.es_init_indices(p_recreate boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    idx_article   text := gamesq._es_setting('article_index');
    idx_community text := gamesq._es_setting('community_index');
    idx_user      text := gamesq._es_setting('user_index');
BEGIN
    RETURN jsonb_build_object(
        idx_article,   gamesq._es_ensure_index(idx_article,   gamesq._es_article_fields(),   p_recreate),
        idx_community, gamesq._es_ensure_index(idx_community, gamesq._es_community_fields(), p_recreate),
        idx_user,      gamesq._es_ensure_index(idx_user,      gamesq._es_user_fields(),      p_recreate)
    );
END;
$$;


-- ── 8. _bulk 封装：传一个 operations jsonb 数组，POST 给 onebase 应用 API
-- ops 形如 [{"action":"index","id":"1","doc":{...}}, {"action":"delete","id":"9"}]
-- 返回 (ok, failed)
CREATE OR REPLACE FUNCTION gamesq._es_bulk(idx text, ops jsonb,
                                            OUT ok int, OUT failed int)
LANGUAGE plpgsql AS $$
DECLARE
    st       int;
    resp     jsonb;
    n        int;
BEGIN
    ok := 0; failed := 0;
    IF ops IS NULL OR jsonb_typeof(ops) <> 'array' THEN RETURN; END IF;
    n := jsonb_array_length(ops);
    IF n = 0 THEN RETURN; END IF;
    IF n > 1000 THEN
        -- onebase 应用 API 单批上限 1000；理论上不会撞，因为 batch ≤ 500，但兜底
        RAISE EXCEPTION '_es_bulk: operations 超过 1000 条上限（实际 %）', n;
    END IF;

    SELECT c.status, c.response INTO st, resp
    FROM gamesq._es_call(
        'POST', '/api/es-app/' || idx || '/bulk',
        jsonb_build_object('operations', ops)
    ) c;

    IF st >= 400 THEN
        RAISE EXCEPTION 'bulk % failed: status=% body=%', idx, st, resp;
    END IF;

    -- onebase 返回 { took_ms, errors, results: [{ok: bool, ...}] }
    SELECT
        COUNT(*) FILTER (WHERE COALESCE((item->>'ok')::boolean, false)),
        COUNT(*) FILTER (WHERE NOT COALESCE((item->>'ok')::boolean, false))
    INTO ok, failed
    FROM jsonb_array_elements(COALESCE(resp->'results', '[]'::jsonb)) AS item;
END;
$$;


-- ── 9. 帖子同步
CREATE OR REPLACE FUNCTION gamesq.es_sync_articles(p_since timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    idx      text := gamesq._es_setting('article_index');
    batch    int  := COALESCE(NULLIF(gamesq._es_setting('article_batch'),'')::int, 500);
    offset_  int  := 0;
    started  timestamptz := clock_timestamp();
    ok_total int := 0;
    fail_total int := 0;
    del_ok_total int := 0;
    del_fail_total int := 0;
    ops      jsonb;
    scanned  int;
    bulk_ok  int; bulk_fail int;
BEGIN
    -- 9.1 upsert 活跃记录
    LOOP
        WITH src AS (
            SELECT a.id,
                   a."titleAndcontent"             AS tac_raw,
                   a.project_id, a.uid,
                   COALESCE(a.way_uid,'')          AS way_uid,
                   COALESCE(a.flang,'')            AS flang,
                   COALESCE(a.review_status,0)     AS review_status,
                   COALESCE(a.top_status,0)        AS top_status,
                   COALESCE(a.hide_status,0)       AS hide_status,
                   COALESCE(a.delete_status,0)     AS delete_status,
                   COALESCE(a.comment_status,0)    AS comment_status,
                   COALESCE(a.visibility_type,0)   AS visibility_type,
                   COALESCE(a.is_official,0)       AS is_official,
                   COALESCE(a.official_id,0)       AS official_id,
                   COALESCE(a.title_type_id,0)     AS title_type_id,
                   COALESCE(a.tag_id,0)            AS tag_id,
                   COALESCE(a.article_type,0)      AS article_type,
                   COALESCE(a.is_feedback,0)       AS is_feedback,
                   COALESCE(a.see_count,0)         AS see_count,
                   COALESCE(a.sum,0)               AS like_count,
                   COALESCE(a.comment_sum,0)       AS comment_sum,
                   COALESCE(a.region_scope,1)      AS region_scope,
                   COALESCE(a.country_code,'')     AS country_code,
                   EXTRACT(EPOCH FROM a.created_at)::bigint AS created_at,
                   EXTRACT(EPOCH FROM a.updated_at)::bigint AS updated_at
            FROM gamesq.article a
            WHERE a.delete_status = 0
              AND COALESCE(a.hide_status, 0) = 0
              AND (p_since IS NULL OR a.updated_at >= p_since)
            ORDER BY a.id
            LIMIT batch OFFSET offset_
        )
        SELECT
            COALESCE(jsonb_agg(jsonb_build_object(
                'action', 'index',
                'id',     s.id::text,
                'doc',    jsonb_build_object(
                    'article_id',     s.id,
                    'project_id',     s.project_id,
                    'uid',            s.uid,
                    'way_uid',        s.way_uid,
                    'flang',          s.flang,
                    'review_status',  s.review_status,
                    'top_status',     s.top_status,
                    'hide_status',    s.hide_status,
                    'delete_status',  s.delete_status,
                    'comment_status', s.comment_status,
                    'visibility_type',s.visibility_type,
                    'is_official',    s.is_official,
                    'official_id',    s.official_id,
                    'title_type_id',  s.title_type_id,
                    'tag_id',         s.tag_id,
                    'article_type',   s.article_type,
                    'is_feedback',    s.is_feedback,
                    'see_count',      s.see_count,
                    'like_count',     s.like_count,
                    'comment_sum',    s.comment_sum,
                    'region_scope',   s.region_scope,
                    'country_code',   s.country_code,
                    'created_at',     s.created_at,
                    'updated_at',     s.updated_at,
                    'title',          parsed.titles,
                    'content',        parsed.contents
                )
            )), '[]'::jsonb),
            COUNT(*)::int
        INTO ops, scanned
        FROM src s, LATERAL gamesq._es_parse_tac(s.tac_raw) AS parsed;

        EXIT WHEN scanned IS NULL OR scanned = 0;
        SELECT b.ok, b.failed INTO bulk_ok, bulk_fail FROM gamesq._es_bulk(idx, ops) b;
        ok_total   := ok_total   + COALESCE(bulk_ok, 0);
        fail_total := fail_total + COALESCE(bulk_fail, 0);
        EXIT WHEN scanned < batch;
        offset_ := offset_ + batch;
    END LOOP;

    -- 9.2 增量删除：刚刚被软删 / 隐藏的，从 ES 删掉
    IF p_since IS NOT NULL THEN
        offset_ := 0;
        LOOP
            SELECT
                COALESCE(jsonb_agg(jsonb_build_object('action', 'delete', 'id', d.id::text)), '[]'::jsonb),
                COUNT(*)::int
            INTO ops, scanned
            FROM (
                SELECT id
                FROM gamesq.article
                WHERE (delete_status <> 0 OR COALESCE(hide_status,0) <> 0)
                  AND updated_at >= p_since
                ORDER BY id
                LIMIT batch OFFSET offset_
            ) d;
            EXIT WHEN scanned IS NULL OR scanned = 0;
            SELECT b.ok, b.failed INTO bulk_ok, bulk_fail FROM gamesq._es_bulk(idx, ops) b;
            del_ok_total   := del_ok_total   + COALESCE(bulk_ok, 0);
            del_fail_total := del_fail_total + COALESCE(bulk_fail, 0);
            EXIT WHEN scanned < batch;
            offset_ := offset_ + batch;
        END LOOP;
    END IF;

    RETURN jsonb_build_object(
        'entity',      'article',
        'index',       idx,
        'since',       p_since,
        'upsert_ok',   ok_total,
        'upsert_fail', fail_total,
        'delete_ok',   del_ok_total,
        'delete_fail', del_fail_total,
        'elapsed_ms',  (EXTRACT(EPOCH FROM clock_timestamp() - started) * 1000)::int
    );
END;
$$;


-- ── 10. 社区同步
CREATE OR REPLACE FUNCTION gamesq.es_sync_communities(p_since timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    idx     text := gamesq._es_setting('community_index');
    batch   int  := COALESCE(NULLIF(gamesq._es_setting('community_batch'),'')::int, 200);
    offset_ int  := 0;
    started timestamptz := clock_timestamp();
    ok_total int := 0; fail_total int := 0; del_ok_total int := 0; del_fail_total int := 0;
    ops     jsonb;
    scanned int;
    bulk_ok int; bulk_fail int;
BEGIN
    LOOP
        WITH src AS (
            SELECT project_id,
                   COALESCE(name,'')                     AS name,
                   COALESCE(show_name,'')                AS show_name,
                   COALESCE(show_name_cn,'')             AS show_name_cn,
                   COALESCE(description,'')              AS description,
                   COALESCE(project_image,'')            AS project_image,
                   COALESCE(status,0)                    AS status,
                   COALESCE(is_private,0)                AS is_private,
                   COALESCE(verify_level,0)              AS verify_level,
                   COALESCE(follow_count,0)              AS follow_count,
                   COALESCE(project_scope,0)             AS project_scope,
                   COALESCE(project_category_id,0)       AS project_category_id,
                   COALESCE(owner_way_uid,'')            AS owner_way_uid,
                   EXTRACT(EPOCH FROM created_at)::bigint AS created_at,
                   EXTRACT(EPOCH FROM updated_at)::bigint AS updated_at
            FROM gamesq.project_list
            WHERE status = 1 AND is_private = 0
              AND (p_since IS NULL OR updated_at >= p_since)
            ORDER BY project_id
            LIMIT batch OFFSET offset_
        )
        SELECT
            COALESCE(jsonb_agg(jsonb_build_object(
                'action', 'index',
                'id',     s.project_id::text,
                'doc',    jsonb_build_object(
                    'project_id',          s.project_id,
                    'name',                s.name,
                    'show_name',           s.show_name,
                    'show_name_cn',        s.show_name_cn,
                    'description_texts',   gamesq._es_parse_description(s.description),
                    'project_image',       s.project_image,
                    'status',              s.status,
                    'is_private',          s.is_private,
                    'verify_level',        s.verify_level,
                    'follow_count',        s.follow_count,
                    'project_scope',       s.project_scope,
                    'project_category_id', s.project_category_id,
                    'owner_way_uid',       s.owner_way_uid,
                    'created_at',          s.created_at,
                    'updated_at',          s.updated_at
                )
            )), '[]'::jsonb),
            COUNT(*)::int
        INTO ops, scanned
        FROM src s;

        EXIT WHEN scanned IS NULL OR scanned = 0;
        SELECT b.ok, b.failed INTO bulk_ok, bulk_fail FROM gamesq._es_bulk(idx, ops) b;
        ok_total   := ok_total   + COALESCE(bulk_ok, 0);
        fail_total := fail_total + COALESCE(bulk_fail, 0);
        EXIT WHEN scanned < batch;
        offset_ := offset_ + batch;
    END LOOP;

    IF p_since IS NOT NULL THEN
        offset_ := 0;
        LOOP
            SELECT
                COALESCE(jsonb_agg(jsonb_build_object('action','delete','id', d.project_id::text)), '[]'::jsonb),
                COUNT(*)::int
            INTO ops, scanned
            FROM (
                SELECT project_id
                FROM gamesq.project_list
                WHERE (status <> 1 OR COALESCE(is_private,0) <> 0)
                  AND updated_at >= p_since
                ORDER BY project_id
                LIMIT batch OFFSET offset_
            ) d;
            EXIT WHEN scanned IS NULL OR scanned = 0;
            SELECT b.ok, b.failed INTO bulk_ok, bulk_fail FROM gamesq._es_bulk(idx, ops) b;
            del_ok_total   := del_ok_total   + COALESCE(bulk_ok, 0);
            del_fail_total := del_fail_total + COALESCE(bulk_fail, 0);
            EXIT WHEN scanned < batch;
            offset_ := offset_ + batch;
        END LOOP;
    END IF;

    RETURN jsonb_build_object(
        'entity',      'community',
        'index',       idx,
        'since',       p_since,
        'upsert_ok',   ok_total,
        'upsert_fail', fail_total,
        'delete_ok',   del_ok_total,
        'delete_fail', del_fail_total,
        'elapsed_ms',  (EXTRACT(EPOCH FROM clock_timestamp() - started) * 1000)::int
    );
END;
$$;


-- ── 11. 用户同步（sq_users 无 updated_at；用 created_at + last_active_time 近似变更时间）
CREATE OR REPLACE FUNCTION gamesq.es_sync_users(p_since timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    idx     text := gamesq._es_setting('user_index');
    batch   int  := COALESCE(NULLIF(gamesq._es_setting('user_batch'),'')::int, 500);
    offset_ int  := 0;
    started timestamptz := clock_timestamp();
    since_epoch bigint := EXTRACT(EPOCH FROM COALESCE(p_since, 'epoch'::timestamptz))::bigint;
    ok_total int := 0; fail_total int := 0; del_ok_total int := 0; del_fail_total int := 0;
    ops     jsonb;
    scanned int;
    bulk_ok int; bulk_fail int;
BEGIN
    LOOP
        WITH src AS (
            SELECT id                                       AS user_id,
                   COALESCE(way_uid,'')                     AS way_uid,
                   COALESCE(username,'')                    AS username,
                   COALESCE(avatar,'')                      AS avatar,
                   COALESCE(project_id,0)                   AS project_id,
                   COALESCE(is_official,0)                  AS is_official,
                   COALESCE(user_auth_level,0)              AS user_auth_level,
                   COALESCE(user_desc,'')                   AS user_desc,
                   COALESCE(lang,'')                        AS lang,
                   COALESCE(last_active_time,0)             AS last_active_time,
                   EXTRACT(EPOCH FROM created_at)::bigint   AS created_at
            FROM gamesq.sq_users
            WHERE ban_account = 0 AND username <> ''
              AND (p_since IS NULL
                   OR created_at >= p_since
                   OR COALESCE(last_active_time, 0) >= since_epoch)
            ORDER BY id
            LIMIT batch OFFSET offset_
        )
        SELECT
            COALESCE(jsonb_agg(jsonb_build_object(
                'action', 'index',
                'id',     s.user_id::text,
                'doc',    jsonb_build_object(
                    'user_id',          s.user_id,
                    'way_uid',          s.way_uid,
                    'username',         s.username,
                    'avatar',           s.avatar,
                    'project_id',       s.project_id,
                    'is_official',      s.is_official,
                    'user_auth_level',  s.user_auth_level,
                    'user_desc',        s.user_desc,
                    'lang',             s.lang,
                    'last_active_time', s.last_active_time,
                    'created_at',       s.created_at
                )
            )), '[]'::jsonb),
            COUNT(*)::int
        INTO ops, scanned
        FROM src s;

        EXIT WHEN scanned IS NULL OR scanned = 0;
        SELECT b.ok, b.failed INTO bulk_ok, bulk_fail FROM gamesq._es_bulk(idx, ops) b;
        ok_total   := ok_total   + COALESCE(bulk_ok, 0);
        fail_total := fail_total + COALESCE(bulk_fail, 0);
        EXIT WHEN scanned < batch;
        offset_ := offset_ + batch;
    END LOOP;

    IF p_since IS NOT NULL THEN
        offset_ := 0;
        LOOP
            SELECT
                COALESCE(jsonb_agg(jsonb_build_object('action','delete','id', d.id::text)), '[]'::jsonb),
                COUNT(*)::int
            INTO ops, scanned
            FROM (
                SELECT id
                FROM gamesq.sq_users
                WHERE (ban_account <> 0 OR username = '')
                  AND (created_at >= p_since OR COALESCE(last_active_time,0) >= since_epoch)
                ORDER BY id
                LIMIT batch OFFSET offset_
            ) d;
            EXIT WHEN scanned IS NULL OR scanned = 0;
            SELECT b.ok, b.failed INTO bulk_ok, bulk_fail FROM gamesq._es_bulk(idx, ops) b;
            del_ok_total   := del_ok_total   + COALESCE(bulk_ok, 0);
            del_fail_total := del_fail_total + COALESCE(bulk_fail, 0);
            EXIT WHEN scanned < batch;
            offset_ := offset_ + batch;
        END LOOP;
    END IF;

    RETURN jsonb_build_object(
        'entity',      'user',
        'index',       idx,
        'since',       p_since,
        'upsert_ok',   ok_total,
        'upsert_fail', fail_total,
        'delete_ok',   del_ok_total,
        'delete_fail', del_fail_total,
        'elapsed_ms',  (EXTRACT(EPOCH FROM clock_timestamp() - started) * 1000)::int
    );
END;
$$;


-- ── 12. 一键编排：定时任务调它就行
--    p_window_seconds NULL → 全量；非 NULL → 用 (now() - window) 作为 since
--    p_ensure_indices true（默认 true）→ 先 init_indices；建索引很轻量（同步用 if_not_exists）
CREATE OR REPLACE FUNCTION gamesq.es_sync_all(
    p_window_seconds int     DEFAULT NULL,
    p_ensure_indices boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    p_since timestamptz := CASE WHEN p_window_seconds IS NULL THEN NULL
                                ELSE now() - (p_window_seconds * interval '1 second') END;
    started timestamptz := clock_timestamp();
    indices jsonb := '{}'::jsonb;
BEGIN
    IF p_ensure_indices THEN
        indices := gamesq.es_init_indices(false);
    END IF;

    RETURN jsonb_build_object(
        'mode',       CASE WHEN p_since IS NULL THEN 'full' ELSE 'incremental' END,
        'since',      p_since,
        'indices',    indices,
        'entities',   jsonb_build_object(
            'article',   gamesq.es_sync_articles(p_since),
            'community', gamesq.es_sync_communities(p_since),
            'user',      gamesq.es_sync_users(p_since)
        ),
        'elapsed_ms', (EXTRACT(EPOCH FROM clock_timestamp() - started) * 1000)::int
    );
END;
$$;


-- ── 13. 轻量健康检查：POST /api/es-app/:idx/count，专给 SQL 编辑器（30s 上限）用来验通路
--   返回每个索引当前文档数 + 每次往返耗时，不扫源表、不写任何东西。
--   提示：用的是 onebase 应用 API 的 count 端点（POST，body 为空 {}）；token 必须放行 POST。
CREATE OR REPLACE FUNCTION gamesq.es_health()
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    idx_article   text := gamesq._es_setting('article_index');
    idx_community text := gamesq._es_setting('community_index');
    idx_user      text := gamesq._es_setting('user_index');
    started       timestamptz;
    elapsed_ms    int;
    st            int;
    resp          jsonb;
    out_obj       jsonb := '{}'::jsonb;
BEGIN
    -- article
    started := clock_timestamp();
    SELECT c.status, c.response INTO st, resp
    FROM gamesq._es_call('POST', '/api/es-app/' || idx_article || '/count', '{}'::jsonb) c;
    elapsed_ms := (EXTRACT(EPOCH FROM clock_timestamp() - started) * 1000)::int;
    out_obj := out_obj || jsonb_build_object(idx_article, jsonb_build_object(
        'status', st, 'elapsed_ms', elapsed_ms,
        'count',  resp -> 'count',
        'error',  CASE WHEN st >= 400 THEN resp ELSE NULL END
    ));

    -- community
    started := clock_timestamp();
    SELECT c.status, c.response INTO st, resp
    FROM gamesq._es_call('POST', '/api/es-app/' || idx_community || '/count', '{}'::jsonb) c;
    elapsed_ms := (EXTRACT(EPOCH FROM clock_timestamp() - started) * 1000)::int;
    out_obj := out_obj || jsonb_build_object(idx_community, jsonb_build_object(
        'status', st, 'elapsed_ms', elapsed_ms,
        'count',  resp -> 'count',
        'error',  CASE WHEN st >= 400 THEN resp ELSE NULL END
    ));

    -- user
    started := clock_timestamp();
    SELECT c.status, c.response INTO st, resp
    FROM gamesq._es_call('POST', '/api/es-app/' || idx_user || '/count', '{}'::jsonb) c;
    elapsed_ms := (EXTRACT(EPOCH FROM clock_timestamp() - started) * 1000)::int;
    out_obj := out_obj || jsonb_build_object(idx_user, jsonb_build_object(
        'status', st, 'elapsed_ms', elapsed_ms,
        'count',  resp -> 'count',
        'error',  CASE WHEN st >= 400 THEN resp ELSE NULL END
    ));

    RETURN out_obj;
END;
$$;


-- ── 14. （可选）回滚段：取消注释即可清理本脚本创建的对象
-- DROP FUNCTION IF EXISTS gamesq.es_health();
-- DROP FUNCTION IF EXISTS gamesq.es_sync_all(int, boolean);
-- DROP FUNCTION IF EXISTS gamesq.es_sync_users(timestamptz);
-- DROP FUNCTION IF EXISTS gamesq.es_sync_communities(timestamptz);
-- DROP FUNCTION IF EXISTS gamesq.es_sync_articles(timestamptz);
-- DROP FUNCTION IF EXISTS gamesq.es_init_indices(boolean);
-- DROP FUNCTION IF EXISTS gamesq._es_ensure_index(text, jsonb, boolean);
-- DROP FUNCTION IF EXISTS gamesq._es_bulk(text, jsonb);
-- DROP FUNCTION IF EXISTS gamesq._es_call(text, text, jsonb);
-- DROP FUNCTION IF EXISTS gamesq._es_http_schema();
-- DROP FUNCTION IF EXISTS gamesq._es_user_fields();
-- DROP FUNCTION IF EXISTS gamesq._es_community_fields();
-- DROP FUNCTION IF EXISTS gamesq._es_article_fields();
-- DROP FUNCTION IF EXISTS gamesq._es_common_settings();
-- DROP FUNCTION IF EXISTS gamesq._es_parse_description(text);
-- DROP FUNCTION IF EXISTS gamesq._es_parse_tac(text);
-- DROP FUNCTION IF EXISTS gamesq._es_strip_html(text);
-- DROP FUNCTION IF EXISTS gamesq._es_setting(text);
-- DROP TABLE    IF EXISTS gamesq._es_sync_config;
