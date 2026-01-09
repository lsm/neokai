#!/bin/bash
# Setup Zig - Simple bash-based installer with local caching
set -e

# Use GitHub Actions tool cache or fallback to home directory
if [[ -n "$RUNNER_TOOL_CACHE" ]]; then
    ZIG_INSTALL="${RUNNER_TOOL_CACHE}/zig"
else
    ZIG_INSTALL="/home/runner/_work/_tool/zig"
fi

REQUESTED_VERSION="${ZIG_VERSION:-0.15.2}"
ZIG_INDEX_URL="https://ziglang.org/download/index.json"

# Output helper
output() {
    echo "$1=$2" >> "$GITHUB_OUTPUT"
}

# Detect OS
detect_os() {
    case "$(uname -s)" in
        Linux)  echo "linux" ;;
        Darwin) echo "macos" ;;
        *)      echo "Unsupported OS: $(uname -s)"; exit 1 ;;
    esac
}

# Detect architecture
detect_arch() {
    case "$(uname -m)" in
        x86_64)  echo "x86_64" ;;
        aarch64) echo "aarch64" ;;
        arm64)   echo "aarch64" ;;
        *)       echo "Unsupported architecture: $(uname -m)"; exit 1 ;;
    esac
}

# Get version directory path
get_version_dir() {
    local version="$1"
    echo "${ZIG_INSTALL}/${version}"
}

# Get Zig binary path for a version
get_zig_path() {
    local version="$1"
    local version_dir=$(get_version_dir "$version")
    echo "${version_dir}/zig"
}

# Check if Zig version is installed
is_version_installed() {
    local version="$1"
    local zig_path=$(get_zig_path "$version")
    [[ -x "$zig_path" ]]
}

# Get installed version string
get_installed_version_string() {
    local version="$1"
    local zig_path=$(get_zig_path "$version")
    if [[ -x "$zig_path" ]]; then
        "$zig_path" version 2>/dev/null || echo ""
    fi
}

# Resolve master to actual dev version
resolve_master_version() {
    local index_json
    index_json=$(curl -fsSL "$ZIG_INDEX_URL" 2>/dev/null) || return 1

    local os=$(detect_os)
    local arch=$(detect_arch)
    local target="${arch}-${os}"

    # Extract master version from index
    echo "$index_json" | grep -oP '"master":\s*\{[^}]*"version":\s*"\K[^"]+' | head -1
}

# Get download URL for version
get_download_url() {
    local version="$1"
    local os=$(detect_os)
    local arch=$(detect_arch)
    local target="${arch}-${os}"

    local index_json
    index_json=$(curl -fsSL "$ZIG_INDEX_URL" 2>/dev/null) || {
        echo "Error: Could not fetch Zig download index" >&2
        return 1
    }

    # For master builds, look in "master" section
    local section="$version"
    if [[ "$version" == "master" ]] || [[ "$version" == *"+"* ]]; then
        section="master"
    fi

    # Extract tarball URL for target platform
    # The JSON structure is: { "version": { "target": { "tarball": "url" } } }
    local url
    url=$(echo "$index_json" | python3 -c "
import json, sys
data = json.load(sys.stdin)
section = '$section'
target = '$target'
if section in data and target in data[section]:
    print(data[section][target].get('tarball', ''))
" 2>/dev/null)

    if [[ -z "$url" ]]; then
        echo "Error: No download URL found for Zig $version on $target" >&2
        return 1
    fi

    echo "$url"
}

# Download and install Zig
install_zig() {
    local version="$1"
    local version_dir=$(get_version_dir "$version")

    echo "Installing Zig ${version}..."

    local url
    url=$(get_download_url "$version") || exit 1

    echo "Downloading from: $url"

    # Create temporary directory
    local tmpdir=$(mktemp -d)
    local archive="${tmpdir}/zig.tar.xz"

    # Download archive
    curl -fsSL -o "$archive" "$url" || {
        echo "Error: Failed to download Zig"
        rm -rf "$tmpdir"
        exit 1
    }

    # Extract archive
    echo "Extracting..."
    tar -xJf "$archive" -C "$tmpdir" || {
        echo "Error: Failed to extract archive"
        rm -rf "$tmpdir"
        exit 1
    }

    # Find extracted directory (zig-*-*-*)
    local extracted_dir=$(find "$tmpdir" -maxdepth 1 -type d -name "zig-*" | head -1)
    if [[ -z "$extracted_dir" ]]; then
        echo "Error: Could not find extracted Zig directory"
        rm -rf "$tmpdir"
        exit 1
    fi

    # Move to version directory
    mkdir -p "$ZIG_INSTALL"
    rm -rf "$version_dir"
    mv "$extracted_dir" "$version_dir"

    # Cleanup
    rm -rf "$tmpdir"

    # Verify installation
    local zig_path=$(get_zig_path "$version")
    if [[ ! -x "$zig_path" ]]; then
        echo "Error: Zig binary not found after extraction"
        exit 1
    fi

    echo "Zig ${version} installed to ${version_dir}"
}

# Main logic
main() {
    echo "Setting up Zig..."
    echo "Requested version: $REQUESTED_VERSION"
    echo "Install path: $ZIG_INSTALL"

    local target_version="$REQUESTED_VERSION"
    local cache_hit="false"

    # Handle master/nightly builds
    if [[ "$REQUESTED_VERSION" == "master" ]]; then
        echo "Resolving master version..."
        local master_version
        master_version=$(resolve_master_version)
        if [[ -n "$master_version" ]]; then
            echo "Master version: $master_version"
            target_version="$master_version"
        else
            echo "Warning: Could not resolve master version"
        fi
    fi

    # Check for cached installation
    if is_version_installed "$target_version"; then
        local installed_ver=$(get_installed_version_string "$target_version")
        echo "Found cached Zig installation: $installed_ver"
        cache_hit="true"
    else
        echo "No cached version found, installing..."
        install_zig "$target_version"
    fi

    # Verify final installation
    local zig_path=$(get_zig_path "$target_version")
    if [[ ! -x "$zig_path" ]]; then
        echo "Error: Zig installation verification failed"
        exit 1
    fi

    local final_version=$("$zig_path" version)
    echo "Zig ${final_version} ready"

    # Add to PATH
    local version_dir=$(get_version_dir "$target_version")
    echo "${version_dir}" >> "$GITHUB_PATH"

    # Set outputs
    output "zig-version" "$final_version"
    output "zig-path" "$zig_path"
    output "cache-hit" "$cache_hit"
}

main
