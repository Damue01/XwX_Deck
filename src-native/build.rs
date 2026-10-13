fn main() {
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
