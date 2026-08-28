//! UTC day arithmetic without a calendar dependency: the app only ever needs
//! "which YYYY-MM-DD does this unix timestamp fall on" and the reverse.
//! Civil-date conversion per Howard Hinnant's algorithms.

/// Days since 1970-01-01 for a civil date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (m + 9) % 12; // Mar=0 .. Feb=11
    let doy = (153 * mp + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146097 + doe - 719468
}

/// Civil date (y, m, d) for days since 1970-01-01.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// YYYY-MM-DD (UTC) for a unix timestamp in seconds.
pub fn day_key(unix_seconds: i64) -> String {
    let (y, m, d) = civil_from_days(unix_seconds.div_euclid(86400));
    format!("{y:04}-{m:02}-{d:02}")
}

/// Parse a strict YYYY-MM-DD into unix seconds at midnight UTC.
pub fn parse_day(day: &str) -> Option<i64> {
    let bytes = day.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let y: i64 = day[0..4].parse().ok()?;
    let m: i64 = day[5..7].parse().ok()?;
    let d: i64 = day[8..10].parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let days = days_from_civil(y, m, d);
    // Reject 2026-02-31 and friends: a round trip must reproduce the input.
    let (yy, mm, dd) = civil_from_days(days);
    if (yy, mm, dd) != (y, m, d) {
        return None;
    }
    Some(days * 86400)
}

pub fn day_bounds(day: &str) -> Result<(i64, i64), String> {
    let start = parse_day(day).ok_or_else(|| format!("bad day: {day}"))?;
    Ok((start, start + 86400))
}

/// Last `n` days as YYYY-MM-DD, most recent first.
pub fn recent_days(n: u32, from_unix: i64) -> Vec<String> {
    (0..n as i64)
        .map(|i| day_key(from_unix - i * 86400))
        .collect()
}

/// Every day from `from` to `to` (both YYYY-MM-DD, inclusive), oldest first.
pub fn days_between(from: &str, to: &str) -> Result<Vec<String>, String> {
    let start = parse_day(from).ok_or_else(|| format!("bad day: {from}"))?;
    let end = parse_day(to).ok_or_else(|| format!("bad day: {to}"))?;
    if start > end {
        return Err(format!("empty range: {from} is after {to}"));
    }
    Ok((start..=end).step_by(86400).map(day_key).collect())
}

/// Unix seconds now.
pub fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock before 1970")
        .as_secs() as i64
}

/// Unix milliseconds now — the trainer/syncer `startedAt` fields kept the
/// Node convention of millisecond timestamps.
pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock before 1970")
        .as_millis() as i64
}

/// ISO-8601 with milliseconds, matching JS `Date.toISOString()`.
pub fn iso_now() -> String {
    let ms = now_millis();
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let (y, mo, d) = civil_from_days(secs.div_euclid(86400));
    let rem = secs.rem_euclid(86400);
    format!(
        "{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_helpers_round_trip() {
        assert_eq!(day_key(1755993599), "2025-08-23");
        assert_eq!(day_bounds("2025-08-23"), Ok((1755907200, 1755993600)));
        // 2025-08-23T10:00:00Z
        assert_eq!(
            recent_days(3, 1755943200),
            vec!["2025-08-23", "2025-08-22", "2025-08-21"]
        );
    }

    #[test]
    fn days_between_spans_the_range_inclusively_oldest_first() {
        assert_eq!(
            days_between("2026-01-30", "2026-02-02").unwrap(),
            vec!["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]
        );
        assert_eq!(days_between("2026-05-01", "2026-05-01").unwrap(), vec!["2026-05-01"]);
        assert!(days_between("2026-05-02", "2026-05-01").unwrap_err().contains("empty range"));
        assert!(days_between("not-a-day", "2026-05-01").unwrap_err().contains("bad day"));
    }

    #[test]
    fn parse_day_rejects_impossible_dates() {
        assert!(parse_day("2026-02-31").is_none());
        assert!(parse_day("2026-13-01").is_none());
        assert!(parse_day("2026-1-1").is_none());
        // Leap day round-trips.
        assert_eq!(day_key(parse_day("2024-02-29").unwrap()), "2024-02-29");
    }
}
