# AGENTS.md - Bilikara Agent Guide

This is a guide for AI agents to understand the Bilikara project structure, technical implementation, and development workflows.

## 1. Project Overview
Bilikara is a Bilibili-based Karaoke system. It consists of a **Host** (PC/TV display) and a **Remote** (Mobile controller).

- **Core Function**: Search and add Bilibili videos to a queue.
- **Media Engine**: Downloads media using `BBDown` and processes it via `FFmpeg`.
- **Playback**: Supports local media playback with independent audio/video tracks for sync and volume control.
- **Sync**: Real-time state synchronization via Server-Sent Events (SSE).

## 2. Setup & Environment
- **Language**: Python 3.8+
- **Frontend**: Vanilla HTML/JS/CSS (No build step).
- **External Dependencies**: `BBDown`, `FFmpeg` (handled automatically or manually placed in `runtime/tools/`).

### Setup Commands
```bash
# Install packaging dependencies (if building)
pip install -r requirements-packaging.txt
```

## 3. Build and Run Commands

### Running the App
```bash
# Start the application (automatic browser launch)
python start_bilikara.py

# Alternative start
python server.py
```

### Building Standalone Executables
```bash
# Windows
build_windows.bat

# macOS
./build_macos.command

# Manual bundle build
python build_bundle.py
```

## 4. Code Style & Patterns

### Backend (Python)
- **Framework**: Custom implementation using `http.server.ThreadingHTTPServer`.
- **Patterns**:
  - **Singleton Context**: `AppContext` (in `server.py`) holds all runtime state.
  - **Persistence**: `PlaylistStore` (in `store.py`) manages JSON-based persistence to `data/state.json`.
  - **Revisions**: Every state change increments `state_revision` to trigger SSE updates.

### Frontend (JavaScript)
- **Pattern**: No frameworks. State-driven re-rendering.
- **State Sync**: Subscribes to `/api/events` (SSE). On every `state` event, the entire UI is refreshed based on the new snapshot.
- **Main Files**:
  - `static/app.js`: Host logic (video/audio sync, SSE listener).
  - `static/remote.js`: Remote logic (search, control commands).

## 5. Testing Instructions
Tests use the standard `unittest` framework.

```bash
# Run all tests
python -m unittest discover tests

# Run specific test
python -m unittest tests/test_server.py
```

## 6. File/Directory Map

### Core Logic (`bilikara/`)
| File | Purpose |
| :--- | :--- |
| `server.py` | API handlers, SSE logic, and the `AppContext` state hub. |
| `store.py` | Persistent state management (Playlist, History, Users). |
| `cache.py` | Wrapper for `BBDown` and `FFmpeg` to manage media downloads. |
| `bilibili.py` | Bilibili API integration (Search, Metadata, Login). |
| `config.py` | Global configuration and directory setups. |
| `models.py` | Shared data structures (PlaylistItem, etc.). |
| `updater.py` | Version checking and auto-update logic. |

### Frontend Assets (`static/`)
| File | Purpose |
| :--- | :--- |
| `index.html` / `app.js` | The Host interface and playback engine. |
| `remote.html` / `remote.js` | The Mobile Remote interface and controller. |
| `styles.css` / `remote.css` | UI styling for Host and Remote respectively. |

### Project Root
| File | Purpose |
| :--- | :--- |
| `start_bilikara.py` | Main entry point for starting the server. |
| `build_bundle.py` | PyInstaller-based build script. |
| `data/` | (Generated) Stores persistence files like `state.json`. |
| `runtime/` | (Generated) Stores tools, logs, and cache. |

---
*Reference: [agents.md standard](https://github.com/agentsmd/agents.md)*
