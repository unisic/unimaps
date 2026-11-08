//! lib/config.ts GZM_NEWS_URL + lib/gzm-news.ts `if (!GZM_NEWS_URL)`: a KB_GZM_NEWS_URL that trims to "" is off,
//! like `off`. Alone in its binary: it sets the environment.

use unimaps::config::GZM_NEWS_URL;
use unimaps::gzm_news::fetch_gzm_news;

#[tokio::test]
async fn blank_news_url_is_off() {
    // SAFETY: the only test in this binary, set before anything reads the environment
    unsafe { std::env::set_var("KB_GZM_NEWS_URL", "   ") };
    assert_eq!(GZM_NEWS_URL.as_deref(), None);
    assert_eq!(fetch_gzm_news().await.err().as_deref(), Some("Error: GZM news off"));
}
