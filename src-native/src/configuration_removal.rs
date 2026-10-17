//! Removing Deck registrations never signs out the source client.
use super::*;

const REMOVED: &str = "removedSubscriptionAccounts";

pub(super) fn filter_accounts(root: &Path, accounts: &mut Vec<Value>, flow: &mut Value) {
    let settings = read(&root.join("settings.json"))
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(Value::Null);
    let removed = settings[REMOVED].as_array();
    accounts.retain(|account| {
        let linked = settings["connections"].as_array().is_some_and(|rows| {
            rows.iter()
                .any(|p| p["subscriptionAccountId"] == account["id"])
        });
        linked
            || !removed.is_some_and(|rows| {
                rows.iter().any(|row| {
                    row["id"] == account["id"]
                        && row["accountKey"].as_str().unwrap_or("")
                            == account["accountKey"].as_str().unwrap_or("")
                })
            })
    });
    if flow["status"] == "complete"
        && removed.is_some_and(|rows| {
            rows.iter()
                .any(|row| row["id"] == flow["accountId"] && row["flowId"] == flow["id"])
        })
    {
        *flow = Value::Null;
    }
}

impl Pilot {
    pub(super) fn prune_removed_connections(&mut self, ids: &[String]) {
        self.settings.connections.retain(|p| !ids.contains(&p.id));
        for policy in self
            .settings
            .other
            .get_mut("serviceSwitching")
            .and_then(Value::as_object_mut)
            .into_iter()
            .flat_map(|policies| policies.values_mut())
        {
            if let Some(providers) = policy.get_mut("providerIds").and_then(Value::as_array_mut) {
                providers.retain(|id| !ids.iter().any(|removed| id.as_str() == Some(removed)));
            }
        }
    }

    pub(super) fn refresh_removal_routes(&self) {
        if let Some(gateway) = &self.gateway {
            if let Ok(routes) = gateway.routes.read() {
                routes.switching.configure(&self.settings);
            }
        }
    }

    pub(super) fn removal_impact(
        &self,
        provider_ids: &[String],
        account_ids: &[String],
    ) -> Vec<String> {
        // Pooled subscription accounts may serve a connection registered under
        // another account in the same authorization group.
        let depends = |id: &str| {
            provider_ids.iter().any(|p| p == id)
                || self
                    .settings
                    .connections
                    .iter()
                    .find(|p| p.id == id)
                    .is_some_and(|p| {
                        !p.subscription_account_id.is_empty()
                            && account_ids.iter().any(|account| {
                                subscription_routing::group(account)
                                    == subscription_routing::group(&p.subscription_account_id)
                            })
                    })
        };
        let mut clients = Vec::new();
        for (client, id) in self.settings.selected.as_object().into_iter().flatten() {
            if id.as_str().is_some_and(depends) {
                clients.push(
                    match client.as_str() {
                        "codex" => "ChatGPT / Codex",
                        "claude" => "Claude",
                        _ => client,
                    }
                    .to_string(),
                );
            }
        }
        for (client, route) in self
            .settings
            .other
            .get("clientRoutes")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            if depends(text(route, "providerId")) {
                clients.push(ingress::label(client).to_string());
            }
        }
        clients.sort();
        clients.dedup();
        clients
    }

    pub(super) async fn remove_subscription_accounts(&mut self, input: &Value) -> Result<Value> {
        let ids: Vec<String> = serde_json::from_value(input.clone()).map_err(|_| "无效订阅账号")?;
        if ids.is_empty() {
            return Err("请选择要移除的账号".into());
        }
        let snapshot = self.subscriptions.snapshot().await;
        if matches!(text(&snapshot["flow"], "status"), "waiting" | "exchanging") {
            return Err("请先完成或取消当前账号授权，再移除账号".into());
        }
        let mut accounts: Vec<_> = snapshot["accounts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| ids.iter().any(|id| a["id"] == *id))
            .cloned()
            .collect();
        for id in &ids {
            if !accounts.iter().any(|a| a["id"] == *id) {
                if !self
                    .settings
                    .connections
                    .iter()
                    .any(|p| p.subscription_account_id == *id)
                {
                    return Err("账号已变化，请刷新后重试".into());
                }
                accounts.push(json!({"id":id}));
            }
        }
        let providers: Vec<_> = self
            .settings
            .connections
            .iter()
            .filter(|p| ids.contains(&p.subscription_account_id))
            .map(|p| p.id.clone())
            .collect();
        let impact = self.removal_impact(&providers, &ids);
        if !impact.is_empty() {
            return Err(format!(
                "请先在模型页切换以下客户端，再移除配置：{}",
                impact.join("、")
            ));
        }
        let before = self.settings.clone();
        let mut removed = self
            .settings
            .other
            .get(REMOVED)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for account in accounts {
            removed.retain(|row| row["id"] != account["id"]);
            removed.push(json!({"id":account["id"],"accountKey":account["accountKey"].as_str().unwrap_or(""),"flowId":snapshot["flow"]["id"]}));
        }
        self.settings.other.insert(REMOVED.into(), json!(removed));
        if let Some(rows) = self
            .settings
            .other
            .get_mut(imported_subscriptions::KEY)
            .and_then(Value::as_array_mut)
        {
            rows.retain(|row| !ids.iter().any(|id| row["id"] == *id));
        }
        self.prune_removed_connections(&providers);
        if let Err(error) = self.persist() {
            self.settings = before;
            return Err(error);
        }
        self.refresh_removal_routes();
        Ok(self.providers().await)
    }
}
