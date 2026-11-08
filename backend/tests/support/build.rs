//! A static build like scripts/compress-static.mjs leaves in out/: pages, a hashed asset with its .br and .gz.

use std::io::Write as _;
use std::path::Path;

pub const INDEX_HTML: &str =
    r#"<!doctype html><html><head><script type="module" src="/assets/index-a1b2c3.js"></script></head></html>"#;
pub const ASSET: &str = "export const city = \"gzm\";\n";
/// zlib.brotliCompressSync(ASSET) from Node: the bytes the TS test decompresses back to ASSET
pub const ASSET_BR: [u8; 31] = [
    11, 13, 128, 101, 120, 112, 111, 114, 116, 32, 99, 111, 110, 115, 116, 32, 99, 105, 116, 121, 32, 61, 32, 34, 103,
    122, 109, 34, 59, 10, 3,
];

pub fn write_build(out: &Path) {
    std::fs::create_dir_all(out.join("assets")).unwrap();
    std::fs::write(out.join("index.html"), INDEX_HTML).unwrap();
    std::fs::write(
        out.join("brygady.html"),
        "<!doctype html><html><body>brygady</body></html>",
    )
    .unwrap();
    std::fs::write(out.join("404.html"), "<!doctype html><html><body>404</body></html>").unwrap();
    std::fs::write(out.join("assets/index-a1b2c3.js"), ASSET).unwrap();
    std::fs::write(out.join("assets/index-a1b2c3.js.br"), ASSET_BR).unwrap();
    // scripts/compress-static.mjs gives every page of the real build a .gz (and a .br), hence its Vary
    std::fs::write(out.join("index.html.gz"), gzip(INDEX_HTML)).unwrap();
    std::fs::write(out.join("assets/index-a1b2c3.js.gz"), gzip(ASSET)).unwrap();
}

fn gzip(s: &str) -> Vec<u8> {
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(s.as_bytes()).unwrap();
    gz.finish().unwrap()
}
