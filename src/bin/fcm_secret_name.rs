//! FCM/Google SA 密钥名派生工具（运维放 K8s Secret 时用）
//!
//! 与运行期 `google.sa_assertion` **共用同一套派生规则**
//! （`onebase::lua_builtins::derive_fcm_secret_name`），确保"读/写两侧"算出的
//! K8s 密钥文件名一致。
//!
//! 派生：`hex(sha256(project \0 tenant_id \0 FCM_KEY_SALT))` + `.json`。
//!
//! 用法：
//!     FCM_KEY_SALT=<保密盐> cargo run --bin fcm_secret_name -- <project> <tenant_id>
//! 输出（stdout 仅这一行，便于脚本取用）：
//!     <hex>.json
//!
//! 把某 project 的 Service Account JSON 放进 `${FCM_SECRETS_DIR}/<hex>.json`
//! （默认 /app/secrets/fcm），运行期就能按 project + 工作流 tenant_id 找到它。
//! 盐是机密：只从进程 env 读，绝不作为参数/日志回显。

use onebase::lua_builtins::derive_fcm_secret_name;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!(
            "用法: FCM_KEY_SALT=<盐> {} <project> <tenant_id>",
            args.first().map(String::as_str).unwrap_or("fcm_secret_name")
        );
        std::process::exit(2);
    }

    let project = args[1].trim();
    if project.is_empty() {
        eprintln!("错误: project 不能为空");
        std::process::exit(2);
    }

    let tenant_id: i32 = match args[2].trim().parse() {
        Ok(v) => v,
        Err(_) => {
            eprintln!("错误: tenant_id 必须是整数，收到 {:?}", args[2]);
            std::process::exit(2);
        }
    };

    let salt = match std::env::var("FCM_KEY_SALT") {
        Ok(s) if !s.is_empty() => s,
        _ => {
            eprintln!("错误: 需通过环境变量 FCM_KEY_SALT 提供保密盐");
            std::process::exit(2);
        }
    };

    let name = derive_fcm_secret_name(project, tenant_id, &salt);
    println!("{}.json", name);
}
