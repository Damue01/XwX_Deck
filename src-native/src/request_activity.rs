//! Admission and completion are serialized with stop; response bodies own leases.
use std::sync::{Arc, Mutex};
#[derive(Default)]
pub(super) struct Activity(Mutex<State>);
#[derive(Default)]
struct State {
    closing: bool,
    requests: usize,
    tools: super::tool_wait::Pending,
}
pub(super) struct Lease(Arc<Activity>);
impl Activity {
    pub fn enter(self: &Arc<Self>) -> Result<Lease, String> {
        let mut state = self.0.lock().map_err(|_| "请求状态不可用")?;
        if state.closing {
            return Err("Gateway 正在停止，请恢复直连后重试".into());
        }
        state.requests += 1;
        Ok(Lease(self.clone()))
    }
    pub fn begin_stop(&self, force: bool) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| "请求状态不可用")?;
        if !force && state.requests != 0 {
            return Err(format!("{} 个回复正在生成或连接仍在使用。", state.requests));
        }
        if !force && state.tools.count() != 0 {
            return Err(format!("{} 个工具调用仍在等待客户端执行或返回结果。请继续等待；如已放弃该任务，可明确强制停止。", state.tools.count()));
        }
        state.closing = true;
        Ok(())
    }
    pub fn reopen(&self) {
        if let Ok(mut state) = self.0.lock() {
            state.closing = false;
        }
    }
    pub fn count(&self) -> usize {
        self.0.lock().map(|s| s.requests).unwrap_or(0)
    }
    pub fn waiting_tools(&self) -> usize {
        self.0.lock().map(|s| s.tools.count()).unwrap_or(0)
    }
    pub fn tools(&self, update: impl FnOnce(&mut super::tool_wait::Pending)) {
        if let Ok(mut state) = self.0.lock() {
            update(&mut state.tools);
        }
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0 .0.lock() {
            state.requests = state.requests.saturating_sub(1);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn busy_stop_preserves_admission_and_completed_stop_closes_it() {
        let activity = Arc::new(Activity::default());
        let first = activity.enter().unwrap();
        assert!(activity.begin_stop(false).is_err());
        let second = activity.enter().unwrap();
        drop(first);
        drop(second);
        activity.begin_stop(false).unwrap();
        assert!(activity.enter().is_err());
        activity.reopen();
        assert!(activity.enter().is_ok());
    }
    #[test]
    fn forced_stop_blocks_new_work_until_restore_failure_reopens() {
        let activity = Arc::new(Activity::default());
        let lease = activity.enter().unwrap();
        activity.begin_stop(true).unwrap();
        assert!(activity.enter().is_err());
        activity.reopen();
        assert_eq!(activity.count(), 1);
        drop(lease);
        assert_eq!(activity.count(), 0);
    }
}
