use std::{env, fs, io::Write, path::PathBuf};

fn compress_embedded_assets() {
    let root =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("missing manifest directory"));
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("missing build output directory"));
    let resources = [
        ("models_dev_capabilities", "models-dev-capabilities.json"),
        ("viewer", "viewer.html"),
        ("prices", "prices.json"),
        ("setup_websites", "setup-websites.json"),
        ("official_models", "official-models.json"),
        ("clients", "clients.json"),
    ];
    let mut manifest = String::from("// Generated lossless embedded resources.\n");
    for (id, filename) in resources {
        let source = root.join("../test-results/native-assets").join(filename);
        println!("cargo:rerun-if-changed={}", source.display());
        let text = fs::read_to_string(&source).unwrap_or_else(|error| {
            panic!(
                "cannot read embedded resource {}: {error}",
                source.display()
            )
        });
        assert!(
            text.len() <= 16 * 1024 * 1024,
            "embedded resource {filename} exceeds 16 MiB"
        );
        let mut encoder =
            zstd::stream::Encoder::new(Vec::new(), 19).expect("cannot create asset encoder");
        encoder
            .include_checksum(true)
            .expect("cannot enable asset checksum");
        encoder
            .write_all(text.as_bytes())
            .expect("cannot compress embedded resource");
        let compressed = encoder.finish().expect("cannot finish embedded resource");
        assert_eq!(
            zstd::stream::decode_all(compressed.as_slice())
                .expect("cannot verify embedded resource"),
            text.as_bytes(),
            "embedded resource {filename} must round trip byte for byte"
        );
        fs::write(output.join(format!("{filename}.zst")), &compressed)
            .expect("cannot write compressed embedded resource");
        manifest.push_str(&format!(
            "// {filename}: {} original bytes, {} compressed bytes.\nstatic {}: EmbeddedText = EmbeddedText::new(include_bytes!(concat!(env!(\"OUT_DIR\"), \"/{filename}.zst\")), {});\npub(crate) fn {id}() -> Result<&'static str, String> {{ {}.text() }}\n",
            text.len(), compressed.len(), id.to_ascii_uppercase(), text.len(), id.to_ascii_uppercase()
        ));
    }
    fs::write(output.join("embedded-assets.rs"), manifest)
        .expect("cannot write embedded asset manifest");
}

fn embed_shared_fonts() {
    let directory = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("../test-results/native-assets/fonts");
    println!("cargo:rerun-if-changed={}", directory.display());
    let mut files = fs::read_dir(&directory)
        .expect("missing prepared offline fonts")
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    files.sort();
    assert!(!files.is_empty(), "offline fonts must not be empty");
    let mut manifest = String::from("static FONTS: &[(&str, &[u8])] = &[\n");
    for path in files {
        let name = path.file_name().unwrap().to_str().unwrap();
        assert!(
            name.len() == 70
                && name.ends_with(".woff2")
                && name[..64].bytes().all(|c| c.is_ascii_hexdigit()),
            "invalid font resource name"
        );
        assert!(
            fs::read(&path).unwrap().starts_with(b"wOF2"),
            "invalid WOFF2 resource"
        );
        println!("cargo:rerun-if-changed={}", path.display());
        manifest.push_str(&format!(
            "({name:?}, include_bytes!({:?})),\n",
            path.to_str().unwrap()
        ));
    }
    manifest.push_str("];\n");
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("embedded-fonts.rs"),
        manifest,
    )
    .expect("cannot write shared font manifest");
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    compress_embedded_assets();
    embed_shared_fonts();
    println!("cargo:rerun-if-changed=src/webcrypto_store.m");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/webcrypto_store.m")
            .flag("-fobjc-arc")
            .compile("deck_webcrypto_store");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-lib=framework=LocalAuthentication");
    }
    tauri_build::build()
}
