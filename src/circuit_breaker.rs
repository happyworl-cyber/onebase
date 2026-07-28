use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 熔断器状态
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CircuitState {
    Closed,   // 正常
    Open,     // 熔断（拒绝请求）
    HalfOpen, // 半开（允许少量探测）
}

/// 熔断器配置
#[derive(Debug, Clone)]
pub struct CircuitBreakerConfig {
    pub failure_threshold: u32,
    pub success_threshold: u32,
    pub timeout_secs: u64,
}

impl Default for CircuitBreakerConfig {
    fn default() -> Self {
        Self {
            failure_threshold: 5,
            success_threshold: 3,
            timeout_secs: 30,
        }
    }
}

/// 数据库级熔断器
pub struct CircuitBreaker {
    config: CircuitBreakerConfig,
    failure_count: AtomicU32,
    success_count: AtomicU32,
    last_failure_time: AtomicU64,
    state: std::sync::RwLock<CircuitState>,
}

impl CircuitBreaker {
    pub fn new(config: CircuitBreakerConfig) -> Self {
        Self {
            config,
            failure_count: AtomicU32::new(0),
            success_count: AtomicU32::new(0),
            last_failure_time: AtomicU64::new(0),
            state: std::sync::RwLock::new(CircuitState::Closed),
        }
    }

    fn now_secs() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO)
            .as_secs()
    }

    fn read_state(&self) -> CircuitState {
        *self.state.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write_state(&self) -> std::sync::RwLockWriteGuard<'_, CircuitState> {
        self.state.write().unwrap_or_else(|e| e.into_inner())
    }

    pub fn allow_request(&self) -> bool {
        let state = self.read_state();
        match state {
            CircuitState::Closed => true,
            CircuitState::Open => {
                let elapsed = Self::now_secs() - self.last_failure_time.load(Ordering::Relaxed);
                if elapsed >= self.config.timeout_secs {
                    let mut s = self.write_state();
                    *s = CircuitState::HalfOpen;
                    self.success_count.store(0, Ordering::Relaxed);
                    tracing::info!("熔断器进入半开状态");
                    true
                } else {
                    false
                }
            }
            CircuitState::HalfOpen => true,
        }
    }

    pub fn record_success(&self) {
        self.failure_count.store(0, Ordering::Relaxed);

        let state = self.read_state();
        if state == CircuitState::HalfOpen {
            let count = self.success_count.fetch_add(1, Ordering::Relaxed) + 1;
            if count >= self.config.success_threshold {
                let mut s = self.write_state();
                *s = CircuitState::Closed;
                tracing::info!("熔断器恢复正常");
            }
        }
    }

    pub fn record_failure(&self) {
        self.last_failure_time
            .store(Self::now_secs(), Ordering::Relaxed);
        let count = self.failure_count.fetch_add(1, Ordering::Relaxed) + 1;

        if count >= self.config.failure_threshold {
            let mut s = self.write_state();
            if *s != CircuitState::Open {
                *s = CircuitState::Open;
                tracing::warn!(
                    "熔断器触发！连续失败 {} 次，进入 Open 状态",
                    count
                );
            }
        }
    }

    pub fn state(&self) -> CircuitState {
        self.read_state()
    }
}

/// 全局熔断器管理（按 database_id 管理）
use dashmap::DashMap;

#[derive(Clone)]
pub struct CircuitBreakerManager {
    breakers: Arc<DashMap<i32, Arc<CircuitBreaker>>>,
    config: CircuitBreakerConfig,
}

impl CircuitBreakerManager {
    pub fn new(config: CircuitBreakerConfig) -> Self {
        Self {
            breakers: Arc::new(DashMap::new()),
            config,
        }
    }

    pub fn get_or_create(&self, db_id: i32) -> Arc<CircuitBreaker> {
        self.breakers
            .entry(db_id)
            .or_insert_with(|| Arc::new(CircuitBreaker::new(self.config.clone())))
            .clone()
    }

    pub fn status_all(&self) -> Vec<(i32, CircuitState)> {
        self.breakers
            .iter()
            .map(|entry| (*entry.key(), entry.value().state()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_circuit_breaker_lifecycle() {
        let config = CircuitBreakerConfig {
            failure_threshold: 3,
            success_threshold: 2,
            timeout_secs: 1,
        };
        let cb = CircuitBreaker::new(config);

        assert_eq!(cb.state(), CircuitState::Closed);
        assert!(cb.allow_request());

        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.state(), CircuitState::Closed);

        cb.record_failure();
        assert_eq!(cb.state(), CircuitState::Open);
        assert!(!cb.allow_request());
    }

    #[test]
    fn test_success_resets_failures() {
        let config = CircuitBreakerConfig {
            failure_threshold: 3,
            success_threshold: 1,
            timeout_secs: 60,
        };
        let cb = CircuitBreaker::new(config);

        cb.record_failure();
        cb.record_failure();
        cb.record_success();

        assert_eq!(cb.state(), CircuitState::Closed);
        assert!(cb.allow_request());
    }

    #[test]
    fn test_circuit_breaker_manager() {
        let mgr = CircuitBreakerManager::new(CircuitBreakerConfig::default());
        let cb1 = mgr.get_or_create(1);
        let cb2 = mgr.get_or_create(2);

        cb1.record_failure();
        assert_eq!(cb2.state(), CircuitState::Closed);
    }
}
