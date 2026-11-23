#!/usr/bin/env bash
set -euo pipefail

REPO_SLUG="ycuwq/agy-ext-swarm"
PLUGIN_DIR_NAME="agy-ext-swarm"
VERSION="${AGY_EXT_SWARM_VERSION:-latest}"
PLUGINS_DIR="${AGY_EXT_SWARM_PLUGINS_DIR:-${HOME}/.gemini/config/plugins}"
ACTION="install"

usage() {
  cat <<'EOF'
AGY Ext Swarm Release Installer (macOS / Linux)

Usage:
  install.sh [options]

Options:
  --version <vX.Y.Z|latest>  Release tag to install (default: latest, env: AGY_EXT_SWARM_VERSION)
  --plugins-dir <path>       Target plugins directory (default: ~/.gemini/config/plugins)
  --workspace                Install into ./.agents/plugins in the current directory
  --uninstall                Remove agy-ext-swarm from the target plugins directory
  -h, --help                 Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      [[ $# -ge 2 ]] || { echo "Error: --version requires a value" >&2; exit 2; }
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="${1#*=}"
      shift
      ;;
    --plugins-dir)
      [[ $# -ge 2 ]] || { echo "Error: --plugins-dir requires a path" >&2; exit 2; }
      PLUGINS_DIR="$2"
      shift 2
      ;;
    --plugins-dir=*)
      PLUGINS_DIR="${1#*=}"
      shift
      ;;
    --workspace)
      PLUGINS_DIR="${PWD}/.agents/plugins"
      shift
      ;;
    --uninstall)
      ACTION="uninstall"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

TARGET_DIR="${PLUGINS_DIR}/${PLUGIN_DIR_NAME}"

if [[ "${ACTION}" == "uninstall" ]]; then
  if [[ -e "${TARGET_DIR}" || -L "${TARGET_DIR}" ]]; then
    rm -rf "${TARGET_DIR}"
    echo "Removed ${TARGET_DIR}"
  else
    echo "Nothing to remove at ${TARGET_DIR}"
  fi
  exit 0
fi

if [[ "${VERSION}" == "latest" ]]; then
  ARCHIVE_URL="https://github.com/${REPO_SLUG}/releases/latest/download/agy-ext-swarm.tar.gz"
else
  TAG="${VERSION}"
  if [[ "${TAG}" != v* ]]; then
    TAG="v${TAG}"
  fi
  ARCHIVE_URL="https://github.com/${REPO_SLUG}/releases/download/${TAG}/agy-ext-swarm-${TAG}.tar.gz"
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

ARCHIVE_PATH="${TMP_DIR}/agy-ext-swarm.tar.gz"
EXTRACT_DIR="${TMP_DIR}/extract"
mkdir -p "${EXTRACT_DIR}"

echo "Downloading AGY Ext Swarm (${VERSION}) from:"
echo "  ${ARCHIVE_URL}"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "${ARCHIVE_URL}" -o "${ARCHIVE_PATH}"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "${ARCHIVE_PATH}" "${ARCHIVE_URL}"
else
  echo "Error: curl or wget is required to download the release archive." >&2
  exit 1
fi

tar -xzf "${ARCHIVE_PATH}" -C "${EXTRACT_DIR}"

EXTRACTED_PLUGIN="${EXTRACT_DIR}/${PLUGIN_DIR_NAME}"
if [[ ! -f "${EXTRACTED_PLUGIN}/plugin.json" || ! -f "${EXTRACTED_PLUGIN}/server/dist/index.mjs" || ! -f "${EXTRACTED_PLUGIN}/server/dist/board.html" ]]; then
  echo "Error: downloaded archive is incomplete or invalid." >&2
  exit 1
fi

if [[ -f "${EXTRACTED_PLUGIN}/bin/ext-board.mjs" ]]; then
  chmod +x "${EXTRACTED_PLUGIN}/bin/ext-board.mjs"
fi

mkdir -p "${PLUGINS_DIR}"

if [[ -d "${TARGET_DIR}" && ! -L "${TARGET_DIR}" && -d "${TARGET_DIR}/.data" ]]; then
  mv "${TARGET_DIR}/.data" "${EXTRACTED_PLUGIN}/.data"
fi

if [[ -e "${TARGET_DIR}" || -L "${TARGET_DIR}" ]]; then
  rm -rf "${TARGET_DIR}"
fi

mv "${EXTRACTED_PLUGIN}" "${TARGET_DIR}"

echo ""
echo "Installed AGY Ext Swarm to:"
echo "  ${TARGET_DIR}"

if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -v 2>/dev/null || true)"
  NODE_MAJOR="${NODE_VER#v}"
  NODE_MAJOR="${NODE_MAJOR%%.*}"
  if [[ -n "${NODE_MAJOR}" && "${NODE_MAJOR}" =~ ^[0-9]+$ && "${NODE_MAJOR}" -lt 20 ]]; then
    echo "Warning: Node.js >= 20 is required to run the MCP server (detected ${NODE_VER})." >&2
  fi
else
  echo "Warning: Node.js (>= 20) was not found in PATH. Install Node.js >= 20 before starting Antigravity." >&2
fi

echo ""
echo "Next steps:"
echo "  1. Open Antigravity Desktop App -> Customizations -> Installed to verify \"AGY Ext Swarm\" is enabled."
echo "  2. If upgrading while Antigravity is running, refresh \"agy-ext-swarm_ext_swarm\" in MCP Servers settings."
