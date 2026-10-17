//! Public connectivity check using the same native TLS and system-proxy features as login.
//! No account, authorization code or token is sent.
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(25))
        .build()?;
    for path in ["openid-configuration", "jwks.json"] {
        let response = client
            .get(format!("https://auth.openai.com/.well-known/{path}"))
            .send()
            .await?;
        let status = response.status();
        let value: serde_json::Value = response.error_for_status()?.json().await?;
        if path == "openid-configuration" {
            assert_eq!(value["issuer"], "https://auth.openai.com");
            assert_eq!(
                value["jwks_uri"],
                "https://auth.openai.com/.well-known/jwks.json"
            );
        } else {
            assert!(!value["keys"].as_array().ok_or("missing keys")?.is_empty());
        }
        println!("PASS native authorization connectivity {path}: {status}");
    }
    Ok(())
}
