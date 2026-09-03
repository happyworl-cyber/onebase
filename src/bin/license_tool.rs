//! OneBase License 签发 / 校验 CLI（原厂内部工具，私钥只留在原厂）。
//!
//! 用法：
//!   license_tool keygen [--out-dir .] [--name license]
//!       生成 RSA 密钥对：<name>_private.pem（自留）+ <name>_public.pem（随镜像分发）。
//!
//!   license_tool fingerprint
//!       打印当前机器的部署指纹（在客户机器上跑，用于 --fingerprint 绑定）。
//!
//!   license_tool issue --priv license_private.pem --customer "某某集团" \
//!       --edition enterprise [--modules ai,ha,xinchuang] [--days 365] [--grace 30] \
//!       [--nodes 3] [--tenants 50] [--fingerprint <fp>] [--id LIC-2026-001] \
//!       [--notes "首年"] [--out license.lic]
//!       用私钥签发一份 License 文件。
//!
//!   license_tool verify --pub license_public.pem --file license.lic
//!       校验签名并打印 claims 与到期状态。

use std::collections::HashMap;
use std::process::exit;

use onebase::license::{
    self, current_fingerprint, generate_keypair, sign_license, verify_license_file, LicenseClaims,
};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        print_usage();
        exit(1);
    }
    let cmd = args[1].as_str();
    let opts = parse_opts(&args[2..]);

    let result = match cmd {
        "keygen" => cmd_keygen(&opts),
        "fingerprint" | "fp" => cmd_fingerprint(),
        "issue" => cmd_issue(&opts),
        "verify" => cmd_verify(&opts),
        "-h" | "--help" | "help" => {
            print_usage();
            Ok(())
        }
        other => Err(format!("未知子命令：{other}\n")),
    };

    if let Err(e) = result {
        eprintln!("错误：{e}");
        exit(1);
    }
}

/// 解析 `--key value` 与布尔 `--flag`。value 缺省为 "true"。
fn parse_opts(args: &[String]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if let Some(key) = a.strip_prefix("--") {
            let next_is_value = args
                .get(i + 1)
                .map(|v| !v.starts_with("--"))
                .unwrap_or(false);
            if next_is_value {
                map.insert(key.to_string(), args[i + 1].clone());
                i += 2;
            } else {
                map.insert(key.to_string(), "true".to_string());
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    map
}

fn cmd_keygen(opts: &HashMap<String, String>) -> Result<(), String> {
    let out_dir = opts.get("out-dir").map(String::as_str).unwrap_or(".");
    let name = opts.get("name").map(String::as_str).unwrap_or("license");
    let (priv_pem, pub_pem) = generate_keypair()?;
    let priv_path = format!("{out_dir}/{name}_private.pem");
    let pub_path = format!("{out_dir}/{name}_public.pem");
    std::fs::write(&priv_path, priv_pem).map_err(|e| format!("写入私钥失败 {priv_path}: {e}"))?;
    std::fs::write(&pub_path, pub_pem).map_err(|e| format!("写入公钥失败 {pub_path}: {e}"))?;
    println!("已生成密钥对：");
    println!("  私钥（原厂自留，切勿分发）: {priv_path}");
    println!("  公钥（随镜像 / 交付包分发）: {pub_path}");
    println!();
    println!("服务端用公钥验签，可通过以下任一方式提供：");
    println!("  - 环境变量 ONEBASE_LICENSE_PUBLIC_KEY_PATH={pub_path}");
    println!("  - 或把 PEM 内容内嵌进 src/license.rs 的 EMBEDDED_PUBLIC_KEY（防替换更硬）");
    Ok(())
}

fn cmd_fingerprint() -> Result<(), String> {
    println!("{}", current_fingerprint());
    Ok(())
}

fn cmd_issue(opts: &HashMap<String, String>) -> Result<(), String> {
    let priv_path = opts.get("priv").ok_or("缺少 --priv <私钥 PEM 路径>")?;
    let customer = opts
        .get("customer")
        .ok_or("缺少 --customer <客户名称>")?
        .clone();
    let edition = opts
        .get("edition")
        .cloned()
        .unwrap_or_else(|| "enterprise".to_string());
    let modules: Vec<String> = opts
        .get("modules")
        .map(|s| {
            s.split(',')
                .map(|x| x.trim().to_string())
                .filter(|x| !x.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let days: i64 = opts
        .get("days")
        .map(|s| s.parse::<i64>())
        .transpose()
        .map_err(|_| "参数 --days 必须是整数")?
        .unwrap_or(365);
    let grace: i64 = opts
        .get("grace")
        .map(|s| s.parse::<i64>())
        .transpose()
        .map_err(|_| "参数 --grace 必须是整数")?
        .unwrap_or(30);
    let max_nodes = opts
        .get("nodes")
        .map(|s| s.parse::<u32>())
        .transpose()
        .map_err(|_| "参数 --nodes 必须是正整数")?;
    let max_tenants = opts
        .get("tenants")
        .map(|s| s.parse::<u32>())
        .transpose()
        .map_err(|_| "参数 --tenants 必须是正整数")?;
    let fingerprint = opts.get("fingerprint").cloned().filter(|s| !s.is_empty());
    let notes = opts.get("notes").cloned();

    let now = chrono::Utc::now().timestamp();
    let license_id = opts
        .get("id")
        .cloned()
        .unwrap_or_else(|| format!("LIC-{now}"));

    let max_accounts_per_tenant = opts
        .get("max-accounts-per-tenant")
        .and_then(|s| s.parse::<u32>().ok());

    // ========== 新增配额参数（基于新定价方案）==========
    let max_projects = opts
        .get("max-projects")
        .and_then(|s| s.parse::<u32>().ok());
    let max_workflows = opts
        .get("max-workflows")
        .and_then(|s| s.parse::<u32>().ok());
    let max_executions_per_month = opts
        .get("max-executions-per-month")
        .and_then(|s| s.parse::<u64>().ok());
    let max_api_endpoints = opts
        .get("max-api-endpoints")
        .and_then(|s| s.parse::<u32>().ok());
    let max_scheduled_jobs = opts
        .get("max-scheduled-jobs")
        .and_then(|s| s.parse::<u32>().ok());
    let max_database_connections = opts
        .get("max-database-connections")
        .and_then(|s| s.parse::<u32>().ok());
    let max_team_members = opts
        .get("max-team-members")
        .and_then(|s| s.parse::<u32>().ok());

    let claims = LicenseClaims {
        license_id,
        customer,
        edition,
        modules,
        max_nodes,
        max_tenants,
        max_accounts_per_tenant,
        max_projects,
        max_workflows,
        max_executions_per_month,
        max_api_endpoints,
        max_scheduled_jobs,
        max_database_connections,
        max_team_members,
        issued_at: now,
        expires_at: now + days * 86_400,
        grace_days: grace,
        fingerprint,
        notes,
    };

    let priv_pem =
        std::fs::read_to_string(priv_path).map_err(|e| format!("读取私钥失败 {priv_path}: {e}"))?;
    let file = sign_license(&priv_pem, &claims)?;
    let out = opts.get("out").map(String::as_str).unwrap_or("license.lic");
    std::fs::write(out, &file).map_err(|e| format!("写入 License 失败 {out}: {e}"))?;

    println!("已签发 License：{out}");
    println!("  客户   : {}", claims.customer);
    println!("  版本   : {}", claims.edition);
    println!(
        "  模块   : {}",
        if claims.modules.is_empty() {
            "（无加购）".to_string()
        } else {
            claims.modules.join(", ")
        }
    );
    println!("  到期   : {} 天后", days);
    println!("  宽限   : {} 天", grace);
    if let Some(fp) = &claims.fingerprint {
        println!("  绑定指纹: {fp}");
    }

    // 输出配额信息
    println!("\n配额限制:");
    if let Some(v) = max_nodes {
        println!("  节点数量: {}", v);
    }
    if let Some(v) = max_tenants.or(max_projects) {
        println!("  项目/租户数量: {}", v);
    }
    if let Some(v) = max_workflows {
        println!("  工作流数量: {}", v);
    }
    if let Some(v) = max_api_endpoints {
        println!("  API 端点数量: {}", v);
    }
    if let Some(v) = max_executions_per_month {
        println!("  月度执行次数: {}", v);
    }
    if let Some(v) = max_scheduled_jobs {
        println!("  定时任务数量: {}", v);
    }
    if let Some(v) = max_database_connections {
        println!("  数据库连接数量: {}", v);
    }
    if let Some(v) = max_team_members {
        println!("  团队成员数量: {}", v);
    }
    if let Some(v) = max_accounts_per_tenant {
        println!("  租户账号数量: {}", v);
    }

    Ok(())
}

fn cmd_verify(opts: &HashMap<String, String>) -> Result<(), String> {
    let pub_path = opts.get("pub").ok_or("缺少 --pub <公钥 PEM 路径>")?;
    let file_path = opts.get("file").ok_or("缺少 --file <License 文件路径>")?;
    let pub_pem =
        std::fs::read_to_string(pub_path).map_err(|e| format!("读取公钥失败 {pub_path}: {e}"))?;
    let content = std::fs::read_to_string(file_path)
        .map_err(|e| format!("读取 License 失败 {file_path}: {e}"))?;
    let claims = verify_license_file(&pub_pem, &content)?;
    let now = chrono::Utc::now().timestamp();
    let (status, message) = license::evaluate(&claims, now, &current_fingerprint());

    println!("签名校验：通过");
    println!("  许可证号: {}", claims.license_id);
    println!("  客户    : {}", claims.customer);
    println!("  版本    : {}", claims.edition);
    println!("  模块    : {}", claims.modules.join(", "));
    println!("  签发    : {}", fmt_ts(claims.issued_at));
    println!("  到期    : {}", fmt_ts(claims.expires_at));
    println!("  宽限    : {} 天", claims.grace_days);
    println!(
        "  绑定指纹: {}",
        claims.fingerprint.as_deref().unwrap_or("（未绑定）")
    );
    println!("  当前指纹: {}", current_fingerprint());

    // 显示配额信息
    println!("\n配额限制:");
    fn print_quota(label: &str, value: Option<u32>) {
        if let Some(v) = value {
            println!("  {}: {}", label, v);
        } else {
            println!("  {}: 不限", label);
        }
    }
    fn print_quota_u64(label: &str, value: Option<u64>) {
        if let Some(v) = value {
            println!("  {}: {}", label, v);
        } else {
            println!("  {}: 不限", label);
        }
    }

    print_quota("节点数量", claims.max_nodes);
    print_quota("项目/租户数量", claims.max_tenants.or(claims.max_projects));
    print_quota("工作流数量", claims.max_workflows);
    print_quota("API 端点数量", claims.max_api_endpoints);
    print_quota_u64("月度执行次数", claims.max_executions_per_month);
    print_quota("定时任务数量", claims.max_scheduled_jobs);
    print_quota("数据库连接数量", claims.max_database_connections);
    print_quota("团队成员数量", claims.max_team_members);
    print_quota("租户账号数量", claims.max_accounts_per_tenant);

    println!("\n  状态    : {} — {}", status.as_str(), message);
    Ok(())
}

fn fmt_ts(secs: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| secs.to_string())
}

fn print_usage() {
    println!(
        "OneBase License 工具\n\n\
         用法:\n  \
         license_tool keygen [--out-dir .] [--name license]\n  \
         license_tool fingerprint\n  \
         license_tool issue --priv <私钥.pem> --customer <名称> [--edition enterprise]\n              \
         [--modules ai,ha] [--days 365] [--grace 30]\n              \
         [--nodes N] [--tenants N] [--max-accounts-per-tenant N]\n              \
         [--max-projects N] [--max-workflows N] [--max-executions-per-month N]\n              \
         [--max-api-endpoints N] [--max-scheduled-jobs N]\n              \
         [--max-database-connections N] [--max-team-members N]\n              \
         [--fingerprint <fp>] [--id <编号>] [--notes <备注>] [--out license.lic]\n  \
         license_tool verify --pub <公钥.pem> --file license.lic\n\n\
         配额参数说明:\n  \
         --max-projects              项目/租户数量上限\n  \
         --max-workflows             工作流数量上限\n  \
         --max-executions-per-month  月度工作流执行次数上限\n  \
         --max-api-endpoints         API 端点数量上限\n  \
         --max-scheduled-jobs        定时任务数量上限\n  \
         --max-database-connections  数据库连接数量上限\n  \
         --max-team-members          团队成员数量上限\n"
    );
}
