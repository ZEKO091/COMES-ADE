fn main() {
    println!("cargo:rerun-if-changed=resources/app.rc");
    println!("cargo:rerun-if-changed=resources/app.manifest");
    println!("cargo:rerun-if-changed=resources/comesshot.ico");
    let rc = if std::path::Path::new("resources/comesshot.ico").exists() {
        "resources/app.rc"
    } else {
        "resources/app-noicon.rc"
    };
    embed_resource::compile(rc, embed_resource::NONE)
        .manifest_optional()
        .unwrap();
}
