//! test/gtfs-csv.test.ts

use unimaps::gtfs_csv::*;

fn csv(line: &str) -> Vec<String> {
    parse_csv_line(line)
}

#[test]
fn splits_plain_fields() {
    assert_eq!(csv("a,b,c"), ["a", "b", "c"]);
}

#[test]
fn keeps_commas_inside_quoted_fields() {
    assert_eq!(csv(r#"a,"b,c",d"#), ["a", "b,c", "d"]);
}

#[test]
fn unescapes_doubled_quotes() {
    assert_eq!(csv(r#"a,"he said ""hi""",c"#), ["a", r#"he said "hi""#, "c"]);
}

#[test]
fn preserves_empty_cells_including_a_trailing_one() {
    assert_eq!(csv("a,,c"), ["a", "", "c"]);
    assert_eq!(csv("a,b,"), ["a", "b", ""]);
    assert_eq!(csv(""), [""]);
}

#[test]
fn split_lines_takes_crlf_cr_and_lf_alike() {
    assert_eq!(split_lines("a\r\nb\rc\nd"), ["a", "b", "c", "d"]);
    assert_eq!(split_lines("a\r\n"), ["a", ""]);
}

#[test]
fn col_finds_a_header_index() {
    let header = csv("stop_id,stop_name");
    assert_eq!(col(&header, "stop_name"), Some(1));
    assert_eq!(col(&header, "missing"), None);
}
