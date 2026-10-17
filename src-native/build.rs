use std::{env, fs, path::PathBuf};

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
