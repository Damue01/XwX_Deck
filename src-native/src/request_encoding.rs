use super::*;
use std::io::Read;

const LIMIT: usize = 16 * 1024 * 1024;

pub(super) async fn decode(request: Request) -> std::result::Result<Request, (u16, String)> {
    let Some(encoding) = request.headers().get("content-encoding") else {
        return Ok(request);
    };
    let encoding = encoding.to_str().unwrap_or("").trim().to_ascii_lowercase();
    if encoding == "identity" {
        return Ok(request);
    }
    if encoding != "zstd" {
        return Err((415, "不支持的请求压缩格式".into()));
    }
    let (mut parts, body) = request.into_parts();
    let bytes = to_bytes(body, LIMIT)
        .await
        .map_err(|_| (413, "请求过大".into()))?;
    let decoded = expand(&bytes).map_err(|message| (400, message))?;
    parts.headers.remove("content-encoding");
    parts.headers.remove("content-length");
    Ok(Request::from_parts(parts, Body::from(decoded)))
}

fn expand(bytes: &[u8]) -> Result<Vec<u8>> {
    let reader = zstd::stream::read::Decoder::new(bytes).map_err(|_| "无效 zstd 请求正文")?;
    let mut decoded = Vec::new();
    reader
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut decoded)
        .map_err(|_| "无效 zstd 请求正文")?;
    if decoded.len() > LIMIT {
        return Err("解压后的请求超过 16 MB 上限".into());
    }
    Ok(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_zstd_body() {
        let body = br#"{"model":"fixture","input":"hello"}"#;
        assert_eq!(
            expand(&zstd::stream::encode_all(&body[..], 1).unwrap()).unwrap(),
            body
        );
        assert!(expand(b"not zstd").is_err());
        assert!(expand(&zstd::stream::encode_all(&vec![0; LIMIT + 1][..], 1).unwrap()).is_err());
    }
}
