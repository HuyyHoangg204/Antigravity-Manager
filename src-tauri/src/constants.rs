use std::sync::LazyLock;
use regex::Regex;

/// URL to fetch the latest Antigravity version
const VERSION_URL: &str = "https://antigravity-auto-updater-974169037036.us-central1.run.app";

/// Fallback version derived from Cargo.toml at compile time
const FALLBACK_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Pre-compiled regex for version parsing (X.Y.Z pattern)
static VERSION_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\d+\.\d+\.\d+").expect("Invalid version regex")
});

/// Parse version from response text using pre-compiled regex
/// Matches semver pattern: X.Y.Z (e.g., "1.15.8")
fn parse_version(text: &str) -> Option<String> {
    VERSION_REGEX.find(text).map(|m| m.as_str().to_string())
}

/// Version source for logging
#[derive(Debug)]
enum VersionSource {
    Remote,
    CargoToml,
}

/// Fetch version from remote endpoint, with fallback to Cargo.toml
/// Uses a separate thread to avoid blocking the main/UI thread
fn fetch_remote_version() -> (String, VersionSource) {
    // [Re-applied Fix] Force use of local Cargo version to ensure stability.
    // The remote URL might return an older version string, causing "Version Not Supported" errors.
    
    // Fallback: Cargo.toml version (always valid at compile time)
    (FALLBACK_VERSION.to_string(), VersionSource::CargoToml)
}

/// Shared User-Agent string for all upstream API requests.
/// Format: antigravity/{version} {os}/{arch}
/// Version priority: remote endpoint > Cargo.toml
/// OS and architecture are detected at runtime.
pub static USER_AGENT: LazyLock<String> = LazyLock::new(|| {
    let (version, source) = fetch_remote_version();

    tracing::info!(
        version = %version,
        source = ?source,
        "User-Agent initialized"
    );

    format!(
        "antigravity/{} {}/{}",
        version,
        std::env::consts::OS,
        std::env::consts::ARCH
    )
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_version_from_updater_response() {
        let text = "Auto updater is running. Stable Version: 1.15.8-5724687216017408";
        assert_eq!(parse_version(text), Some("1.15.8".to_string()));
    }

    #[test]
    fn test_parse_version_simple() {
        assert_eq!(parse_version("1.15.8"), Some("1.15.8".to_string()));
        assert_eq!(parse_version("Version: 2.0.0"), Some("2.0.0".to_string()));
        assert_eq!(parse_version("v1.2.3"), Some("1.2.3".to_string()));
    }

    #[test]
    fn test_parse_version_invalid() {
        assert_eq!(parse_version("no version here"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("1.2"), None); // Only X.Y, not X.Y.Z
    }

    #[test]
    fn test_parse_version_with_suffix() {
        // Regex only matches X.Y.Z, suffix is naturally excluded
        let text = "antigravity/1.15.8 windows/amd64";
        assert_eq!(parse_version(text), Some("1.15.8".to_string()));
    }
}

