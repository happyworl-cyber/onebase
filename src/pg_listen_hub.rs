//! One dedicated LISTEN connection per tenant database, shared by subscribers.
//!
//! Production sessions use `connect_dedicated_listener`. Tests inject a fake
//! factory that records connect/listen/unlisten/close ops and can push notices.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use tokio::sync::mpsc;

const RECONNECT_DELAY: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct ListenHub {
    inner: Arc<HubInner>,
}

struct HubInner {
    cmd_tx: mpsc::UnboundedSender<HubCmd>,
    counts: Arc<DashMap<i32, u32>>,
    next_id: AtomicU64,
}

pub struct Subscription {
    id: u64,
    cmd_tx: mpsc::UnboundedSender<HubCmd>,
    rx: mpsc::UnboundedReceiver<ListenNotice>,
}

#[derive(Debug, Clone)]
pub struct ListenNotice {
    pub database_id: i32,
    pub channel: String,
    pub payload: String,
}

enum HubCmd {
    Subscribe {
        database_id: i32,
        channel: String,
        tx: mpsc::UnboundedSender<ListenNotice>,
        id: u64,
    },
    Unsubscribe {
        id: u64,
    },
}

enum WorkerCmd {
    Subscribe {
        channel: String,
        tx: mpsc::UnboundedSender<ListenNotice>,
        id: u64,
    },
    Unsubscribe {
        id: u64,
    },
}

#[derive(Clone)]
enum Factory {
    /// `None` falls back to a `DATABASE_URL` management pool (`start()`).
    Production { pool: Option<sqlx::PgPool> },
    #[cfg(test)]
    Test(TestListenFactory),
}

enum SessionLoopResult {
    Reconnect,
    Idle,
    Shutdown,
}

struct PgListenSession {
    _pool: sqlx::PgPool,
    listener: sqlx::postgres::PgListener,
    database_id: i32,
}

enum Session {
    Pg(PgListenSession),
    #[cfg(test)]
    Fake(FakeSession),
}

impl ListenHub {
    /// Production hub: dedicated `PgListener` per database via `connect_dedicated_listener`.
    ///
    /// Lazy-opens a management pool from `DATABASE_URL` when loading tenant config.
    /// Prefer [`Self::start_with_pool`] when the process already has a main pool.
    #[allow(dead_code)]
    pub fn start() -> Self {
        Self::start_inner(Factory::Production { pool: None })
    }

    /// Same as [`Self::start`], but uses `pool` for `load_database_config`.
    #[allow(dead_code)]
    pub fn start_with_pool(pool: sqlx::PgPool) -> Self {
        Self::start_inner(Factory::Production { pool: Some(pool) })
    }

    #[cfg(test)]
    pub fn start_with_factory(factory: TestListenFactory) -> Self {
        Self::start_inner(Factory::Test(factory))
    }

    fn start_inner(factory: Factory) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let counts = Arc::new(DashMap::new());
        tokio::spawn(supervisor(cmd_rx, factory, counts.clone()));
        Self {
            inner: Arc::new(HubInner {
                cmd_tx,
                counts,
                next_id: AtomicU64::new(1),
            }),
        }
    }

    pub fn subscribe(&self, database_id: i32, channel: &str) -> Subscription {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel();
        let _ = self.inner.cmd_tx.send(HubCmd::Subscribe {
            database_id,
            channel: channel.to_string(),
            tx,
            id,
        });
        Subscription {
            id,
            cmd_tx: self.inner.cmd_tx.clone(),
            rx,
        }
    }

    pub fn listener_count(&self, database_id: i32) -> u32 {
        self.inner.counts.get(&database_id).map(|v| *v).unwrap_or(0)
    }
}

impl Subscription {
    pub async fn recv(&mut self) -> Option<ListenNotice> {
        self.rx.recv().await
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let _ = self.cmd_tx.send(HubCmd::Unsubscribe { id: self.id });
    }
}

async fn supervisor(
    mut cmd_rx: mpsc::UnboundedReceiver<HubCmd>,
    factory: Factory,
    counts: Arc<DashMap<i32, u32>>,
) {
    let mut workers: HashMap<i32, mpsc::UnboundedSender<WorkerCmd>> = HashMap::new();
    let mut sub_db: HashMap<u64, i32> = HashMap::new();

    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            HubCmd::Subscribe {
                database_id,
                channel,
                tx,
                id,
            } => {
                sub_db.insert(id, database_id);
                send_to_worker(
                    &mut workers,
                    database_id,
                    &factory,
                    &counts,
                    WorkerCmd::Subscribe { channel, tx, id },
                );
            }
            HubCmd::Unsubscribe { id } => {
                if let Some(database_id) = sub_db.remove(&id) {
                    if let Some(tx) = workers.get(&database_id) {
                        if tx.send(WorkerCmd::Unsubscribe { id }).is_err() {
                            workers.remove(&database_id);
                        }
                    }
                }
            }
        }
    }
}

fn send_to_worker(
    workers: &mut HashMap<i32, mpsc::UnboundedSender<WorkerCmd>>,
    database_id: i32,
    factory: &Factory,
    counts: &Arc<DashMap<i32, u32>>,
    mut cmd: WorkerCmd,
) {
    for _ in 0..2 {
        let worker = ensure_worker(workers, database_id, factory, counts);
        match worker.send(cmd) {
            Ok(()) => return,
            Err(e) => {
                workers.remove(&database_id);
                cmd = e.0;
            }
        }
    }
}

fn ensure_worker(
    workers: &mut HashMap<i32, mpsc::UnboundedSender<WorkerCmd>>,
    database_id: i32,
    factory: &Factory,
    counts: &Arc<DashMap<i32, u32>>,
) -> mpsc::UnboundedSender<WorkerCmd> {
    if let Some(tx) = workers.get(&database_id) {
        if !tx.is_closed() {
            return tx.clone();
        }
        workers.remove(&database_id);
    }
    let (tx, rx) = mpsc::unbounded_channel();
    let factory = factory.clone();
    let counts = counts.clone();
    tokio::spawn(async move {
        db_worker(database_id, factory, counts, rx).await;
    });
    workers.insert(database_id, tx.clone());
    tx
}

async fn db_worker(
    database_id: i32,
    factory: Factory,
    counts: Arc<DashMap<i32, u32>>,
    mut cmd_rx: mpsc::UnboundedReceiver<WorkerCmd>,
) {
    let mut subs: HashMap<String, Vec<(u64, mpsc::UnboundedSender<ListenNotice>)>> = HashMap::new();

    loop {
        if drain_cmds_until_subscribed(&mut cmd_rx, &mut subs)
            .await
            .is_err()
        {
            counts.insert(database_id, 0);
            return;
        }

        let mut session = match factory.connect(database_id).await {
            Ok(s) => {
                counts.insert(database_id, 1);
                s
            }
            Err(e) => {
                tracing::warn!(
                    database_id,
                    error = %e,
                    "LISTEN connect failed, retrying"
                );
                tokio::time::sleep(RECONNECT_DELAY).await;
                continue;
            }
        };

        let channels: Vec<String> = subs.keys().cloned().collect();
        let mut listen_failed = false;
        for ch in &channels {
            if let Err(e) = session.listen(ch).await {
                tracing::warn!(
                    database_id,
                    channel = %ch,
                    error = %e,
                    "LISTEN failed, reconnecting"
                );
                listen_failed = true;
                break;
            }
        }
        if listen_failed {
            drop(session);
            counts.insert(database_id, 0);
            tokio::time::sleep(RECONNECT_DELAY).await;
            continue;
        }

        let result = run_session_loop(database_id, &mut session, &mut subs, &mut cmd_rx).await;
        drop(session);
        counts.insert(database_id, 0);
        match result {
            SessionLoopResult::Shutdown => return,
            SessionLoopResult::Idle => continue,
            SessionLoopResult::Reconnect => {
                tokio::time::sleep(RECONNECT_DELAY).await;
            }
        }
    }
}

async fn drain_cmds_until_subscribed(
    cmd_rx: &mut mpsc::UnboundedReceiver<WorkerCmd>,
    subs: &mut HashMap<String, Vec<(u64, mpsc::UnboundedSender<ListenNotice>)>>,
) -> Result<(), ()> {
    loop {
        while subs.is_empty() {
            match cmd_rx.recv().await {
                None => return Err(()),
                Some(cmd) => apply_sub_cmd(subs, cmd),
            }
        }
        while let Ok(cmd) = cmd_rx.try_recv() {
            apply_sub_cmd(subs, cmd);
        }
        if !subs.is_empty() {
            return Ok(());
        }
    }
}

fn apply_sub_cmd(
    subs: &mut HashMap<String, Vec<(u64, mpsc::UnboundedSender<ListenNotice>)>>,
    cmd: WorkerCmd,
) {
    match cmd {
        WorkerCmd::Subscribe { channel, tx, id } => {
            subs.entry(channel).or_default().push((id, tx));
        }
        WorkerCmd::Unsubscribe { id } => {
            let _ = remove_sub(subs, id);
        }
    }
}

/// Returns how the worker should treat the session after this loop ends.
async fn run_session_loop(
    database_id: i32,
    session: &mut Session,
    subs: &mut HashMap<String, Vec<(u64, mpsc::UnboundedSender<ListenNotice>)>>,
    cmd_rx: &mut mpsc::UnboundedReceiver<WorkerCmd>,
) -> SessionLoopResult {
    loop {
        tokio::select! {
            biased;
            cmd = cmd_rx.recv() => {
                match cmd {
                    None => return SessionLoopResult::Shutdown,
                    Some(WorkerCmd::Subscribe { channel, tx, id }) => {
                        let entry = subs.entry(channel.clone()).or_default();
                        let first = entry.is_empty();
                        entry.push((id, tx));
                        if first {
                            if let Err(e) = session.listen(&channel).await {
                                tracing::warn!(
                                    database_id,
                                    channel = %channel,
                                    error = %e,
                                    "LISTEN failed, reconnecting"
                                );
                                return SessionLoopResult::Reconnect;
                            }
                        }
                    }
                    Some(WorkerCmd::Unsubscribe { id }) => {
                        let emptied_ch = remove_sub(subs, id);
                        if subs.is_empty() {
                            while let Ok(queued) = cmd_rx.try_recv() {
                                apply_sub_cmd(subs, queued);
                            }
                            if subs.is_empty() {
                                return SessionLoopResult::Idle;
                            }
                            if let Some(ref ch) = emptied_ch {
                                if !subs.contains_key(ch) {
                                    if let Err(e) = session.unlisten(ch).await {
                                        tracing::warn!(
                                            database_id,
                                            channel = %ch,
                                            error = %e,
                                            "UNLISTEN failed, reconnecting"
                                        );
                                        return SessionLoopResult::Reconnect;
                                    }
                                }
                            }
                            for ch in subs.keys().cloned().collect::<Vec<_>>() {
                                if emptied_ch.as_ref() == Some(&ch) {
                                    continue;
                                }
                                if let Err(e) = session.listen(&ch).await {
                                    tracing::warn!(
                                        database_id,
                                        channel = %ch,
                                        error = %e,
                                        "LISTEN failed, reconnecting"
                                    );
                                    return SessionLoopResult::Reconnect;
                                }
                            }
                            continue;
                        }
                        if let Some(ch) = emptied_ch {
                            if let Err(e) = session.unlisten(&ch).await {
                                tracing::warn!(
                                    database_id,
                                    channel = %ch,
                                    error = %e,
                                    "UNLISTEN failed, reconnecting"
                                );
                                return SessionLoopResult::Reconnect;
                            }
                        }
                    }
                }
            }
            result = session.recv() => {
                match result {
                    Ok(notice) => {
                        if let Some(senders) = subs.get(&notice.channel) {
                            for (_, tx) in senders {
                                let _ = tx.send(notice.clone());
                            }
                        } else {
                            tracing::debug!(
                                database_id,
                                channel = %notice.channel,
                                "LISTEN notice with no subscribers"
                            );
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            database_id,
                            error = %e,
                            "LISTEN recv failed, reconnecting"
                        );
                        return SessionLoopResult::Reconnect;
                    }
                }
            }
        }
    }
}

fn remove_sub(
    subs: &mut HashMap<String, Vec<(u64, mpsc::UnboundedSender<ListenNotice>)>>,
    id: u64,
) -> Option<String> {
    let mut emptied = None;
    for (ch, vec) in subs.iter_mut() {
        if let Some(pos) = vec.iter().position(|(sid, _)| *sid == id) {
            vec.remove(pos);
            if vec.is_empty() {
                emptied = Some(ch.clone());
            }
            break;
        }
    }
    if let Some(ch) = emptied.clone() {
        subs.remove(&ch);
    }
    emptied
}

impl Factory {
    async fn connect(&self, database_id: i32) -> Result<Session, String> {
        match self {
            Factory::Production { pool } => {
                let session = connect_pg_session(database_id, pool.as_ref()).await?;
                Ok(Session::Pg(session))
            }
            #[cfg(test)]
            Factory::Test(factory) => Ok(Session::Fake(factory.connect_session(database_id))),
        }
    }
}

impl Session {
    async fn listen(&mut self, channel: &str) -> Result<(), String> {
        match self {
            Session::Pg(s) => s.listener.listen(channel).await.map_err(|e| e.to_string()),
            #[cfg(test)]
            Session::Fake(s) => {
                s.listen(channel);
                Ok(())
            }
        }
    }

    async fn unlisten(&mut self, channel: &str) -> Result<(), String> {
        match self {
            Session::Pg(s) => s
                .listener
                .unlisten(channel)
                .await
                .map_err(|e| e.to_string()),
            #[cfg(test)]
            Session::Fake(s) => {
                s.unlisten(channel);
                Ok(())
            }
        }
    }

    async fn recv(&mut self) -> Result<ListenNotice, String> {
        match self {
            Session::Pg(s) => {
                let n = s.listener.recv().await.map_err(|e| e.to_string())?;
                Ok(ListenNotice {
                    database_id: s.database_id,
                    channel: n.channel().to_string(),
                    payload: n.payload().to_string(),
                })
            }
            #[cfg(test)]
            Session::Fake(s) => s.recv().await,
        }
    }
}

static HUB_MAIN_POOL: tokio::sync::OnceCell<sqlx::PgPool> = tokio::sync::OnceCell::const_new();

async fn hub_main_pool() -> Result<sqlx::PgPool, String> {
    HUB_MAIN_POOL
        .get_or_try_init(|| async {
            let url = std::env::var("DATABASE_URL").map_err(|e| e.to_string())?;
            crate::db::create_pool(&url)
                .await
                .map_err(|e| e.to_string())
        })
        .await
        .cloned()
}

async fn connect_pg_session(
    database_id: i32,
    pool: Option<&sqlx::PgPool>,
) -> Result<PgListenSession, String> {
    let main_pool = match pool {
        Some(p) => p.clone(),
        None => hub_main_pool().await?,
    };
    let config = crate::auto_api_handlers::load_database_config(&main_pool, database_id)
        .await
        .map_err(|e| e.to_string())?;
    let (pool, listener) = crate::pool_manager::connect_dedicated_listener(&config)
        .await
        .map_err(|e| e.to_string())?;
    Ok(PgListenSession {
        _pool: pool,
        listener,
        database_id,
    })
}

// ───── test factory / fake session ──────────────────────────────────────────

#[cfg(test)]
use std::sync::Mutex;

/// Test double for a dedicated LISTEN session factory.
///
/// Ops: `connect:{id}`, `listen:{id}:{channel}`, `unlisten:{id}:{channel}`, `close:{id}`.
#[cfg(test)]
#[derive(Clone)]
pub struct TestListenFactory {
    inner: Arc<TestListenFactoryInner>,
}

#[cfg(test)]
struct TestListenFactoryInner {
    ops: Mutex<Vec<String>>,
    push_txs: Mutex<HashMap<i32, mpsc::UnboundedSender<ListenNotice>>>,
}

#[cfg(test)]
struct FakeSession {
    database_id: i32,
    factory: TestListenFactory,
    rx: mpsc::UnboundedReceiver<ListenNotice>,
}

#[cfg(test)]
impl TestListenFactory {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(TestListenFactoryInner {
                ops: Mutex::new(Vec::new()),
                push_txs: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn ops(&self) -> Vec<String> {
        self.inner.ops.lock().expect("ops mutex").clone()
    }

    pub fn push(&self, database_id: i32, channel: &str, payload: &str) {
        let notice = ListenNotice {
            database_id,
            channel: channel.to_string(),
            payload: payload.to_string(),
        };
        if let Some(tx) = self
            .inner
            .push_txs
            .lock()
            .expect("push_txs mutex")
            .get(&database_id)
        {
            let _ = tx.send(notice);
        }
    }

    fn record(&self, op: String) {
        self.inner.ops.lock().expect("ops mutex").push(op);
    }

    fn connect_session(&self, database_id: i32) -> FakeSession {
        self.record(format!("connect:{database_id}"));
        let (tx, rx) = mpsc::unbounded_channel();
        self.inner
            .push_txs
            .lock()
            .expect("push_txs mutex")
            .insert(database_id, tx);
        FakeSession {
            database_id,
            factory: self.clone(),
            rx,
        }
    }
}

#[cfg(test)]
impl FakeSession {
    fn listen(&mut self, channel: &str) {
        self.factory
            .record(format!("listen:{}:{channel}", self.database_id));
    }

    fn unlisten(&mut self, channel: &str) {
        self.factory
            .record(format!("unlisten:{}:{channel}", self.database_id));
    }

    async fn recv(&mut self) -> Result<ListenNotice, String> {
        self.rx
            .recv()
            .await
            .ok_or_else(|| "fake listener closed".to_string())
    }
}

#[cfg(test)]
impl Drop for FakeSession {
    fn drop(&mut self) {
        self.factory
            .inner
            .push_txs
            .lock()
            .expect("push_txs mutex")
            .remove(&self.database_id);
        self.factory.record(format!("close:{}", self.database_id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::time::timeout;

    async fn wait_listener_count(hub: &ListenHub, database_id: i32, expected: u32) {
        timeout(Duration::from_secs(2), async {
            loop {
                if hub.listener_count(database_id) == expected {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!(
                "timeout waiting for listener_count({database_id}) == {expected}, got {}",
                hub.listener_count(database_id)
            )
        });
    }

    async fn wait_ops_contain(factory: &TestListenFactory, needles: &[&str]) {
        timeout(Duration::from_secs(2), async {
            loop {
                let ops = factory.ops();
                if needles.iter().all(|n| ops.iter().any(|op| op == n)) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!(
                "timeout waiting for ops containing {needles:?}, got {:?}",
                factory.ops()
            )
        });
    }

    #[tokio::test]
    async fn two_channels_same_db_one_connection() {
        let factory = TestListenFactory::new();
        let hub = ListenHub::start_with_factory(factory.clone());
        let _a = hub.subscribe(1, "a");
        let _b = hub.subscribe(1, "b");
        wait_listener_count(&hub, 1, 1).await;
        wait_ops_contain(&factory, &["connect:1", "listen:1:a", "listen:1:b"]).await;
        let ops = factory.ops();
        assert_eq!(
            ops.iter().filter(|op| op.as_str() == "connect:1").count(),
            1
        );
        assert_eq!(hub.listener_count(1), 1);
    }

    #[tokio::test]
    async fn two_dbs_two_connections() {
        let factory = TestListenFactory::new();
        let hub = ListenHub::start_with_factory(factory.clone());
        let _a = hub.subscribe(1, "a");
        let _b = hub.subscribe(2, "b");
        wait_listener_count(&hub, 1, 1).await;
        wait_listener_count(&hub, 2, 1).await;
        wait_ops_contain(&factory, &["connect:1", "connect:2"]).await;
        assert_eq!(hub.listener_count(1), 1);
        assert_eq!(hub.listener_count(2), 1);
    }

    #[tokio::test]
    async fn two_subs_same_channel_both_receive() {
        let factory = TestListenFactory::new();
        let hub = ListenHub::start_with_factory(factory.clone());
        let mut a = hub.subscribe(1, "ch");
        let mut b = hub.subscribe(1, "ch");
        wait_listener_count(&hub, 1, 1).await;
        wait_ops_contain(&factory, &["listen:1:ch"]).await;
        let ops = factory.ops();
        assert_eq!(
            ops.iter().filter(|op| op.as_str() == "listen:1:ch").count(),
            1
        );

        factory.push(1, "ch", "hello");
        let na = timeout(Duration::from_secs(2), a.recv())
            .await
            .expect("recv a timed out")
            .expect("recv a closed");
        let nb = timeout(Duration::from_secs(2), b.recv())
            .await
            .expect("recv b timed out")
            .expect("recv b closed");
        assert_eq!(na.payload, "hello");
        assert_eq!(nb.payload, "hello");
        assert_eq!(na.channel, "ch");
        assert_eq!(nb.channel, "ch");
        assert_eq!(na.database_id, 1);
        assert_eq!(nb.database_id, 1);
    }

    #[tokio::test]
    async fn last_sub_unlistens_and_empty_db_closes() {
        let factory = TestListenFactory::new();
        let hub = ListenHub::start_with_factory(factory.clone());
        let a = hub.subscribe(1, "a");
        let b = hub.subscribe(1, "b");
        wait_listener_count(&hub, 1, 1).await;
        wait_ops_contain(&factory, &["listen:1:a", "listen:1:b"]).await;

        drop(a);
        wait_ops_contain(&factory, &["unlisten:1:a"]).await;
        assert!(
            !factory.ops().iter().any(|op| op.as_str() == "close:1"),
            "dropping one channel must not close the db connection: {:?}",
            factory.ops()
        );
        assert_eq!(hub.listener_count(1), 1);

        drop(b);
        wait_ops_contain(&factory, &["close:1"]).await;
        wait_listener_count(&hub, 1, 0).await;
        assert_eq!(hub.listener_count(1), 0);
    }

    #[tokio::test]
    async fn dead_subscriber_does_not_block_others() {
        let factory = TestListenFactory::new();
        let hub = ListenHub::start_with_factory(factory.clone());
        let a = hub.subscribe(1, "ch");
        let mut b = hub.subscribe(1, "ch");
        wait_listener_count(&hub, 1, 1).await;
        wait_ops_contain(&factory, &["listen:1:ch"]).await;

        drop(a);
        tokio::time::sleep(Duration::from_millis(20)).await;

        factory.push(1, "ch", "ping");
        let n = timeout(Duration::from_secs(2), b.recv())
            .await
            .expect("recv b timed out")
            .expect("recv b closed");
        assert_eq!(n.payload, "ping");
    }

    #[tokio::test]
    async fn resubscribe_after_last_unsub_still_receives() {
        let factory = TestListenFactory::new();
        let hub = ListenHub::start_with_factory(factory.clone());
        let first = hub.subscribe(1, "a");
        wait_listener_count(&hub, 1, 1).await;
        wait_ops_contain(&factory, &["listen:1:a"]).await;

        // Same-task burst: last unsubscribe + subscribe before yielding to the worker.
        drop(first);
        let mut next = hub.subscribe(1, "b");

        wait_ops_contain(&factory, &["listen:1:b"]).await;
        wait_listener_count(&hub, 1, 1).await;

        factory.push(1, "b", "after-resub");
        let n = timeout(Duration::from_secs(2), next.recv())
            .await
            .expect("recv after last-unsub resubscribe timed out")
            .expect("subscription died after last-unsub resubscribe");
        assert_eq!(n.payload, "after-resub");
        assert_eq!(n.channel, "b");
        assert_eq!(n.database_id, 1);

        let ops = factory.ops();
        let listen_b = ops
            .iter()
            .position(|op| op.as_str() == "listen:1:b")
            .expect("listen:1:b missing");
        let closed_before_listen_b = ops[..listen_b].iter().any(|op| op.as_str() == "close:1");
        if !closed_before_listen_b {
            assert_eq!(
                ops.iter().filter(|op| op.as_str() == "connect:1").count(),
                1,
                "burst unlisten+listen should keep the connection: {ops:?}"
            );
        }
    }
}
