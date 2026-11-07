//! `HttpZb` (lib/gzm.ts fetch + cappedText) against a local server: compression and the texts of undici's errors.

/// Node's fetch (undici) asks for `br, gzip, deflate` on https and decodes the reply; zbiorkom answers ~8.6x smaller.
#[tokio::test]
async fn http_zb_asks_for_compression_and_decodes_the_body() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use unimaps::gzm::{HttpZb, ZbTransport};

    const GZ: [u8; 28] = [
        0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x03, 0xab, 0x56, 0xca, 0xcf, 0x56, 0xb2, 0x32, 0xac,
        0x05, 0x00, 0x09, 0x8c, 0x54, 0x10, 0x08, 0x00, 0x00, 0x00,
    ];
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/positions", l.local_addr().unwrap());
    let head = tokio::spawn(async move {
        let (mut s, _) = l.accept().await.unwrap();
        let (mut head, mut buf) = (Vec::new(), [0u8; 1024]);
        while !head.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = s.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            head.extend_from_slice(&buf[..n]);
        }
        let mut res = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: 28\r\n\r\n".to_vec();
        res.extend_from_slice(&GZ);
        s.write_all(&res).await.unwrap();
        let _ = s.shutdown().await;
        String::from_utf8_lossy(&head).to_lowercase()
    });
    let res = HttpZb
        .get(
            &url,
            &[("Accept", "application/json")],
            std::time::Duration::from_secs(5),
            1000,
        )
        .await
        .unwrap();
    let head = head.await.unwrap();
    let ae = head
        .lines()
        .find_map(|l| l.strip_prefix("accept-encoding:"))
        .unwrap_or_default();
    for enc in ["br", "gzip", "deflate"] {
        assert!(
            ae.split(',').any(|e| e.trim() == enc),
            "accept-encoding {ae:?} lacks {enc}"
        );
    }
    assert_eq!((res.status, res.body.as_str()), (200, r#"{"ok":1}"#));
}

/// `String(err)` of undici's fetch: refused = "TypeError: fetch failed", `AbortSignal.timeout` =
/// "TimeoutError: ...", a body cut short = "TypeError: terminated" (Node 22).
#[tokio::test]
async fn http_zb_fails_with_the_text_of_undicis_fetch() {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use unimaps::gzm::{HttpZb, ZbTransport};

    let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let refused = format!("http://{}/", closed.local_addr().unwrap());
    drop(closed);
    let err = HttpZb.get(&refused, &[], Duration::from_secs(5), 1000).await.err();
    assert_eq!(err.as_deref(), Some("TypeError: fetch failed"));

    let mute = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", mute.local_addr().unwrap());
    let hold = tokio::spawn(async move {
        let conn = mute.accept().await;
        tokio::time::sleep(Duration::from_secs(5)).await;
        drop(conn);
    });
    let err = HttpZb.get(&url, &[], Duration::from_millis(200), 1000).await.err();
    assert_eq!(
        err.as_deref(),
        Some("TimeoutError: The operation was aborted due to timeout")
    );
    hold.abort();

    let short = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", short.local_addr().unwrap());
    tokio::spawn(async move {
        if let Ok((mut s, _)) = short.accept().await {
            // the request read first: closing on unread bytes would reset the connection before the head is read
            let (mut head, mut buf) = (Vec::new(), [0u8; 1024]);
            while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                match s.read(&mut buf).await {
                    Ok(n) if n > 0 => head.extend_from_slice(&buf[..n]),
                    _ => break,
                }
            }
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nabc").await;
            let _ = s.shutdown().await;
        }
    });
    let err = HttpZb.get(&url, &[], Duration::from_secs(5), 1000).await.err();
    assert_eq!(err.as_deref(), Some("TypeError: terminated"));
}
