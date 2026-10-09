//! Small executable used only by the isolated physical updater regression.
use std::{io::Read, path::PathBuf};
fn main() {
    let path = PathBuf::from(std::env::var_os("XWX_UPDATE_TEST_RECEIPT").expect("isolated receipt"));
    #[cfg(fixture_new)]
    let version = "fixture-new";
    #[cfg(not(fixture_new))]
    let version = "fixture-old";
    std::fs::write(path, format!("{{\"version\":\"{version}\"}}\n")).unwrap();
    #[cfg(not(fixture_new))]
    { let _ = std::io::stdin().read_to_end(&mut Vec::new()); }
}
