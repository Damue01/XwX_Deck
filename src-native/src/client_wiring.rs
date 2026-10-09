//! Small, reversible client configuration edits. Comments and unrelated fields survive.
use super::*;
use sha2::{Digest, Sha256};
const CLIENTS: &[&str] = &["opencode", "gemini-cli", "qwen-code", "pi", "mimo-code", "crush", "qoder", "droid", "codebuddy-code", "workbuddy"];

pub(super) fn checked_model(id: &str, model: &str) -> Result<()> {
    // Crush expands environment variables and shell substitutions in config strings.
    if model.trim().is_empty() || model.len() > 256 || model.chars().any(char::is_control)
        || (id == "crush" && model.contains(['$', '`'])) {
        return Err("请设置有效模型".into());
    }
    Ok(())
}
pub(super) fn automatic_client(id: &str) -> bool {
    CLIENTS.contains(&id)
}
fn clean(source: &str) -> Result<Vec<u8>> {
    let mut b = source.as_bytes().to_vec();
    let mut i = 0;
    let mut quoted = false;
    while i < b.len() {
        if quoted {
            if b[i] == b'\\' {
                i += 2;
                continue;
            }
            if b[i] == b'"' {
                quoted = false;
            }
            i += 1;
            continue;
        }
        if b[i] == b'"' {
            quoted = true;
            i += 1;
            continue;
        }
        if i + 1 < b.len() && b[i] == b'/' && b[i + 1] == b'/' {
            while i < b.len() && b[i] != b'\n' {
                b[i] = b' ';
                i += 1;
            }
            continue;
        }
        if i + 1 < b.len() && b[i] == b'/' && b[i + 1] == b'*' {
            b[i] = b' ';
            b[i + 1] = b' ';
            i += 2;
            let mut closed = false;
            while i + 1 < b.len() {
                if b[i] == b'*' && b[i + 1] == b'/' {
                    b[i] = b' ';
                    b[i + 1] = b' ';
                    i += 2;
                    closed = true;
                    break;
                }
                if !b[i].is_ascii_whitespace() {
                    b[i] = b' ';
                }
                i += 1;
            }
            if !closed {
                return Err("客户端 JSON 注释未结束，原文件已保留".into());
            }
            continue;
        }
        i += 1;
    }
    quoted = false;
    i = 0;
    while i < b.len() {
        if quoted {
            if b[i] == b'\\' {
                i += 2;
                continue;
            }
            if b[i] == b'"' {
                quoted = false;
            }
        } else if b[i] == b'"' {
            quoted = true;
        } else if b[i] == b',' {
            let mut j = i + 1;
            while j < b.len() && b[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < b.len() && (b[j] == b'}' || b[j] == b']') {
                b[i] = b' ';
            }
        }
        i += 1;
    }
    serde_json::from_slice::<Value>(&b)
        .map_err(|_| "客户端 JSON 无法解析，原文件已保留".to_string())?;
    unique_keys(&b, 0)?;
    Ok(b)
}
fn parsed(source: &str) -> Result<Value> {
    serde_json::from_slice(&clean(source)?).map_err(err)
}
fn ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && b[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}
fn end(b: &[u8], at: usize) -> Result<usize> {
    let mut stream = serde_json::Deserializer::from_slice(&b[at..]).into_iter::<Value>();
    stream.next().ok_or("配置字段缺失")?.map_err(err)?;
    Ok(at + stream.byte_offset())
}
fn unique_keys(b: &[u8], at: usize) -> Result<()> {
    let mut i = ws(b, at);
    if b.get(i) == Some(&b'{') {
        i += 1;
        let mut seen = std::collections::BTreeSet::new();
        loop {
            i = ws(b, i);
            if b.get(i) == Some(&b'}') {
                return Ok(());
            }
            let finish = end(b, i)?;
            let key: String = serde_json::from_slice(&b[i..finish]).map_err(err)?;
            if !seen.insert(key) {
                return Err("客户端 JSON 字段重复，原文件已保留".into());
            }
            i = ws(b, finish) + 1;
            i = ws(b, i);
            unique_keys(b, i)?;
            i = ws(b, end(b, i)?);
            if b.get(i) == Some(&b',') {
                i += 1;
            } else {
                return Ok(());
            }
        }
    }
    if b.get(i) == Some(&b'[') {
        i += 1;
        loop {
            i = ws(b, i);
            if b.get(i) == Some(&b']') {
                return Ok(());
            }
            unique_keys(b, i)?;
            i = ws(b, end(b, i)?);
            if b.get(i) == Some(&b',') {
                i += 1;
            } else {
                return Ok(());
            }
        }
    }
    Ok(())
}
fn object(
    b: &[u8],
    at: usize,
    key: &str,
) -> Result<Option<(usize, usize, usize, Option<usize>, Option<usize>)>> {
    let mut i = ws(b, at);
    if b.get(i) != Some(&b'{') {
        return Err("客户端配置字段不是对象".into());
    }
    i += 1;
    let mut previous = None;
    loop {
        i = ws(b, i);
        if b.get(i) == Some(&b'}') {
            return Ok(None);
        }
        let key_start = i;
        let key_end = end(b, i)?;
        let name: String = serde_json::from_slice(&b[i..key_end]).map_err(err)?;
        i = ws(b, key_end);
        if b.get(i) != Some(&b':') {
            return Err("配置字段缺少冒号".into());
        }
        let value_start = ws(b, i + 1);
        let value_end = end(b, value_start)?;
        i = ws(b, value_end);
        let next = if b.get(i) == Some(&b',') {
            Some(i)
        } else {
            None
        };
        if name == key {
            return Ok(Some((key_start, value_start, value_end, previous, next)));
        }
        if let Some(comma) = next {
            previous = Some(comma);
            i = comma + 1;
        } else {
            return Ok(None);
        }
    }
}
fn patch(source: &str, path: &[&str], value: Option<&Value>) -> Result<String> {
    if path.is_empty() { return Ok(value.map(Value::to_string).unwrap_or_else(||"{}".into())); }
    let bytes = clean(source)?;
    let mut parent = 0;
    for (depth, key) in path[..path.len() - 1].iter().enumerate() {
        match object(&bytes, parent, key)? {
            Some((_, start, _, _, _)) => parent = start,
            None => {
                if value.is_none() {
                    return Ok(source.into());
                }
                let mut out = patch(source, &path[..=depth], Some(&json!({})))?;
                out = patch(&out, path, value)?;
                return Ok(out);
            }
        }
    }
    let key = path.last().ok_or("空配置字段")?;
    if let Some((key_start, start, finish, previous, next)) = object(&bytes, parent, key)? {
        let (a, b, replacement) = if let Some(value) = value {
            (start, finish, value.to_string())
        } else if let Some(next) = next {
            (key_start, next + 1, String::new())
        } else {
            (previous.unwrap_or(key_start), finish, String::new())
        };
        return Ok(format!("{}{}{}", &source[..a], replacement, &source[b..]));
    }
    let Some(value) = value else {
        return Ok(source.into());
    };
    let finish = end(&bytes, parent)?;
    let mut close = finish - 1;
    while bytes[close].is_ascii_whitespace() {
        close -= 1;
    }
    let nonempty = parsed(&source[parent..finish])?
        .as_object()
        .is_some_and(|o| !o.is_empty());
    // A trailing comma already in the original must not receive another one.
    let mut meaningful = close;
    while meaningful > 0 && bytes[meaningful - 1].is_ascii_whitespace() {
        meaningful -= 1;
    }
    let trailing = source[..close]
        .as_bytes()
        .iter()
        .enumerate()
        .skip(meaningful)
        .any(|(i, b)| *b == b',' && bytes[i] == b' ');
    let separator = if nonempty && !trailing { "," } else { "" };
    Ok(format!(
        "{}{separator}\n  {}: {}\n{}",
        &source[..close],
        json!(key),
        value,
        &source[close..]
    ))
}
fn value_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut node = v;
    for key in path {
        node = node.get(*key)?;
    }
    Some(node)
}
fn env_value(source: &str, key: &str) -> Option<String> {
    source.lines().find_map(|line| {
        line.trim()
            .strip_prefix(&format!("{key}="))
            .map(String::from)
    })
}
fn checked_path(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        if fs::symlink_metadata(ancestor).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("客户端配置路径包含符号链接，原文件已保留".into());
        }
    }
    Ok(())
}
fn checked_env(source: &str, key: &str) -> Result<()> {
    if source
        .lines()
        .filter(|line| line.trim().starts_with(&format!("{key}=")))
        .count()
        > 1
    {
        return Err("客户端环境变量重复，原文件已保留".into());
    }
    Ok(())
}
fn env_patch(source: &str, key: &str, value: Option<&str>) -> String {
    let mut found = false;
    let mut lines = vec![];
    for line in source.lines() {
        if line.trim().starts_with(&format!("{key}=")) {
            if !found {
                if let Some(value) = value {
                    lines.push(format!("{key}={value}"));
                }
            }
            found = true;
        } else {
            lines.push(line.into());
        }
    }
    if !found {
        if let Some(value) = value {
            lines.push(format!("{key}={value}"));
        }
    }
    if lines.is_empty() {
        String::new()
    } else {
        lines.join("\n") + "\n"
    }
}
fn json_plan(path: &Path, options: Vec<(Vec<&str>,Value)>) -> Result<Value> {
    let source=read(path)?.unwrap_or("{}".into());
    let value=parsed(&source)?;
    let mut content=source.clone();
    let mut patches=vec![];
    for (keys,managed) in options {
        patches.push(json!({"path":keys,"before":value_at(&value,&keys),"existed":value_at(&value,&keys).is_some(),"managed":managed}));
        content=patch(&content,&keys,Some(&managed))?;
    }
    Ok(json!({"file":path,"before":source,"beforeExisted":path.exists(),"content":content,"patches":patches,"env":false}))
}
impl Pilot {
    fn client_home(&self) -> PathBuf {
        if self.isolated {
            self.root.join("client-home")
        } else {
            Self::home()
        }
    }
    fn wiring_directory(&self, variable: &str, fallback: PathBuf) -> PathBuf {
        if self.isolated { return fallback; }
        std::env::var_os(variable).map(PathBuf::from).map(|path| {
            if path.starts_with("~") { Self::home().join(path.strip_prefix("~").unwrap().strip_prefix("/").unwrap_or(path.strip_prefix("~").unwrap())) } else { path }
        }).filter(|path|path.is_absolute()).unwrap_or(fallback)
    }
    fn wiring_paths(&self, id: &str) -> Vec<PathBuf> {
        let home = self.client_home();
        match id {
            "opencode" => {
                let directory = if self.isolated {
                    home.join(".config/opencode")
                } else {
                    std::env::var_os("OPENCODE_CONFIG_DIR")
                        .map(PathBuf::from)
                        .unwrap_or_else(|| {
                            std::env::var_os("XDG_CONFIG_HOME")
                                .map(PathBuf::from)
                                .unwrap_or(home.join(".config"))
                                .join("opencode")
                        })
                };
                let jsonc = directory.join("opencode.jsonc");
                vec![if jsonc.exists() {
                    jsonc
                } else {
                    directory.join("opencode.json")
                }]
            }
            "gemini-cli" => vec![
                home.join(".gemini/settings.json"),
                home.join(".gemini/.env"),
            ],
            "qwen-code" => vec![home.join(".qwen/settings.json")],
            "pi" => {
                let dir = self.wiring_directory("PI_CODING_AGENT_DIR", home.join(".pi/agent"));
                vec![dir.join("models.json"), dir.join("settings.json")]
            }
            "mimo-code" => {
                let mut dir = self.wiring_directory("XDG_CONFIG_HOME", home.join(".config")).join("mimocode");
                if !self.isolated && std::env::var_os("MIMOCODE_HOME").is_some() {
                    dir = self.wiring_directory("MIMOCODE_HOME", home.join(".mimocode")).join("config");
                }
                let jsonc = dir.join("mimocode.jsonc");
                vec![if jsonc.exists() { jsonc } else { dir.join("mimocode.json") }]
            }
            "qoder" => vec![self.wiring_directory("QODER_CONFIG_DIR",home.join(".qoder")).join("settings.json")],
            "droid" => vec![self.wiring_directory("FACTORY_HOME_OVERRIDE",home.clone()).join(".factory/settings.json")],
            "codebuddy-code" => {
                let dir = self.wiring_directory("CODEBUDDY_CONFIG_DIR", home.join(".codebuddy"));
                vec![dir.join("models.json"),dir.join("settings.json")]
            }
            "workbuddy" => vec![self.wiring_directory("WORKBUDDY_CONFIG_DIR",home.join(".workbuddy")).join("models.json")],
            "crush" => {
                let config = self.wiring_directory("CRUSH_GLOBAL_CONFIG",self.wiring_directory("XDG_CONFIG_HOME",home.join(".config")).join("crush")).join("crush.json");
                let data_directory = if cfg!(windows)&&!self.isolated {
                    self.wiring_directory("LOCALAPPDATA",home.join("AppData/Local")).join("crush")
                } else { self.wiring_directory("XDG_DATA_HOME",home.join(".local/share")).join("crush") };
                let data = self.wiring_directory("CRUSH_GLOBAL_DATA",data_directory).join("crush.json");
                vec![config,data]
            }
            _ => vec![],
        }
    }
    pub(super) fn client_route_snapshot(&self, id: &str) -> Result<Value> {
        if !ingress::valid_client(id) {
            return Err("无效客户端".into());
        }
        let paths = self.wiring_paths(id);
        let mut hash = Sha256::new();
        let mut external = false;
        let owned = self.root.join(format!("client-wiring-{id}.json")).exists();
        for path in &paths {
            checked_path(path)?;
            let source = read(path)?;
            hash.update(path.to_string_lossy().as_bytes());
            hash.update([0]);
            hash.update(if source.is_some() { [1] } else { [0] });
            hash.update(source.as_deref().unwrap_or("").as_bytes());
            if let Some(source) = source {
                if path
                    .extension()
                    .is_some_and(|e| e == "json" || e == "jsonc")
                {
                    let v = parsed(&source)?;
                    external |= match id {
                        "opencode" | "mimo-code" => v["model"]
                            .as_str()
                            .is_some_and(|v| !v.starts_with("xwx_deck/")),
                        "gemini-cli" => v["security"]["auth"]["selectedType"]
                            .as_str()
                            .is_some_and(|v| v != "gemini-api-key"),
                        "pi" => v.get("defaultModel").is_some() || v["defaultProvider"].as_str().is_some_and(|v|v != "xwx_deck") || v["providers"].get("xwx_deck").is_some(),
                        "crush" => v["models"].get("large").is_some() || v["models"].get("small").is_some() || v["providers"].get("xwx_deck").is_some(),
                        "droid" => v["sessionDefaultSettings"].get("model").is_some() || v.get("model").is_some() || v.get("customModels").is_some(),
                        "codebuddy-code" | "workbuddy" => v.get("models").is_some() || v.is_array() || v.get("model").is_some(),
                        _ => v["model"]["name"].as_str().is_some_and(|v| !v.is_empty()),
                    };
                }
            }
        }
        let route = self
            .settings
            .other
            .get("clientRoutes")
            .and_then(|v| v.get(id))
            .cloned()
            .unwrap_or(json!({"providerId":null,"model":"","enabled":true}));
        let url = self
            .gateway
            .as_ref()
            .map(|g| format!("http://127.0.0.1:{}/clients/{id}", g.port));
        Ok(
            json!({"client":id,"providerId":route["providerId"],"model":route["model"],"enabled":route["enabled"]!=false,"automatic":CLIENTS.contains(&id),"baseUrl":url,"configDigest":format!("{:x}",hash.finalize()),"requiresTakeover":external&&!owned,"configPaths":paths}),
        )
    }
    fn plan_client(&self, id: &str, port: u16, route: &Value) -> Result<Vec<Value>> {
        let paths = self.wiring_paths(id);
        if paths.is_empty() {
            return Ok(vec![]);
        }
        let model = text(route, "model");
        checked_model(id, model)?;
        let base = format!("http://127.0.0.1:{port}/clients/{id}");
        let mut plans = vec![];
        let options = match id {
            "opencode" | "mimo-code" => {
                let original = read(&paths[0])?.unwrap_or("{}".into());
                let v = parsed(&original)?;
                if v.get("providers").is_some()
                    || v.get("$schema")
                        .and_then(Value::as_str)
                        .is_some_and(|s| s.contains("v2"))
                {
                    vec![
                        (
                            vec!["providers", "xwx_deck"],
                            json!({"name":"XwX Deck","package":"@opencode/ai/providers/openai-compatible","settings":{"baseURL":format!("{base}/v1"),"apiKey":"xwx-deck"},"models":{model:{"name":model}}}),
                        ),
                        (vec!["model"], json!(format!("xwx_deck/{model}"))),
                    ]
                } else {
                    vec![
                        (
                            vec!["provider", "xwx_deck"],
                            json!({"name":"XwX Deck","npm":"@ai-sdk/openai-compatible","options":{"baseURL":format!("{base}/v1"),"apiKey":"xwx-deck"},"models":{model:{"name":model}}}),
                        ),
                        (vec!["model"], json!(format!("xwx_deck/{model}"))),
                    ]
                }
            }
            "gemini-cli" => vec![
                (vec!["model", "name"], json!(model)),
                (
                    vec!["security", "auth", "selectedType"],
                    json!("gemini-api-key"),
                ),
            ],
            "qwen-code" => vec![
                (
                    vec!["modelProviders", "xwx_deck"],
                    json!([{"id":model,"name":model,"baseUrl":format!("{base}/v1"),"envKey":"XWX_DECK_GATEWAY_KEY","wireApi":"chat-completions","generationConfig":{"customHeaders":{"x-session-id":"${session_id}"}}}]),
                ),
                (vec!["providerProtocol", "xwx_deck"], json!("openai")),
                (vec!["env", "XWX_DECK_GATEWAY_KEY"], json!("xwx-deck")),
                (vec!["security", "auth", "selectedType"], json!("xwx_deck")),
                (vec!["model", "name"], json!(model)),
            ],
            "pi" => vec![(vec!["providers","xwx_deck"],json!({"baseUrl":format!("{base}/v1"),"api":"openai-completions","apiKey":"xwx-deck","models":[{"id":model,"name":model}]}))],
            "qoder" => vec![
                (vec!["providers","xwx_deck"],json!({"displayName":"XwX Deck","protocol":"openai","baseUrl":format!("{base}/v1"),"apiKey":"xwx-deck","model":model,"models":[{"model":model,"displayName":model,"capabilities":{"tools":true}}]})),
                (vec!["model","name"],json!(format!("xwx_deck/{model}")))
            ],
            "droid" => {
                let v = parsed(&read(&paths[0])?.unwrap_or("{}".into()))?;
                let mut models = match v.get("customModels") {
                    Some(value) => value.as_array().ok_or("Droid customModels 必须是数组")?.clone(), None => vec![]
                };
                models.retain(|m|!text(m,"id").starts_with("custom:xwx_deck/"));
                models.push(json!({"id":format!("custom:xwx_deck/{model}"),"model":model,"displayName":format!("XwX Deck {model}"),"baseUrl":format!("{base}/v1"),"apiKey":"xwx-deck","provider":"generic-chat-completion-api"}));
                vec![(vec!["customModels"],json!(models)),(vec!["sessionDefaultSettings","model"],json!(format!("custom:xwx_deck/{model}")))]
            }
            "codebuddy-code" | "workbuddy" => {
                let v = parsed(&read(&paths[0])?.unwrap_or("{}".into()))?;
                let source = if v.is_array() { Some(&v) } else { v.get("models") };
                let mut models = match source { Some(value) => value.as_array().ok_or("models 必须是数组")?.clone(),None=>vec![] };
                models.retain(|m|text(m,"vendor")!="xwx_deck");
                models.push(json!({"id":format!("xwx_deck/{model}"),"name":format!("XwX Deck {model}"),"vendor":"xwx_deck","apiKey":"xwx-deck","url":format!("{base}/v1/chat/completions"),"supportsToolCall":true}));
                let mut options = vec![(if v.is_array() {vec![]} else {vec!["models"]},json!(models))];
                if let Some(allowed)=v.get("availableModels") {
                    let mut allowed=allowed.as_array().ok_or("availableModels 必须是数组")?.clone();
                    let selected=json!(format!("xwx_deck/{model}"));
                    if !allowed.contains(&selected) {allowed.push(selected);}
                    options.push((vec!["availableModels"],json!(allowed)));
                }
                options
            }
            "crush" => vec![(vec!["providers","xwx_deck"],json!({"type":"openai-compat","name":"XwX Deck","base_url":format!("{base}/v1"),"api_key":"xwx-deck","models":[{"id":model,"name":model}]}))],
            _ => vec![],
        };
        plans.push(json_plan(&paths[0],options)?);
        if id == "pi" {
            let settings=parsed(&read(&paths[1])?.unwrap_or("{}".into()))?;
            let mut options=vec![(vec!["defaultProvider"],json!("xwx_deck")),(vec!["defaultModel"],json!(model))];
            if let Some(enabled)=settings.get("enabledModels") {
                let mut enabled=enabled.as_array().ok_or("Pi enabledModels 必须是数组")?.clone();
                if !enabled.is_empty() {
                    let selected=json!(format!("xwx_deck/{model}"));
                    if !enabled.contains(&selected) { enabled.push(selected); }
                    options.push((vec!["enabledModels"],json!(enabled)));
                }
            }
            plans.push(json_plan(&paths[1],options)?);
        }
        if id == "codebuddy-code" {
            plans.push(json_plan(&paths[1],vec![(vec!["model"],json!(format!("xwx_deck/{model}")))])?);
        }
        if id == "crush" {
            plans.push(json_plan(&paths[1],vec![(vec!["models","large"],json!({"provider":"xwx_deck","model":model})),(vec!["models","small"],json!({"provider":"xwx_deck","model":model}))])?);
        }
        if id == "gemini-cli" {
            let source = read(&paths[1])?.unwrap_or_default();
            let mut content = source.clone();
            let mut patches = vec![];
            for (key, value) in [
                ("GOOGLE_GEMINI_BASE_URL", base.as_str()),
                ("GEMINI_API_KEY", "xwx-deck"),
            ] {
                checked_env(&source, key)?;
                patches.push(json!({"key":key,"before":env_value(&source,key),"managed":value}));
                content = env_patch(&content, key, Some(value));
            }
            plans.push(json!({"file":paths[1],"before":source,"beforeExisted":paths[1].exists(),"content":content,"patches":patches,"env":true}));
        }
        Ok(plans)
    }
    pub(super) fn apply_client_wiring(&self, port: u16) -> Result<()> {
        self.apply_client_wiring_for(port, None)
    }
    pub(super) fn apply_client_wiring_for(&self, port: u16, only: Option<&str>) -> Result<()> {
        for (id, route) in self
            .settings
            .other
            .get("clientRoutes")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            if only.is_some_and(|x| x != id)
                || route["enabled"] == false
                || !CLIENTS.contains(&id.as_str())
                || !self
                    .settings
                    .connections
                    .iter()
                    .any(|provider| provider.id == text(route, "providerId"))
            {
                continue;
            }
            // Only clients explicitly configured in Deck are eligible. Never create an uninstalled client's config.
            if !self.client_discovery().installed(id) {
                continue;
            }
            let ledger = self.root.join(format!("client-wiring-{id}.json"));
            if ledger.exists() {
                self.restore_client_wiring(Some(id))?;
            }
            let snapshot = self.client_route_snapshot(id)?;
            if snapshot["configDigest"] != route["acceptedDigest"] {
                return Err(format!(
                    "{} 配置已变化，原文件已保留，请重新确认接管",
                    ingress::label(id)
                ));
            }
            let plans = self.plan_client(id, port, route)?;
            for plan in &plans {
                checked_path(&PathBuf::from(text(plan, "file")))?;
            }
            write(&ledger, &json!(plans).to_string())?;
            for plan in &plans {
                let path = PathBuf::from(text(plan, "file"));
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(err)?;
                }
                let current = read(&path)?;
                let expected = if plan["beforeExisted"] == true {
                    Some(text(plan, "before"))
                } else {
                    None
                };
                if current.as_deref() != expected {
                    return Err("客户端配置在接管期间变化，原文件与恢复证据已保留".into());
                }
                if let Err(error) = write(&path, text(plan, "content")) {
                    let _ = self.restore_client_wiring(Some(id));
                    return Err(error);
                }
            }
        }
        Ok(())
    }
    pub(super) fn restore_client_wiring(&self, only: Option<&str>) -> Result<()> {
        let mut ready = vec![];
        for id in CLIENTS {
            if only.is_some_and(|x| x != *id) {
                continue;
            }
            let ledger = self.root.join(format!("client-wiring-{id}.json"));
            let Some(source) = read(&ledger)? else {
                continue;
            };
            let plans: Vec<Value> = serde_json::from_str(&source).map_err(err)?;
            let allowed = self.wiring_paths(id);
            for plan in plans {
                let path = PathBuf::from(text(&plan, "file"));
                if !allowed.contains(&path) {
                    return Err("客户端恢复路径不匹配，保留证据".into());
                }
                checked_path(&path)?;
                let current = match read(&path)? {
                    Some(v) => v,
                    None if plan["beforeExisted"] == false => {
                        ready.push((path, String::new(), ledger.clone(), true));
                        continue;
                    }
                    None => return Err("客户端配置被删除，保留恢复证据".into()),
                };
                let mut restored = current.clone();
                if plan["env"] == true {
                    for p in plan["patches"].as_array().ok_or("恢复账本损坏")? {
                        let key = text(p, "key");
                        checked_env(&current, key)?;
                        if env_value(&current, key).as_deref() != p["managed"].as_str()
                            && env_value(&current, key).as_deref() != p["before"].as_str()
                        {
                            return Err(format!(
                                "{} 配置被外部修改，Gateway 与恢复证据已保留",
                                ingress::label(id)
                            ));
                        }
                        restored = env_patch(&restored, key, p["before"].as_str());
                    }
                } else {
                    let v = parsed(&current)?;
                    for p in plan["patches"].as_array().ok_or("恢复账本损坏")? {
                        let keys: Vec<_> = p["path"]
                            .as_array()
                            .ok_or("恢复字段损坏")?
                            .iter()
                            .filter_map(Value::as_str)
                            .collect();
                        if value_at(&v, &keys) != Some(&p["managed"])
                            && value_at(&v, &keys)
                                != if p["existed"] == true {
                                    Some(&p["before"])
                                } else {
                                    None
                                }
                        {
                            return Err(format!(
                                "{} 配置被外部修改，Gateway 与恢复证据已保留",
                                ingress::label(id)
                            ));
                        }
                        restored = patch(
                            &restored,
                            &keys,
                            if p["existed"] == true {
                                Some(&p["before"])
                            } else {
                                None
                            },
                        )?;
                    }
                }
                if current == text(&plan, "content") {
                    restored = text(&plan, "before").into();
                }
                let remove = current == text(&plan, "content") && plan["beforeExisted"] == false;
                ready.push((path, restored, ledger.clone(), remove));
            }
        }
        for (path, source, _, remove) in &ready {
            if *remove {
                if path.exists() {
                    fs::remove_file(path).map_err(err)?;
                }
            } else {
                write(path, source)?;
            }
        }
        for (_, _, ledger, _) in ready {
            if ledger.exists() {
                fs::remove_file(ledger).map_err(err)?;
            }
        }
        Ok(())
    }
}
